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
// With a body the call is a POST and the JSON body is part of the signature.
async function tiktok(path: string, link: { access_token: string; shop_cipher?: string }, params: Record<string, string | number> = {}, body?: unknown) {
  const q: Record<string, string> = { app_key: env("TIKTOK_APP_KEY"), timestamp: String(Math.floor(Date.now() / 1000)) };
  if (link.shop_cipher && !path.startsWith("/authorization/")) q.shop_cipher = link.shop_cipher;
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") q[k] = String(v);
  const base = Object.keys(q).sort().map((k) => k + q[k]).join("");
  const secret = env("TIKTOK_APP_SECRET");
  const json = body === undefined ? "" : JSON.stringify(body);
  q.sign = await hmac(secret, secret + path + base + json + secret);
  const r = await fetch(API() + path + "?" + new URLSearchParams(q), {
    method: body === undefined ? "GET" : "POST", body: body === undefined ? undefined : json,
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
  let body: { action?: string; company_id?: string; code?: string; state?: string; since?: number; page_token?: string; by?: string; days?: number };
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
    // Live orders for the TV dashboard: orders placed since `since` (unix seconds), newest first, a page of
    // up to 100 at a time for as many pages as fit in a few seconds. With by: "update", orders changed since
    // then instead (shipped, delivered), for the order map. Needs the Order permission on the TikTok app (the
    // shop reconnects after it is added). Only what the dashboard shows is returned: for where an order is
    // going, the city, state and the first 3 digits of the ZIP code, never the name or street.
    if (body.action === "orders") {
      const cid = body.company_id;
      const st = await rpc("tiktok_status", { cid });   // owners and admins only
      if (st?.[0]?.enabled === false) return reply(403, { error: "TikTok Shop is not turned on for this company." });
      const { data: link } = await admin.from("tiktok_links").select("*").eq("company_id", cid).maybeSingle();
      if (!link) return reply(400, { error: "TikTok Shop is not connected." });
      await freshToken(admin, link);
      const since = Math.max(0, Math.floor(Number(body.since) || 0));
      const orders: Record<string, unknown>[] = [];
      let token = String(body.page_token || ""), pages = 0;
      const started = Date.now();
      try {
        do {
          const byUpdate = body.by === "update";
          const d = await tiktok("/order/202309/orders/search", link,
            { page_size: 100, sort_field: byUpdate ? "update_time" : "create_time", sort_order: "DESC", page_token: token },
            byUpdate ? { update_time_ge: since } : { create_time_ge: since });
          // deno-lint-ignore no-explicit-any
          for (const o of (d.orders || []) as any[]) {
            const p = o.payment || {};
            // deno-lint-ignore no-explicit-any
            const items = ((o.line_items || []) as any[]).map((l) => ({ name: String(l.product_name || ""), sku: String(l.sku_name || ""), price: Number(l.sale_price) || 0, image: String(l.sku_image || "") }));
            const ad = o.recipient_address || {};
            // deno-lint-ignore no-explicit-any
            const lvl = (n: string) => String(((ad.district_info || []) as any[]).find((x) => x.address_level === n || String(x.address_level_name || "").toLowerCase() === ({ L1: "state", L3: "city" } as Record<string, string>)[n])?.address_name || "");
            orders.push({ id: String(o.id), t: Number(o.create_time) || 0, ut: Number(o.update_time) || 0, status: String(o.status || ""),
              state: lvl("L1"), city: lvl("L3"), zip3: String(ad.postal_code || "").replace(/\D/g, "").slice(0, 3),
              gmv: Number(p.original_total_product_price ?? p.sub_total) || items.reduce((a, l) => a + l.price, 0),
              paid: Number(p.total_amount) || 0, items });
          }
          token = String(d.next_page_token || ""); pages++;
        } while (token && pages < 20 && Date.now() - started < 8000);
      } catch (e) {
        const m = String((e as Error).message);
        if (/scope|permission|authori[sz]|not allowed|access denied/i.test(m))
          throw new Fail(403, "TikTok has not given Stockroom access to orders yet. Add the Order permission to the app in TikTok Partner Center, then disconnect and connect TikTok Shop again. (" + m + ")");
        throw e;
      }
      return reply(200, { orders, next_page_token: token });
    }

    // Squishy City: each product's TikTok units over the last `days` days (TikTok's day, Pacific time). Adds up
    // days not done yet (and today and yesterday again) for as long as fits in a few seconds; the page calls
    // again while `missing` is above 0.
    if (body.action === "city") {
      const cid = body.company_id;
      const st = await rpc("tiktok_status", { cid });   // owners and admins only
      if (st?.[0]?.enabled === false) return reply(403, { error: "TikTok Shop is not turned on for this company." });
      const { data: link } = await admin.from("tiktok_links").select("*").eq("company_id", cid).maybeSingle();
      if (!link) return reply(400, { error: "TikTok Shop is not connected." });
      const days = Math.max(1, Math.min(90, Math.floor(Number(body.days) || 30)));
      const missing = await fillCity(admin, link, days, 20_000);
      const want = cityDays(days);
      const { data, error } = await user.rpc("tiktok_city", { cid, day_from: want[want.length - 1], day_to: want[0] });
      if (error) throw new Fail(500, error.message);
      return reply(200, { ...data, days, missing });
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
          let cityLeft = -1;
          if (Date.now() - started < AUTO_BUDGET_MS - 15_000) cityLeft = await fillCity(admin, link, 30, Math.min(40_000, AUTO_BUDGET_MS - 10_000 - (Date.now() - started))).catch(() => -1);
          companies.push({ company_id: link.company_id, ...r, left, cityLeft });
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

// Refreshes the access token when it has less than a day left.
// deno-lint-ignore no-explicit-any
async function freshToken(admin: any, link: any) {
  if (!link.access_expires || new Date(link.access_expires).getTime() < Date.now() + 86_400_000) {
    if (link.refresh_expires && new Date(link.refresh_expires).getTime() < Date.now()) {
      throw new Fail(401, "The TikTok connection has expired. Disconnect and connect TikTok Shop again.");
    }
    Object.assign(link, await tokenCall("refresh", link.refresh_token));
    await admin.from("tiktok_links").update({
      access_token: link.access_token, access_expires: link.access_expires, refresh_token: link.refresh_token, refresh_expires: link.refresh_expires,
    }).eq("company_id", link.company_id);
  }
}

// deno-lint-ignore no-explicit-any
async function syncNow(admin: any, link: any) {
  const started = Date.now();
  await freshToken(admin, link);
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

// ---------- Squishy City: TikTok units per product per day ----------
// TikTok's day is Pacific time (as in Seller Center). ptMidnight("2026-11-14") is that day's start in ms.
function ptOffset(ms: number) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" })
    .formatToParts(ms).map((x) => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(ms / 1000) * 1000;
}
const ptDay = (ms: number) => new Date(ms + ptOffset(ms)).toISOString().slice(0, 10);
function ptMidnight(day: string) {
  const guess = Date.parse(day + "T08:00:00Z");
  return Date.parse(day + "T00:00:00Z") - ptOffset(guess);
}
// The last n Pacific days, newest first ("YYYY-MM-DD").
function cityDays(n: number) {
  const out: string[] = []; let d = ptDay(Date.now());
  for (let i = 0; i < n; i++) { out.push(d); d = new Date(Date.parse(d + "T12:00:00Z") - 864e5).toISOString().slice(0, 10); }
  return out;
}
// Adds up one day's orders by product and replaces that day's totals.
// deno-lint-ignore no-explicit-any
async function fillCityDay(admin: any, link: any, day: string) {
  const from = Math.floor(ptMidnight(day) / 1000), next = new Date(Date.parse(day + "T12:00:00Z") + 864e5).toISOString().slice(0, 10);
  const to = Math.floor(ptMidnight(next) / 1000);
  const by = new Map<string, { product: string; image: string; units: number; gmv: number }>();
  let orders = 0;
  // A busy day is thousands of orders, 100 to a page: the day is split into 24 one-hour windows, read 8 at a
  // time, so a whole day takes seconds instead of minutes.
  const span = (to - from) / 24, hours = Array.from({ length: 24 }, (_, i) => [Math.round(from + i * span), i === 23 ? to : Math.round(from + (i + 1) * span)]);
  const hour = async ([a, b]: number[]) => {
    let token = "", guard = 0;
    do {
      const d = await tiktok("/order/202309/orders/search", link, { page_size: 100, sort_field: "create_time", sort_order: "ASC", page_token: token }, { create_time_ge: a, create_time_lt: b });
      // deno-lint-ignore no-explicit-any
      for (const o of (d.orders || []) as any[]) {
        if (o.status === "UNPAID" || o.status === "CANCELLED") continue;
        orders++;
        // deno-lint-ignore no-explicit-any
        for (const l of (o.line_items || []) as any[]) {
          const k = String(l.product_name || "Item").slice(0, 200);
          const e = by.get(k) || { product: k, image: String(l.sku_image || ""), units: 0, gmv: 0 };
          e.units++; e.gmv += Number(l.sale_price) || 0; if (!e.image && l.sku_image) e.image = String(l.sku_image);
          by.set(k, e);
        }
      }
      token = String(d.next_page_token || "");
    } while (token && ++guard < 300);
  };
  for (let i = 0; i < hours.length; i += 8) await Promise.all(hours.slice(i, i + 8).map(hour));
  await admin.from("tiktok_product_days").delete().eq("company_id", link.company_id).eq("day", day);
  const rows = [...by.values()].map((e) => ({ company_id: link.company_id, day, product: e.product, image: e.image || null, units: e.units, gmv: Math.round(e.gmv * 100) / 100 }));
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await admin.from("tiktok_product_days").insert(rows.slice(i, i + 500));
    if (error) throw new Fail(500, error.message);
  }
  await admin.from("tiktok_city_days").upsert({ company_id: link.company_id, day, orders, filled_at: new Date().toISOString() });
}
// Fills the last n days that are missing, plus today (when last added up over 4 minutes ago) and yesterday (20),
// newest first, while time allows. Returns how many days are still missing.
// deno-lint-ignore no-explicit-any
async function fillCity(admin: any, link: any, n: number, budgetMs: number) {
  const started = Date.now();
  await freshToken(admin, link);
  const want = cityDays(n);
  const { data: have } = await admin.from("tiktok_city_days").select("day, filled_at").eq("company_id", link.company_id).gte("day", want[want.length - 1]);
  const at = new Map((have || []).map((r: { day: string; filled_at: string }) => [String(r.day).slice(0, 10), Date.parse(r.filled_at)]));
  const todo = want.filter((d, i) => !at.has(d) || (i < 2 && Date.now() - (at.get(d) as number) > (i ? 20 : 4) * 60_000));
  let done = 0;
  for (const d of todo) {
    if (Date.now() - started > budgetMs) break;
    await fillCityDay(admin, link, d); done++;
  }
  return want.filter((d) => !at.has(d)).length - todo.slice(0, done).filter((d) => !at.has(d)).length;
}
