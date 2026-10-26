-- TikTok Shop report matches TikTok's own Finance reports:
--   * each order line counts on its statement's date (when TikTok settled it), not the day the order was placed;
--   * adjustments are split by their type (for example "Early Settlement recovery"), so money TikTok paid early
--     and later took back shows as such.
-- Lines already pulled are moved to their statement date in batches by tiktok_prepare, which the report page
-- calls, so this runs quickly. Safe to run more than once.

-- Every "*_amount" field, as before, plus each non-order line's adjustment under its type:
-- {"adjustment_by_type.<type>|adjustment_amount": n}.
create or replace function public.tiktok_flat(d jsonb, prefix text default '') returns jsonb
language plpgsql immutable set search_path = '' as $$
declare r record; out jsonb := '{}'::jsonb; n text; ty text;
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
  ty := lower(regexp_replace(coalesce(d ->> 'type', ''), '[^A-Za-z0-9]+', '_', 'g'));
  if prefix = '' and out ? '|adjustment_amount' and (out ->> '|adjustment_amount')::numeric <> 0 and ty not in ('', 'order') then
    out := out || jsonb_build_object('adjustment_by_type.' || ty || '|adjustment_amount', out -> '|adjustment_amount');
  end if;
  return out;
end $$;

-- Whether a line has been given its statement's date (and its amounts worked out again).
do $$ begin
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'tiktok_transactions' and column_name = 'stamped') then
    alter table public.tiktok_transactions add column stamped boolean not null default false;
    -- Every line is added up again on its new date, so the old totals go (only the first time this runs).
    delete from public.tiktok_hourly;
  end if;
end $$;
create index if not exists tiktok_transactions_unstamped on public.tiktok_transactions(company_id) where not stamped;

create or replace function public.tiktok_fill_amounts() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.at := coalesce((select s.statement_time from public.tiktok_statements s where s.company_id = new.company_id and s.id = new.statement_id), new.at);
  if tg_op = 'UPDATE' then
    if new.data is not distinct from old.data and new.at is not distinct from old.at and old.stamped then
      new.amounts := old.amounts; new.rolled_up := old.rolled_up; return new;
    end if;
    -- Lines not yet stamped were in the totals cleared above, so there is nothing to take out.
    if old.rolled_up and old.stamped then perform public.tiktok_roll(old.company_id, old.at, coalesce(old.amounts, public.tiktok_flat(old.data)), -1); end if;
  end if;
  new.stamped := true;
  new.amounts := public.tiktok_flat(new.data); new.rolled_up := false;
  return new;
end $$;
drop trigger if exists tiktok_fill_amounts on public.tiktok_transactions;
create trigger tiktok_fill_amounts before insert or update of data, at, stamped on public.tiktok_transactions
  for each row execute function public.tiktok_fill_amounts();

create or replace function public.tiktok_unroll_deleted() returns trigger
language plpgsql set search_path = '' as $$
begin
  if old.rolled_up and old.stamped then perform public.tiktok_roll(old.company_id, old.at, coalesce(old.amounts, public.tiktok_flat(old.data)), -1); end if;
  return old;
end $$;

-- Gives up to lim older lines their statement date, then adds up to lim lines into the hourly totals.
-- Returns how many lines are still left to do.
create or replace function public.tiktok_prepare(cid uuid, lim int default 1000) returns int
language plpgsql security definer set search_path = '' as $$
declare left_over int; m int := greatest(1, least(coalesce(lim, 1000), 10000));
begin
  perform public.tiktok_require_admin(cid);
  update public.tiktok_transactions t set stamped = true
  where t.company_id = cid and t.id in (
    select id from public.tiktok_transactions where company_id = cid and not stamped limit m for update skip locked);
  with batch as (
    select t.id, t.at, coalesce(t.amounts, public.tiktok_flat(t.data)) as a
    from public.tiktok_transactions t where t.company_id = cid and not t.rolled_up and t.stamped
    limit m for update skip locked
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
  select count(*) into left_over from public.tiktok_transactions where company_id = cid and (not rolled_up or not stamped);
  return left_over;
end $$;

revoke execute on function public.tiktok_prepare(uuid, int) from public, anon;
grant execute on function public.tiktok_prepare(uuid, int) to authenticated;
