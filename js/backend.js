/* Stockroom backend: sign-in, companies and teams on Supabase, plus the storage API the app uses
   (db / user / downloads / assets — the same shape it had when it ran inside Claude). */
(function(){
'use strict';

const CFG = window.STOCKROOM_CONFIG || {};
const configured = !!(CFG.supabaseUrl && CFG.supabaseAnonKey && window.supabase);
const sb = configured ? window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseAnonKey) : null;

const ROLES = {
  owner:  {label:'Owner',  note:'Everything, including the team and company settings.'},
  admin:  {label:'Admin',  note:'Everything except changing other admins.'},
  staff:  {label:'Staff',  note:'Sells, adds stock and clocks in. Cannot see costs or change settings.'},
  viewer: {label:'Viewer', note:'Can look but cannot change anything.'}
};
const LS_COMPANY = 'stockroom_company', LS_INVITE = 'stockroom_invite';

const S = window.STOCKROOM = {
  sb, company:null, role:null, user:null, memberships:[],
  brand(){ return (S.company && S.company.name) || 'Stockroom'; },
  logo(){ return (S.company && S.company.logo) || monogram(S.brand()); },
  openAccount: () => openAccount()
};

/* ---------- small helpers ---------- */
function h(tag, props, ...kids){
  const e = document.createElement(tag);
  for (const [k,v] of Object.entries(props||{})){
    if (v==null || v===false) continue;
    if (k==='class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k==='value') e.value = v;
    else e.setAttribute(k, v===true ? '' : v);
  }
  for (const k of kids.flat(Infinity)){
    if (k==null || k===false) continue;
    e.append(k.nodeType ? k : document.createTextNode(String(k)));
  }
  return e;
}
const lsGet = k => { try { return localStorage.getItem(k) || ''; } catch(e){ return ''; } };
const lsSet = (k, v) => { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch(e){} };
function newId(){
  const a = 'abcdefghijklmnopqrstuvwxyz0123456789', b = crypto.getRandomValues(new Uint8Array(20));
  let s = ''; for (const x of b) s += a[x % 36]; return s;
}
function err(e, fallback){
  const m = e && (e.message || e.error_description || e.msg);
  return m ? String(m) : (fallback || 'Something went wrong. Try again.');
}
function appError(e){
  const x = new Error(err(e, 'Could not save'));
  const offline = !navigator.onLine || /fetch|network|load failed/i.test(String(e && e.message));
  x.code = offline ? 'unavailable' : (e && e.code) || 'error';
  return x;
}
function monogram(name){
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 256, 256); grad.addColorStop(0, '#ff3b4a'); grad.addColorStop(1, '#8f0c18');
  g.fillStyle = grad; g.fillRect(0, 0, 256, 256);
  const letters = String(name||'S').trim().split(/\s+/).map(w=>w[0]).join('').slice(0,2).toUpperCase() || 'S';
  g.fillStyle = '#fff'; g.font = 'bold ' + (letters.length>1 ? 112 : 140) + 'px system-ui,-apple-system,sans-serif';
  g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(letters, 128, 136);
  return c.toDataURL('image/jpeg', 0.9);
}
async function resizeImage(file, max){
  const url = URL.createObjectURL(file);
  try {
    const im = await new Promise((res, rej)=>{ const i = new Image(); i.onload = ()=>res(i); i.onerror = rej; i.src = url; });
    const sc = Math.min(1, max / Math.max(im.width, im.height));
    const c = document.createElement('canvas'); c.width = Math.round(im.width*sc); c.height = Math.round(im.height*sc);
    const g = c.getContext('2d'); g.fillStyle = '#000'; g.fillRect(0, 0, c.width, c.height); g.drawImage(im, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.88);
  } finally { URL.revokeObjectURL(url); }
}
function siteUrl(){ return location.origin + location.pathname; }

/* ---------- photos ---------- */
window.photoSrc = function(id){
  if (!id) return '';
  if (/^data:|^https?:/.test(id)) return id;
  if (!sb || id.indexOf('/') < 0) return '';
  return sb.storage.from('photos').getPublicUrl(id).data.publicUrl;
};

/* ---------- document store (Firestore-like, as the app expects) ---------- */
function makeDb(cid){
  const data = new Map();            // coll -> Map(id -> doc data)
  const collSubs = new Map();        // coll -> Set({next, error})
  const docSubs = new Map();         // "coll/id" -> Set({next, error})
  const pending = new Set();
  let loaded = false, flushQueued = false, channel = null, everSubscribed = false;

  const collMap = c => { let m = data.get(c); if (!m){ m = new Map(); data.set(c, m); } return m; };
  const clone = v => (v && typeof v === 'object') ? structuredClone(v) : v;
  function docSnap(c, id){
    const v = collMap(c).get(id);
    return {id, exists: v !== undefined, data: () => clone(v)};
  }
  function collSnap(c){
    const docs = [...collMap(c).entries()].map(([id, v]) => ({id, exists:true, data: () => clone(v)}));
    return {docs, size:docs.length, empty:!docs.length};
  }
  function touch(c, id){ pending.add(c); pending.add(c + '/' + id); queueFlush(); }
  function queueFlush(){
    if (flushQueued || !loaded) return;
    flushQueued = true;
    queueMicrotask(()=>{
      flushQueued = false;
      const keys = [...pending]; pending.clear();
      for (const k of keys){
        const i = k.indexOf('/');
        if (i < 0) (collSubs.get(k) || []).forEach(s => s.next(collSnap(k)));
        else (docSubs.get(k) || []).forEach(s => s.next(docSnap(k.slice(0, i), k.slice(i + 1))));
      }
    });
  }
  function apply(c, id, v){
    if (v === undefined || v === null) collMap(c).delete(id); else collMap(c).set(id, v);
    touch(c, id);
  }
  function failAll(e){
    for (const set of [...collSubs.values(), ...docSubs.values()]) set.forEach(s => s.error && s.error(e));
  }

  async function loadAll(){
    const fresh = new Map(), size = 1000;
    for (let from = 0; ; from += size){
      const {data:rows, error} = await sb.from('docs').select('coll,id,data')
        .eq('company_id', cid).order('coll').order('id').range(from, from + size - 1);
      if (error) throw error;
      for (const r of rows){ if (!fresh.has(r.coll)) fresh.set(r.coll, new Map()); fresh.get(r.coll).set(r.id, r.data); }
      if (rows.length < size) break;
    }
    const colls = new Set([...data.keys(), ...fresh.keys()]);
    data.clear(); for (const [c, m] of fresh) data.set(c, m);
    loaded = true;
    for (const c of colls){ pending.add(c); for (const id of collMap(c).keys()) pending.add(c + '/' + id); }
    for (const k of docSubs.keys()) pending.add(k);
    for (const k of collSubs.keys()) pending.add(k);
    queueFlush();
  }
  async function refetchDoc(c, id){
    const {data:row, error} = await sb.from('docs').select('data').eq('company_id', cid).eq('coll', c).eq('id', id).maybeSingle();
    if (!error) apply(c, id, row ? row.data : null);
  }
  function listen(){
    channel = sb.channel('company:' + cid, {config:{private:true}})
      .on('broadcast', {event:'change'}, msg => {
        const p = msg && msg.payload; if (!p || !p.coll || !p.id) return;
        if (p.op === 'DELETE') apply(p.coll, p.id, null);
        else if (p.data == null) refetchDoc(p.coll, p.id);
        else apply(p.coll, p.id, p.data);
      })
      .subscribe(status => {
        if (status === 'SUBSCRIBED'){
          // After a reconnect, reload everything so changes made while offline are not missed.
          if (everSubscribed) loadAll().catch(()=>{});
          everSubscribed = true;
        }
      });
  }
  window.addEventListener('online', () => { if (loaded) loadAll().catch(()=>{}); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && loaded && channel && channel.state !== 'joined') loadAll().catch(()=>{});
  });

  const started = (async()=>{ await sb.realtime.setAuth(); listen(); await loadAll(); })();
  started.catch(e => failAll(appError(e)));

  function split(path){
    const i = path.indexOf('/');
    if (i <= 0 || path.indexOf('/', i + 1) >= 0) throw new Error('Bad document path: ' + path);
    return [path.slice(0, i), path.slice(i + 1)];
  }
  function docRef(c, id){
    return {
      id,
      async set(v){
        const val = JSON.parse(JSON.stringify(v));
        const {error} = await sb.from('docs').upsert({company_id:cid, coll:c, id, data:val, updated_at:new Date().toISOString()}, {onConflict:'company_id,coll,id'});
        if (error) throw appError(error);
        apply(c, id, val);
      },
      async update(patch){
        const p = JSON.parse(JSON.stringify(patch));
        const {error} = await sb.rpc('doc_patch', {cid, c, i:id, patch:p});
        if (error) throw appError(error);
        const cur = collMap(c).get(id);
        apply(c, id, Object.assign({}, cur || {}, p));
      },
      async delete(){
        const {error} = await sb.from('docs').delete().eq('company_id', cid).eq('coll', c).eq('id', id);
        if (error) throw appError(error);
        apply(c, id, null);
      },
      async get(){ await started; return docSnap(c, id); },
      onSnapshot(next, error){
        const k = c + '/' + id, s = {next, error};
        if (!docSubs.has(k)) docSubs.set(k, new Set());
        docSubs.get(k).add(s);
        if (loaded){ pending.add(k); queueFlush(); }
        return () => docSubs.get(k).delete(s);
      }
    };
  }
  return {
    doc(path){ const [c, id] = split(path); return docRef(c, id); },
    collection(c){
      return {
        doc(id){ return docRef(c, id || newId()); },
        async add(v){ const r = docRef(c, newId()); await r.set(v); return r; },
        async get(){ await started; return collSnap(c); },
        onSnapshot(next, error){
          const s = {next, error};
          if (!collSubs.has(c)) collSubs.set(c, new Set());
          collSubs.get(c).add(s);
          if (loaded){ pending.add(c); queueFlush(); }
          return () => collSubs.get(c).delete(s);
        }
      };
    },
    ready: started
  };
}

