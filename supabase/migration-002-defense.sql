-- =====================================================================
-- MedFinder PH — migration 002 (defense scope)
-- Run in Supabase SQL Editor AFTER schema.sql. Idempotent: safe to re-run.
--
-- ORDER OF OPERATIONS
--   1. Apply the Android sign-up change first (user metadata
--      privacy_consent = true). Section 6 makes sign-up fail server-side
--      without it.
--   2. Run this file.
--   3. Deploy the site.
--
-- CONTRACT (shared with the Android app)
--   reserve_stock(p_pharmacy_id uuid, p_medicine_id uuid, p_quantity int,
--                 p_payment_proof_path text,
--                 p_contact_name text default null,
--                 p_contact_phone text default null,
--                 p_notes text default null) returns reservations
--   cancel_reservation(p_reservation_id uuid) returns reservations
--   Error message (PostgREST `message`) is exactly one of:
--     NOT_AUTHENTICATED, INVALID_QUANTITY, PROOF_REQUIRED,
--     INVALID_PROOF_PATH, CONTACT_REQUIRED, LISTING_NOT_FOUND,
--     ACTIVE_RESERVATION_LIMIT, INSUFFICIENT_STOCK, CANNOT_CANCEL,
--     RESERVATION_NOT_FOUND
--   Stock status thresholds (single source of truth, section 2):
--     quantity 0 = out_of_stock, 1..5 = low_stock, >5 = in_stock
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Columns
-- ---------------------------------------------------------------------

alter table public.pharmacy_stock
  add column if not exists quantity integer;

-- Backfill once from the legacy status text, then lock the column down.
update public.pharmacy_stock
set quantity = case stock_status
                 when 'in_stock'  then 20
                 when 'low_stock' then 3
                 else 0
               end
where quantity is null;

alter table public.pharmacy_stock
  alter column quantity set default 0,
  alter column quantity set not null;

alter table public.pharmacy_stock
  drop constraint if exists pharmacy_stock_quantity_nonneg;
alter table public.pharmacy_stock
  add constraint pharmacy_stock_quantity_nonneg check (quantity >= 0);

alter table public.medicines
  add column if not exists requires_prescription boolean not null default false;

-- Seed antibiotic flag. Extend for other Rx-only items as needed.
update public.medicines set requires_prescription = true
where lower(name) = 'amoxicillin' or lower(generic_name) = 'amoxicillin';

alter table public.profiles
  add column if not exists privacy_consent_at timestamptz;

-- ---------------------------------------------------------------------
-- 2. pharmacy_stock: derived status + freshness timestamp
--    stock_status is now a function of quantity. Nothing writes it
--    directly; the trigger overwrites any client-supplied value.
--    updated_at means "an admin last verified this row". Holds and
--    releases performed by reserve/cancel set app.stock_hold so they do
--    not fake freshness.
-- ---------------------------------------------------------------------

create or replace function public.pharmacy_stock_before_write()
returns trigger
language plpgsql
as $$
begin
  new.stock_status := case
    when new.quantity <= 0 then 'out_of_stock'
    when new.quantity <= 5 then 'low_stock'
    else 'in_stock'
  end;

  if tg_op = 'INSERT'
     or coalesce(current_setting('app.stock_hold', true), '') <> '1' then
    new.updated_at := now();
  end if;

  return new;
end;
$$;

drop trigger if exists pharmacy_stock_before_write on public.pharmacy_stock;
create trigger pharmacy_stock_before_write
  before insert or update on public.pharmacy_stock
  for each row execute function public.pharmacy_stock_before_write();

-- Re-derive status for rows backfilled above.
update public.pharmacy_stock set quantity = quantity;

-- ---------------------------------------------------------------------
-- 3. Reservations: terminal states are immutable; cancel releases stock
--    Immutability makes the release idempotent: a reservation can enter
--    'cancelled' exactly once, so its units are returned exactly once.
--    Completed reservations keep their units decremented (dispensed).
-- ---------------------------------------------------------------------

