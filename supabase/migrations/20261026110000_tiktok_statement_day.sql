-- TikTok dates its payouts the way Seller Center's Finance reports do: a payout from orders on its statement's
-- day, and a payout with no sales (early settlement, and its recovery) one day before. Checked against
-- Seller Center for Sep 27 - Oct 26: 78 payouts, $299,897.38. Order lines and payouts now use that date.
-- Safe to run more than once.

-- The day TikTok shows a statement on.
create or replace function public.tiktok_statement_day(t timestamptz, d jsonb) returns timestamptz
language sql immutable set search_path = '' as $$
  select case when t is not null and coalesce(case when d ->> 'revenue_amount' ~ '^\s*-?[0-9]+(\.[0-9]+)?\s*$'
                                                 then trim(d ->> 'revenue_amount')::numeric end, 0) = 0
              then t - interval '1 day' else t end
$$;
grant execute on function public.tiktok_statement_day(timestamptz, jsonb) to authenticated, service_role;

create or replace function public.tiktok_fill_amounts() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.at := coalesce((select public.tiktok_statement_day(s.statement_time, s.data) from public.tiktok_statements s
                      where s.company_id = new.company_id and s.id = new.statement_id), new.at);
  new.amounts := public.tiktok_flat(new.data);
  if tg_op = 'UPDATE' then
    if old.stamped and new.at is not distinct from old.at and new.amounts is not distinct from old.amounts then
      new.rolled_up := old.rolled_up; new.stamped := true; return new;
    end if;
    if old.rolled_up and old.stamped then perform public.tiktok_roll(old.company_id, old.at, coalesce(old.amounts, public.tiktok_flat(old.data)), -1); end if;
  end if;
  new.stamped := true; new.rolled_up := false;
  return new;
end $$;

-- Lines of payouts with no sales move to the day before; they are taken out of the totals here and added
-- back on their new day by tiktok_prepare, which the report page calls.
update public.tiktok_transactions t set stamped = true
from public.tiktok_statements s
where s.company_id = t.company_id and s.id = t.statement_id
  and t.at is distinct from public.tiktok_statement_day(s.statement_time, s.data);

create or replace function public.tiktok_payouts(cid uuid, t_from timestamptz, t_to timestamptz)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare r jsonb;
begin
  perform public.tiktok_require_admin(cid);
  with st as (
    select * from (select s.id, public.tiktok_statement_day(s.statement_time, s.data) as statement_time, s.data, s.transactions_synced_at
      from public.tiktok_statements s where s.company_id = cid) d
    where (t_from is null or d.statement_time >= t_from) and (t_to is null or d.statement_time < t_to)
  ), amts as (
    select st.id, e.key, trim(coalesce(e.value ->> 'amount', e.value #>> '{}'))::numeric as v
    from st, jsonb_each(st.data) e
    where e.key like '%\_amount' and coalesce(e.value ->> 'amount', e.value #>> '{}') ~ '^\s*-?[0-9]+(\.[0-9]+)?\s*$'
  ), recent as (
    select * from st order by statement_time desc limit 500
  ), ln as (
    select t.statement_id, count(*) as n, sum(coalesce((t.amounts ->> '|settlement_amount')::numeric, 0)) as paid,
      sum(coalesce((t.amounts ->> '|reserve_amount')::numeric, 0)) as reserve
    from public.tiktok_transactions t where t.company_id = cid and t.statement_id in (select id from recent) group by 1
  )
  select jsonb_build_object(
    'count', (select count(*) from st),
    'totals', coalesce((select jsonb_object_agg(key, total) from (select key, sum(v) as total from amts group by key) x), '{}'::jsonb),
    'list', coalesce((select jsonb_agg(jsonb_build_object(
        'id', p.id, 'statement_time', p.statement_time, 'payment_status', p.data ->> 'payment_status',
        'amounts', coalesce((select jsonb_object_agg(a.key, a.v) from amts a where a.id = p.id), '{}'::jsonb),
        'lines', coalesce(ln.n, 0), 'lines_paid', coalesce(ln.paid, 0), 'lines_reserve', coalesce(ln.reserve, 0), 'pulled', p.transactions_synced_at is not null)
      order by p.statement_time desc) from recent p left join ln on ln.statement_id = p.id), '[]'::jsonb)
  ) into r;
  return r;
end $$;

revoke execute on function public.tiktok_payouts(uuid, timestamptz, timestamptz) from public, anon;
grant execute on function public.tiktok_payouts(uuid, timestamptz, timestamptz) to authenticated;
