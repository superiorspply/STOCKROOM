// Local stand-in for Supabase, for testing the site without a cloud project.
// Real parts: PostgreSQL with the real migration and security rules, and PostgREST (Supabase's database API).
// Simplified parts: sign-in (/auth/v1), photo storage (/storage/v1) and live updates (/realtime/v1).
//
//   node dev/server.mjs   then open http://localhost:8080
//
// Needs: PostgreSQL running locally (superuser via `su postgres`), the `postgrest` binary on PATH or in
// $POSTGREST, and `npm install` in dev/. See dev/README.md.
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {spawn, execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import pg from 'pg';
import {WebSocketServer} from 'ws';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DB = process.env.DEV_DB || 'stockroom_dev';
const API_PORT = +(process.env.API_PORT || 54321), SITE_PORT = +(process.env.SITE_PORT || 8080), REST_PORT = API_PORT + 1;
const SECRET = 'dev-secret-at-least-32-characters-long!!';
const PG_PASS = 'devpass';

const b64u = b => Buffer.from(b).toString('base64url');
function sign(claims){
  const head = b64u(JSON.stringify({alg:'HS256', typ:'JWT'})), body = b64u(JSON.stringify(claims));
  return head + '.' + body + '.' + crypto.createHmac('sha256', SECRET).update(head + '.' + body).digest('base64url');
}
function verify(tok){
  if (!tok) return null;
  const [h, b, s] = tok.split('.');
  if (!s || crypto.createHmac('sha256', SECRET).update(h + '.' + b).digest('base64url') !== s) return null;
  const c = JSON.parse(Buffer.from(b, 'base64url').toString());
  return c.exp && c.exp < Date.now() / 1000 ? null : c;
}
export const ANON_KEY = sign({role:'anon', iss:'dev', exp:4102444800});

/* ---------- database ---------- */
function psql(sql, db = DB){
  const f = path.join(fs.mkdtempSync('/tmp/sr-'), 'q.sql'); fs.writeFileSync(f, sql); fs.chmodSync(path.dirname(f), 0o755); fs.chmodSync(f, 0o644);
  return execFileSync('su', ['postgres', '-c', `psql -q -X -v ON_ERROR_STOP=1 -d ${db} -f ${f}`], {stdio:['ignore', 'pipe', 'inherit']}).toString();
}
function setupDb(){
  execFileSync('su', ['postgres', '-c', `dropdb --if-exists --force ${DB}; createdb ${DB}`]);
  const mig = fs.readdirSync(path.join(ROOT, 'supabase/migrations')).sort().map(f => fs.readFileSync(path.join(ROOT, 'supabase/migrations', f), 'utf8')).join('\n');
  psql(fs.readFileSync(path.join(ROOT, 'supabase/tests/stubs.sql'), 'utf8') + `
alter table auth.users add column pw text;
do $$ begin if not exists (select 1 from pg_roles where rolname = 'authenticator') then
  create role authenticator login noinherit password '${PG_PASS}'; end if; end $$;
grant anon, authenticated, service_role to authenticator;
` + mig + `
grant usage on schema auth, realtime, storage to service_role;
grant all on all tables in schema auth, realtime, storage, public to service_role;
grant all on all sequences in schema auth, realtime, storage, public to service_role;
create function realtime.notify_message() returns trigger language plpgsql as $$
begin perform pg_notify('realtime', json_build_object('id', new.id, 'topic', new.topic)::text); return new; end $$;
create trigger notify after insert on realtime.messages for each row execute function realtime.notify_message();
`);
}
// The server's own queries run as service_role (bypasses row security); asUser() switches to a signed-in user.
const pool = new pg.Pool({host:'127.0.0.1', user:'authenticator', password:PG_PASS, database:DB, max:8});
pool.on('connect', c => c.query('set role service_role'));
const admin = () => new pg.Client({host:'127.0.0.1', user:'authenticator', password:PG_PASS, database:DB});
async function asUser(claims, fn){
  const c = await pool.connect();
  try {
    await c.query('begin');
    await c.query("select set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.sub', $2, true)", [JSON.stringify(claims), claims.sub || '']);
    await c.query('set local role ' + (claims.role === 'authenticated' ? 'authenticated' : 'anon'));
    const r = await fn(c);
    await c.query('commit');
    return r;
  } catch(e){ await c.query('rollback').catch(()=>{}); throw e; }
  finally { c.release(); }
}

/* ---------- http helpers ---------- */
const CORS = {'access-control-allow-origin':'*', 'access-control-allow-headers':'*', 'access-control-allow-methods':'GET,POST,PUT,PATCH,DELETE,OPTIONS', 'access-control-expose-headers':'*'};
function send(res, code, body, headers){
  res.writeHead(code, Object.assign({'content-type':'application/json'}, CORS, headers || {}));
  res.end(body === undefined ? '' : typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
const readBody = req => new Promise(r => { const a = []; req.on('data', d => a.push(d)); req.on('end', () => r(Buffer.concat(a))); });
const bearer = req => verify((req.headers.authorization || '').replace(/^Bearer /i, ''));

/* ---------- auth ---------- */
const hash = (pw, salt) => salt + ':' + crypto.scryptSync(pw, salt, 32).toString('hex');
function session(u){
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const user = {id:u.id, aud:'authenticated', role:'authenticated', email:u.email, app_metadata:{}, user_metadata:{}, created_at:new Date().toISOString()};
  return {access_token:sign({sub:u.id, email:u.email, role:'authenticated', aud:'authenticated', exp}), token_type:'bearer', expires_in:3600, expires_at:exp,
    refresh_token:sign({sub:u.id, email:u.email, typ:'refresh', exp:exp + 86400 * 30}), user};
}
async function auth(req, res, url){
  const p = url.pathname.replace('/auth/v1', ''), body = req.method === 'GET' ? {} : JSON.parse((await readBody(req)).toString() || '{}');
  const q = (sql, args) => pool.query(sql, args);
  if (p === '/signup'){
    const email = String(body.email || '').toLowerCase();
    if ((await q('select 1 from auth.users where email = $1', [email])).rowCount) return send(res, 422, {code:422, error_code:'user_already_exists', msg:'User already registered'});
    if (String(body.password || '').length < 6) return send(res, 422, {code:422, error_code:'weak_password', msg:'Password should be at least 6 characters.'});
    const id = crypto.randomUUID();
    await q('insert into auth.users(id, email, pw) values ($1, $2, $3)', [id, email, hash(body.password, crypto.randomBytes(8).toString('hex'))]);
    return send(res, 200, session({id, email}));
  }
  if (p === '/token'){
    const grant = url.searchParams.get('grant_type');
    if (grant === 'password'){
      const r = await q('select id, email, pw from auth.users where email = $1', [String(body.email || '').toLowerCase()]);
      const u = r.rows[0];
      if (!u || hash(body.password || '', u.pw.split(':')[0]) !== u.pw) return send(res, 400, {code:400, error_code:'invalid_credentials', msg:'Invalid login credentials'});
      return send(res, 200, session(u));
    }
    if (grant === 'refresh_token'){
      const c = verify(body.refresh_token);
      if (!c || c.typ !== 'refresh') return send(res, 400, {code:400, error_code:'refresh_token_not_found', msg:'Invalid Refresh Token'});
      return send(res, 200, session({id:c.sub, email:c.email}));
    }
  }
  if (p === '/user'){
    const c = bearer(req); if (!c || !c.sub) return send(res, 401, {code:401, msg:'invalid JWT'});
    if (req.method === 'PUT' && body.password) await q('update auth.users set pw = $2 where id = $1', [c.sub, hash(body.password, crypto.randomBytes(8).toString('hex'))]);
    return send(res, 200, session({id:c.sub, email:c.email}).user);
  }
  if (p === '/logout') return send(res, 204);
  if (p === '/recover') return send(res, 200, {});
  send(res, 404, {msg:'not found: ' + p});
}

/* ---------- storage ---------- */
const files = new Map();
// The Supabase client uploads Blobs as multipart/form-data; keep just the file part, as Supabase does.
function unwrap(body, type){
  const m = /multipart\/form-data;\s*boundary=(.+)$/i.exec(type || '');
  if (!m) return {body, type};
  const sep = Buffer.from('--' + m[1].replace(/^"|"$/g, ''));
  let i = body.indexOf(sep);
  while (i >= 0){
    const next = body.indexOf(sep, i + sep.length); if (next < 0) break;
    const part = body.subarray(i + sep.length + 2, next - 2), he = part.indexOf('\r\n\r\n');
    const head = part.subarray(0, he).toString(), ct = /content-type:\s*([^\r\n]+)/i.exec(head);
    if (ct && !/text\/plain/i.test(ct[1])) return {body:part.subarray(he + 4), type:ct[1].trim()};
    i = next;
  }
  return {body, type};
}
async function storage(req, res, url){
  const m = url.pathname.match(/^\/storage\/v1\/object\/(public\/)?([^/]+)\/(.+)$/);
  if (!m) return send(res, 404, {message:'not found'});
  const [, pub, bucket, name] = m, key = bucket + '/' + decodeURIComponent(name);
  if (req.method === 'GET' && pub){
    const f = files.get(key); if (!f) return send(res, 404, {message:'Object not found'});
    return send(res, 200, f.body, {'content-type':f.type, 'cache-control':'max-age=3600'});
  }
  if (req.method === 'POST' || req.method === 'PUT'){
    const c = bearer(req) || {role:'anon'}, body = await readBody(req);
    try {
      await asUser(c, cl => cl.query('insert into storage.objects(bucket_id, name) values ($1, $2)', [bucket, decodeURIComponent(name)]));
    } catch(e){ return send(res, 403, {statusCode:'403', error:'Unauthorized', message:'new row violates row-level security policy'}); }
    files.set(key, unwrap(body, req.headers['content-type'] || 'application/octet-stream'));
    return send(res, 200, {Key:key, Id:crypto.randomUUID()});
  }
  send(res, 405, {message:'method not allowed'});
}

/* ---------- realtime (Phoenix protocol, broadcast only) ---------- */
const subs = new Map();   // topic -> Set(ws)
async function canJoin(claims, topic){
  // Like Supabase: insert a probe message, then check the user may read it under the realtime.messages rules.
  const c = await pool.connect();
  try {
    await c.query('begin');
    const {rows:[probe]} = await c.query("insert into realtime.messages(topic, event, payload, private) values ($1, 'probe', '{}', true) returning id", [topic]);
    await c.query("select set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.sub', $2, true), set_config('realtime.topic', $3, true)", [JSON.stringify(claims), claims.sub || '', topic]);
    await c.query('set local role authenticated');
    return (await c.query('select 1 from realtime.messages where id = $1', [probe.id])).rowCount === 1;
  } catch(e){ return false; }
  finally { await c.query('rollback').catch(()=>{}); c.release(); }
}
function realtime(server){
  const wss = new WebSocketServer({noServer:true});
  server.on('upgrade', (req, sock, head) => {
    if (!req.url.startsWith('/realtime/v1/websocket')) return sock.destroy();
    wss.handleUpgrade(req, sock, head, ws => wss.emit('connection', ws, req));
  });
  wss.on('connection', ws => {
    ws.topics = new Set();
    ws.on('message', async raw => {
      let msg; try { msg = JSON.parse(raw.toString()); } catch(e){ return; }
      const [joinRef, ref, topic, event, payload] = msg;
      const reply = (status, response) => ws.send(JSON.stringify([joinRef, ref, topic, 'phx_reply', {status, response:response || {}}]));
      if (event === 'heartbeat') return reply('ok');
      if (event === 'phx_join'){
        const name = topic.replace(/^realtime:/, ''), claims = verify(payload.access_token) || {role:'anon'};
        if (payload.config && payload.config.private && !(await canJoin(claims, name)))
          return reply('error', {reason:'Unauthorized: You do not have permissions to read from this Channel topic: ' + name});
        if (!subs.has(name)) subs.set(name, new Set());
        subs.get(name).add(ws); ws.topics.add(name);
        return reply('ok', {postgres_changes:[]});
      }
      if (event === 'phx_leave'){ const n = topic.replace(/^realtime:/, ''); subs.get(n)?.delete(ws); ws.topics.delete(n); return reply('ok'); }
      if (event === 'access_token') return reply('ok');
      reply('ok');
    });
    ws.on('close', () => { for (const t of ws.topics) subs.get(t)?.delete(ws); });
  });
  const l = admin();
  l.connect().then(() => l.query('set role service_role')).then(() => l.query('listen realtime'));
  l.on('notification', async n => {
    const {id, topic} = JSON.parse(n.payload);
    const set = subs.get(topic); if (!set || !set.size) return;
    const {rows:[m]} = await pool.query('select event, payload from realtime.messages where id = $1', [id]).catch(() => ({rows:[]}));
    if (!m || m.event === 'probe') return;
    const frame = JSON.stringify([null, null, 'realtime:' + topic, 'broadcast', {type:'broadcast', event:m.event, payload:m.payload}]);
    for (const ws of set) if (ws.readyState === 1) ws.send(frame);
  });
}

/* ---------- PostgREST + site ---------- */
function startPostgrest(){
  const bin = process.env.POSTGREST || 'postgrest';
  const env = Object.assign({}, process.env, {
    PGRST_DB_URI:`postgres://authenticator:${PG_PASS}@127.0.0.1:5432/${DB}`, PGRST_DB_SCHEMAS:'public', PGRST_DB_ANON_ROLE:'anon',
    PGRST_JWT_SECRET:SECRET, PGRST_SERVER_PORT:String(REST_PORT), PGRST_SERVER_HOST:'127.0.0.1', PGRST_DB_MAX_ROWS:'1000', PGRST_LOG_LEVEL:'error'});
  const p = spawn(bin, [], {env, stdio:['ignore', 'inherit', 'inherit']});
  process.on('exit', () => p.kill());
  return p;
}
function proxyRest(req, res, url){
  const headers = Object.assign({}, req.headers); delete headers.host;
  if (headers.apikey && !headers.authorization) headers.authorization = 'Bearer ' + headers.apikey;
  const p = http.request({host:'127.0.0.1', port:REST_PORT, method:req.method, path:url.pathname.replace('/rest/v1', '') + url.search, headers}, r => {
    res.writeHead(r.statusCode, Object.assign({}, r.headers, CORS)); r.pipe(res);
  });
  p.on('error', e => send(res, 502, {message:String(e)}));
  req.pipe(p);
}
const TYPES = {'.html':'text/html; charset=utf-8', '.js':'text/javascript', '.css':'text/css', '.json':'application/json', '.png':'image/png', '.jpg':'image/jpeg', '.svg':'image/svg+xml'};
function site(req, res){
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/config.js')
    return send(res, 200, `window.STOCKROOM_CONFIG = {supabaseUrl: 'http://localhost:${API_PORT}', supabaseAnonKey: '${ANON_KEY}'};`, {'content-type':'text/javascript'});
  let f = path.normalize(path.join(ROOT, decodeURIComponent(url.pathname)));
  if (!f.startsWith(ROOT) || /\/(supabase|dev|\.git)(\/|$)/.test(f.slice(ROOT.length))) return send(res, 404, 'not found', {'content-type':'text/plain'});
  if (fs.existsSync(f) && fs.statSync(f).isDirectory()) f = path.join(f, 'index.html');
  if (!fs.existsSync(f)) return send(res, 404, 'not found', {'content-type':'text/plain'});
  send(res, 200, fs.readFileSync(f), {'content-type':TYPES[path.extname(f)] || 'application/octet-stream'});
}

setupDb();
startPostgrest();
const api = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (req.method === 'OPTIONS') return send(res, 204);
    if (url.pathname.startsWith('/rest/v1')) return proxyRest(req, res, url);
    if (url.pathname.startsWith('/auth/v1')) return await auth(req, res, url);
    if (url.pathname.startsWith('/storage/v1')) return await storage(req, res, url);
    send(res, 404, {message:'not found'});
  } catch(e){ console.error(e); send(res, 500, {message:String(e.message || e)}); }
});
realtime(api);
api.listen(API_PORT, () => console.log('API  http://localhost:' + API_PORT));
http.createServer(site).listen(SITE_PORT, () => console.log('Site http://localhost:' + SITE_PORT));