create or replace function public.reservation_guard_and_release()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status is distinct from old.status then
    if old.status in ('cancelled', 'completed') then
      raise exception 'TERMINAL_STATE';
    end if;

    if new.status = 'cancelled' then
      perform set_config('app.stock_hold', '1', true);
      update public.pharmacy_stock
      set quantity = quantity + old.quantity
      where pharmacy_id = old.pharmacy_id
        and medicine_id = old.medicine_id;
      perform set_config('app.stock_hold', '', true);
    end if;
  end if;
  return new;
end;
$$;

-- Trigger names sort alphabetically within BEFORE UPDATE: this guard
-- ("a_") runs before on_reservation_status_change so an illegal
-- transition is rejected before a notification row is written.
drop trigger if exists a_reservation_guard_and_release on public.reservations;
create trigger a_reservation_guard_and_release
  before update on public.reservations
  for each row execute function public.reservation_guard_and_release();

-- ---------------------------------------------------------------------
-- 4. RPC: reserve_stock — the ONLY path that creates reservations
-- ---------------------------------------------------------------------

create or replace function public.reserve_stock(
  p_pharmacy_id        uuid,
  p_medicine_id        uuid,
  p_quantity           integer,
  p_payment_proof_path text,
  p_contact_name       text default null,
  p_contact_phone      text default null,
  p_notes              text default null
)
returns public.reservations
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid     uuid := auth.uid();
  v_stock   public.pharmacy_stock%rowtype;
  v_profile public.profiles%rowtype;
  v_name    text;
  v_phone   text;
  v_active  integer;
  v_row     public.reservations;
  c_max_qty    constant integer := 10;
  c_max_active constant integer := 3;
begin
  if v_uid is null then
    raise exception 'NOT_AUTHENTICATED';
  end if;

  if p_quantity is null or p_quantity < 1 or p_quantity > c_max_qty then
    raise exception 'INVALID_QUANTITY';
  end if;

  if p_payment_proof_path is null or length(trim(p_payment_proof_path)) = 0 then
    raise exception 'PROOF_REQUIRED';
  end if;
  -- A caller may only reference an object inside their own folder.
  if position(v_uid::text || '/' in p_payment_proof_path) <> 1
     or p_payment_proof_path like '%..%' then
    raise exception 'INVALID_PROOF_PATH';
  end if;

  select * into v_profile from public.profiles where id = v_uid;
  v_name  := coalesce(nullif(trim(p_contact_name), ''),  nullif(trim(v_profile.full_name), ''));
  v_phone := coalesce(nullif(trim(p_contact_phone), ''), nullif(trim(v_profile.phone), ''));
  if v_name is null or v_phone is null then
    raise exception 'CONTACT_REQUIRED';
  end if;

  -- Serialize this user's concurrent reserve calls so the cap check
  -- cannot be raced by two simultaneous requests.
  perform pg_advisory_xact_lock(hashtext(v_uid::text));

  select count(*) into v_active
  from public.reservations
  where user_id = v_uid
    and status in ('pending_verification', 'payment_confirmed', 'ready_for_pickup');
  if v_active >= c_max_active then
    raise exception 'ACTIVE_RESERVATION_LIMIT';
  end if;

  -- Row lock: concurrent reservations for the same listing queue here.
  select * into v_stock
  from public.pharmacy_stock
  where pharmacy_id = p_pharmacy_id and medicine_id = p_medicine_id
  for update;
  if not found then
    raise exception 'LISTING_NOT_FOUND';
  end if;
  if v_stock.quantity < p_quantity then
    raise exception 'INSUFFICIENT_STOCK';
  end if;

  perform set_config('app.stock_hold', '1', true);
  update public.pharmacy_stock
  set quantity = quantity - p_quantity
  where id = v_stock.id;
  perform set_config('app.stock_hold', '', true);

  insert into public.reservations (
    user_id, pharmacy_id, medicine_id, quantity,
    contact_name, contact_phone, notes, payment_proof_url
  ) values (
    v_uid, p_pharmacy_id, p_medicine_id, p_quantity,
    v_name, v_phone, nullif(trim(p_notes), ''), p_payment_proof_path
  )
  returning * into v_row;

  return v_row;
end;
$$;

revoke all on function public.reserve_stock(uuid, uuid, integer, text, text, text, text) from public, anon;
grant execute on function public.reserve_stock(uuid, uuid, integer, text, text, text, text) to authenticated;

