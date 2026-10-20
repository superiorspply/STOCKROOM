-- Stockroom: multi-company inventory app.
-- Every row belongs to a company; row-level security keeps each company's data private to its members.

-- ---------- tables ----------
create table public.companies (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 1 and 80),
  logo text check (logo is null or (logo like 'data:image/%' and char_length(logo) < 400000)),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create table public.members (
  company_id uuid not null references public.companies(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('owner','admin','staff','viewer')),
  email text,
  created_at timestamptz not null default now(),
  primary key (company_id, user_id)
);
create index members_user_idx on public.members(user_id);

create table public.invites (
  code text primary key default replace(gen_random_uuid()::text, '-', ''),
  company_id uuid not null references public.companies(id) on delete cascade,
  role text not null check (role in ('admin','staff','viewer')),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '7 days',
  used_by uuid references auth.users(id) on delete set null,
  used_at timestamptz
);
create index invites_company_idx on public.invites(company_id);

-- App data, stored as documents: (company, collection, id) -> json.
create table public.docs (
  company_id uuid not null references public.companies(id) on delete cascade,
  coll text not null check (coll ~ '^[a-z][a-z0-9_]{0,39}$'),
  id text not null check (char_length(id) between 1 and 200),
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (company_id, coll, id)
);

-- ---------- helpers ----------
-- The caller's role in a company, or null when not a member.
create or replace function public.my_role(cid uuid) returns text
language sql stable security definer set search_path = '' as $$
  select m.role from public.members m where m.company_id = cid and m.user_id = auth.uid()
$$;

-- Text to uuid, or null when it is not one (policies must deny, not error, on bad input).
create or replace function public.try_uuid(t text) returns uuid
language plpgsql immutable set search_path = '' as $$
begin
  return t::uuid;
exception when others then
  return null;
end $$;

-- Documents only owners and admins may read (they hold third-party credentials).
create or replace function public.is_private_doc(c text, i text) returns boolean
language sql immutable set search_path = '' as $$
  select c = 'settings' and i = 'stockx'
$$;

-- ---------- row-level security ----------
alter table public.companies enable row level security;
alter table public.members enable row level security;
alter table public.invites enable row level security;
alter table public.docs enable row level security;

create policy companies_read on public.companies for select to authenticated
  using (public.my_role(id) is not null);
create policy companies_edit on public.companies for update to authenticated
  using (public.my_role(id) in ('owner','admin')) with check (public.my_role(id) in ('owner','admin'));
create policy companies_delete on public.companies for delete to authenticated
  using (public.my_role(id) = 'owner');

create policy members_read on public.members for select to authenticated
  using (public.my_role(company_id) is not null);

create policy invites_read on public.invites for select to authenticated
  using (public.my_role(company_id) in ('owner','admin'));
create policy invites_delete on public.invites for delete to authenticated
  using (public.my_role(company_id) in ('owner','admin'));

create policy docs_read on public.docs for select to authenticated
  using (case when public.is_private_doc(coll, id) then public.my_role(company_id) in ('owner','admin')
              else public.my_role(company_id) is not null end);
create policy docs_insert on public.docs for insert to authenticated
  with check (case when coll = 'settings' then public.my_role(company_id) in ('owner','admin')
                   else public.my_role(company_id) in ('owner','admin','staff') end);
create policy docs_update on public.docs for update to authenticated
  using (case when coll = 'settings' then public.my_role(company_id) in ('owner','admin')
              else public.my_role(company_id) in ('owner','admin','staff') end)
  with check (case when coll = 'settings' then public.my_role(company_id) in ('owner','admin')
                   else public.my_role(company_id) in ('owner','admin','staff') end);
create policy docs_delete on public.docs for delete to authenticated
  using (case when coll = 'settings' then public.my_role(company_id) in ('owner','admin')
              else public.my_role(company_id) in ('owner','admin','staff') end);

grant select, update, delete on public.companies to authenticated;
grant select on public.members to authenticated;
grant select, delete on public.invites to authenticated;
grant select, insert, update, delete on public.docs to authenticated;

