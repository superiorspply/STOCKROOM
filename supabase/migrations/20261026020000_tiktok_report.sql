-- TikTok Shop report totals worked out in the database, so a busy shop's report loads quickly
-- instead of downloading every order line to the browser. Safe to run more than once.
-- Adding the column below works through every order line already pulled, so the first run can take a few seconds.

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

alter table public.tiktok_transactions add column if not exists amounts jsonb generated always as (public.tiktok_flat(data)) stored;
create index if not exists tiktok_transactions_order on public.tiktok_transactions(company_id, order_id);

-- Everything the TikTok Shop report shows for [t_from, t_to), as one JSON value:
--   lines:  each amount field summed across the order lines, with where it sits (path; '' for top-level totals)
--   days:   paid to you per day in the viewer's time zone
--   orders: the newest 150 orders with sales and payout, plus how many orders in all
-- Runs as the caller, so row security limits it to owners and admins of the company.
create or replace function public.tiktok_report(cid uuid, t_from timestamptz, t_to timestamptz, tz text default 'UTC')
returns jsonb
language sql stable set search_path = '' as $$
  with tx as (
    select t.id, coalesce(nullif(t.order_id, ''), t.id) as order_key, t.at, t.amounts,
      (t.amounts ->> '|revenue_amount')::numeric as revenue, (t.amounts ->> '|settlement_amount')::numeric as paid
    from public.tiktok_transactions t
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

revoke execute on function public.tiktok_report(uuid, timestamptz, timestamptz, text) from public, anon;
grant execute on function public.tiktok_report(uuid, timestamptz, timestamptz, text) to authenticated;
