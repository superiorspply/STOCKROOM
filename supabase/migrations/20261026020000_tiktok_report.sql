-- TikTok Shop report totals worked out in the database, so a busy shop's report loads quickly
-- instead of downloading every order line to the browser. Safe to run more than once.

-- Every "*_amount" field in a TikTok record, flattened to {"<path>|<key>": number}. Path is where the field sits
-- (e.g. "fee_tax_breakdown.fee"), empty for top-level totals. TikTok sends "12.34", 12.34 or {"amount": "12.34"}.
create or replace function public.tiktok_flat(d jsonb, prefix text default '') returns jsonb
language plpgsql immutable set search_path = '' as $$
declare r record; out jsonb := '{}'::jsonb; n text;
begin
  for r in select key, value from jsonb_each(d) loop
    if r.key like '%\_amount' then
      n := case when jsonb_typeof(r.value) in ('string', 'number') then r.value #>> '{}'
                when jsonb_typeof(r.value) = 'object' then r.value ->> 'amount' end;
      if n ~ '^\s*-?[0-9]+(\.[0-9]+)?\s*$' then out := out || jsonb_build_object(prefix || '|' || r.key, trim(n)::numeric); end if;
    elsif jsonb_typeof(r.value) = 'object' then
      out := out || public.tiktok_flat(r.value, case when prefix = '' then r.key else prefix || '.' || r.key end);
    end if;
  end loop;
  return out;
end $$;

-- Each order line keeps its flattened amounts in "amounts", filled when it is written. Lines pulled before this
-- migration are filled in batches by tiktok_prepare(), which the report page calls, so this runs quickly.
-- (An earlier draft made "amounts" a generated column; adding that rewrote the whole table and could time out.)
do $$ begin
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'tiktok_transactions'
             and column_name = 'amounts' and is_generated = 'ALWAYS') then
    alter table public.tiktok_transactions drop column amounts;
  end if;
end $$;
alter table public.tiktok_transactions add column if not exists amounts jsonb;
create index if not exists tiktok_transactions_order on public.tiktok_transactions(company_id, order_id);
create index if not exists tiktok_transactions_unflat on public.tiktok_transactions(company_id) where amounts is null;

create or replace function public.tiktok_fill_amounts() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.amounts := public.tiktok_flat(new.data);
  return new;
end $$;
drop trigger if exists tiktok_fill_amounts on public.tiktok_transactions;
create trigger tiktok_fill_amounts before insert or update of data on public.tiktok_transactions
  for each row execute function public.tiktok_fill_amounts();

-- Fills "amounts" for up to 2000 older lines of a company; returns how many are still left. Owners and admins only.
create or replace function public.tiktok_prepare(cid uuid) returns int
language plpgsql security definer set search_path = '' as $$
declare left_over int;
begin
  perform public.tiktok_require_admin(cid);
  update public.tiktok_transactions t set amounts = public.tiktok_flat(t.data)
  where t.company_id = cid and t.id in (select id from public.tiktok_transactions where company_id = cid and amounts is null limit 2000);
  select count(*) into left_over from public.tiktok_transactions where company_id = cid and amounts is null;
  return left_over;
end $$;

-- Everything the TikTok Shop report shows for [t_from, t_to), as one JSON value:
--   lines:  each amount field summed across the order lines, with where it sits (path; '' for top-level totals)
--   days:   paid to you per day in the viewer's time zone
--   orders: the newest 150 orders with sales and payout, plus how many orders in all
-- Runs as the caller, so row security limits it to owners and admins of the company.
create or replace function public.tiktok_report(cid uuid, t_from timestamptz, t_to timestamptz, tz text default 'UTC')
returns jsonb
language sql stable set search_path = '' as $$
  with tx as (
    select t.id, coalesce(nullif(t.order_id, ''), t.id) as order_key, t.at, a.amounts,
      (a.amounts ->> '|revenue_amount')::numeric as revenue, (a.amounts ->> '|settlement_amount')::numeric as paid
    from public.tiktok_transactions t, lateral (select coalesce(t.amounts, public.tiktok_flat(t.data)) as amounts) a
    where t.company_id = cid and (t_from is null or t.at >= t_from) and (t_to is null or t.at < t_to)
  ),
  lines as (
    select split_part(e.key, '|', 1) as path, split_part(e.key, '|', 2) as key,
      sum(e.value::numeric) as total, count(*) filter (where e.value::numeric <> 0) as n
    from tx, jsonb_each(tx.amounts) e group by e.key
  ),
  days as (
    select (at at time zone coalesce(nullif(tz, ''), 'UTC'))::date as day, sum(coalesce(paid, 0)) as paid, count(*) as n
    from tx group by 1
  ),
  orders as (
    select order_key, min(at) as at, sum(coalesce(revenue, 0)) as revenue, sum(coalesce(paid, 0)) as paid
    from tx group by order_key
  )
  select jsonb_build_object(
    'lines', coalesce((select jsonb_agg(jsonb_build_object('path', path, 'key', key, 'total', total, 'n', n)) from lines), '[]'::jsonb),
    'days', coalesce((select jsonb_agg(jsonb_build_object('day', day, 'paid', paid, 'n', n) order by day) from days), '[]'::jsonb),
    'order_count', (select count(*) from orders),
    'orders', coalesce((select jsonb_agg(jsonb_build_object('id', order_key, 'at', at, 'revenue', revenue, 'paid', paid) order by at desc)
                        from (select * from orders order by at desc limit 150) o), '[]'::jsonb)
  )
$$;

revoke execute on function public.tiktok_report(uuid, timestamptz, timestamptz, text), public.tiktok_prepare(uuid) from public, anon;
grant execute on function public.tiktok_report(uuid, timestamptz, timestamptz, text), public.tiktok_prepare(uuid) to authenticated;
grant execute on function public.tiktok_flat(jsonb, text) to authenticated, service_role;