-- ---------- functions the app calls ----------
create or replace function public.create_company(company_name text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare cid uuid;
begin
  if auth.uid() is null then raise exception 'Sign in first' using errcode = '42501'; end if;
  insert into public.companies(name, created_by) values (btrim(company_name), auth.uid()) returning id into cid;
  insert into public.members(company_id, user_id, role, email) values (cid, auth.uid(), 'owner', auth.jwt()->>'email');
  return cid;
end $$;

create or replace function public.create_invite(cid uuid, invite_role text) returns text
language plpgsql security definer set search_path = '' as $$
declare r text := public.my_role(cid); c text;
begin
  if r is null or r not in ('owner','admin') then raise exception 'Only owners and admins can invite people' using errcode = '42501'; end if;
  if invite_role not in ('admin','staff','viewer') then raise exception 'Unknown role' using errcode = '22023'; end if;
  if invite_role = 'admin' and r <> 'owner' then raise exception 'Only the owner can invite admins' using errcode = '42501'; end if;
  insert into public.invites(company_id, role, created_by) values (cid, invite_role, auth.uid()) returning code into c;
  return c;
end $$;

create or replace function public.accept_invite(invite_code text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare inv public.invites;
begin
  if auth.uid() is null then raise exception 'Sign in first' using errcode = '42501'; end if;
  select * into inv from public.invites where code = invite_code for update;
  if not found then raise exception 'This invite link is not valid' using errcode = 'P0002'; end if;
  if exists (select 1 from public.members where company_id = inv.company_id and user_id = auth.uid()) then
    return inv.company_id;
  end if;
  if inv.used_at is not null then raise exception 'This invite link has already been used' using errcode = 'P0002'; end if;
  if inv.expires_at < now() then raise exception 'This invite link has expired' using errcode = 'P0002'; end if;
  update public.invites set used_by = auth.uid(), used_at = now() where code = invite_code;
  insert into public.members(company_id, user_id, role, email) values (inv.company_id, auth.uid(), inv.role, auth.jwt()->>'email');
  return inv.company_id;
end $$;

-- What an invite link is for, so the sign-in screen can say "Join <company>". The code itself is the secret.
create or replace function public.invite_info(invite_code text) returns table(company_name text, role text, valid boolean)
language sql stable security definer set search_path = '' as $$
  select c.name, i.role, (i.used_at is null and i.expires_at > now())
  from public.invites i join public.companies c on c.id = i.company_id
  where i.code = invite_code
$$;

create or replace function public.set_member_role(cid uuid, member uuid, new_role text) returns void
language plpgsql security definer set search_path = '' as $$
declare r text := public.my_role(cid); cur text;
begin
  select role into cur from public.members where company_id = cid and user_id = member;
  if cur is null then raise exception 'Not a member' using errcode = 'P0002'; end if;
  if r is null or r not in ('owner','admin') then raise exception 'Only owners and admins can change roles' using errcode = '42501'; end if;
  if new_role not in ('admin','staff','viewer') then raise exception 'Unknown role' using errcode = '22023'; end if;
  if cur = 'owner' then raise exception 'The owner''s role cannot be changed' using errcode = '42501'; end if;
  if r <> 'owner' and (cur = 'admin' or new_role = 'admin') then raise exception 'Only the owner can change admins' using errcode = '42501'; end if;
  update public.members set role = new_role where company_id = cid and user_id = member;
end $$;

create or replace function public.remove_member(cid uuid, member uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare r text := public.my_role(cid); cur text;
begin
  select role into cur from public.members where company_id = cid and user_id = member;
  if cur is null then return; end if;
  if cur = 'owner' then raise exception 'The owner cannot be removed' using errcode = '42501'; end if;
  if member <> auth.uid() then
    if r is null or r not in ('owner','admin') then raise exception 'Only owners and admins can remove people' using errcode = '42501'; end if;
    if r <> 'owner' and cur = 'admin' then raise exception 'Only the owner can remove admins' using errcode = '42501'; end if;
  end if;
  delete from public.members where company_id = cid and user_id = member;
end $$;

-- Merge fields into an existing document (top-level keys replace, like the app expects).
create or replace function public.doc_patch(cid uuid, c text, i text, patch jsonb) returns void
language plpgsql security invoker set search_path = '' as $$
begin
  update public.docs set data = data || patch, updated_at = now()
    where company_id = cid and coll = c and id = i;
  if not found then raise exception 'Document not found' using errcode = 'P0002'; end if;
end $$;

revoke execute on all functions in schema public from public, anon;
grant execute on function public.create_company(text), public.create_invite(uuid, text), public.accept_invite(text),
  public.set_member_role(uuid, uuid, text), public.remove_member(uuid, uuid), public.doc_patch(uuid, text, text, jsonb),
  public.my_role(uuid), public.is_private_doc(text, text), public.try_uuid(text) to authenticated;
grant execute on function public.invite_info(text) to anon, authenticated;

-- ---------- live updates ----------
-- Each change is broadcast on the private topic "company:<id>"; only members may listen.
create or replace function public.docs_broadcast() returns trigger
language plpgsql security definer set search_path = '' as $$
declare r public.docs := coalesce(new, old);
begin
  perform realtime.send(
    jsonb_build_object('op', tg_op, 'coll', r.coll, 'id', r.id,
      'data', case when tg_op = 'DELETE' or public.is_private_doc(r.coll, r.id) then null else new.data end),
    'change', 'company:' || r.company_id::text, true);
  return null;
end $$;
create trigger docs_broadcast after insert or update or delete on public.docs
  for each row execute function public.docs_broadcast();

create policy company_listen on realtime.messages for select to authenticated
  using (realtime.topic() like 'company:%'
         and public.my_role(public.try_uuid(split_part(realtime.topic(), ':', 2))) is not null);

-- ---------- photos ----------
-- Files live at photos/<company id>/<random name>. Anyone with the exact link can view a photo;
-- only staff and above of that company can add or remove them.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('photos', 'photos', true, 10485760, array['image/jpeg','image/png','image/webp'])
on conflict (id) do nothing;

create policy photos_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'photos'
              and public.my_role(public.try_uuid((storage.foldername(name))[1])) in ('owner','admin','staff'));
create policy photos_delete on storage.objects for delete to authenticated
  using (bucket_id = 'photos'
         and public.my_role(public.try_uuid((storage.foldername(name))[1])) in ('owner','admin','staff'));
