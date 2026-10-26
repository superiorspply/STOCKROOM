-- TikTok payouts list for the report page, checked once like tiktok_report (owner or admin), returning only the
-- fields the page shows. Also records the longer limit on requests from the site (30 seconds instead of 8),
-- which the owner set on the Pro plan. Safe to run more than once.

alter role authenticated set statement_timeout = '30s';

create index if not exists tiktok_statements_time on public.tiktok_statements(company_id, statement_time);

create or replace function public.tiktok_payouts(cid uuid, t_from timestamptz, t_to timestamptz)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform public.tiktok_require_admin(cid);
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', s.id, 'statement_time', s.statement_time,
      'settlement_amount', s.data -> 'settlement_amount', 'payment_status', s.data ->> 'payment_status') order by s.statement_time desc)
    from (select * from public.tiktok_statements
          where company_id = cid and (t_from is null or statement_time >= t_from) and (t_to is null or statement_time < t_to)
          order by statement_time desc limit 500) s
  ), '[]'::jsonb);
end $$;

revoke execute on function public.tiktok_payouts(uuid, timestamptz, timestamptz) from public, anon;
grant execute on function public.tiktok_payouts(uuid, timestamptz, timestamptz) to authenticated;
