-- =====================================================================
-- MedFinder PH — Supabase schema
-- Run this in Supabase SQL Editor (Project → SQL Editor → New query).
-- Safe to run once on a fresh project. Order matters: extensions →
-- tables → functions/triggers → RLS → storage.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Extensions
-- ---------------------------------------------------------------------
create extension if not exists "pgcrypto"; -- gen_random_uuid()
create extension if not exists "pg_trgm";  -- fuzzy/partial medicine-name search

-- ---------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------

-- profiles: extends auth.users with app-level fields + role.
-- Row is created automatically by the on_auth_user_created trigger below.
create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  full_name   text,
  phone       text,
  role        text not null default 'customer' check (role in ('customer','admin')),
  created_at  timestamptz not null default now()
);

create table if not exists public.pharmacies (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique,
  location    text,
  created_at  timestamptz not null default now()
);

create table if not exists public.medicines (
  id            uuid primary key default gen_random_uuid(),
  name          text not null unique,
  generic_name  text,
  description   text,
  created_at    timestamptz not null default now()
);

-- pharmacy_stock: junction table — price/availability of one medicine
-- at one pharmacy. One row per (pharmacy, medicine) pair.
create table if not exists public.pharmacy_stock (
  id             uuid primary key default gen_random_uuid(),
  pharmacy_id    uuid not null references public.pharmacies(id) on delete cascade,
  medicine_id    uuid not null references public.medicines(id) on delete cascade,
  price          numeric(10,2) not null check (price >= 0),
  stock_status   text not null default 'in_stock'
                 check (stock_status in ('in_stock','low_stock','out_of_stock')),
  updated_at     timestamptz not null default now(),
  unique (pharmacy_id, medicine_id)
);

-- reservations: one row per medicine per checkout (a "cart" is just
-- several of these inserted together, one per line item).
create table if not exists public.reservations (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references auth.users(id) on delete cascade,
  pharmacy_id       uuid not null references public.pharmacies(id),
  medicine_id       uuid not null references public.medicines(id),
  quantity          integer not null default 1 check (quantity > 0),
  contact_name      text not null,
  contact_phone     text not null,
  notes             text,
  status            text not null default 'pending_verification'
                    check (status in (
                      'pending_verification',
                      'payment_confirmed',
                      'ready_for_pickup',
                      'completed',
                      'cancelled'
                    )),
  payment_proof_url text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create table if not exists public.notifications (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users(id) on delete cascade,
  reservation_id uuid references public.reservations(id) on delete cascade,
  message        text not null,
  read_bool      boolean not null default false,
  created_at     timestamptz not null default now()
);

-- Helpful indexes for the lookups the app actually does.
create index if not exists idx_pharmacy_stock_medicine on public.pharmacy_stock(medicine_id);
create index if not exists idx_reservations_user on public.reservations(user_id);
create index if not exists idx_notifications_user_unread on public.notifications(user_id) where read_bool = false;
create index if not exists idx_medicines_name_trgm on public.medicines using gin (name gin_trgm_ops);
create index if not exists idx_medicines_generic_name_trgm on public.medicines using gin (generic_name gin_trgm_ops);

-- ---------------------------------------------------------------------
-- Functions & triggers
-- ---------------------------------------------------------------------

-- is_admin(): security-definer helper so RLS policies can check role
-- without re-triggering RLS on profiles (avoids recursive-policy issues).
create or replace function public.is_admin()
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'admin'
  );
$$;

-- handle_new_user(): auto-create a profiles row on signup.
-- full_name and phone are read from the signUp() options.data payload
-- (see js/signup.js) — this always fires, even when email confirmation
-- is on and there's no session yet for a client-side profile update.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, full_name, phone)
  values (
    new.id,
    new.raw_user_meta_data ->> 'full_name',
    new.raw_user_meta_data ->> 'phone'
  );
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- handle_reservation_status_change(): fires a notification row whenever
-- an admin (or anyone) changes a reservation's status. Runs as
-- security definer so it can insert regardless of who made the update.
create or replace function public.handle_reservation_status_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status is distinct from old.status then
    insert into public.notifications (user_id, reservation_id, message)
    values (
      new.user_id,
      new.id,
      case new.status
        when 'payment_confirmed' then 'Payment confirmed for your reservation.'
        when 'ready_for_pickup'  then 'Your reservation is ready for pickup.'
        when 'completed'         then 'Reservation completed.'
        when 'cancelled'         then 'Reservation cancelled.'
        else 'Reservation status updated to ' || new.status || '.'
      end
    );
  end if;
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists on_reservation_status_change on public.reservations;
create trigger on_reservation_status_change
  before update on public.reservations
  for each row execute function public.handle_reservation_status_change();

