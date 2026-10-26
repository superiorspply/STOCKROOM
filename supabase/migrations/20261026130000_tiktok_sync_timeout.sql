-- The TikTok server function writes order lines as the service role; give its requests a longer time limit
-- (60 seconds), so a busy moment doesn't fail a sync.
-- Safe to run more than once.
alter role service_role set statement_timeout = '60s';
notify pgrst, 'reload config';
