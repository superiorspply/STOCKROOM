-- TikTok Shop finance: a company connects its TikTok Shop once, then the server function
-- supabase/functions/tiktok pulls its payouts (statements) and each order's fee breakdown (transactions).
-- The TikTok tokens are only ever read by that function (service role); people never see them.
-- Owners and admins can read the finance data. Safe to run more than once.

create table if not exists public.tiktok_links (
  company_id uuid primary key references public.companies(id) on delete cascade,
  shop_id text, shop_name text, shop_cipher text, region text,
  access_token text, access_expires timestamptz,
  refresh_token text, refresh_expires timestamptz,
  connected_by uuid references auth.users(id) on delete set null,
  connected_at timestamptz not null default now(),
  synced_at timestamptz, sync_error text
);
alter table public.tiktok_links enable row level security;   -- no policies: tokens stay server-side
revoke all on public.tiktok_links from anon, authenticated;

-- One-time "state" values that tie TikTok's redirect back to the person and company that started it.
create table if not exists public.tiktok_states (
  state text primary key,
  company_id uuid not null references public.companies(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table public.tiktok_states enable row level security;
revoke all on public.tiktok_states from anon, authenticated;

create table if not exists public.tiktok_statements (
  company_id uuid not null references public.companies(id) on delete cascade,
  id text not null,
  statement_time timestamptz,
  data jsonb not null default '{}'::jsonb,
  transactions_synced_at timestamptz,   -- when its order breakdown was last pulled
  primary key (company_id, id)
);
create table if not exists public.tiktok_transactions (
  company_id uuid not null references public.companies(id) on delete cascade,
  id text not null,
  statement_id text,
  order_id text,
  at timestamptz,
  data jsonb not null default '{}'::jsonb,
  primary key (company_id, id)
);
create index if not exists tiktok_transactions_at on public.tiktok_transactions(company_id, at);
alter table public.tiktok_statements enable row level security;
alter table public.tiktok_transactions enable row level security;
drop policy if exists tiktok_statements_read on public.tiktok_statements;
create policy tiktok_statements_read on public.tiktok_statements for select to authenticated
  using (public.my_role(company_id) in ('owner','admin'));
drop policy if exists tiktok_transactions_read on public.tiktok_transactions;
create policy tiktok_transactions_read on public.tiktok_transactions for select to authenticated
  using (public.my_role(company_id) in ('owner','admin'));
revoke all on public.tiktok_statements, public.tiktok_transactions from anon, authenticated;
grant select on public.tiktok_statements, public.tiktok_transactions to authenticated;
grant all on public.tiktok_links, public.tiktok_states, public.tiktok_statements, public.tiktok_transactions to service_role;

create or replace function public.tiktok_require_admin(cid uuid) returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if public.my_role(cid) is null or public.my_role(cid) not in ('owner','admin') then
    raise exception 'Only owners and admins can use TikTok Shop finance' using errcode = '42501';
  end if;
end $$;

-- Whether the company is connected, without the tokens.
create or replace function public.tiktok_status(cid uuid)
returns table(connected boolean, shop_name text, connected_at timestamptz, synced_at timestamptz, sync_error text)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform public.tiktok_require_admin(cid);
  return query
    select l.company_id is not null, l.shop_name, l.connected_at, l.synced_at, l.sync_error
    from (select 1) one left join public.tiktok_links l on l.company_id = cid;
end $$;

-- Starts connecting: returns a one-time state for TikTok's authorization link.
create or replace function public.tiktok_begin(cid uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare st text := 'tt' || replace(gen_random_uuid()::text, '-', '');
begin
  perform public.tiktok_require_admin(cid);
  delete from public.tiktok_states where created_at < now() - interval '1 hour';
  insert into public.tiktok_states(state, company_id, user_id) values (st, cid, auth.uid());
  return st;
end $$;

-- Finishing: uses up the state (only the person who started, within 30 minutes) and returns its company.
create or replace function public.tiktok_take_state(st text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare cid uuid;
begin
  delete from public.tiktok_states
   where state = st and user_id = auth.uid() and created_at > now() - interval '30 minutes'
  returning company_id into cid;
  if cid is null then raise exception 'This TikTok connection link has expired. Start again from Stockroom.' using errcode = 'P0001'; end if;
  perform public.tiktok_require_admin(cid);
  return cid;
end $$;

-- Disconnects: forgets the tokens. Finance data already pulled stays.
create or replace function public.tiktok_disconnect(cid uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform public.tiktok_require_admin(cid);
  delete from public.tiktok_links where company_id = cid;
end $$;

revoke execute on function public.tiktok_require_admin(uuid), public.tiktok_status(uuid), public.tiktok_begin(uuid),
  public.tiktok_take_state(text), public.tiktok_disconnect(uuid) from public, anon;
grant execute on function public.tiktok_require_admin(uuid), public.tiktok_status(uuid), public.tiktok_begin(uuid),
  public.tiktok_take_state(text), public.tiktok_disconnect(uuid) to authenticated;