/* ---------- the runtime the app asks for ---------- */
let resolveReady; const ready = new Promise(r => { resolveReady = r; });
let dbInstance = null;
const runtime = {
  db(){ return dbInstance || (dbInstance = makeDb(S.company.id)); },
  user(){
    return {
      isOwner: async () => S.role === 'owner',
      canEdit: async () => S.role === 'owner' || S.role === 'admin',
      can: async what => what === 'data.write' ? S.role !== 'viewer' : true,
      email: S.user && S.user.email
    };
  },
  downloads(){
    return {
      async save({filename, data}){
        const blob = data instanceof Blob ? data : new Blob([data], {type: /\.html?$/.test(filename) ? 'text/html' : /\.csv$/.test(filename) ? 'text/csv' : /\.json$/.test(filename) ? 'application/json' : 'application/octet-stream'});
        const url = URL.createObjectURL(blob);
        const a = h('a', {href:url, download:filename, style:'display:none'});
        document.body.append(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 60000);
      }
    };
  },
  assets(){
    return {
      async upload(blob, opts){
        const type = (opts && opts.type) || blob.type || 'image/jpeg';
        const ext = type === 'image/png' ? 'png' : type === 'image/webp' ? 'webp' : 'jpg';
        const path = S.company.id + '/' + newId() + '.' + ext;
        const {error} = await sb.storage.from('photos').upload(path, blob, {contentType:type, cacheControl:'31536000'});
        if (error) throw appError(error);
        return {id:path};
      }
    };
  }
};
window.claude = {
  async use(name){
    await ready;
    if (!runtime[name]) throw new Error('Not available: ' + name);
    return runtime[name]();
  }
};