-- search_medicines(): fuzzy medicine-name search for search.js.
-- supabase-js can't express trigram similarity ordering through its
-- query builder, so this is exposed as an RPC instead. Matches on
-- substring (ilike) OR trigram similarity above pg_trgm's default 0.3
-- threshold (catches typos like "amoxicilin"), ranked by best match.
-- Deliberately returns medicines only, not pharmacy_stock — search.js
-- does one small follow-up query per matched medicine (at most ~5) to
-- fetch pharmacy listings, which keeps this function simple to read
-- and change later at the cost of a few extra round trips.
create or replace function public.search_medicines(search_term text, result_limit int default 5)
returns table (
  id            uuid,
  name          text,
  generic_name  text,
  description   text,
  match_score   real
)
language sql
stable
set search_path = public
as $$
  select
    m.id, m.name, m.generic_name, m.description,
    greatest(
      similarity(m.name, search_term),
      similarity(coalesce(m.generic_name, ''), search_term)
    ) as match_score
  from public.medicines m
  where m.name % search_term
     or m.generic_name % search_term
     or m.name ilike '%' || search_term || '%'
     or m.generic_name ilike '%' || search_term || '%'
  order by match_score desc, m.name asc
  limit result_limit;
$$;

grant execute on function public.search_medicines(text, int) to anon, authenticated;

-- ---------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------

alter table public.profiles       enable row level security;
alter table public.pharmacies     enable row level security;
alter table public.medicines      enable row level security;
alter table public.pharmacy_stock enable row level security;
alter table public.reservations   enable row level security;
alter table public.notifications  enable row level security;

-- profiles
create policy "profiles_select_own_or_admin" on public.profiles
  for select using (auth.uid() = id or public.is_admin());
create policy "profiles_update_own" on public.profiles
  for update using (auth.uid() = id);

-- pharmacies — public read, admin write
create policy "pharmacies_select_public" on public.pharmacies
  for select using (true);
create policy "pharmacies_insert_admin" on public.pharmacies
  for insert with check (public.is_admin());
create policy "pharmacies_update_admin" on public.pharmacies
  for update using (public.is_admin());
create policy "pharmacies_delete_admin" on public.pharmacies
  for delete using (public.is_admin());

-- medicines — public read, admin write
create policy "medicines_select_public" on public.medicines
  for select using (true);
create policy "medicines_insert_admin" on public.medicines
  for insert with check (public.is_admin());
create policy "medicines_update_admin" on public.medicines
  for update using (public.is_admin());
create policy "medicines_delete_admin" on public.medicines
  for delete using (public.is_admin());

-- pharmacy_stock — public read, admin write
create policy "stock_select_public" on public.pharmacy_stock
  for select using (true);
create policy "stock_insert_admin" on public.pharmacy_stock
  for insert with check (public.is_admin());
create policy "stock_update_admin" on public.pharmacy_stock
  for update using (public.is_admin());
create policy "stock_delete_admin" on public.pharmacy_stock
  for delete using (public.is_admin());

-- reservations — customers see/create only their own; only admins update
create policy "reservations_select_own_or_admin" on public.reservations
  for select using (auth.uid() = user_id or public.is_admin());
create policy "reservations_insert_own" on public.reservations
  for insert with check (auth.uid() = user_id);
create policy "reservations_update_admin" on public.reservations
  for update using (public.is_admin());

-- notifications — customers see/update read state of only their own.
-- No insert policy: rows are created only by the trigger (security definer).
create policy "notifications_select_own" on public.notifications
  for select using (auth.uid() = user_id);
create policy "notifications_update_own" on public.notifications
  for update using (auth.uid() = user_id);

-- ---------------------------------------------------------------------
-- Storage — GCash payment proof screenshots
-- Path convention: {user_id}/{reservation_id or timestamp}.{ext}
-- ---------------------------------------------------------------------

insert into storage.buckets (id, name, public)
values ('payment-proofs', 'payment-proofs', false)
on conflict (id) do nothing;

create policy "payment_proof_insert_own" on storage.objects
  for insert with check (
    bucket_id = 'payment-proofs'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "payment_proof_select_own_or_admin" on storage.objects
  for select using (
    bucket_id = 'payment-proofs'
    and ((storage.foldername(name))[1] = auth.uid()::text or public.is_admin())
  );

-- ---------------------------------------------------------------------
-- Seed data (safe to delete — for local testing of search/results only)
-- ---------------------------------------------------------------------

insert into public.pharmacies (name, location) values
  ('Mercury Drug — Rizal Ave',   'Rizal Avenue, Puerto Princesa City'),
  ('Watsons — Robinsons PPC',    'Robinsons Place Palawan, Puerto Princesa City'),
  ('The Generics Pharmacy — Malvar', 'Malvar Street, Puerto Princesa City')
on conflict do nothing;

insert into public.medicines (name, generic_name, description) values
  ('Biogesic',  'Paracetamol',       'Fever and pain relief, 500mg tablet'),
  ('Neozep',    'Phenylephrine HCl', 'Colds and flu relief'),
  ('Amoxicillin', 'Amoxicillin',     'Antibiotic, 500mg capsule')
on conflict do nothing;

-- Make the first admin manually after your first signup, e.g.:
-- update public.profiles set role = 'admin' where id = '<your-auth-user-uuid>';
