-- Invoice scanning: a server function (supabase/functions/scan-invoice) reads supplier invoices with Claude.
-- Scanning is off for every company until support turns it on, and each company has a monthly scan limit.
-- Safe to run more than once.

create table if not exists public.scan_settings (
  company_id uuid primary key references public.companies(id) on delete cascade,
  enabled boolean not null default false,
  monthly_limit int not null default 100 check (monthly_limit between 0 and 10000),
  updated_at timestamptz not null default now()
);
alter table public.scan_settings enable row level security;   -- read through scan_status(), changed through support_set_scan()

create table if not exists public.scan_log (
  id bigserial primary key,
  company_id uuid not null references public.companies(id) on delete cascade,
  user_id uuid references auth.users(id) on delete set null,
  started_at timestamptz not null default now(),
  status text not null default 'started' check (status in ('started','done','failed')),
  input_tokens int,
  output_tokens int
);
create index if not exists scan_log_company_idx on public.scan_log(company_id, started_at desc);
alter table public.scan_log enable row level security;
drop policy if exists scan_log_read on public.scan_log;
create policy scan_log_read on public.scan_log for select to authenticated
  using (public.my_role(company_id) in ('owner','admin'));
grant select on public.scan_log to authenticated;

-- Scans that count toward the month: started or finished, not failed ones.
create or replace function public.scans_this_month(cid uuid) returns int
language sql stable security definer set search_path = '' as $$
  select count(*)::int from public.scan_log
  where company_id = cid and status <> 'failed' and started_at >= date_trunc('month', now())
$$;

create or replace function public.scan_status(cid uuid)
returns table(enabled boolean, monthly_limit int, used int)
language plpgsql stable security definer set search_path = '' as $$
begin
  if public.my_role(cid) is null then raise exception 'Not a member of this company' using errcode = '42501'; end if;
  return query
    select coalesce(s.enabled, false), coalesce(s.monthly_limit, 100), public.scans_this_month(cid)
    from (select 1) one left join public.scan_settings s on s.company_id = cid;
end $$;

-- Called by the server function before it reads an invoice. Checks access and the limit, and records the scan.
create or replace function public.scan_begin(cid uuid) returns bigint
language plpgsql security definer set search_path = '' as $$
declare s public.scan_settings; n bigint;
begin
  if public.my_role(cid) is null or public.my_role(cid) not in ('owner','admin') then
    raise exception 'Only owners and admins can scan invoices' using errcode = '42501';
  end if;
  select * into s from public.scan_settings where company_id = cid for update;
  if not found or not s.enabled then
    raise exception 'Invoice scanning is not turned on for this company' using errcode = 'P0001';
  end if;
  if public.scans_this_month(cid) >= s.monthly_limit then
    raise exception 'This company has used all % invoice scans for this month', s.monthly_limit using errcode = 'P0001';
  end if;
  insert into public.scan_log(company_id, user_id) values (cid, auth.uid()) returning id into n;
  return n;
end $$;

-- Called by the server function afterwards. A failed scan does not count toward the limit.
create or replace function public.scan_finish(scan_id bigint, ok boolean, in_tokens int, out_tokens int) returns void
language plpgsql security definer set search_path = '' as $$
begin
  update public.scan_log
     set status = case when ok then 'done' else 'failed' end, input_tokens = in_tokens, output_tokens = out_tokens
   where id = scan_id and user_id = auth.uid() and status = 'started';
end $$;

-- Support turns scanning on or off for a company and sets its monthly limit.
create or replace function public.support_set_scan(cid uuid, on_off boolean, scan_limit int) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_platform_admin() then raise exception 'Support access only' using errcode = '42501'; end if;
  insert into public.scan_settings(company_id, enabled, monthly_limit, updated_at)
  values (cid, on_off, scan_limit, now())
  on conflict (company_id) do update set enabled = excluded.enabled, monthly_limit = excluded.monthly_limit, updated_at = now();
end $$;

revoke execute on function public.scans_this_month(uuid), public.scan_status(uuid), public.scan_begin(uuid),
  public.scan_finish(bigint, boolean, int, int), public.support_set_scan(uuid, boolean, int) from public, anon;
grant execute on function public.scan_status(uuid), public.scan_begin(uuid),
  public.scan_finish(bigint, boolean, int, int), public.support_set_scan(uuid, boolean, int) to authenticated;
