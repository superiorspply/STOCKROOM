-- tiktok_prepare takes a batch size, so the page can use smaller batches when a shop's order lines are large
-- and a batch would run past the 8-second limit on requests from the site. Safe to run more than once.

drop function if exists public.tiktok_prepare(uuid);
create or replace function public.tiktok_prepare(cid uuid, lim int default 1000) returns int
language plpgsql security definer set search_path = '' as $$
declare left_over int;
begin
  perform public.tiktok_require_admin(cid);
  with batch as (
    select t.id, t.at, coalesce(t.amounts, public.tiktok_flat(t.data)) as a
    from public.tiktok_transactions t where t.company_id = cid and not t.rolled_up
    limit greatest(1, least(coalesce(lim, 1000), 10000)) for update skip locked
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
  select count(*) into left_over from public.tiktok_transactions where company_id = cid and not rolled_up;
  return left_over;
end $$;

revoke execute on function public.tiktok_prepare(uuid, int) from public, anon;
grant execute on function public.tiktok_prepare(uuid, int) to authenticated;
