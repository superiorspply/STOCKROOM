-- TikTok payouts for the report page, with TikTok's own statement totals so the headline numbers match
-- Seller Center to the cent, and each payout checked against its order lines. Safe to run more than once.
--   count:  payouts in [t_from, t_to)
--   totals: every "*_amount" field of those payouts, summed (settlement, net sales, fees, shipping, ...)
--   list:   the newest 500, each with its amounts, how many order lines Stockroom has for it, what those lines
--           add up to, and whether its lines have been pulled from TikTok yet.

create index if not exists tiktok_transactions_statement on public.tiktok_transactions(company_id, statement_id);

create or replace function public.tiktok_payouts(cid uuid, t_from timestamptz, t_to timestamptz)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare r jsonb;
begin
  perform public.tiktok_require_admin(cid);
  with st as (
    select s.id, s.statement_time, s.data, s.transactions_synced_at from public.tiktok_statements s
    where s.company_id = cid and (t_from is null or s.statement_time >= t_from) and (t_to is null or s.statement_time < t_to)
  ), amts as (
    select st.id, e.key, trim(coalesce(e.value ->> 'amount', e.value #>> '{}'))::numeric as v
    from st, jsonb_each(st.data) e
    where e.key like '%\_amount' and coalesce(e.value ->> 'amount', e.value #>> '{}') ~ '^\s*-?[0-9]+(\.[0-9]+)?\s*$'
  ), recent as (
    select * from st order by statement_time desc limit 500
  ), ln as (
    select t.statement_id, count(*) as n, sum(coalesce((t.amounts ->> '|settlement_amount')::numeric, 0)) as paid
    from public.tiktok_transactions t where t.company_id = cid and t.statement_id in (select id from recent) group by 1
  )
  select jsonb_build_object(
    'count', (select count(*) from st),
    'totals', coalesce((select jsonb_object_agg(key, total) from (select key, sum(v) as total from amts group by key) x), '{}'::jsonb),
    'list', coalesce((select jsonb_agg(jsonb_build_object(
        'id', p.id, 'statement_time', p.statement_time, 'payment_status', p.data ->> 'payment_status',
        'amounts', coalesce((select jsonb_object_agg(a.key, a.v) from amts a where a.id = p.id), '{}'::jsonb),
        'lines', coalesce(ln.n, 0), 'lines_paid', coalesce(ln.paid, 0), 'pulled', p.transactions_synced_at is not null)
      order by p.statement_time desc) from recent p left join ln on ln.statement_id = p.id), '[]'::jsonb)
  ) into r;
  return r;
end $$;

revoke execute on function public.tiktok_payouts(uuid, timestamptz, timestamptz) from public, anon;
grant execute on function public.tiktok_payouts(uuid, timestamptz, timestamptz) to authenticated;
