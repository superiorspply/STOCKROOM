-- The TikTok payouts check (each payout against its order lines) added up every order line of the shown
-- payouts on each page load, which ran past the time limit for a busy shop. Each payout's order lines are now
-- kept as running totals, like the hourly report totals: added by tiktok_prepare_lines, taken out by the
-- same triggers. The first run fills them from the lines already added up (close the TikTok page while it
-- runs). Safe to run more than once.

do $$ begin
  if not exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'tiktok_statement_lines') then
    create table public.tiktok_statement_lines (
      company_id uuid not null references public.companies(id) on delete cascade,
      statement_id text not null,
      n int not null default 0,              -- order lines added up
      paid numeric not null default 0,       -- their settlement_amount
      reserve numeric not null default 0,    -- their reserve_amount
      primary key (company_id, statement_id)
    );
    insert into public.tiktok_statement_lines(company_id, statement_id, n, paid, reserve)
    select company_id, statement_id, count(*), sum(coalesce((amounts ->> '|settlement_amount')::numeric, 0)),
      sum(coalesce((amounts ->> '|reserve_amount')::numeric, 0))
    from public.tiktok_transactions where rolled_up and stamped and statement_id is not null group by 1, 2;
  end if;
end $$;
alter table public.tiktok_statement_lines enable row level security;   -- read through tiktok_payouts()
revoke all on public.tiktok_statement_lines from anon, authenticated;
grant all on public.tiktok_statement_lines to service_role;

-- Adds (sign 1) or takes away (sign -1) one line in its payout's totals.
create or replace function public.tiktok_roll_statement(cid uuid, sid text, a jsonb, sign int) returns void
language sql set search_path = '' as $$
  insert into public.tiktok_statement_lines as l (company_id, statement_id, n, paid, reserve)
  select cid, sid, sign, sign * coalesce((a ->> '|settlement_amount')::numeric, 0), sign * coalesce((a ->> '|reserve_amount')::numeric, 0)
  where sid is not null
  on conflict (company_id, statement_id) do update set n = l.n + excluded.n, paid = l.paid + excluded.paid, reserve = l.reserve + excluded.reserve
$$;
revoke execute on function public.tiktok_roll_statement(uuid, text, jsonb, int) from public, anon, authenticated;

create or replace function public.tiktok_fill_amounts() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.at := coalesce((select public.tiktok_statement_day(s.statement_time, s.data) from public.tiktok_statements s
                      where s.company_id = new.company_id and s.id = new.statement_id), new.at);
  new.amounts := public.tiktok_flat(new.data);
  if tg_op = 'UPDATE' then
    if old.stamped and new.at is not distinct from old.at and new.amounts is not distinct from old.amounts
       and new.statement_id is not distinct from old.statement_id then
      new.rolled_up := old.rolled_up; new.stamped := true; return new;
    end if;
    if old.rolled_up and old.stamped then
      perform public.tiktok_roll(old.company_id, old.at, coalesce(old.amounts, public.tiktok_flat(old.data)), -1);
      perform public.tiktok_roll_statement(old.company_id, old.statement_id, coalesce(old.amounts, public.tiktok_flat(old.data)), -1);
    end if;
  end if;
  new.stamped := true; new.rolled_up := false;
  return new;
end $$;

create or replace function public.tiktok_unroll_deleted() returns trigger
language plpgsql set search_path = '' as $$
begin
  if old.rolled_up and old.stamped then
    perform public.tiktok_roll(old.company_id, old.at, coalesce(old.amounts, public.tiktok_flat(old.data)), -1);
    perform public.tiktok_roll_statement(old.company_id, old.statement_id, coalesce(old.amounts, public.tiktok_flat(old.data)), -1);
  end if;
  return old;
end $$;

create or replace function public.tiktok_prepare_lines(cid uuid, lim int default 1000) returns int
language plpgsql security definer set search_path = '' as $$
declare left_over int; m int := greatest(1, least(coalesce(lim, 1000), 10000));
begin
  update public.tiktok_transactions t set stamped = true
  where t.company_id = cid and t.id in (
    select id from public.tiktok_transactions where company_id = cid and not stamped limit m for update skip locked);
  with batch as (
    select t.id, t.at, t.statement_id, coalesce(t.amounts, public.tiktok_flat(t.data)) as a
    from public.tiktok_transactions t where t.company_id = cid and not t.rolled_up and t.stamped
    limit m for update skip locked
  ), done as (
    update public.tiktok_transactions t set amounts = b.a, rolled_up = true
    from batch b where t.company_id = cid and t.id = b.id
    returning b.at, b.statement_id, b.a
  ), per_statement as (
    insert into public.tiktok_statement_lines as l (company_id, statement_id, n, paid, reserve)
    select cid, statement_id, count(*), sum(coalesce((a ->> '|settlement_amount')::numeric, 0)), sum(coalesce((a ->> '|reserve_amount')::numeric, 0))
    from done where statement_id is not null group by statement_id
    on conflict (company_id, statement_id) do update set n = l.n + excluded.n, paid = l.paid + excluded.paid, reserve = l.reserve + excluded.reserve
  ), sums as (
    select date_trunc('hour', at) as hour, e.key as k, sum(e.value::numeric) as total, count(*) filter (where e.value::numeric <> 0) as n
    from done, jsonb_each(done.a) e group by 1, 2
    union all
    select date_trunc('hour', at), '#', 0, count(*) from done group by 1
  )
  insert into public.tiktok_hourly(company_id, hour, k, total, n)
  select cid, hour, k, total, n from sums
  on conflict (company_id, hour, k) do update set total = public.tiktok_hourly.total + excluded.total, n = public.tiktok_hourly.n + excluded.n;
  select count(*) into left_over from public.tiktok_transactions where company_id = cid and (not rolled_up or not stamped);
  return left_over;
end $$;
revoke execute on function public.tiktok_prepare_lines(uuid, int) from public, anon, authenticated;
grant execute on function public.tiktok_prepare_lines(uuid, int) to service_role;

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
    select l.statement_id, l.n, l.paid, l.reserve from public.tiktok_statement_lines l
    where l.company_id = cid and l.statement_id in (select id from recent)
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
