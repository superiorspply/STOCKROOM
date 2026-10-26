-- Keeps TikTok Shop synced every hour, even when nobody opens the page. Run once in the Supabase SQL editor,
-- after supabase/migrations/20261026120000_tiktok_auto_sync.sql. Safe to run again (it replaces the job).
-- It uses Supabase's pg_cron (scheduled jobs) and pg_net (web requests from the database).
create extension if not exists pg_cron;
create extension if not exists pg_net;

update public.tiktok_cron set url = 'https://dxkwoxgdnzkxypkxxmxz.supabase.co/functions/v1/tiktok';

-- At 7 minutes past every hour. The function stops itself before its time limit and carries on next hour.
select cron.schedule('tiktok-auto-sync', '7 * * * *', $job$
  select net.http_post(
    url := c.url,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', c.secret),
    body := '{"action":"auto"}'::jsonb,
    timeout_milliseconds := 150000)
  from public.tiktok_cron c where c.url is not null
$job$);

-- To check it later: select * from cron.job_run_details order by start_time desc limit 5;
-- To stop it:        select cron.unschedule('tiktok-auto-sync');