/* ---------- sign-in gate ---------- */
const css = `
#gate{position:fixed;inset:0;z-index:60;background:var(--bg,#09090b);color:var(--ink,#f6f6f8);overflow:auto;display:flex;justify-content:center;align-items:flex-start;padding:max(48px,env(safe-area-inset-top)) 16px 40px}
#gate .gbox{width:100%;max-width:420px}
#gate .glogo{display:flex;align-items:center;gap:12px;margin:0 0 26px}
#gate .glogo img{width:52px;height:52px;border-radius:15px;box-shadow:0 8px 24px rgba(229,25,43,.4)}
#gate .glogo b{display:block;font-family:'Bricolage Grotesque','IBM Plex Sans',system-ui,sans-serif;font-size:26px;letter-spacing:-.02em;line-height:1.1}
#gate .glogo span{color:var(--muted,#9a9aa6);font-size:14px}
#gate h2{font-family:'Bricolage Grotesque','IBM Plex Sans',system-ui,sans-serif;font-size:24px;margin:0 0 6px;letter-spacing:-.02em}
#gate p{color:var(--muted,#9a9aa6);margin:0 0 18px;font-size:14.5px}
#gate .gcard{background:var(--surface,#131316);border:1px solid var(--line,#27272e);border-radius:22px;padding:20px}
#gate .gtabs{display:flex;gap:4px;background:var(--surface2,#1c1c21);border-radius:14px;padding:4px;margin-bottom:16px}
#gate .gtabs button{flex:1;border:0;background:none;border-radius:11px;padding:9px;font-weight:600;color:var(--muted,#9a9aa6);cursor:pointer}
#gate .gtabs button[aria-selected="true"]{background:var(--accent,#e5192b);color:#fff}
#gate .btn{width:100%;padding:13px;font-size:15px}
#gate .glink{background:none;border:0;color:var(--accent-text,#ff5a64);font-weight:600;cursor:pointer;padding:10px 0 0;font-size:14px}
#gate .gmsg{font-size:14px;margin:0 0 12px;min-height:0}
#gate .gmsg.bad{color:var(--bad,#ff6b6b)} #gate .gmsg.good{color:var(--ok,#3ddc97)}
#gate .gco{display:flex;align-items:center;gap:12px;width:100%;text-align:left;background:var(--surface2,#1c1c21);border:1px solid var(--line,#27272e);border-radius:16px;padding:12px;margin-bottom:8px;cursor:pointer;color:inherit}
#gate .gco img{width:40px;height:40px;border-radius:12px;object-fit:cover}
#gate .gco small{display:block;color:var(--muted,#9a9aa6)}
#gate .ginvite{background:var(--accent-soft,rgba(229,25,43,.16));border:1px solid rgba(229,25,43,.4);border-radius:14px;padding:10px 12px;margin:0 0 14px;font-size:14px}
.acct .mem{display:flex;align-items:center;gap:8px;padding:10px 0;border-top:1px solid var(--line)}
.acct .mem .who{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:14px}
.acct select{padding:10px 8px;border:1px solid var(--line);border-radius:12px;background:#0b0b0d;color:var(--ink);font-size:15px}
.acct .mem select{padding:7px 8px;border-radius:10px;font-size:14px}
.top h1{overflow:hidden}
.top h1 .b1{overflow:hidden;text-overflow:ellipsis}
#acctBtn{display:inline-grid;place-items:center;width:34px;height:34px;padding:0;border-radius:50%}
#acctBtn svg{width:19px;height:19px;fill:none;stroke:currentColor;stroke-width:1.9;stroke-linecap:round}
.acct .sec{margin:18px 0 6px;font-weight:700;font-size:15px}
.acct .linkbox{display:flex;gap:6px;margin:8px 0}
.acct .linkbox input{flex:1;min-width:0;padding:10px;border:1px solid var(--line);border-radius:12px;background:#0b0b0d;font-size:13px}
.acct .logo-row{display:flex;align-items:center;gap:12px;margin:6px 0 12px}
.acct .logo-row img{width:56px;height:56px;border-radius:14px;object-fit:cover;background:#000}
#supportBar{position:sticky;top:0;z-index:8;display:flex;align-items:center;justify-content:center;gap:10px;background:var(--accent,#e5192b);color:#fff;font-size:13px;font-weight:600;padding:calc(6px + env(safe-area-inset-top,0px)) 12px 6px}
#supportBar button{background:rgba(0,0,0,.28);color:#fff;border:0;border-radius:999px;padding:4px 12px;font-weight:600;font-size:12.5px;cursor:pointer}
#supportFrame{position:fixed;inset:0;border:3px solid var(--accent,#e5192b);pointer-events:none;z-index:70}
#gate .gsearch{width:100%;padding:11px 13px;border:1px solid var(--line,#27272e);border-radius:14px;background:#0b0b0d;color:inherit;font-size:16px;margin:0 0 10px}
#gate .gsec{font-size:12.5px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--muted,#9a9aa6);margin:16px 0 8px}
`;
document.head.append(h('style', {}, css));

