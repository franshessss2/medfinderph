# MedFinder PH

Medicine finder + pharmacy reservation system for Puerto Princesa, Philippines.
Vanilla HTML/CSS/JS. No build step. Supabase (Postgres + Auth + Storage) via CDN script tag.

## Status

Built so far: file structure, database schema, landing page (`index.html`),
login (`login.html`), signup (`signup.html`), search (`search.html`),
reserve (`reserve.html`), dashboard (`dashboard.html`), admin panel
(`admin/dashboard.html`).
Not yet built: nothing — all planned pages are in place.

## File structure

```
medfinder-ph/
├── index.html              landing page
├── search.html              search results — fuzzy match via search_medicines() RPC
├── login.html               email/password login
├── signup.html               name/email/phone/password signup
├── dashboard.html              customer reservation history + notifications
├── reserve.html               cart/GCash reservation form + payment proof upload
├── admin/
│   ├── dashboard.html         reservation queue, payment proof review, pharmacy/medicine/stock CRUD
│   ├── css/admin.css          admin-only layout: tabs, tables, modal (extends css/style.css)
│   └── js/dashboard.js        admin-page-only: requireAdmin() gated, all four admin sections
├── css/
│   └── style.css            design tokens + shared components (buttons, cards, forms, status pill)
├── js/
│   ├── supabase-client.js   Supabase client singleton + auth helpers (getSession, getProfile, requireAuth, requireAdmin)
│   ├── utils.js               shared display helpers (escapeHtml, formatPeso, statusPillHtml) — no Supabase dependency
│   ├── nav.js                mobile nav toggle, shared by every page
│   ├── landing.js            landing-page-only: swaps nav for "My reservations" when signed in
│   ├── reveal.js              site-wide, non-module: header scroll-shrink + scroll-triggered [data-reveal] fades
│   ├── login.js               login-page-only: signInWithPassword + inline errors
│   ├── signup.js              signup-page-only: signUp with full_name/phone in options.data
│   ├── search.js               search-page-only: search_medicines() RPC + per-medicine pharmacy listings
│   ├── reserve.js               reserve-page-only: listing lookup, GCash proof upload, reservation insert
│   └── dashboard.js              dashboard-page-only: reservation history + notification panel
├── assets/                  (empty — icons are inline SVG, no image assets yet)
└── supabase/
    └── schema.sql           tables, RLS policies, triggers, storage bucket, seed data
```

## Setup

1. **Create a Supabase project** at supabase.com. Note the Project URL and anon/public API key
   (Project Settings → API).

2. **Run the schema.** Supabase dashboard → SQL Editor → New query → paste the full contents of
   `supabase/schema.sql` → Run. This creates all six tables, the `is_admin()` helper, the two
   triggers (auto-create profile on signup, auto-create notification on status change), every
   RLS policy, the `payment-proofs` storage bucket and its policies, and inserts 3 sample
   pharmacies + 3 sample medicines so search has something to return immediately.

3. **Wire up the frontend.** Open `js/supabase-client.js` and replace:
   ```js
   const SUPABASE_URL = 'https://YOUR-PROJECT-REF.supabase.co';
   const SUPABASE_ANON_KEY = 'YOUR-ANON-PUBLIC-KEY';
   ```
   with the values from step 1. The anon key is safe to ship client-side — RLS is what actually
   restricts access, not the key.

4. **Create your admin account.** Sign up through `signup.html`, then in the SQL Editor run:
   ```sql
   update public.profiles set role = 'admin' where id = '<your-auth-user-uuid>';
   ```
   Find the UUID in Authentication → Users.

5. **Serve locally over HTTP**, not `file://` — ES module imports (`js/landing.js` uses
   `type="module"`) are blocked under the file protocol. Any static server works, e.g.:
   ```
   npx serve .
   ```
   or Python's `python3 -m http.server`.

6. **Deploy.** Static hosting only — GitHub Pages, Netlify, or Vercel (as a static site, no
   framework preset). Push `SUPABASE_URL`/`SUPABASE_ANON_KEY` as committed values in
   `supabase-client.js` (there's no server to hold secrets in this architecture); everything
   sensitive is enforced by RLS instead.

## Migration 002 (defense scope)

Run `supabase/migration-002-defense.sql` after `schema.sql` (idempotent). It adds
`pharmacy_stock.quantity` (status is derived from it), `medicines.requires_prescription`,
`profiles.privacy_consent_at`, the `reserve_stock` / `cancel_reservation` /
`expire_stale_reservations` RPCs, release-on-cancel, server-side consent and proof-upload limits.
`reservations` can no longer be inserted directly; `reserve_stock` is the only path.
New pages/modules: `privacy.html`, `js/connection.js` (offline banner + network-action guard).

## Schema notes

- `reservations` has one row per medicine per checkout — a "cart" of 3 items becomes 3 rows,
  each independently trackable. Fields beyond the brief's abbreviated list
  (`contact_name`, `contact_phone`, `notes`, `quantity`, `updated_at`) were added to actually
  hold the reservation form's data.
- `profiles` (not in the original table list) extends `auth.users` with `role` — Supabase Auth
  has no built-in role field, so the admin/customer check needs somewhere to live.
- `handle_new_user()` reads both `full_name` and `phone` out of `raw_user_meta_data`, populated
  via `options.data` on `signUp()` in `js/signup.js` — there's no separate "edit profile" step in
  this build, so this trigger is the only path `profiles.phone` ever gets set through.
- Notifications are inserted by a database trigger on `reservations` status changes, not by
  client-side JS — so a status change always produces a notification regardless of which admin
  screen made it, with no risk of the client "forgetting" to insert one.
- `search_medicines(search_term, result_limit)` is a Postgres function, not a table — called via
  `db.rpc('search_medicines', {...})` from `js/search.js`. supabase-js's query builder can't
  express trigram-similarity ordering, so the fuzzy match logic lives here instead. Matches on
  substring OR trigram similarity above pg_trgm's default 0.3 threshold, so "amoxicilin" still
  finds "Amoxicillin".
  three states from the brief).
- `status` values: `pending_verification`, `payment_confirmed`, `ready_for_pickup`, `completed`,
  plus `cancelled` (added — not in the brief's list, but reservations need a way to be closed
  out without "completed").
