-- Stockroom Operator: an AI assistant (supabase/functions/operator, Claude) that answers questions about the
-- company's data and prepares changes (invoices, payments, customers, stock) for the person to confirm.
-- The app does the reading and writing itself, as the signed-in person, so the Operator can never see or
-- change more than they can. The function only passes the conversation to Claude.
-- Off for every company until support turns it on; each company has a monthly limit on Claude requests.
-- Safe to run more than once.

create table if not exists public.operator_settings (
  company_id uuid primary key references public.companies(id) on delete cascade,
  enabled boolean not null default false,
  monthly_limit int not null default 3000 check (monthly_limit between 0 and 100000),
  updated_at timestamptz not null default now()
);
alter table public.operator_settings enable row level security;   -- read through operator_status(), changed through support_set_operator()
revoke all on public.operator_settings from anon, authenticated;

create table if not exists public.operator_log (
  id bigserial primary key,
  company_id uuid not null references public.companies(id) on delete cascade,
  user_id uuid references auth.users(id) on delete set null,
  started_at timestamptz not null default now(),
  status text not null default 'started' check (status in ('started','done','failed')),
  input_tokens int,
  output_tokens int
);
create index if not exists operator_log_company_idx on public.operator_log(company_id, started_at desc);
alter table public.operator_log enable row level security;
drop policy if exists operator_log_read on public.operator_log;
create policy operator_log_read on public.operator_log for select to authenticated
  using (public.my_role(company_id) in ('owner','admin'));
revoke all on public.operator_log from anon, authenticated;
grant select on public.operator_log to authenticated;
grant all on public.operator_settings, public.operator_log to service_role;

-- Requests that count toward the month: started or finished, not failed ones.
create or replace function public.operator_this_month(cid uuid) returns int
language sql stable security definer set search_path = '' as $$
  select count(*)::int from public.operator_log
  where company_id = cid and status <> 'failed' and started_at >= date_trunc('month', now())
$$;

create or replace function public.operator_status(cid uuid)
returns table(enabled boolean, monthly_limit int, used int)
language plpgsql stable security definer set search_path = '' as $$
begin
  if public.my_role(cid) is null then raise exception 'Not a member of this company' using errcode = '42501'; end if;
  return query
    select coalesce(s.enabled, false), coalesce(s.monthly_limit, 3000), public.operator_this_month(cid)
    from (select 1) one left join public.operator_settings s on s.company_id = cid;
end $$;

-- Called by the server function before each Claude request. Any member may use the Operator.
create or replace function public.operator_begin(cid uuid) returns bigint
language plpgsql security definer set search_path = '' as $$
declare s public.operator_settings; n bigint;
begin
  if public.my_role(cid) is null then raise exception 'Not a member of this company' using errcode = '42501'; end if;
  select * into s from public.operator_settings where company_id = cid for update;
  if not found or not s.enabled then
    raise exception 'The Operator is not turned on for this company' using errcode = 'P0001';
  end if;
  if public.operator_this_month(cid) >= s.monthly_limit then
    raise exception 'This company has used all % Operator requests for this month', s.monthly_limit using errcode = 'P0001';
  end if;
  insert into public.operator_log(company_id, user_id) values (cid, auth.uid()) returning id into n;
  return n;
end $$;

-- Called by the server function afterwards. A failed request does not count toward the limit.
create or replace function public.operator_finish(req_id bigint, ok boolean, in_tokens int, out_tokens int) returns void
language plpgsql security definer set search_path = '' as $$
begin
  update public.operator_log
     set status = case when ok then 'done' else 'failed' end, input_tokens = in_tokens, output_tokens = out_tokens
   where id = req_id and user_id = auth.uid() and status = 'started';
end $$;

-- Support turns the Operator on or off for a company and sets its monthly limit.
create or replace function public.support_set_operator(cid uuid, on_off boolean, req_limit int) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_platform_admin() then raise exception 'Support access only' using errcode = '42501'; end if;
  insert into public.operator_settings(company_id, enabled, monthly_limit, updated_at)
  values (cid, on_off, req_limit, now())
  on conflict (company_id) do update set enabled = excluded.enabled, monthly_limit = excluded.monthly_limit, updated_at = now();
end $$;

revoke execute on function public.operator_this_month(uuid), public.operator_status(uuid), public.operator_begin(uuid),
  public.operator_finish(bigint, boolean, int, int), public.support_set_operator(uuid, boolean, int) from public, anon;
grant execute on function public.operator_status(uuid), public.operator_begin(uuid),
  public.operator_finish(bigint, boolean, int, int), public.support_set_operator(uuid, boolean, int) to authenticated;