let gateEl = null;
function gate(...content){
  if (!gateEl){ gateEl = h('div', {id:'gate', role:'dialog', 'aria-modal':'true'}); document.body.append(gateEl); document.body.classList.add('locked'); }
  gateEl.replaceChildren(h('div', {class:'gbox'},
    h('div', {class:'glogo'}, h('img', {src:'icons/icon.svg', alt:''}), h('div', {}, h('b', {}, 'Stockroom'), h('span', {}, 'Inventory, orders and sales for your business'))),
    content));
  const f = gateEl.querySelector('input'); if (f && !gateEl.contains(document.activeElement)) f.focus();
}
function closeGate(){ if (gateEl){ gateEl.remove(); gateEl = null; document.body.classList.remove('locked'); } }
function field(label, input, hint){
  return h('label', {class:'field'}, h('span', {class:'lbl'}, label), input, hint ? h('span', {class:'hint'}, hint) : null);
}
function msgEl(){ return h('p', {class:'gmsg', role:'status'}); }
function say(el, text, kind){ el.textContent = text || ''; el.className = 'gmsg' + (kind ? ' ' + kind : ''); }
async function busy(btn, fn){
  const t = btn.textContent; btn.disabled = true; btn.textContent = 'Please wait…';
  try { return await fn(); } finally { btn.disabled = false; btn.textContent = t; }
}

function pendingInvite(){
  const q = new URLSearchParams(location.search).get('invite');
  if (q){ lsSet(LS_INVITE, q); history.replaceState(null, '', siteUrl() + location.hash); }
  return lsGet(LS_INVITE);
}
// Fills the invite notice once its details load; the form around it is not redrawn, so typing is never lost.
let inviteInfo = null;
function inviteBanner(code){
  const box = h('div', {});
  if (!code) return box;
  const fill = r => {
    if (!r) box.replaceChildren(h('div', {class:'ginvite'}, 'That invite link is not valid. Ask for a new one.'));
    else if (!r.valid) box.replaceChildren(h('div', {class:'ginvite'}, 'That invite to ', h('b', {}, r.company_name), ' has expired or was already used. Ask for a new one.'));
    else box.replaceChildren(h('div', {class:'ginvite'}, 'You are invited to join ', h('b', {}, r.company_name), ' as ', (ROLES[r.role]||{}).label || r.role, '. Sign in or create an account to accept.'));
  };
  if (inviteInfo && inviteInfo.code === code) fill(inviteInfo.row);
  else sb.rpc('invite_info', {invite_code:code}).then(({data, error}) => {
    if (error) return;
    inviteInfo = {code, row:data && data[0]}; fill(inviteInfo.row);
  }, () => {});
  return box;
}

function showSignIn(mode){
  const banner = inviteBanner(pendingInvite());
  const email = h('input', {type:'email', autocomplete:'email', required:true, inputmode:'email', autocapitalize:'off', spellcheck:'false'});
  const pass = h('input', {type:'password', autocomplete: mode==='signup' ? 'new-password' : 'current-password', required:true, minlength:'8'});
  const m = msgEl();
  const go = h('button', {class:'btn primary', type:'submit'}, mode==='signup' ? 'Create account' : 'Sign in');
  const form = h('form', {onsubmit: async e => {
    e.preventDefault(); say(m, '');
    await busy(go, async () => {
      if (mode === 'signup'){
        if (pass.value.length < 8){ say(m, 'Use at least 8 characters for your password.', 'bad'); return; }
        const {data, error} = await sb.auth.signUp({email:email.value.trim(), password:pass.value, options:{emailRedirectTo:siteUrl()}});
        if (error){ say(m, err(error), 'bad'); return; }
        if (!data.session){ showCheckEmail(email.value.trim()); return; }
      } else {
        const {error} = await sb.auth.signInWithPassword({email:email.value.trim(), password:pass.value});
        if (error){ say(m, /invalid/i.test(error.message) ? 'Wrong email or password.' : /confirm/i.test(error.message) ? 'Confirm your email first. Check your inbox for the link.' : err(error), 'bad'); return; }
      }
      await afterSignIn();
    });
  }},
    field('Email', email),
    field('Password', pass, mode==='signup' ? 'At least 8 characters.' : null),
    m, go,
    mode==='signin' ? h('button', {class:'glink', type:'button', onclick:() => showForgot(email.value)}, 'Forgot password?') : null);
  gate(
    banner,
    h('div', {class:'gcard'},
      h('div', {class:'gtabs', role:'tablist'},
        h('button', {type:'button', role:'tab', 'aria-selected':String(mode==='signin'), onclick:() => showSignIn('signin')}, 'Sign in'),
        h('button', {type:'button', role:'tab', 'aria-selected':String(mode==='signup'), onclick:() => showSignIn('signup')}, 'Create account')),
      form));
}
function showCheckEmail(addr){
  gate(h('div', {class:'gcard'}, h('h2', {}, 'Check your email'),
    h('p', {}, 'We sent a link to ', h('b', {}, addr), '. Open it on this device to finish creating your account.'),
    h('button', {class:'btn', type:'button', onclick:() => showSignIn('signin')}, 'Back to sign in')));
}
function showForgot(prefill){
  const email = h('input', {type:'email', autocomplete:'email', required:true, value:prefill||''});
  const m = msgEl(); const go = h('button', {class:'btn primary', type:'submit'}, 'Send reset link');
  gate(h('div', {class:'gcard'}, h('h2', {}, 'Reset your password'), h('p', {}, 'We will email you a link to choose a new password.'),
    h('form', {onsubmit: async e => {
      e.preventDefault();
      await busy(go, async () => {
        const {error} = await sb.auth.resetPasswordForEmail(email.value.trim(), {redirectTo:siteUrl()});
        if (error) say(m, err(error), 'bad'); else say(m, 'If that email has an account, a reset link is on its way.', 'good');
      });
    }}, field('Email', email), m, go),
    h('button', {class:'glink', type:'button', onclick:() => showSignIn('signin')}, 'Back to sign in')));
}
function showNewPassword(){
  const pass = h('input', {type:'password', autocomplete:'new-password', required:true, minlength:'8'});
  const m = msgEl(); const go = h('button', {class:'btn primary', type:'submit'}, 'Save new password');
  gate(h('div', {class:'gcard'}, h('h2', {}, 'Choose a new password'),
    h('form', {onsubmit: async e => {
      e.preventDefault();
      if (pass.value.length < 8){ say(m, 'Use at least 8 characters.', 'bad'); return; }
      await busy(go, async () => {
        const {error} = await sb.auth.updateUser({password:pass.value});
        if (error){ say(m, err(error), 'bad'); return; }
        location.replace(siteUrl());
      });
    }}, field('New password', pass, 'At least 8 characters.'), m, go)));
}

