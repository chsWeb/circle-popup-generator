-- ---------------------------------------------------------------------------
-- Circle Popup Generator — database schema
--
-- Run this once in the Supabase SQL editor (Dashboard -> SQL Editor -> New
-- query -> paste -> Run). It is idempotent, so re-running is safe.
-- ---------------------------------------------------------------------------

create table if not exists public.purchases (
  id                          uuid primary key default gen_random_uuid(),
  user_id                     uuid not null references auth.users (id) on delete cascade,
  email                       text,
  status                      text not null default 'paid',
  amount_total                integer,
  currency                    text,
  stripe_customer_id          text,
  stripe_session_id           text unique,
  stripe_payment_intent_id    text,
  created_at                  timestamptz not null default now()
);

-- One live purchase per account. The generator is unlimited-use once unlocked,
-- so a second payment would buy nothing — this stops accidental double charges
-- from creating a confusing second row.
create unique index if not exists purchases_user_paid_idx
  on public.purchases (user_id)
  where status = 'paid';

create index if not exists purchases_user_id_idx on public.purchases (user_id);

alter table public.purchases enable row level security;

-- Signed-in users may read their own purchase row and nothing else. This is
-- what lets the browser ask "am I unlocked?" directly, with no API call.
drop policy if exists "read own purchases" on public.purchases;
create policy "read own purchases"
  on public.purchases
  for select
  using (auth.uid() = user_id);

-- Deliberately no insert/update/delete policies. Only the Stripe webhook
-- writes here, and it uses the service-role key, which bypasses RLS. A user
-- therefore cannot grant themselves access by calling the Supabase API.

-- ---------------------------------------------------------------------------
-- Explicit table privileges.
--
-- These matter when "Automatically expose new tables" is OFF on the project
-- (which is what Supabase recommends). With that setting off, a new table is
-- invisible to the Data API until it is granted, so without these lines the
-- browser could not check its own purchase status and the generator would
-- never unlock.
--
-- Stating them explicitly means this schema works the same either way, instead
-- of silently depending on a project-creation checkbox.
-- ---------------------------------------------------------------------------

-- Reaching a table also requires usage on its schema. Normally already granted
-- at project setup; stated here so this script stands on its own.
grant usage on schema public to authenticated, service_role;

-- Signed-in users: read only, and RLS still narrows that to their own row.
grant select on public.purchases to authenticated;

-- The Stripe webhook. Bypasses RLS, but still needs table privileges.
grant all on public.purchases to service_role;

-- `anon` is granted nothing. Signed-out visitors have no business reading
-- purchase records, and the free generator never needs to.
revoke all on public.purchases from anon;

-- ---------------------------------------------------------------------------
-- Image uploads.
--
-- Popup images are served to members inside a Circle community on someone
-- else's domain, so the bucket must be publicly readable. Writing is the part
-- that is locked down: only a paid account, only into a folder named after its
-- own user id.
--
-- The size and MIME limits are enforced by the bucket itself rather than by
-- browser code, so they hold even if someone calls the storage API directly.
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'popup-images',
  'popup-images',
  true,
  2097152, -- 2 MB. Popup images display at most 620px wide.
  array['image/jpeg', 'image/png', 'image/webp', 'image/gif']
)
on conflict (id) do update set
  public             = excluded.public,
  file_size_limit    = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "popup images are publicly readable" on storage.objects;
create policy "popup images are publicly readable"
  on storage.objects
  for select
  using (bucket_id = 'popup-images');

-- The paywall, enforced in the database rather than in the browser: an account
-- with no paid purchase row simply cannot insert.
drop policy if exists "paid accounts upload popup images" on storage.objects;
create policy "paid accounts upload popup images"
  on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'popup-images'
    and (storage.foldername(name))[1] = auth.uid()::text
    and exists (
      select 1 from public.purchases p
      where p.user_id = auth.uid() and p.status = 'paid'
    )
  );

drop policy if exists "accounts delete their own popup images" on storage.objects;
create policy "accounts delete their own popup images"
  on storage.objects
  for delete
  to authenticated
  using (
    bucket_id = 'popup-images'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
