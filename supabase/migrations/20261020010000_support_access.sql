-- Support access: people listed in platform_admins can open any company with admin powers, to help fix things.
-- Nobody can add themselves: rows are added only from the Supabase SQL editor (see SETUP.md).
-- Safe to run more than once.

create table if not exists public.platform_admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table public.platform_admins enable row level security;   -- no policies: not readable or writable from the app

-- Every time support opens a company. The company's owners and admins can see these entries.
create table if not exists public.support_log (
  id bigserial primary key,
  company_id uuid not null references public.companies(id) on delete cascade,
  admin_id uuid references auth.users(id) on delete set null,
  admin_email text,
  opened_at timestamptz not null default now()
);
create index if not exists support_log_company_idx on public.support_log(company_id, opened_at desc);
alter table public.support_log enable row level security;

create or replace function public.is_platform_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.platform_admins p where p.user_id = auth.uid())
$$;

-- Members keep their own role. Support, when not a member, acts as an admin: it can fix data, settings and the
-- team, but cannot delete the company, change the owner or manage other admins.
create or replace function public.my_role(cid uuid) returns text
language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select m.role from public.members m where m.company_id = cid and m.user_id = auth.uid()),
    (select 'admin' from public.companies c
       where c.id = cid and exists (select 1 from public.platform_admins p where p.user_id = auth.uid())))
$$;

drop policy if exists support_log_read on public.support_log;
create policy support_log_read on public.support_log for select to authenticated
  using (public.my_role(company_id) in ('owner','admin'));
grant select on public.support_log to authenticated;

-- Every company, for the support picker.
create or replace function public.support_companies()
returns table(id uuid, name text, logo text, created_at timestamptz, owner_email text, members bigint)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_platform_admin() then raise exception 'Support access only' using errcode = '42501'; end if;
  return query
    select c.id, c.name, c.logo, c.created_at,
      (select m.email from public.members m where m.company_id = c.id and m.role = 'owner' limit 1),
      (select count(*) from public.members m where m.company_id = c.id)
    from public.companies c order by c.name;
end $$;

-- Record that support opened a company, and return the company.
create or replace function public.support_open(cid uuid) returns setof public.companies
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_platform_admin() then raise exception 'Support access only' using errcode = '42501'; end if;
  insert into public.support_log(company_id, admin_id, admin_email) values (cid, auth.uid(), auth.jwt()->>'email');
  return query select * from public.companies where id = cid;
end $$;

revoke execute on function public.is_platform_admin(), public.support_companies(), public.support_open(uuid) from public, anon;
grant execute on function public.is_platform_admin(), public.support_companies(), public.support_open(uuid) to authenticated;
