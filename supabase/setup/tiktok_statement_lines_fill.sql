-- Fills each TikTok payout's running order-line totals (tiktok_statement_lines) for payouts already added up,
-- 40 payouts per run. Run it after supabase/migrations/20261026140000_tiktok_statement_lines.sql, again and
-- again until statements_left is 0. Close the TikTok page while it runs. Safe to run more than once.
with todo as (
  select s.company_id, s.id from public.tiktok_statements s
  where not exists (select 1 from public.tiktok_statement_lines l where l.company_id = s.company_id and l.statement_id = s.id)
  limit 40
)
insert into public.tiktok_statement_lines as l (company_id, statement_id, n, paid, reserve)
select d.company_id, d.id, count(t.id), coalesce(sum((t.amounts ->> '|settlement_amount')::numeric), 0),
  coalesce(sum((t.amounts ->> '|reserve_amount')::numeric), 0)
from todo d left join public.tiktok_transactions t on t.company_id = d.company_id and t.statement_id = d.id and t.rolled_up and t.stamped
group by d.company_id, d.id
on conflict (company_id, statement_id) do update set n = excluded.n, paid = excluded.paid, reserve = excluded.reserve;

select count(*) as statements_left from public.tiktok_statements s
where not exists (select 1 from public.tiktok_statement_lines l where l.company_id = s.company_id and l.statement_id = s.id);
