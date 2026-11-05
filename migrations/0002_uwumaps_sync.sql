-- Saved places sync (main-site/api/sync.js). Run once in the Supabase SQL editor, after 0001. Never
-- edited after: later changes go in a new file.
--
-- There are no accounts. A device makes a sync code and any device given that code shares the same
-- places. Only a hash of the code is kept, so this table alone can't be used to read anybody's.
--
-- Only the site's Vercel Functions read or write it, with the service role (or secret) key. Row
-- level security is on with no policies, so the public anon key gets nothing.

create table if not exists public.uwumaps_sync (
    code_hash  text primary key check (code_hash ~ '^[a-f0-9]{64}$'),
    -- { "<place id>": { ...place, "t": <ms last changed>, "deleted": true? } }
    places     jsonb not null default '{}'::jsonb,
    updated_at timestamptz not null default now(),
    -- Forgotten after a year with no device syncing, pushed on each sync.
    expires_at timestamptz not null default now() + interval '365 days'
);

create index if not exists uwumaps_sync_expires_at_idx on public.uwumaps_sync (expires_at);

alter table public.uwumaps_sync enable row level security;
revoke all on public.uwumaps_sync from anon, authenticated;
grant select, insert, update, delete on public.uwumaps_sync to service_role;
