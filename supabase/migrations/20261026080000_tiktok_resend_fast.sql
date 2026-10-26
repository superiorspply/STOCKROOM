-- TikTok sync was timing out: each sync sends the last few days of order lines again, and a line whose stored
-- copy differed only in fields Stockroom doesn't add up (older lines were stored in full, new ones slim) was
-- taken out of the totals and added back one by one. Now a line whose amounts and date are unchanged keeps
-- its place in the totals, whatever else differs. Safe to run more than once.

create or replace function public.tiktok_fill_amounts() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.at := coalesce((select s.statement_time from public.tiktok_statements s where s.company_id = new.company_id and s.id = new.statement_id), new.at);
  new.amounts := public.tiktok_flat(new.data);
  if tg_op = 'UPDATE' then
    if old.stamped and new.at is not distinct from old.at and new.amounts is not distinct from old.amounts then
      new.rolled_up := old.rolled_up; new.stamped := true; return new;
    end if;
    -- Lines not yet stamped were in totals cleared when statement dates came in, so there is nothing to take out.
    if old.rolled_up and old.stamped then perform public.tiktok_roll(old.company_id, old.at, coalesce(old.amounts, public.tiktok_flat(old.data)), -1); end if;
  end if;
  new.stamped := true; new.rolled_up := false;
  return new;
end $$;
