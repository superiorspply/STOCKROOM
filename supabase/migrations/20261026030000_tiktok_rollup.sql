-- TikTok Shop report from running hourly totals, so it stays fast however many orders a shop has.
-- Each order line is added into tiktok_hourly once (by tiktok_prepare, which the report page calls first);
-- the report then sums at most a few thousand hourly rows. Safe to run more than once, and quick.

create table if not exists public.tiktok_hourly (
  company_id uuid not null references public.companies(id) on delete cascade,
  hour timestamptz not null,
  k text not null,                 -- "<path>|<field>" as in tiktok_flat, or '#' for the number of order lines
  total numeric not null default 0,
  n int not null default 0,        -- lines with a non-zero amount (for '#': lines)
  primary key (company_id, hour, k)
);
alter table public.tiktok_hourly enable row level security;
drop policy if exists tiktok_hourly_read on public.tiktok_hourly;
create policy tiktok_hourly_read on public.tiktok_hourly for select to authenticated
  using (public.my_role(company_id) in ('owner','admin'));
revoke all on public.tiktok_hourly from anon, authenticated;
grant select on public.tiktok_hourly to authenticated;
grant all on public.tiktok_hourly to service_role;

-- Whether a line has been added into the hourly totals. Adding a column with a constant default is instant.
alter table public.tiktok_transactions add column if not exists rolled_up boolean not null default false;
create index if not exists tiktok_transactions_todo on public.tiktok_transactions(company_id) where not rolled_up;
drop index if exists public.tiktok_transactions_unflat;

-- Adds (sign 1) or takes away (sign -1) one line's amounts in the hourly totals.
create or replace function public.tiktok_roll(cid uuid, t timestamptz, a jsonb, sign int) returns void
language sql set search_path = '' as $$
  insert into public.tiktok_hourly(company_id, hour, k, total, n)
  select cid, date_trunc('hour', t), e.key, sign * e.value::numeric, sign * (e.value::numeric <> 0)::int from jsonb_each(a) e
  union all select cid, date_trunc('hour', t), '#', 0, sign
  on conflict (company_id, hour, k) do update set total = public.tiktok_hourly.total + excluded.total, n = public.tiktok_hourly.n + excluded.n
$$;

-- When TikTok sends a line again: unchanged lines keep their totals; changed ones are taken out and added back
-- by the next tiktok_prepare. Deleted lines are taken out.
create or replace function public.tiktok_fill_amounts() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'UPDATE' then
    if new.data is not distinct from old.data and new.at is not distinct from old.at then
      new.amounts := old.amounts; new.rolled_up := old.rolled_up; return new;
    end if;
    if old.rolled_up then perform public.tiktok_roll(old.company_id, old.at, coalesce(old.amounts, public.tiktok_flat(old.data)), -1); end if;
  end if;
  new.amounts := public.tiktok_flat(new.data); new.rolled_up := false;
  return new;
end $$;
drop trigger if exists tiktok_fill_amounts on public.tiktok_transactions;
create trigger tiktok_fill_amounts before insert or update of data, at on public.tiktok_transactions
  for each row execute function public.tiktok_fill_amounts();

create or replace function public.tiktok_unroll_deleted() returns trigger
language plpgsql set search_path = '' as $$
begin
  if old.rolled_up then perform public.tiktok_roll(old.company_id, old.at, coalesce(old.amounts, public.tiktok_flat(old.data)), -1); end if;
  return old;
end $$;
drop trigger if exists tiktok_unroll_deleted on public.tiktok_transactions;
create trigger tiktok_unroll_deleted after delete on public.tiktok_transactions
  for each row execute function public.tiktok_unroll_deleted();

