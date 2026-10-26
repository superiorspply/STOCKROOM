-- TikTok Shop stays synced without anyone opening the page: a scheduled job (set up once with
-- supabase/setup/tiktok_auto_sync.sql) calls the tiktok server function every hour with a secret only the
-- database and that function can read, and the function pulls new payouts and adds them into the totals.
-- Safe to run more than once.

-- The secret the hourly job sends, and where to send it. Only the server function (service role) reads it.
create table if not exists public.tiktok_cron (
  id boolean primary key default true check (id),
  secret text not null default replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''),
  url text
);
alter table public.tiktok_cron enable row level security;   -- no policies: people never see it
revoke all on public.tiktok_cron from anon, authenticated;
grant select on public.tiktok_cron to service_role;
insert into public.tiktok_cron(id) values (true) on conflict (id) do nothing;

-- Adds new or changed lines into the hourly totals, as tiktok_prepare does, for the server function.
create or replace function public.tiktok_prepare_lines(cid uuid, lim int default 1000) returns int
language plpgsql security definer set search_path = '' as $$
declare left_over int; m int := greatest(1, least(coalesce(lim, 1000), 10000));
begin
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

create or replace function public.tiktok_prepare(cid uuid, lim int default 1000) returns int
language plpgsql security definer set search_path = '' as $$
begin
  perform public.tiktok_require_admin(cid);
  return public.tiktok_prepare_lines(cid, lim);
end $$;

revoke execute on function public.tiktok_prepare_lines(uuid, int) from public, anon, authenticated;
grant execute on function public.tiktok_prepare_lines(uuid, int) to service_role;
revoke execute on function public.tiktok_prepare(uuid, int) from public, anon;
grant execute on function public.tiktok_prepare(uuid, int) to authenticated;