async function loadMemberships(){
  const {data, error} = await sb.from('members').select('role, company_id, companies(id, name, logo)').eq('user_id', S.user.id);
  if (error) throw error;
  S.memberships = (data || []).filter(r => r.companies).map(r => ({role:r.role, company:r.companies}))
    .sort((a, b) => a.company.name.localeCompare(b.company.name));
  return S.memberships;
}
function showCreateCompany(first){
  const name = h('input', {type:'text', required:true, maxlength:'80', autocomplete:'organization', placeholder:'e.g. Superior Supply'});
  const m = msgEl(); const go = h('button', {class:'btn primary', type:'submit'}, 'Create company');
  gate(h('div', {class:'gcard'},
    h('h2', {}, first ? 'Set up your company' : 'Add a company'),
    h('p', {}, first ? 'Your inventory, customers and sales are kept private to your company. You can invite your team next.' : 'Each company has its own separate inventory and team.'),
    h('form', {onsubmit: async e => {
      e.preventDefault();
      if (!name.value.trim()){ say(m, 'Enter a company name.', 'bad'); return; }
      await busy(go, async () => {
        const {data:cid, error} = await sb.rpc('create_company', {company_name:name.value.trim()});
        if (error){ say(m, err(error), 'bad'); return; }
        lsSet(LS_COMPANY, cid); await afterSignIn();
      });
    }}, field('Company name', name), m, go),
    h('p', {style:'margin:16px 0 0;font-size:13.5px'}, 'Joining someone else’s company? Open the invite link they sent you.'),
    first ? null : h('button', {class:'glink', type:'button', onclick:() => afterSignIn()}, 'Cancel'),
    h('button', {class:'glink', type:'button', style:'display:block', onclick:signOut}, 'Sign out (' + (S.user.email || '') + ')')));
}
function showPicker(){
  gate(h('div', {class:'gcard'}, h('h2', {}, 'Choose a company'),
    S.memberships.map(mb => h('button', {class:'gco', type:'button', onclick:() => { lsSet(LS_COMPANY, mb.company.id); enter(mb); }},
      h('img', {src: mb.company.logo || monogram(mb.company.name), alt:''}),
      h('div', {}, h('b', {}, mb.company.name), h('small', {}, ROLES[mb.role].label)))),
    S.isSupport ? h('button', {class:'btn', type:'button', style:'margin-top:8px', onclick:showSupportList}, 'Support: open any company') : null,
    h('button', {class:'glink', type:'button', onclick:() => showCreateCompany(false)}, '+ Add a company'),
    h('button', {class:'glink', type:'button', style:'display:block', onclick:signOut}, 'Sign out')));
}
async function showSupportList(){
  const q = h('input', {class:'gsearch', type:'search', placeholder:'Search by company or owner email', autocomplete:'off', 'aria-label':'Search companies'});
  const list = h('div', {}, h('p', {}, 'Loading companies…'));
  gate(h('div', {class:'gcard'}, h('h2', {}, 'Support'),
    h('p', {}, 'Open any company to help fix something. You will have admin powers there, and the owner can see that you opened it.'),
    q, list,
    h('button', {class:'glink', type:'button', onclick:() => S.memberships.length ? showPicker() : afterSignIn()}, 'Back')));
  const {data, error} = await sb.rpc('support_companies');
  if (error){ list.replaceChildren(h('p', {}, err(error))); return; }
  const draw = () => {
    const t = q.value.trim().toLowerCase();
    const rows = (data || []).filter(c => !t || c.name.toLowerCase().includes(t) || String(c.owner_email || '').toLowerCase().includes(t));
    list.replaceChildren(...(rows.length ? rows.map(c => h('button', {class:'gco', type:'button', onclick:() => enterSupport(c.id)},
      h('img', {src: c.logo || monogram(c.name), alt:''}),
      h('div', {}, h('b', {}, c.name), h('small', {}, (c.owner_email || 'no owner') + ' \u00b7 ' + c.members + ' ' + (c.members == 1 ? 'person' : 'people'))))) : [h('p', {}, 'No companies match.')]));
  };
  q.addEventListener('input', draw); draw();
}
async function enterSupport(cid){
  if (S.company){ lsSet(LS_COMPANY, cid); location.reload(); return; }   // switching: reopen fresh, logged once on load
  const {data, error} = await sb.rpc('support_open', {cid});
  const c = data && data[0];
  if (error || !c){ lsSet(LS_COMPANY, ''); gate(h('div', {class:'gcard'}, h('h2', {}, 'Could not open'), h('p', {}, err(error, 'That company no longer exists.')),
    h('button', {class:'btn primary', type:'button', onclick:() => afterSignIn()}, 'Continue'))); return; }
  lsSet(LS_COMPANY, c.id);
  enter({role:'admin', company:{id:c.id, name:c.name, logo:c.logo}, support:true});
}

