-- Squishy City (TV mode): how many of each product TikTok sold per day, so the city's buildings can grow with
-- sales. The tiktok function fills a day at a time from TikTok's orders (TikTok's day, Pacific time): the
-- hourly job keeps today and yesterday fresh and works back through earlier days; opening the city fills
-- what is still missing. Owners and admins can read it. Safe to run more than once.

create table if not exists public.tiktok_product_days (
  company_id uuid not null references public.companies(id) on delete cascade,
  day date not null,
  product text not null,
  image text,
  units int not null default 0,
  gmv numeric not null default 0,
  primary key (company_id, day, product)
);
-- Which days have been added up, and when (today and yesterday are added up again as orders come in).
create table if not exists public.tiktok_city_days (
  company_id uuid not null references public.companies(id) on delete cascade,
  day date not null,
  orders int not null default 0,
  filled_at timestamptz not null default now(),
  primary key (company_id, day)
);
alter table public.tiktok_product_days enable row level security;
alter table public.tiktok_city_days enable row level security;
drop policy if exists tiktok_product_days_read on public.tiktok_product_days;
create policy tiktok_product_days_read on public.tiktok_product_days for select to authenticated
  using (public.my_role(company_id) in ('owner','admin'));
drop policy if exists tiktok_city_days_read on public.tiktok_city_days;
create policy tiktok_city_days_read on public.tiktok_city_days for select to authenticated
  using (public.my_role(company_id) in ('owner','admin'));
revoke all on public.tiktok_product_days, public.tiktok_city_days from anon, authenticated;
grant select on public.tiktok_product_days, public.tiktok_city_days to authenticated;
grant all on public.tiktok_product_days, public.tiktok_city_days to service_role;

-- Each product's units and sales from day_from to day_to (inclusive), biggest first, plus how many of those
-- days have been added up so far.
create or replace function public.tiktok_city(cid uuid, day_from date, day_to date)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform public.tiktok_require_admin(cid);
  return jsonb_build_object(
    'products', coalesce((select jsonb_agg(jsonb_build_object('product', product, 'image', image, 'units', units, 'gmv', gmv) order by units desc)
      from (select product, max(image) as image, sum(units)::int as units, sum(gmv) as gmv from public.tiktok_product_days
            where company_id = cid and day between day_from and day_to group by product order by sum(units) desc limit 60) p), '[]'::jsonb),
    'days_filled', (select count(*) from public.tiktok_city_days where company_id = cid and day between day_from and day_to),
    'orders', coalesce((select sum(orders) from public.tiktok_city_days where company_id = cid and day between day_from and day_to), 0));
end $$;

revoke execute on function public.tiktok_city(uuid, date, date) from public, anon;
grant execute on function public.tiktok_city(uuid, date, date) to authenticated;
