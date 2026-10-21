// Shared Playwright setup: serves CDN libraries from node_modules so tests run offline.
import {chromium} from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const NM = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../node_modules');
export const SITE = process.env.SITE || 'http://localhost:8080/';
export async function browser(){
  return chromium.launch({executablePath: fs.existsSync('/opt/pw-browsers/chromium-1194/chrome-linux/chrome') ? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' : undefined});
}
export async function context(b, opts){
  const ctx = await b.newContext(Object.assign({viewport:{width:430, height:900}, acceptDownloads:true}, opts || {}));
  await ctx.route('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@*/dist/umd/supabase.js', r =>
    r.fulfill({body:fs.readFileSync(path.join(NM, '@supabase/supabase-js/dist/umd/supabase.js')), contentType:'text/javascript'}));
  await ctx.route('https://cdnjs.cloudflare.com/ajax/libs/jspdf/**', r =>
    r.fulfill({body:fs.readFileSync(path.join(NM, 'jspdf/dist/jspdf.umd.min.js')), contentType:'text/javascript'}));
  await ctx.route('https://cdnjs.cloudflare.com/ajax/libs/xlsx/**', r =>
    r.fulfill({body:fs.readFileSync(path.join(NM, 'xlsx/dist/xlsx.full.min.js')), contentType:'text/javascript'}));
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, r => r.fulfill({body:'', contentType:'text/css'}));
  return ctx;
}
export async function page(ctx, errors){
  const p = await ctx.newPage();
  p.on('pageerror', e => errors.push('pageerror: ' + e.message));
  p.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push('console: ' + m.text()); });
  p.on('response', async r => { if (r.status() >= 400) errors.push('http ' + r.status() + ' ' + r.request().method() + ' ' + r.url() + ' ' + (await r.text().catch(() => '')).slice(0, 160)); });
  return p;
}