async function afterSignIn(){
  const {data:{user}} = await sb.auth.getUser();
  if (!user){ showSignIn('signin'); return; }
  S.user = user;
  const code = pendingInvite();
  if (code){
    const {data:cid, error} = await sb.rpc('accept_invite', {invite_code:code});
    lsSet(LS_INVITE, '');
    if (error){
      gate(h('div', {class:'gcard'}, h('h2', {}, 'Could not join'), h('p', {}, err(error)),
        h('button', {class:'btn primary', type:'button', onclick:() => afterSignIn()}, 'Continue')));
      return;
    }
    lsSet(LS_COMPANY, cid);
  }
  let list;
  try { list = await loadMemberships(); }
  catch(e){
    gate(h('div', {class:'gcard'}, h('h2', {}, 'Could not connect'), h('p', {}, 'Check your internet connection and try again.'),
      h('button', {class:'btn primary', type:'button', onclick:() => afterSignIn()}, 'Try again')));
    return;
  }
  try { S.isSupport = (await sb.rpc('is_platform_admin')).data === true; } catch(e){ S.isSupport = false; }
  const last = lsGet(LS_COMPANY);
  if (S.isSupport && last && !list.some(x => x.company.id === last)){ await enterSupport(last); return; }
  if (!list.length){ if (S.isSupport) showPicker(); else showCreateCompany(true); return; }
  const pick = list.find(x => x.company.id === last) || (list.length === 1 && !S.isSupport ? list[0] : null);
  if (pick) enter(pick); else showPicker();
}
function enter(mb){
  if (S.company){ location.reload(); return; }   // switching company: start fresh
  S.company = mb.company; S.role = mb.role; S.support = !!mb.support;
  closeGate();
  if (S.support){
    document.body.prepend(h('div', {id:'supportBar', role:'status'}, 'Support mode \u00b7 ' + mb.company.name,
      h('button', {type:'button', onclick:() => { lsSet(LS_COMPANY, ''); location.replace(siteUrl()); }}, 'Exit')));
    document.body.append(h('div', {id:'supportFrame', 'aria-hidden':'true'}));
  }
  applyBrand();
  resolveReady();
}
function applyBrand(){
  const name = S.brand(), logo = S.logo();
  document.title = name + ' x Stockroom';
  document.querySelectorAll('.top h1 .b1, .sidebrand b').forEach(e => { e.textContent = name; });
  document.querySelectorAll('img.logo').forEach(i => { i.src = logo; });
  if (typeof window.onBrandChange === 'function') window.onBrandChange(name, logo);
}
async function signOut(){
  try { await sb.auth.signOut(); } catch(e){}
  lsSet(LS_COMPANY, '');
  location.replace(siteUrl());
}

/* ---------- account & team sheet ---------- */
function sheet(title, body){
  const close = () => { back.remove(); document.body.classList.remove('locked'); };
  const back = h('div', {class:'backdrop', onclick: e => { if (e.target === back) close(); }},
    h('div', {class:'sheet acct', role:'dialog', 'aria-modal':'true', 'aria-label':title},
      h('div', {class:'sheet-head'}, h('h2', {}, title), h('button', {class:'icon-btn', type:'button', 'aria-label':'Close', onclick:close}, '×')),
      h('div', {class:'sheet-body'}, body)));
  document.body.append(back); document.body.classList.add('locked');
  return close;
}
function toast(t){ const el = document.getElementById('toast'); if (!el) return; el.textContent = t; el.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => { el.hidden = true; }, 2600); }
const isManager = () => S.role === 'owner' || S.role === 'admin';

