// Connects a company's TikTok Shop and pulls its finance data (payouts and each order's fees).
// Deploy: Supabase dashboard -> Edge Functions -> deploy "tiktok" with this file (see SETUP.md), Verify JWT off.
// An hourly job calls it with action "auto" (see supabase/setup/tiktok_auto_sync.sql).
// Secrets: TIKTOK_APP_KEY, TIKTOK_APP_SECRET and TIKTOK_AUTH_URL (the app's authorization link from
// TikTok Shop Partner Center). SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY are provided by Supabase.
// The app's redirect URL in Partner Center is the site itself (https://stockroominc.com/); the site passes
// TikTok's code here with action "finish".
import { createClient } from "npm:@supabase/supabase-js@2.117.2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const env = (k: string) => (Deno.env.get(k) || "").trim();   // pasted secrets often carry a stray space or newline
const API = () => env("TIKTOK_API_BASE") || "https://open-api.tiktokglobalshop.com";
const AUTH = () => env("TIKTOK_AUTH_BASE") || "https://auth.tiktok-shops.com";
// Finance API versions to try, newest first. TikTok retires old versions, so a failing one falls back to the next.
const STATEMENT_VERSIONS = ["202309"];
const TRANSACTION_VERSIONS = ["202501", "202309"];
const FIRST_SYNC_DAYS = 90, OVERLAP_DAYS = 3, TIME_BUDGET_MS = 100_000, AUTO_BUDGET_MS = 130_000;

class Fail extends Error { status: number; constructor(status: number, msg: string) { super(msg); this.status = status; } }
function reply(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
async function hmac(secret: string, text: string) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(text)));
}

