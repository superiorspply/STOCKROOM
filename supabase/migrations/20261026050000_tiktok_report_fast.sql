-- The TikTok report checks once that the caller is an owner or admin of the company, then reads the totals
-- directly. Before, it ran as the caller, so row security checked every hourly row (167,000 for a busy shop),
-- which made it about ten times slower and ran past the 8-second limit on requests from the site.
-- Safe to run more than once.

create or replace function public.tiktok_report(cid uuid, t_from timestamptz, t_to timestamptz, tz text default 'UTC')
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform public.tiktok_require_admin(cid);
  return (
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
  );
end $$;

revoke execute on function public.tiktok_report(uuid, timestamptz, timestamptz, text) from public, anon;
grant execute on function public.tiktok_report(uuid, timestamptz, timestamptz, text) to authenticated;
