-- Squishy City: each product's first and last day with sales, so the city can show new products as
-- construction sites and ones that stopped selling as dark, boarded-up buildings. Replaces tiktok_city
-- (same inputs; adds first_day, last_day and filled_from). Safe to run more than once.

create or replace function public.tiktok_city(cid uuid, day_from date, day_to date)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform public.tiktok_require_admin(cid);
  return jsonb_build_object(
    'products', coalesce((select jsonb_agg(jsonb_build_object('product', p.product, 'image', p.image, 'units', p.units, 'gmv', p.gmv,
        'first_day', (select min(d.day) from public.tiktok_product_days d where d.company_id = cid and d.product = p.product),
        'last_day', p.last_day) order by p.units desc)
      from (select product, max(image) as image, sum(units)::int as units, sum(gmv) as gmv, max(day) as last_day from public.tiktok_product_days
            where company_id = cid and day between day_from and day_to group by product order by sum(units) desc limit 60) p), '[]'::jsonb),
    'days_filled', (select count(*) from public.tiktok_city_days where company_id = cid and day between day_from and day_to),
    'filled_from', (select min(day) from public.tiktok_city_days where company_id = cid),
    'orders', coalesce((select sum(orders) from public.tiktok_city_days where company_id = cid and day between day_from and day_to), 0));
end $$;

revoke execute on function public.tiktok_city(uuid, date, date) from public, anon;
grant execute on function public.tiktok_city(uuid, date, date) to authenticated;
