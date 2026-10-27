-- Only one TikTok sync runs at a time per shop. The page's sync, Sync now and the hourly job could write the
-- same order lines together and fail with "lock timeout". Safe to run more than once.

-- When a sync started, so only one runs at a time (see the tiktok function's sync()).
alter table public.tiktok_links add column if not exists sync_started_at timestamptz;
-- Takes the shop for a sync unless another started less than 3 minutes ago (longer than one sync runs);
-- false means one is already running.
create or replace function public.tiktok_sync_begin(cid uuid) returns boolean
language sql set search_path = '' as $$
  with took as (
    update public.tiktok_links set sync_started_at = now()
    where company_id = cid and (sync_started_at is null or sync_started_at < now() - interval '3 minutes')
    returning 1)
  select exists (select 1 from took)
$$;
create or replace function public.tiktok_sync_end(cid uuid) returns void
language sql set search_path = '' as $$
  update public.tiktok_links set sync_started_at = null where company_id = cid
$$;
revoke execute on function public.tiktok_sync_begin(uuid), public.tiktok_sync_end(uuid) from public, anon, authenticated;
grant execute on function public.tiktok_sync_begin(uuid), public.tiktok_sync_end(uuid) to service_role;
