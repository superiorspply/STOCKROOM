-- TikTok Shop finance is switched on per company by support, like invoice scanning.
-- It is off for every company except those already connected to TikTok when this runs.
-- Safe to run more than once.

create table if not exists public.tiktok_settings (
  company_id uuid primary key references public.companies(id) on delete cascade,
  enabled boolean not null default false,
  updated_at timestamptz not null default now()
);
alter table public.tiktok_settings enable row level security;   -- read through tiktok_status(), changed through support_set_tiktok()
revoke all on public.tiktok_settings from anon, authenticated;
grant all on public.tiktok_settings to service_role;

-- Companies that already connected keep it.
insert into public.tiktok_settings(company_id, enabled)
select company_id, true from public.tiktok_links
on conflict (company_id) do nothing;

create or replace function public.tiktok_enabled(cid uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select enabled from public.tiktok_settings where company_id = cid), false)
$$;

-- Status now says whether TikTok Shop is switched on for the company.
drop function if exists public.tiktok_status(uuid);
create function public.tiktok_status(cid uuid)
returns table(enabled boolean, connected boolean, shop_name text, connected_at timestamptz, synced_at timestamptz, sync_error text)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform public.tiktok_require_admin(cid);
  return query
    select public.tiktok_enabled(cid), l.company_id is not null, l.shop_name, l.connected_at, l.synced_at, l.sync_error
    from (select 1) one left join public.tiktok_links l on l.company_id = cid;
end $$;

create or replace function public.tiktok_begin(cid uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare st text := 'tt' || replace(gen_random_uuid()::text, '-', '');
begin
  perform public.tiktok_require_admin(cid);
  if not public.tiktok_enabled(cid) then raise exception 'TikTok Shop is not turned on for this company' using errcode = 'P0001'; end if;
  delete from public.tiktok_states where created_at < now() - interval '1 hour';
  insert into public.tiktok_states(state, company_id, user_id) values (st, cid, auth.uid());
  return st;
end $$;

create or replace function public.tiktok_take_state(st text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare cid uuid;
begin
  delete from public.tiktok_states
   where state = st and user_id = auth.uid() and created_at > now() - interval '30 minutes'
  returning company_id into cid;
  if cid is null then raise exception 'This TikTok connection link has expired. Start again from Stockroom.' using errcode = 'P0001'; end if;
  perform public.tiktok_require_admin(cid);
  if not public.tiktok_enabled(cid) then raise exception 'TikTok Shop is not turned on for this company' using errcode = 'P0001'; end if;
  return cid;
end $$;

-- Support switches TikTok Shop on or off for a company.
create or replace function public.support_set_tiktok(cid uuid, on_off boolean) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_platform_admin() then raise exception 'Support access only' using errcode = '42501'; end if;
  insert into public.tiktok_settings(company_id, enabled, updated_at) values (cid, on_off, now())
  on conflict (company_id) do update set enabled = excluded.enabled, updated_at = now();
end $$;

revoke execute on function public.tiktok_enabled(uuid), public.tiktok_status(uuid), public.tiktok_begin(uuid),
  public.tiktok_take_state(text), public.support_set_tiktok(uuid, boolean) from public, anon;
grant execute on function public.tiktok_enabled(uuid), public.tiktok_status(uuid), public.tiktok_begin(uuid),
  public.tiktok_take_state(text), public.support_set_tiktok(uuid, boolean) to authenticated;
