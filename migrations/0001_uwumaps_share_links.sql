-- Short share links (main-site/api/_lib/share-links.js) and the request limits that protect the
-- API routes (main-site/api/_lib/rate.js). Run once in the Supabase SQL editor. Never edited after:
-- later changes go in a new file.
--
--   kind 'place'       /go/<id>    One place.
--   kind 'directions'  /trip/<id>  Both ends of a route and how to travel it.
--   kind 'eta'         /eta/<id>   Live progress on a trip, updated as it goes, and then gone.
--   kind 'list'        /list/<id>  A named list of saved places.
--
-- Only the site's Vercel Functions read or write these, with the service role (or secret) key.
-- Row level security is on with no policies, so the public anon key gets nothing.

create table if not exists public.uwumaps_share_links (
    id          text primary key check (id ~ '^[a-z0-9]{10}$'),
    kind        text not null check (kind in ('place', 'directions', 'eta', 'list')),
    data        jsonb not null,
    -- A hash of what's shared, so sharing the same thing again gives the same link. Null for an
    -- ETA link, which is new every time.
    dedupe_key  text unique,
    -- An ETA link: a SHA-256 hash of the secret the sharing device updates it with.
    secret_hash text,
    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now(),
    -- An ETA link: gone after this. Null for the kinds that last.
    expires_at  timestamptz
);

create index if not exists uwumaps_share_links_expires_at_idx
    on public.uwumaps_share_links (expires_at)
    where expires_at is not null;

alter table public.uwumaps_share_links enable row level security;
revoke all on public.uwumaps_share_links from anon, authenticated;
grant select, insert, update, delete on public.uwumaps_share_links to service_role;

create table if not exists public.uwumaps_rate_limits (
    key        text primary key,
    count      integer not null default 0,
    expires_at timestamptz not null
);

alter table public.uwumaps_rate_limits enable row level security;
revoke all on public.uwumaps_rate_limits from anon, authenticated;
grant select, insert, update, delete on public.uwumaps_rate_limits to service_role;

-- Counts one request against a key, in a window of window_seconds, and answers the count so far.
create or replace function public.uwumaps_bump_rate(p_key text, window_seconds integer)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
    result integer;
begin
    insert into public.uwumaps_rate_limits as r (key, count, expires_at)
    values (p_key, 1, now() + make_interval(secs => window_seconds))
    on conflict (key) do update
        set count = case when r.expires_at < now() then 1 else r.count + 1 end,
            expires_at = case when r.expires_at < now() then excluded.expires_at else r.expires_at end
    returning count into result;

    -- An occasional sweep, so the table doesn't grow without end.
    if random() < 0.01 then
        delete from public.uwumaps_rate_limits where expires_at < now();
    end if;

    return result;
end;
$$;

revoke all on function public.uwumaps_bump_rate(text, integer) from public, anon, authenticated;
grant execute on function public.uwumaps_bump_rate(text, integer) to service_role;