-- Direct inserts bypass the stock hold and the cap. Remove the path.
drop policy if exists "reservations_insert_own" on public.reservations;

-- ---------------------------------------------------------------------
-- 5. RPC: cancel_reservation (customer) and expiry (admin / scheduler)
-- ---------------------------------------------------------------------

create or replace function public.cancel_reservation(p_reservation_id uuid)
returns public.reservations
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_row public.reservations;
begin
  if v_uid is null then
    raise exception 'NOT_AUTHENTICATED';
  end if;

  select * into v_row from public.reservations
  where id = p_reservation_id and user_id = v_uid
  for update;
  if not found then
    raise exception 'RESERVATION_NOT_FOUND';
  end if;

  -- Once payment is confirmed the pharmacy owns the order; only
  -- unverified reservations are customer-cancellable.
  if v_row.status <> 'pending_verification' then
    raise exception 'CANNOT_CANCEL';
  end if;

  update public.reservations set status = 'cancelled'
  where id = p_reservation_id
  returning * into v_row;

  return v_row;
end;
$$;

revoke all on function public.cancel_reservation(uuid) from public, anon;
grant execute on function public.cancel_reservation(uuid) to authenticated;

-- Cancels unverified reservations older than p_older_than_minutes.
-- Callable by: admins (button in admin panel) and the database owner
-- (pg_cron, where auth.uid() is null). Not callable by anon.
-- The per-row status update fires the release trigger, so units return
-- to stock exactly once.
create or replace function public.expire_stale_reservations(p_older_than_minutes integer default 1440)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  if auth.uid() is not null and not public.is_admin() then
    raise exception 'NOT_AUTHORIZED';
  end if;
  if p_older_than_minutes is null or p_older_than_minutes < 1 then
    raise exception 'INVALID_WINDOW';
  end if;

  with expired as (
    update public.reservations
    set status = 'cancelled'
    where status = 'pending_verification'
      and created_at < now() - make_interval(mins => p_older_than_minutes)
    returning 1
  )
  select count(*) into v_count from expired;

  return v_count;
end;
$$;

revoke all on function public.expire_stale_reservations(integer) from public, anon;
grant execute on function public.expire_stale_reservations(integer) to authenticated;

-- Optional scheduler (Supabase: Database -> Extensions -> enable pg_cron):
--   select cron.schedule('expire-stale-reservations', '*/15 * * * *',
--     $$select public.expire_stale_reservations(1440)$$);

-- ---------------------------------------------------------------------
-- 6. Data Privacy Act: consent enforced server-side
--    The sign-up form checkbox is UX. This is the control: sign-up
--    fails unless the client asserts consent in user metadata, and the
--    server records when it happened.
-- ---------------------------------------------------------------------

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(new.raw_user_meta_data ->> 'privacy_consent', '') <> 'true' then
    raise exception 'CONSENT_REQUIRED';
  end if;

  insert into public.profiles (id, full_name, phone, privacy_consent_at)
  values (
    new.id,
    new.raw_user_meta_data ->> 'full_name',
    new.raw_user_meta_data ->> 'phone',
    now()
  );
  return new;
end;
$$;

-- ---------------------------------------------------------------------
-- 7. Storage: proof upload limits enforced by the bucket, not the client
-- ---------------------------------------------------------------------

update storage.buckets
set file_size_limit = 5242880,
    allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp']
where id = 'payment-proofs';

-- Lets the client remove a proof it uploaded when the reservation call
-- then fails (cap reached, stock gone). Proofs already attached to a
-- reservation cannot be deleted by the customer.
drop policy if exists "payment_proof_delete_unreferenced_own" on storage.objects;
create policy "payment_proof_delete_unreferenced_own" on storage.objects
  for delete using (
    bucket_id = 'payment-proofs'
    and (storage.foldername(name))[1] = auth.uid()::text
    and not exists (
      select 1 from public.reservations r where r.payment_proof_url = name
    )
  );

-- ---------------------------------------------------------------------
-- 8. Demo seed (optional): quantities that exercise all three states
-- ---------------------------------------------------------------------
-- update public.pharmacy_stock set quantity = 2 where quantity = 3;
