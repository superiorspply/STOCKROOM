-- Run after stubs.sql and the migration. Prints PASS/FAIL lines; any FAIL is a bug.
create schema t; grant usage on schema t to authenticated, anon;
create table t.results (n serial, ok boolean, msg text); grant insert, select on t.results to authenticated, anon; grant usage on sequence t.results_n_seq to authenticated, anon;
create function t.ok(c boolean, msg text) returns void language sql as $$ insert into t.results(ok, msg) values (coalesce(c, false), msg) $$;
create function t.fails(q text, msg text) returns void language plpgsql as $$
begin
  begin execute q; exception when others then insert into t.results(ok, msg) values (true, msg); return; end;
  insert into t.results(ok, msg) values (false, msg || ' (expected an error)');
end $$;
create function t.works(q text, msg text) returns void language plpgsql as $$
begin
  begin execute q; exception when others then insert into t.results(ok, msg) values (false, msg || ': ' || sqlerrm); return; end;
  insert into t.results(ok, msg) values (true, msg);
end $$;
create function t.count(q text) returns bigint language plpgsql as $$ declare n bigint; begin execute 'select count(*) from (' || q || ') x' into n; return n; end $$;
create function t.as_user(u text, email text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', u, false);
  perform set_config('request.jwt.claims', json_build_object('sub', u, 'email', email)::text, false);
end $$;
grant execute on all functions in schema t to authenticated, anon;

insert into auth.users values
 ('00000000-0000-0000-0000-00000000000a', 'owner@a.com'), ('00000000-0000-0000-0000-00000000000b', 'owner@b.com'),
 ('00000000-0000-0000-0000-0000000000a1', 'staff@a.com'), ('00000000-0000-0000-0000-0000000000a2', 'viewer@a.com'),
 ('00000000-0000-0000-0000-0000000000a3', 'admin@a.com'), ('00000000-0000-0000-0000-0000000000ff', 'support@stockroom.test');

set role authenticated;
-- Owner A creates company A; owner B creates company B.
select t.as_user('00000000-0000-0000-0000-00000000000a', 'owner@a.com');
create temp table ids(k text primary key, v text); grant select on ids to anon;
insert into ids select 'A', public.create_company('Acme')::text;
select t.ok((select role from public.members where user_id = auth.uid()) = 'owner', 'creator becomes owner');
select t.ok((select email from public.members where user_id = auth.uid()) = 'owner@a.com', 'owner email recorded');
insert into public.docs(company_id, coll, id, data) select v::uuid, 'items', 'i1', '{"sku":"A-1","qty":5}' from ids where k = 'A';
insert into public.docs(company_id, coll, id, data) select v::uuid, 'settings', 'stockx', '{"token":"secret"}' from ids where k = 'A';
insert into public.docs(company_id, coll, id, data) select v::uuid, 'settings', 'brackets', '{"medium":100}' from ids where k = 'A';
select public.doc_patch((select v::uuid from ids where k='A'), 'items', 'i1', '{"qty":7}');
select t.ok((select data from public.docs where id = 'i1') = '{"sku":"A-1","qty":7}', 'doc_patch merges top-level fields');
select t.fails($$select public.doc_patch((select v::uuid from ids where k='A'), 'items', 'nope', '{"qty":1}')$$, 'doc_patch on missing doc errors');
insert into ids select 'inv_staff', public.create_invite((select v::uuid from ids where k='A'), 'staff');
insert into ids select 'inv_viewer', public.create_invite((select v::uuid from ids where k='A'), 'viewer');
insert into ids select 'inv_admin', public.create_invite((select v::uuid from ids where k='A'), 'admin');
select t.fails($$select public.create_invite((select v::uuid from ids where k='A'), 'owner')$$, 'cannot invite as owner');
select set_config('realtime.topic', 'company:' || (select v from ids where k='A'), false);
select t.ok(exists(select 1 from realtime.messages where topic like 'company:%' and payload->>'id' = 'i1' and payload->'data'->>'qty' = '7'), 'changes are broadcast with data');
select t.ok(exists(select 1 from realtime.messages where payload->>'id' = 'stockx' and payload->'data' = 'null'::jsonb), 'private doc broadcast has no data');

select t.as_user('00000000-0000-0000-0000-00000000000b', 'owner@b.com');
insert into ids select 'B', public.create_company('Bolt')::text;
select t.ok(t.count('select * from public.docs') = 0, 'B cannot see A docs');
select t.ok(t.count('select * from public.companies') = 1, 'B sees only own company');
select t.ok(t.count('select * from public.members') = 1, 'B sees only own members');
select t.ok(t.count('select * from public.invites') = 0, 'B cannot see A invites');
select t.fails($$select public.accept_invite('bogus')$$, 'bogus invite code is rejected');
select t.fails($$insert into public.docs(company_id, coll, id) values ((select v::uuid from ids where k='A'), 'items', 'x')$$, 'B cannot write into A');
update public.docs set data = '{}' where coll = 'items';
delete from public.docs where coll = 'items';
select t.fails($$select public.create_invite((select v::uuid from ids where k='A'), 'staff')$$, 'B cannot invite to A');
select t.fails($$select public.set_member_role((select v::uuid from ids where k='A'), '00000000-0000-0000-0000-00000000000a', 'viewer')$$, 'B cannot change A roles');
select t.fails($$update public.companies set name = 'hacked' where id = (select v::uuid from ids where k='A') returning 1$$, 'noop') where false;
update public.companies set name = 'hacked' where id = (select v::uuid from ids where k='A');
select t.fails($$select public.doc_patch((select v::uuid from ids where k='A'), 'items', 'i1', '{"qty":0}')$$, 'B cannot patch A doc');
insert into storage.objects(bucket_id, name) select 'photos', v || '/b.jpg' from ids where k = 'B';
select t.fails($$insert into storage.objects(bucket_id, name) select 'photos', v || '/x.jpg' from ids where k = 'A'$$, 'B cannot upload into A photos');
select t.fails($$insert into storage.objects(bucket_id, name) values ('photos', 'not-a-uuid/x.jpg')$$, 'bad photo folder is denied');
set realtime.topic = 'x'; select set_config('realtime.topic', 'company:' || (select v from ids where k='A'), false);
select t.ok(t.count('select * from realtime.messages') = 0, 'B cannot listen to A topic');
select set_config('realtime.topic', 'company:not-a-uuid', false);
select t.ok(t.count('select * from realtime.messages') = 0, 'bad topic is denied without error');
select set_config('realtime.topic', 'company:' || (select v from ids where k='B'), false);
select t.ok(t.count('select * from realtime.messages') > 0, 'B can listen to own topic');

-- Staff joins A.
select t.as_user('00000000-0000-0000-0000-0000000000a1', 'staff@a.com');
select t.ok(t.count('select * from public.docs') = 0, 'non-member sees nothing before joining');
select t.ok(public.accept_invite((select v from ids where k='inv_staff'))::text = (select v from ids where k='A'), 'staff accepts invite');
select t.ok(public.accept_invite((select v from ids where k='inv_staff'))::text = (select v from ids where k='A'), 'accepting again is harmless');
select t.ok(t.count('select * from public.docs where coll = ''items''') = 1, 'staff sees items');
select t.ok(t.count($$select * from public.docs where coll = 'settings' and id = 'stockx'$$) = 0, 'staff cannot read StockX token');
select t.ok(t.count($$select * from public.docs where coll = 'settings' and id = 'brackets'$$) = 1, 'staff can read normal settings');
insert into public.docs(company_id, coll, id, data) select v::uuid, 'sales', 's1', '{"qty":1}' from ids where k = 'A';
select t.ok(t.count($$select * from public.docs where id = 's1'$$) = 1, 'staff can record a sale');
select t.fails($$insert into public.docs(company_id, coll, id) select v::uuid, 'settings', 'orders' from ids where k = 'A'$$, 'staff cannot write settings');
update public.docs set data = '{}' where coll = 'settings';
select t.fails($$select public.create_invite((select v::uuid from ids where k='A'), 'viewer')$$, 'staff cannot invite');
select t.fails($$select public.set_member_role((select v::uuid from ids where k='A'), auth.uid(), 'admin')$$, 'staff cannot promote self');
select t.ok(t.count('select * from public.invites') = 0, 'staff cannot list invites');
select t.works($$insert into storage.objects(bucket_id, name) select 'photos', v || '/s.jpg' from ids where k = 'A'$$, 'staff can upload photos');

-- Viewer joins A.
select t.as_user('00000000-0000-0000-0000-0000000000a2', 'viewer@a.com');
select public.accept_invite((select v from ids where k='inv_viewer'));
select t.ok(t.count('select * from public.docs where coll = ''items''') = 1, 'viewer sees items');
select t.fails($$insert into public.docs(company_id, coll, id) select v::uuid, 'sales', 's2' from ids where k = 'A'$$, 'viewer cannot write');
select t.fails($$select public.doc_patch((select v::uuid from ids where k='A'), 'items', 'i1', '{"qty":0}')$$, 'viewer cannot patch');
select t.fails($$insert into storage.objects(bucket_id, name) select 'photos', v || '/v.jpg' from ids where k = 'A'$$, 'viewer cannot upload');

select t.as_user('00000000-0000-0000-0000-00000000000b', 'owner@b.com');
select t.fails($$select public.accept_invite((select v from ids where k='inv_staff'))$$, 'used invite cannot be reused by someone else');

-- Admin joins A.
select t.as_user('00000000-0000-0000-0000-0000000000a3', 'admin@a.com');
select public.accept_invite((select v from ids where k='inv_admin'));
select t.ok(t.count($$select * from public.docs where id = 'stockx'$$) = 1, 'admin can read StockX token');
select t.fails($$select public.create_invite((select v::uuid from ids where k='A'), 'admin')$$, 'admin cannot invite admins');
select public.set_member_role((select v::uuid from ids where k='A'), '00000000-0000-0000-0000-0000000000a2', 'staff');
select t.ok((select role from public.members where user_id = '00000000-0000-0000-0000-0000000000a2') = 'staff', 'admin can promote viewer to staff');
select t.fails($$select public.set_member_role((select v::uuid from ids where k='A'), '00000000-0000-0000-0000-00000000000a', 'staff')$$, 'admin cannot demote owner');
select t.fails($$select public.remove_member((select v::uuid from ids where k='A'), '00000000-0000-0000-0000-00000000000a')$$, 'owner cannot be removed');
select t.fails($$delete from public.companies where id = (select v::uuid from ids where k='A') returning 1$$, 'noop') where false;
delete from public.companies;
select t.ok(t.count('select * from public.companies') = 1, 'admin cannot delete company');
select public.remove_member((select v::uuid from ids where k='A'), '00000000-0000-0000-0000-0000000000a2');
select t.ok(t.count('select * from public.members') = 3, 'admin can remove staff');

-- Owner back.
select t.as_user('00000000-0000-0000-0000-00000000000a', 'owner@a.com');
select t.ok((select name from public.companies) = 'Acme', 'company name unchanged by outsiders');
select t.ok((select data->>'qty' from public.docs where id = 'i1') = '7', 'item unchanged by outsiders');
select t.ok((select data from public.docs where id = 'brackets') = '{"medium":100}', 'settings unchanged by staff');
select public.set_member_role((select v::uuid from ids where k='A'), '00000000-0000-0000-0000-0000000000a3', 'viewer');
select t.ok((select role from public.members where user_id = '00000000-0000-0000-0000-0000000000a3') = 'viewer', 'owner can demote admin');
update public.companies set name = 'Acme Co' where id = (select v::uuid from ids where k='A');
select t.ok((select name from public.companies) = 'Acme Co', 'owner can rename company');
select t.fails($$update public.companies set logo = 'javascript:alert(1)'$$, 'logo must be an image');

-- Support access.
select t.as_user('00000000-0000-0000-0000-0000000000ff', 'support@stockroom.test');
select t.ok(not public.is_platform_admin(), 'a normal user is not support');
select t.fails($$select * from public.support_companies()$$, 'a normal user cannot list all companies');
select t.fails($$select * from public.support_open((select v::uuid from ids where k='A'))$$, 'a normal user cannot open a company as support');
select t.fails($$insert into public.platform_admins values (auth.uid())$$, 'nobody can make themselves support');
select t.ok(t.count('select * from public.docs') = 0, 'before being made support, sees no data');
reset role;
insert into public.platform_admins values ('00000000-0000-0000-0000-0000000000ff');
set role authenticated;
select t.as_user('00000000-0000-0000-0000-0000000000ff', 'support@stockroom.test');
select t.ok(public.is_platform_admin(), 'support is recognised');
select t.ok(t.count('select * from public.support_companies()') = 2, 'support lists every company');
select t.ok((select name from public.support_open((select v::uuid from ids where k='A'))) = 'Acme Co', 'support can open a company');
select t.ok(public.my_role((select v::uuid from ids where k='A')) = 'admin', 'support acts as admin');
select t.ok(t.count($$select * from public.docs where company_id = (select v::uuid from ids where k='A')$$) >= 3, 'support sees the company data, StockX settings included');
select t.works($$select public.doc_patch((select v::uuid from ids where k='A'), 'items', 'i1', '{"qty":8}')$$, 'support can fix an item');
select t.works($$insert into public.docs(company_id, coll, id, data) select v::uuid, 'settings', 'orders', '{"medium":5}' from ids where k = 'A'$$, 'support can fix settings');
select t.ok(t.count('select * from public.members') >= 3, 'support can see the team');
select t.fails($$select public.set_member_role((select v::uuid from ids where k='A'), '00000000-0000-0000-0000-00000000000a', 'staff')$$, 'support cannot demote the owner');
select t.fails($$select public.create_invite((select v::uuid from ids where k='A'), 'admin')$$, 'support cannot invite admins');
delete from public.companies where id = (select v::uuid from ids where k='A');
select t.ok(t.count($$select * from public.companies where id = (select v::uuid from ids where k='A')$$) = 1, 'support cannot delete a company');
select t.ok(t.count($$select * from public.members where user_id = auth.uid()$$) = 0, 'support does not appear in any team');
select t.works($$insert into storage.objects(bucket_id, name) select 'photos', v || '/support.jpg' from ids where k = 'A'$$, 'support can upload photos');
select set_config('realtime.topic', 'company:' || (select v from ids where k='A'), false);
select t.ok(t.count('select * from realtime.messages') > 0, 'support can listen to live updates');
select t.as_user('00000000-0000-0000-0000-00000000000a', 'owner@a.com');
select t.ok(t.count($$select * from public.support_log where admin_email = 'support@stockroom.test'$$) = 1, 'owner can see that support opened their company');
select t.as_user('00000000-0000-0000-0000-00000000000b', 'owner@b.com');
select t.ok(t.count('select * from public.support_log') = 0, 'other companies cannot see that log');
select t.ok(t.count('select * from public.docs') = 0, 'B still sees none of A after all this');

-- Invoice scanning.
select t.as_user('00000000-0000-0000-0000-00000000000a', 'owner@a.com');
select t.ok((select not enabled from public.scan_status((select v::uuid from ids where k='A'))), 'scanning starts switched off');
select t.fails($$select public.scan_begin((select v::uuid from ids where k='A'))$$, 'cannot scan while switched off');
select t.fails($$select public.support_set_scan((select v::uuid from ids where k='A'), true, 2)$$, 'owners cannot switch scanning on themselves');
select t.fails($$insert into public.scan_settings values ((select v::uuid from ids where k='A'), true, 999)$$, 'scan settings cannot be written directly');
select t.as_user('00000000-0000-0000-0000-0000000000ff', 'support@stockroom.test');
select public.support_set_scan((select v::uuid from ids where k='A'), true, 2);
select t.as_user('00000000-0000-0000-0000-00000000000a', 'owner@a.com');
select t.ok((select enabled and monthly_limit = 2 and used = 0 from public.scan_status((select v::uuid from ids where k='A'))), 'support can switch scanning on with a limit');
create temp table scans(n bigint); grant all on scans to authenticated;
insert into scans select public.scan_begin((select v::uuid from ids where k='A'));
select public.scan_finish((select max(n) from scans), false, 10, 0);
select t.ok((select used = 0 from public.scan_status((select v::uuid from ids where k='A'))), 'a failed scan does not count');
insert into scans select public.scan_begin((select v::uuid from ids where k='A'));
select public.scan_finish((select max(n) from scans), true, 1500, 900);
insert into scans select public.scan_begin((select v::uuid from ids where k='A'));
select t.ok((select used = 2 from public.scan_status((select v::uuid from ids where k='A'))), 'scans are counted');
select t.fails($$select public.scan_begin((select v::uuid from ids where k='A'))$$, 'the monthly limit is enforced');
select t.ok(t.count('select * from public.scan_log') = 3, 'owner can see the scan log');
select t.as_user('00000000-0000-0000-0000-0000000000a3', 'admin@a.com');
select public.scan_finish((select max(n) from scans), false, 0, 0);
select t.as_user('00000000-0000-0000-0000-00000000000a', 'owner@a.com');
select t.ok((select status from public.scan_log where id = (select max(n) from scans)) = 'started', 'only the person who started a scan can finish it');
select t.as_user('00000000-0000-0000-0000-00000000000b', 'owner@b.com');
select t.fails($$select * from public.scan_status((select v::uuid from ids where k='A'))$$, 'another company cannot see scan status');
select t.fails($$select public.scan_begin((select v::uuid from ids where k='A'))$$, 'another company cannot scan as A');
select t.ok(t.count('select * from public.scan_log') = 0, 'another company cannot see the scan log');
select t.fails($$select public.scan_begin((select v::uuid from ids where k='B'))$$, 'B is still switched off');

-- TikTok Shop finance.
reset role;
insert into public.tiktok_links(company_id, shop_name, access_token, refresh_token) select v::uuid, 'A Shop', 'SECRET-ACCESS', 'SECRET-REFRESH' from ids where k = 'A';
insert into public.tiktok_statements(company_id, id, statement_time, data) select v::uuid, 'S1', now(), '{"settlement_amount":"10"}' from ids where k = 'A';
insert into public.tiktok_transactions(company_id, id, statement_id, at, data) select v::uuid, 'T1', 'S1', now(), '{"revenue_amount":"20"}' from ids where k = 'A';
set role authenticated;
select t.as_user('00000000-0000-0000-0000-00000000000a', 'owner@a.com');
select public.set_member_role((select v::uuid from ids where k='A'), '00000000-0000-0000-0000-0000000000a3', 'admin');
select t.ok((select connected and shop_name = 'A Shop' from public.tiktok_status((select v::uuid from ids where k='A'))), 'owner sees the TikTok connection');
select t.fails($$select * from public.tiktok_links$$, 'TikTok tokens cannot be read, even by the owner');
select t.fails($$select * from public.tiktok_states$$, 'TikTok connection states cannot be read');
select t.ok(t.count('select * from public.tiktok_statements') = 1 and t.count('select * from public.tiktok_transactions') = 1, 'owner can read TikTok payouts and orders');
select t.fails($$insert into public.tiktok_transactions(company_id, id) select v::uuid, 'X' from ids where k = 'A'$$, 'TikTok data cannot be written from the app');
create temp table tt(st text); grant all on tt to authenticated;
select t.ok((select not enabled from public.tiktok_status((select v::uuid from ids where k='A'))), 'TikTok Shop starts switched off');
select t.fails($$select public.tiktok_begin((select v::uuid from ids where k='A'))$$, 'cannot connect TikTok while switched off');
select t.fails($$select public.support_set_tiktok((select v::uuid from ids where k='A'), true)$$, 'owners cannot switch TikTok Shop on themselves');
select t.fails($$insert into public.tiktok_settings values ((select v::uuid from ids where k='A'), true)$$, 'TikTok settings cannot be written directly');
select t.as_user('00000000-0000-0000-0000-0000000000ff', 'support@stockroom.test');
select public.support_set_tiktok((select v::uuid from ids where k='A'), true);
select t.as_user('00000000-0000-0000-0000-00000000000a', 'owner@a.com');
select t.ok((select enabled from public.tiktok_status((select v::uuid from ids where k='A'))), 'support can switch TikTok Shop on');
insert into tt select public.tiktok_begin((select v::uuid from ids where k='A'));
select t.ok((select st like 'tt%' and length(st) > 20 from tt), 'connecting gives a one-time state');
select t.as_user('00000000-0000-0000-0000-0000000000a3', 'admin@a.com');
select t.fails($$select public.tiktok_take_state((select st from tt))$$, 'someone else cannot use that state');
select t.as_user('00000000-0000-0000-0000-00000000000a', 'owner@a.com');
select t.ok(public.tiktok_take_state((select st from tt)) = (select v::uuid from ids where k='A'), 'the person who started can finish connecting');
select t.fails($$select public.tiktok_take_state((select st from tt))$$, 'a state works only once');
select t.as_user('00000000-0000-0000-0000-0000000000a3', 'admin@a.com');
select t.ok(t.count('select * from public.tiktok_transactions') = 1, 'admins can read TikTok orders');
select t.as_user('00000000-0000-0000-0000-0000000000a2', 'viewer@a.com');
select t.ok(t.count('select * from public.tiktok_transactions') = 0 and t.count('select * from public.tiktok_statements') = 0, 'viewers cannot see TikTok finances');
select t.fails($$select * from public.tiktok_status((select v::uuid from ids where k='A'))$$, 'viewers cannot see the TikTok connection');
select t.fails($$select public.tiktok_begin((select v::uuid from ids where k='A'))$$, 'viewers cannot connect TikTok');
select t.as_user('00000000-0000-0000-0000-00000000000b', 'owner@b.com');
select t.ok(t.count('select * from public.tiktok_transactions') = 0, 'another company cannot see TikTok orders');
select t.fails($$select public.tiktok_disconnect((select v::uuid from ids where k='A'))$$, 'another company cannot disconnect TikTok');
select t.ok((select not connected from public.tiktok_status((select v::uuid from ids where k='B'))), 'B is not connected');
select t.ok((select not enabled from public.tiktok_status((select v::uuid from ids where k='B'))), 'TikTok Shop stays off for other companies');
select t.as_user('00000000-0000-0000-0000-00000000000a', 'owner@a.com');
select public.tiktok_disconnect((select v::uuid from ids where k='A'));
select t.ok((select not connected from public.tiktok_status((select v::uuid from ids where k='A'))), 'owner can disconnect TikTok');
select t.ok(t.count('select * from public.tiktok_transactions') = 1, 'disconnecting keeps the data already pulled');
reset role; update public.tiktok_transactions set amounts = null; set role authenticated;
select t.as_user('00000000-0000-0000-0000-0000000000a2', 'viewer@a.com');
select t.fails($$select public.tiktok_prepare((select v::uuid from ids where k='A'))$$, 'viewers cannot prepare TikTok data');
select t.as_user('00000000-0000-0000-0000-00000000000a', 'owner@a.com');
select t.ok(public.tiktok_prepare((select v::uuid from ids where k='A')) = 0, 'preparing fills older TikTok lines');
reset role; select t.ok((select amounts is not null from public.tiktok_transactions where id = 'T1'), 'TikTok amounts are filled'); set role authenticated;
select t.ok((select (r->>'order_count')::int = 1 and r->'lines' @> '[{"path":"","key":"revenue_amount","total":20}]' from public.tiktok_report((select v::uuid from ids where k='A'), null, null) r), 'the TikTok report adds up the order lines');
select t.as_user('00000000-0000-0000-0000-0000000000a2', 'viewer@a.com');
select t.ok((select (r->>'order_count')::int = 0 from public.tiktok_report((select v::uuid from ids where k='A'), null, null) r), 'viewers get an empty TikTok report');
select t.as_user('00000000-0000-0000-0000-00000000000b', 'owner@b.com');
select t.ok((select (r->>'order_count')::int = 0 from public.tiktok_report((select v::uuid from ids where k='A'), null, null) r), 'another company gets an empty TikTok report for A');
select t.as_user('00000000-0000-0000-0000-00000000000a', 'owner@a.com');

-- Signed out.
reset role; set role anon;
select t.ok(t.count('select 1 from information_schema.role_table_grants where grantee = ''anon'' and table_schema = ''public''') = 0, 'anon has no table access');
select t.fails($$select public.create_company('x')$$, 'anon cannot create company');
select t.ok((select company_name from public.invite_info((select v from ids where k='inv_admin'))) = 'Acme Co', 'anon can see which company an invite is for');
select t.ok((select not valid from public.invite_info((select v from ids where k='inv_staff'))), 'used invite shows as not valid');
select t.ok(t.count($$select * from public.invite_info('bogus')$$) = 0, 'bogus invite shows nothing');
select t.fails($$select * from public.invites$$, 'anon cannot list invites');
select t.fails($$select * from public.support_companies()$$, 'anon cannot list companies');
reset role;
select case when ok then 'PASS ' else 'FAIL ' end || msg from t.results order by n;
select count(*) filter (where not ok) || ' failed of ' || count(*) from t.results;