async function openAccount(){
  const body = h('div', {});
  const close = sheet('Account', body);
  const m = msgEl();
  const parts = [];

  // Company
  parts.push(h('div', {class:'sec'}, 'Company'));
  if (isManager()){
    const name = h('input', {type:'text', maxlength:'80', value:S.company.name});
    const img = h('img', {src:S.logo(), alt:'Company logo'});
    const file = h('input', {type:'file', accept:'image/*', style:'display:none'});
    file.addEventListener('change', async () => {
      const f = file.files && file.files[0]; if (!f) return;
      try {
        const logo = await resizeImage(f, 256);
        const {error} = await sb.from('companies').update({logo}).eq('id', S.company.id);
        if (error) throw error;
        S.company.logo = logo; img.src = logo; applyBrand(); toast('Logo updated');
      } catch(e){ say(m, 'Could not update the logo. ' + err(e, ''), 'bad'); }
      file.value = '';
    });
    parts.push(
      h('div', {class:'logo-row'}, img,
        h('button', {class:'btn', type:'button', onclick:() => file.click()}, 'Change logo'),
        S.company.logo ? h('button', {class:'linkdanger', type:'button', onclick: async () => {
          const {error} = await sb.from('companies').update({logo:null}).eq('id', S.company.id);
          if (!error){ S.company.logo = null; img.src = S.logo(); applyBrand(); }
        }}, 'Remove') : null, file),
      h('form', {class:'linkbox', onsubmit: async e => {
        e.preventDefault(); const v = name.value.trim(); if (!v) return;
        const {error} = await sb.from('companies').update({name:v}).eq('id', S.company.id);
        if (error){ say(m, err(error), 'bad'); return; }
        S.company.name = v; applyBrand(); toast('Company name saved');
      }}, name, h('button', {class:'btn', type:'submit'}, 'Save name')));
  } else {
    parts.push(h('p', {}, h('b', {}, S.company.name), ' · you are ', ROLES[S.role].label));
  }

  // Team
  const team = h('div', {});
  parts.push(h('div', {class:'sec'}, 'Team'), team);
  async function drawTeam(){
    const [{data:mem}, inv] = await Promise.all([
      sb.from('members').select('user_id, role, email, created_at').eq('company_id', S.company.id).order('created_at'),
      isManager() ? sb.from('invites').select('code, role, expires_at, used_at').eq('company_id', S.company.id).is('used_at', null).gt('expires_at', new Date().toISOString()).order('created_at') : Promise.resolve({data:[]})
    ]);
    const rows = (mem || []).map(x => {
      const me = x.user_id === S.user.id;
      const canChange = isManager() && x.role !== 'owner' && !me && (S.role === 'owner' || x.role !== 'admin');
      const sel = canChange ? h('select', {'aria-label':'Role for ' + (x.email || 'member'), onchange: async () => {
        const {error} = await sb.rpc('set_member_role', {cid:S.company.id, member:x.user_id, new_role:sel.value});
        if (error){ say(m, err(error), 'bad'); sel.value = x.role; } else { x.role = sel.value; toast('Role updated'); }
      }}, ['admin','staff','viewer'].filter(r => S.role === 'owner' || r !== 'admin' || x.role === 'admin')
          .map(r => h('option', {value:r, selected: r === x.role}, ROLES[r].label))) : h('span', {class:'tbadge'}, ROLES[x.role].label);
      const rm = canChange ? h('button', {class:'linkdanger', type:'button', onclick: async () => {
        if (!confirm('Remove ' + (x.email || 'this person') + ' from ' + S.company.name + '?')) return;
        const {error} = await sb.rpc('remove_member', {cid:S.company.id, member:x.user_id});
        if (error) say(m, err(error), 'bad'); else drawTeam();
      }}, 'Remove') : null;
      return h('div', {class:'mem'}, h('span', {class:'who'}, (x.email || 'Member') + (me ? ' (you)' : '')), sel, rm);
    });
    const kids = [rows];
    if (isManager()){
      const role = h('select', {'aria-label':'Role for new person'},
        ['staff','viewer'].concat(S.role === 'owner' ? ['admin'] : []).map(r => h('option', {value:r}, ROLES[r].label)));
      const note = h('span', {class:'hint'}, ROLES.staff.note);
      role.addEventListener('change', () => { note.textContent = ROLES[role.value].note; });
      const out = h('div', {});
      kids.push(h('div', {class:'sec', style:'font-size:14px'}, 'Invite someone'),
        h('div', {class:'linkbox'}, role, h('button', {class:'btn primary', type:'button', onclick: async () => {
          const {data:code, error} = await sb.rpc('create_invite', {cid:S.company.id, invite_role:role.value});
          if (error){ say(m, err(error), 'bad'); return; }
          const link = siteUrl() + '?invite=' + code;
          const inp = h('input', {type:'text', readonly:true, value:link, onfocus: e => e.target.select()});
          out.replaceChildren(h('p', {class:'hint', style:'margin:8px 0 0'}, 'Send this link to the person. It works once and expires in 7 days.'),
            h('div', {class:'linkbox'}, inp, h('button', {class:'btn', type:'button', onclick: async () => {
              try {
                if (navigator.share) await navigator.share({title:'Join ' + S.company.name + ' on Stockroom', url:link});
                else { await navigator.clipboard.writeText(link); toast('Link copied'); }
              } catch(e){ inp.select(); }
            }}, navigator.share ? 'Share' : 'Copy')));
        }}, 'Create invite link')), note, out);
      const open = (inv && inv.data) || [];
      if (open.length) kids.push(h('p', {class:'hint', style:'margin-top:10px'}, open.length + ' unused invite link' + (open.length>1?'s':'') + '. ',
        h('button', {class:'linkdanger', type:'button', onclick: async () => {
          await sb.from('invites').delete().eq('company_id', S.company.id).is('used_at', null);
          toast('Unused links cancelled'); drawTeam();
        }}, 'Cancel them')));
    }
    team.replaceChildren(...kids.flat());
  }
  drawTeam().catch(() => say(m, 'Could not load the team.', 'bad'));

  // Support history
  if (isManager()){
    const hist = h('div', {});
    parts.push(hist);
    sb.from('support_log').select('admin_email, opened_at').eq('company_id', S.company.id).order('opened_at', {ascending:false}).limit(5)
      .then(({data}) => {
        if (!data || !data.length) return;
        hist.replaceChildren(h('div', {class:'sec'}, 'Support visits'),
          h('p', {class:'hint', style:'margin:0 0 6px'}, 'Times Stockroom support opened ' + S.company.name + ' to help.'),
          ...data.map(r => h('div', {class:'mem hist'}, h('span', {class:'who'}, r.admin_email || 'Support'),
            h('span', {class:'hint', style:'margin:0'}, new Date(r.opened_at).toLocaleString(undefined, {month:'short', day:'numeric', hour:'numeric', minute:'2-digit'})))));
      }, () => {});
  }

  // Data import
  if (isManager()){
    const file = h('input', {type:'file', accept:'application/json,.json', style:'display:none'});
    const status = h('p', {class:'hint'});
    file.addEventListener('change', () => { const f = file.files && file.files[0]; file.value = ''; if (f) importFile(f, status); });
    parts.push(h('div', {class:'sec'}, 'Bring in data'),
      h('p', {class:'hint', style:'margin:0 0 8px'}, 'Import a Stockroom backup (.json) into ' + S.company.name + '. Records with the same ID are replaced; nothing else is deleted.'),
      h('button', {class:'btn', type:'button', onclick:() => file.click()}, 'Import a backup file'), file, status);
  }

  // Switch / you
  parts.push(h('div', {class:'sec'}, 'You'),
    h('p', {style:'margin:0 0 10px;font-size:14px'}, S.user.email || ''),
    h('div', {class:'foot'},
      h('button', {class:'btn', type:'button', onclick:() => { close(); showSwitch(); }}, S.memberships.length > 1 || S.isSupport ? 'Switch company' : 'Add a company'),
      h('button', {class:'btn danger', type:'button', onclick:signOut}, 'Sign out')),
    S.role !== 'owner' && !S.support ? h('button', {class:'linkdanger', type:'button', style:'margin-top:10px', onclick: async () => {
      if (!confirm('Leave ' + S.company.name + '? You will lose access until someone invites you again.')) return;
      const {error} = await sb.rpc('remove_member', {cid:S.company.id, member:S.user.id});
      if (error){ say(m, err(error), 'bad'); return; }
      lsSet(LS_COMPANY, ''); location.replace(siteUrl());
    }}, 'Leave this company') : null,
    m);
  body.append(...parts);
}
function showSwitch(){
  if (S.memberships.length > 1 || S.isSupport) showPicker(); else showCreateCompany(false);
}

