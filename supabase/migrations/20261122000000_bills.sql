-- Bills: supplier invoices kept as files (PDF or a photo), with whether the order came in complete, whether
-- it is paid, and notes written on the pages. Nothing here touches inventory. Only owners and admins can
-- see or change bills, like the rest of the money side. Safe to run more than once.

-- The bills/<id> documents are private to owners and admins (read, broadcast and write).
create or replace function public.is_private_doc(c text, i text) returns boolean
language sql immutable set search_path = '' as $$
  select (c = 'settings' and i = 'stockx') or c = 'bills'
$$;

drop policy if exists docs_insert on public.docs;
create policy docs_insert on public.docs for insert to authenticated
  with check (case when coll in ('settings','bills') then public.my_role(company_id) in ('owner','admin')
                   else public.my_role(company_id) in ('owner','admin','staff') end);
drop policy if exists docs_update on public.docs;
create policy docs_update on public.docs for update to authenticated
  using (case when coll in ('settings','bills') then public.my_role(company_id) in ('owner','admin')
              else public.my_role(company_id) in ('owner','admin','staff') end)
  with check (case when coll in ('settings','bills') then public.my_role(company_id) in ('owner','admin')
                   else public.my_role(company_id) in ('owner','admin','staff') end);
drop policy if exists docs_delete on public.docs;
create policy docs_delete on public.docs for delete to authenticated
  using (case when coll in ('settings','bills') then public.my_role(company_id) in ('owner','admin')
              else public.my_role(company_id) in ('owner','admin','staff') end);

-- The files: a private bucket at bills/<company id>/<random name>, never public. Owners and admins of that
-- company can read, add and remove them.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('bills', 'bills', false, 26214400, array['application/pdf','image/jpeg','image/png','image/webp'])
on conflict (id) do update set public = false;

drop policy if exists bills_read on storage.objects;
create policy bills_read on storage.objects for select to authenticated
  using (bucket_id = 'bills' and public.my_role(public.try_uuid((storage.foldername(name))[1])) in ('owner','admin'));
drop policy if exists bills_insert on storage.objects;
create policy bills_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'bills' and public.my_role(public.try_uuid((storage.foldername(name))[1])) in ('owner','admin'));
drop policy if exists bills_delete on storage.objects;
create policy bills_delete on storage.objects for delete to authenticated
  using (bucket_id = 'bills' and public.my_role(public.try_uuid((storage.foldername(name))[1])) in ('owner','admin'));