// TikTok's request signature: secret + path + sorted key/value pairs (+ body) + secret, HMAC-SHA256 with the secret.
async function tiktok(path: string, link: { access_token: string; shop_cipher?: string }, params: Record<string, string | number> = {}) {
  const q: Record<string, string> = { app_key: env("TIKTOK_APP_KEY"), timestamp: String(Math.floor(Date.now() / 1000)) };
  if (link.shop_cipher && !path.startsWith("/authorization/")) q.shop_cipher = link.shop_cipher;
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") q[k] = String(v);
  const base = Object.keys(q).sort().map((k) => k + q[k]).join("");
  const secret = env("TIKTOK_APP_SECRET");
  q.sign = await hmac(secret, secret + path + base + secret);
  const r = await fetch(API() + path + "?" + new URLSearchParams(q), {
    headers: { "x-tts-access-token": link.access_token, "content-type": "application/json" },
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.code !== 0) throw new Fail(502, "TikTok said: " + (j.message || r.statusText) + (j.code ? " (" + j.code + ")" : ""));
  return j.data || {};
}
// The first list of records in a response, whatever TikTok calls it.
const listIn = (d: Record<string, unknown>) =>
  (Object.values(d).find((v) => Array.isArray(v) && (v.length === 0 || typeof v[0] === "object")) || []) as Record<string, unknown>[];
const unixIso = (v: unknown) => { const n = Number(v); return n > 0 ? new Date(n * 1000).toISOString() : null; };

async function tokenCall(kind: "get" | "refresh", value: string) {
  const q = new URLSearchParams({ app_key: env("TIKTOK_APP_KEY"), app_secret: env("TIKTOK_APP_SECRET") });
  if (kind === "get") { q.set("auth_code", value); q.set("grant_type", "authorized_code"); }
  else { q.set("refresh_token", value); q.set("grant_type", "refresh_token"); }
  const r = await fetch(AUTH() + "/api/v2/token/" + kind + "?" + q);
  const j = await r.json().catch(() => ({}));
  if (j.code !== 0 || !j.data?.access_token) {
    const keys = /client_key|client_secret|app_key|app_secret|invalid app/i.test(j.message || "") ? " Check that TIKTOK_APP_KEY and TIKTOK_APP_SECRET in Supabase match the app in TikTok Partner Center." : "";
    throw new Fail(502, "TikTok did not accept the connection: " + (j.message || r.statusText) + "." + keys);
  }
  return {
    access_token: j.data.access_token, access_expires: unixIso(j.data.access_token_expire_in),
    refresh_token: j.data.refresh_token, refresh_expires: unixIso(j.data.refresh_token_expire_in),
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return reply(405, { error: "Use POST" });
  let body: { action?: string; company_id?: string; code?: string; state?: string };
  try { body = await req.json(); } catch { return reply(400, { error: "Send JSON" }); }
  if (!env("TIKTOK_APP_KEY") || !env("TIKTOK_APP_SECRET")) return reply(500, { error: "TikTok Shop is not set up yet (missing app key or secret)." });

  // As the signed-in person, so the database decides what they may do; and as the server, for tokens and data.
  const publicKey = req.headers.get("apikey") || env("SUPABASE_ANON_KEY");
  const user = createClient(env("SUPABASE_URL"), publicKey, {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } }, auth: { persistSession: false },
  });
  const admin = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
  const rpc = async (fn: string, args: Record<string, unknown>) => {
    const { data, error } = await user.rpc(fn, args);
    if (error) throw new Fail(403, error.message);
    return data;
  };

  try {
    if (body.action === "start") {
      if (!env("TIKTOK_AUTH_URL")) return reply(500, { error: "TikTok Shop is not set up yet (missing authorization link)." });
      const state = await rpc("tiktok_begin", { cid: body.company_id });
      const url = new URL(env("TIKTOK_AUTH_URL"));
      url.searchParams.set("state", state);
      return reply(200, { url: url.toString() });
    }

    if (body.action === "finish") {
      if (!body.code || !body.state) return reply(400, { error: "Missing code or state" });
      const cid = await rpc("tiktok_take_state", { st: body.state });
      const tok = await tokenCall("get", body.code);
      const shops = listIn(await tiktok("/authorization/202309/shops", tok));
      const shop = shops[0] as Record<string, string> | undefined;
      if (!shop) throw new Fail(502, "TikTok did not return a shop for this account.");
      const { data: who } = await user.auth.getUser();
      const { error } = await admin.from("tiktok_links").upsert({
        company_id: cid, shop_id: String(shop.id ?? ""), shop_name: shop.name ?? "", shop_cipher: shop.cipher ?? "", region: shop.region ?? "",
        ...tok, connected_by: who?.user?.id ?? null, connected_at: new Date().toISOString(), synced_at: null, sync_error: null,
      });
      if (error) throw new Fail(500, error.message);
      return reply(200, { shop_name: shop.name ?? "" });
    }

    if (body.action === "sync") {
      const cid = body.company_id;
      const st = await rpc("tiktok_status", { cid });   // owners and admins only
      if (st?.[0]?.enabled === false) return reply(403, { error: "TikTok Shop is not turned on for this company." });
      const { data: link } = await admin.from("tiktok_links").select("*").eq("company_id", cid).maybeSingle();
      if (!link) return reply(400, { error: "TikTok Shop is not connected." });
      try { return reply(200, await sync(admin, link)); }
      catch (e) {
        await admin.from("tiktok_links").update({ sync_error: String((e as Error).message) }).eq("company_id", cid);
        throw e;
      }
    }
    // The hourly job (supabase/setup/tiktok_auto_sync.sql): every connected company that has TikTok Shop on is
    // synced and its new lines added into the totals, so the page is up to date when it opens.
    if (body.action === "auto") {
      const { data: cron } = await admin.from("tiktok_cron").select("secret").maybeSingle();
      if (!cron?.secret || req.headers.get("x-cron-secret") !== cron.secret) return reply(403, { error: "Not allowed" });
      const started = Date.now();
      const { data: on } = await admin.from("tiktok_settings").select("company_id").eq("enabled", true);
      const { data: links } = await admin.from("tiktok_links").select("*").in("company_id", (on || []).map((r: { company_id: string }) => r.company_id));
      const companies = [];
      for (const link of links || []) {
        if (Date.now() - started > AUTO_BUDGET_MS) break;
        try {
          const r = await sync(admin, link);
          let left = 1;
          while (left > 0 && Date.now() - started < AUTO_BUDGET_MS) {
            const { data, error } = await admin.rpc("tiktok_prepare_lines", { cid: link.company_id, lim: 2000 });
            if (error) throw new Fail(500, error.message);
            left = Number(data);
          }
          companies.push({ company_id: link.company_id, ...r, left });
        } catch (e) {
          await admin.from("tiktok_links").update({ sync_error: String((e as Error).message) }).eq("company_id", link.company_id);
          companies.push({ company_id: link.company_id, error: String((e as Error).message) });
        }
      }
      return reply(200, { companies });
    }
    return reply(400, { error: "Unknown action" });
  } catch (e) {
    const status = e instanceof Fail ? e.status : 500;
    return reply(status, { error: String((e as Error)?.message ?? e) });
  }
});

// One sync at a time per shop: the page's sync, Sync now and the hourly job would otherwise write the same
// order lines together and wait on each other until the database gives up. A sync takes the shop for up to
// 3 minutes (longer than one sync runs); a second one meanwhile returns { busy: true } without doing anything.
// deno-lint-ignore no-explicit-any
async function sync(admin: any, link: any) {
  const { data: got, error } = await admin.rpc("tiktok_sync_begin", { cid: link.company_id });
  if (!error && !got) return { busy: true, more: false, statements: 0, synced: 0, left: 0, transactions: 0 };
  try { return await syncNow(admin, link); }
  finally { if (!error) await admin.rpc("tiktok_sync_end", { cid: link.company_id }); }
}