/* ---------- import ---------- */
const COLLS = ['items','customers','sales','invoices','employees','shifts','settings'];
function b64ToBlob(b64, type){
  const bin = atob(b64), u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return new Blob([u], {type});
}
async function importFile(f, status){
  let j;
  try { j = JSON.parse(await f.text()); } catch(e){ status.textContent = 'That file is not a Stockroom backup.'; return; }
  const docs = {};   // coll -> {id: data}
  let photos = {}, logo = null;
  if (j && j.format === 'stockroom-import' && j.docs){
    for (const c of Object.keys(j.docs)) if (COLLS.includes(c)) docs[c] = j.docs[c];
    photos = j.photos || {}; logo = (j.company && j.company.logo) || null;
  } else if (j && j.format === 1 && Array.isArray(j.items)){
    for (const c of ['items','customers','sales','invoices']){
      docs[c] = {};
      for (const r of (j[c] || [])){ if (!r || !r.id) continue; const v = Object.assign({}, r); delete v.id; docs[c][r.id] = v; }
    }
    const st = j.settings || {}; docs.settings = {};
    if (st.brackets) docs.settings.brackets = st.brackets;
    if (st.orderSizes) docs.settings.orders = st.orderSizes;
    if (st.business) docs.settings.business = {text:st.business};
  } else { status.textContent = 'That file is not a Stockroom backup.'; return; }
  const total = Object.values(docs).reduce((n, o) => n + Object.keys(o).length, 0);
  if (!confirm('Import ' + total + ' records' + (Object.keys(photos).length ? ' and ' + Object.keys(photos).length + ' photos' : '') + ' into ' + S.company.name + '?')) return;
  try {
    const map = {}; let n = 0; const ids = Object.keys(photos);
    for (const old of ids){
      status.textContent = 'Uploading photos… ' + (++n) + ' of ' + ids.length;
      const path = S.company.id + '/' + newId() + '.jpg';
      const {error} = await sb.storage.from('photos').upload(path, b64ToBlob(photos[old], 'image/jpeg'), {contentType:'image/jpeg', cacheControl:'31536000'});
      if (error) throw error;
      map[old] = path;
    }
    const rows = [];
    for (const c of Object.keys(docs)) for (const [id, v] of Object.entries(docs[c])){
      const d = Object.assign({}, v);
      if (c === 'items' && d.photoId) d.photoId = map[d.photoId] || (d.photoId.indexOf('/') > 0 ? d.photoId : '');
      rows.push({company_id:S.company.id, coll:c, id:String(id), data:d});
    }
    for (let i = 0; i < rows.length; i += 200){
      status.textContent = 'Saving records… ' + Math.min(i + 200, rows.length) + ' of ' + rows.length;
      const {error} = await sb.from('docs').upsert(rows.slice(i, i + 200), {onConflict:'company_id,coll,id'});
      if (error) throw error;
    }
    if (logo && !S.company.logo){
      const {error} = await sb.from('companies').update({logo}).eq('id', S.company.id);
      if (!error){ S.company.logo = logo; applyBrand(); }
    }
    status.textContent = 'Imported ' + rows.length + ' records. Reloading…';
    setTimeout(() => location.reload(), 1200);
  } catch(e){ status.textContent = 'Import stopped: ' + err(e) + '. You can run it again safely.'; }
}

/* ---------- start ---------- */
function addAccountButton(){
  const top = document.querySelector('header.top');
  if (!top || document.getElementById('acctBtn')) return;
  const btn = h('button', {class:'linkbtn', id:'acctBtn', type:'button', 'aria-label':'Account and team', title:'Account and team', onclick:() => openAccount()});
  btn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8.5" r="3.8"/><path d="M4.5 20c.9-3.6 3.9-5.6 7.5-5.6s6.6 2 7.5 5.6"/></svg>';
  top.append(btn);
}
async function start(){
  if (!configured){
    gate(h('div', {class:'gcard'}, h('h2', {}, 'Almost there'),
      h('p', {}, 'This site is not connected to its database yet. Add your Supabase project URL and anon key to config.js.')));
    return;
  }
  addAccountButton();
  sb.auth.onAuthStateChange((event) => {
    if (event === 'PASSWORD_RECOVERY') setTimeout(showNewPassword, 0);
    if (event === 'SIGNED_OUT' && S.company) location.replace(siteUrl());
  });
  if (/type=recovery/.test(location.hash)) return;   // onAuthStateChange shows the new-password form
  const {data:{session}} = await sb.auth.getSession();
  if (session) await afterSignIn(); else showSignIn(pendingInvite() ? 'signup' : 'signin');
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => start());
else start();
})();