-- Adds up to 5000 new or changed lines of a company into the hourly totals; returns how many are still left.
-- Owners and admins only.
create or replace function public.tiktok_prepare(cid uuid) returns int
language plpgsql security definer set search_path = '' as $$
declare left_over int;
begin
  perform public.tiktok_require_admin(cid);
  with batch as (
    select t.id, t.at, coalesce(t.amounts, public.tiktok_flat(t.data)) as a
    from public.tiktok_transactions t where t.company_id = cid and not t.rolled_up
    limit 5000 for update skip locked
  ), done as (
    update public.tiktok_transactions t set amounts = b.a, rolled_up = true
    from batch b where t.company_id = cid and t.id = b.id
    returning b.at, b.a
  ), sums as (
    select date_trunc('hour', at) as hour, e.key as k, sum(e.value::numeric) as total, count(*) filter (where e.value::numeric <> 0) as n
    from done, jsonb_each(done.a) e group by 1, 2
    union all
    select date_trunc('hour', at), '#', 0, count(*) from done group by 1
  )
  insert into public.tiktok_hourly(company_id, hour, k, total, n)
  select cid, hour, k, total, n from sums
  on conflict (company_id, hour, k) do update set total = public.tiktok_hourly.total + excluded.total, n = public.tiktok_hourly.n + excluded.n;
  select count(*) into left_over from public.tiktok_transactions where company_id = cid and not rolled_up;
  return left_over;
end $$;

-- The report for [t_from, t_to): summed lines, paid per day in the viewer's time zone, how many order lines,
-- and the newest 150 orders. Hours are whole, so day edges are exact in time zones with whole-hour offsets.
-- Runs as the caller, so row security limits it to owners and admins.
create or replace function public.tiktok_report(cid uuid, t_from timestamptz, t_to timestamptz, tz text default 'UTC')
returns jsonb
language sql stable set search_path = '' as $$
  with h as (
    select hour, k, total, n from public.tiktok_hourly
    where company_id = cid and (t_from is null or hour >= t_from) and (t_to is null or hour < t_to)
  ),
  lines as (
    select split_part(k, '|', 1) as path, split_part(k, '|', 2) as key, sum(total) as total, sum(n) as n
    from h where k <> '#' group by k having sum(n) <> 0 or sum(total) <> 0
  ),
  days as (
    select (hour at time zone coalesce(nullif(tz, ''), 'UTC'))::date as day,
      coalesce(sum(total) filter (where k = '|settlement_amount'), 0) as paid, coalesce(sum(n) filter (where k = '#'), 0) as n
    from h group by 1
  ),
  recent as (
    select coalesce(nullif(t.order_id, ''), t.id) as order_key, t.at, coalesce(t.amounts, public.tiktok_flat(t.data)) as a
    from public.tiktok_transactions t
    where t.company_id = cid and (t_from is null or t.at >= t_from) and (t_to is null or t.at < t_to)
    order by t.at desc limit 400
  ),
  orders as (
    select order_key, min(at) as at, sum(coalesce((a ->> '|revenue_amount')::numeric, 0)) as revenue,
      sum(coalesce((a ->> '|settlement_amount')::numeric, 0)) as paid
    from recent group by order_key order by min(at) desc limit 150
  )
  select jsonb_build_object(
    'lines', coalesce((select jsonb_agg(jsonb_build_object('path', path, 'key', key, 'total', total, 'n', n)) from lines), '[]'::jsonb),
    'days', coalesce((select jsonb_agg(jsonb_build_object('day', day, 'paid', paid, 'n', n) order by day) from days), '[]'::jsonb),
    'order_count', (select coalesce(sum(n), 0) from h where k = '#'),
    'orders', coalesce((select jsonb_agg(jsonb_build_object('id', order_key, 'at', at, 'revenue', revenue, 'paid', paid) order by at desc) from orders), '[]'::jsonb)
  )
$$;

revoke execute on function public.tiktok_roll(uuid, timestamptz, jsonb, int) from public, anon, authenticated;
grant execute on function public.tiktok_roll(uuid, timestamptz, jsonb, int) to service_role;
revoke execute on function public.tiktok_prepare(uuid), public.tiktok_report(uuid, timestamptz, timestamptz, text) from public, anon;
grant execute on function public.tiktok_prepare(uuid), public.tiktok_report(uuid, timestamptz, timestamptz, text) to authenticated;