// deno-lint-ignore no-explicit-any
async function syncNow(admin: any, link: any) {
  const started = Date.now();
  if (!link.access_expires || new Date(link.access_expires).getTime() < Date.now() + 86_400_000) {
    if (link.refresh_expires && new Date(link.refresh_expires).getTime() < Date.now()) {
      throw new Fail(401, "The TikTok connection has expired. Disconnect and connect TikTok Shop again.");
    }
    Object.assign(link, await tokenCall("refresh", link.refresh_token));
    await admin.from("tiktok_links").update({
      access_token: link.access_token, access_expires: link.access_expires, refresh_token: link.refresh_token, refresh_expires: link.refresh_expires,
    }).eq("company_id", link.company_id);
  }
  // From a few days before the newest statement already pulled (statements can change until paid), or 90 days back.
  const { data: last } = await admin.from("tiktok_statements").select("statement_time").eq("company_id", link.company_id)
    .order("statement_time", { ascending: false }).limit(1).maybeSingle();
  const since = last?.statement_time ? new Date(last.statement_time).getTime() - OVERLAP_DAYS * 864e5 : Date.now() - FIRST_SYNC_DAYS * 864e5;

  const statements: Record<string, unknown>[] = [];
  let token = "";
  await firstWorking(STATEMENT_VERSIONS, async (v) => {
    statements.length = 0; token = "";
    do {
      const d = await tiktok(`/finance/${v}/statements`, link, {
        statement_time_ge: Math.floor(since / 1000), statement_time_lt: Math.floor(Date.now() / 1000) + 86400,
        sort_field: "statement_time", sort_order: "ASC", page_size: 100, page_token: token,
      });
      statements.push(...listIn(d)); token = String(d.next_page_token || "");
    } while (token);
  });
  const rows = statements.map((s) => ({ company_id: link.company_id, id: String(s.id), statement_time: unixIso(s.statement_time), data: s }));
  for (let i = 0; i < rows.length; i += 200) {
    const { error } = await admin.from("tiktok_statements").upsert(rows.slice(i, i + 200));
    if (error) throw new Fail(500, error.message);
  }

  // Pull the order breakdown for new or recent statements, and any an earlier sync ran out of time for.
  const { data: todo, error: te } = await admin.from("tiktok_statements").select("id, statement_time").eq("company_id", link.company_id)
    .or(`transactions_synced_at.is.null,statement_time.gte.${new Date(since).toISOString()}`).order("statement_time", { ascending: true });
  if (te) throw new Fail(500, te.message);
  let done = 0, transactions = 0, more = false;
  for (const s of todo) {
    if (Date.now() - started > TIME_BUDGET_MS) { more = true; break; }
    const tx: Record<string, unknown>[] = [];
    await firstWorking(TRANSACTION_VERSIONS, async (v) => {
      tx.length = 0; let t = "";
      do {
        const d = await tiktok(`/finance/${v}/statements/${s.id}/statement_transactions`, link, { sort_field: "order_create_time", page_size: 100, page_token: t });
        tx.push(...listIn(d)); t = String(d.next_page_token || "");
      } while (t);
    });
    const txRows = tx.map((x, i) => ({
      company_id: link.company_id, id: String(x.id ?? `${s.id}-${i}`), statement_id: s.id, order_id: String(x.order_id ?? ""),
      at: unixIso(x.order_create_time) || s.statement_time, data: slim(x),
    }));
    await saveLines(admin, txRows);
    await admin.from("tiktok_statements").update({ transactions_synced_at: new Date().toISOString() }).eq("company_id", link.company_id).eq("id", s.id);
    done++; transactions += txRows.length;
  }
  // A round that got this far worked, so any earlier error is cleared; synced_at is set once nothing is left.
  await admin.from("tiktok_links").update(more ? { sync_error: null } : { synced_at: new Date().toISOString(), sync_error: null }).eq("company_id", link.company_id);
  return { statements: rows.length, synced: done, left: todo.length - done, transactions, more };
}

// Saves order lines in batches. Each line written updates the running totals, so a batch can run past the
// database's time limit when it is busy (for example while the report page adds lines up); such a batch is
// retried smaller after a moment.
// deno-lint-ignore no-explicit-any
async function saveLines(admin: any, rows: Record<string, unknown>[]) {
  let size = 100;
  for (let i = 0; i < rows.length;) {
    const { error } = await admin.from("tiktok_transactions").upsert(rows.slice(i, i + size));
    if (!error) { i += size; continue; }
    if (!/timeout/i.test(error.message) || size <= 5) throw new Fail(500, error.message);
    size = Math.max(5, Math.floor(size / 2));
    await new Promise((r) => setTimeout(r, 1000));
  }
}

// What Stockroom keeps of an order line: every "*_amount" field where it sits (the report and order detail use
// those) and the line's own short top-level fields (type, ids, times). TikTok's full record is several KB per
// line; for a busy shop that filled the database, so lists and other nested detail are left out.
// deno-lint-ignore no-explicit-any
function slim(o: any, top = true): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o || {})) {
    if (/_amount$/.test(k)) out[k] = v;
    else if (v && typeof v === "object" && !Array.isArray(v)) { const s = slim(v, false); if (Object.keys(s).length) out[k] = s; }
    else if (top && (typeof v === "number" || typeof v === "boolean" || (typeof v === "string" && v.length <= 200))) out[k] = v;
  }
  return out;
}

// Runs fn with each API version until one works; remembers nothing, so a retired version costs one failed call.
async function firstWorking(versions: string[], fn: (v: string) => Promise<void>) {
  let last: unknown = null;
  for (const v of versions) {
    try { await fn(v); return v; } catch (e) { last = e; if (!(e instanceof Fail)) throw e; }
  }
  throw last;
}
