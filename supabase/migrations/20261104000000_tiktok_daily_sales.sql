-- TikTok net sales per day (TikTok's UTC calendar day, as Seller Center reports), for the sales goal tracker.
-- Read from the hourly totals, so it stays fast for a big shop. Owners and admins only. Safe to run more than once.
create or replace function public.tiktok_daily_sales(cid uuid, t_from timestamptz, t_to timestamptz)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform public.tiktok_require_admin(cid);
  return coalesce((
    select jsonb_agg(jsonb_build_object('day', day, 'sales', sales) order by day)
    from (select (hour at time zone 'UTC')::date as day, sum(total) as sales
          from public.tiktok_hourly
          where company_id = cid and k = '|revenue_amount' and (t_from is null or hour >= t_from) and (t_to is null or hour < t_to)
          group by 1) d
  ), '[]'::jsonb);
end $$;

revoke execute on function public.tiktok_daily_sales(uuid, timestamptz, timestamptz) from public, anon;
grant execute on function public.tiktok_daily_sales(uuid, timestamptz, timestamptz) to authenticated;
