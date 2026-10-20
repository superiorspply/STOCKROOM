// End-to-end check against the local server (node dev/server.mjs). Run: node dev/tests/e2e.mjs
import {browser, context, page, SITE} from './helpers.mjs';
import fs from 'node:fs';
import zlib from 'node:zlib';
import {execFileSync} from 'node:child_process';

// Support access is granted only from the database, like the real SQL-editor step.
function makeSupport(email){
  execFileSync('su', ['postgres', '-c', `psql -q -d ${process.env.DEV_DB || 'stockroom_dev'} -c "insert into public.platform_admins select id from auth.users where email = '${email}'"`]);
}

const results = [];
const check = (ok, msg) => { results.push((ok ? 'PASS ' : 'FAIL ') + msg); };
const errs = [];
const run = Date.now().toString(36);
const SUPPORT = `support-${run}@stockroom.test`;
const OWNER = `owner-${run}@acme.test`, STAFF = `staff-${run}@acme.test`, OTHER = `other-${run}@bolt.test`, PW = 'correct-horse-9';

// A tiny valid PNG (1x1 red) for photo uploads.
function png(){
  const crc = b => { let c, t = []; for (let n = 0; n < 256; n++){ c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    let x = 0xffffffff; for (const v of b) x = t[(x ^ v) & 0xff] ^ (x >>> 8); return (x ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(8, 0); ihdr.writeUInt32BE(8, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc(8 * 25); for (let y = 0; y < 8; y++){ raw[y * 25] = 0; for (let x = 0; x < 8; x++){ raw[y * 25 + 1 + x * 3] = 220; } }
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const PHOTO = '/tmp/stockroom-test.png'; fs.writeFileSync(PHOTO, png());

async function signUp(p, email, url){
  await p.goto(url || SITE);
  await p.getByRole('tab', {name:'Create account'}).click();
  await p.getByLabel('Email').fill(email);
  await p.getByLabel('Password').fill(PW);
  await p.getByRole('button', {name:'Create account'}).last().click();
}
async function addItem(p, name, qty, price, photo){
  await p.getByRole('tab', {name:'Inventory'}).click();
  await p.locator('#fab').click();
  await p.getByLabel('Category').selectOption({label:'Other products'});
  await p.getByLabel('Item name').fill(name);
  await p.getByLabel('Quantity').fill(String(qty));
  await p.getByLabel(/^Small order price/).fill(String(price));
  if (photo) await p.locator('.sheet input[type=file]').first().setInputFiles(photo);
  await p.locator('.sheet button[type=submit]').click();
  try { await p.locator('.sheet-head h2').filter({hasNotText:'Receive item'}).waitFor({timeout:8000}); }
  catch(e){ await p.screenshot({path:'/tmp/stockroom-additem.png'}); throw new Error('add item failed: ' + (await p.locator('.sheet .err').allTextContents()).join(' | ')); }
  await p.keyboard.press('Escape');
  if (await p.locator('.backdrop').count()) await p.locator('.backdrop .icon-btn').first().click();
}
const rowNames = p => p.locator('.name').allTextContents();

const b = await browser();
try {
  // 1. Owner signs up and creates a company.
  const ctxA = await context(b), A = await page(ctxA, errs);
  await signUp(A, OWNER);
  await A.getByLabel('Company name').fill('Acme Supply');
  await A.getByRole('button', {name:'Create company'}).click();
  await A.locator('#status.live').waitFor({timeout:10000});
  check((await A.locator('.top h1 .b1').textContent()) === 'Acme Supply', 'header shows company name');
  check((await A.title()) === 'Acme Supply x Stockroom', 'page title shows company name');
  check(/^data:image\/jpeg/.test(await A.locator('.top img.logo').getAttribute('src')), 'monogram logo is shown');
  check((await A.locator('#status').textContent()).includes('Saved online'), 'owner status is Saved online');

  // 2. Owner adds items, one with a photo.
  await addItem(A, 'Blue Widget', 10, 5, PHOTO);
  await A.getByRole('tab', {name:'Inventory'}).click();
  await A.waitForTimeout(500);
  check((await rowNames(A)).some(t => t.includes('Blue Widget')), 'new item appears in inventory');
  const src = await A.locator('.thumb img').first().getAttribute('src').catch(() => '');
  check(/\/storage\/v1\/object\/public\/photos\/[0-9a-f-]{36}\/[a-z0-9]{20}\.jpg$/.test(src || ''), 'item photo is stored under the company folder');
  const photoOk = await A.evaluate(u => new Promise(r => { const i = new Image(); i.onload = () => r(i.naturalWidth > 0); i.onerror = () => r(false); i.src = u; }), src);
  check(photoOk, 'item photo displays');

  // 3. Data survives a reload.
  await A.reload();
  await A.locator('#status.live').waitFor({timeout:10000});
  await A.getByRole('tab', {name:'Inventory'}).click(); await A.waitForTimeout(800);
  check((await rowNames(A)).some(t => t.includes('Blue Widget')), 'item is still there after reload');

  // 4. Owner creates a staff invite link.
  await A.locator('#acctBtn').click();
  await A.getByRole('button', {name:'Create invite link'}).click();
  const link = await A.locator('.acct .linkbox input[readonly]').inputValue();
  check(/\?invite=[0-9a-f]{32}$/.test(link), 'invite link is created');
  await A.locator('.acct').locator('..').locator('.icon-btn').first().click().catch(() => {});
  await A.keyboard.press('Escape');
  if (await A.locator('.backdrop').count()) await A.locator('.backdrop .icon-btn').first().click();

  // 5. Staff opens the link, signs up, joins Acme.
  const ctxB = await context(b), B = await page(ctxB, errs);
  await B.goto(link);
  await B.locator('.ginvite').waitFor();
  check((await B.locator('.ginvite').textContent()).includes('Acme Supply as Staff'), 'invite banner names the company and role');
  check(await B.getByRole('tab', {name:'Create account'}).getAttribute('aria-selected') === 'true', 'invite opens on Create account');
  await signUp(B, STAFF, SITE);   // the invite code was saved when the link was opened
  await B.locator('#status.live').waitFor({timeout:10000});
  check((await B.locator('#status').textContent()).includes('Staff'), 'staff status shows Staff');
  check((await B.locator('.top h1 .b1').textContent()) === 'Acme Supply', 'staff is in Acme');
  await B.getByRole('tab', {name:'Inventory'}).click(); await B.waitForTimeout(800);
  check((await rowNames(B)).some(t => t.includes('Blue Widget')), 'staff sees the owner’s items');

  // 6. Live updates: owner adds an item, staff sees it without reloading.
  await addItem(A, 'Red Widget', 3, 7);
  let seen = false;
  for (let i = 0; i < 20 && !seen; i++){ await B.waitForTimeout(250); seen = (await rowNames(B)).some(t => t.includes('Red Widget')); }
  check(seen, 'staff sees a new item live, without reloading');

  // 7. Staff cannot change settings (blocked by the database, not just hidden).
  let mark = errs.length;
  const denied = await B.evaluate(async () => {
    const db = await window.claude.use('db');
    try { await db.doc('settings/orders').set({medium:2, large:3}); return false; } catch(e){ return true; }
  });
  check(denied, 'database refuses settings change from staff');
  await B.waitForTimeout(300); errs.splice(mark);   // that refusal is the expected 403
  const staffWrite = await B.evaluate(async () => {
    const db = await window.claude.use('db');
    try { await db.collection('customers').doc().set({name:'Walk-in'}); return true; } catch(e){ return String(e); }
  });
  check(staffWrite === true, 'staff can add a customer');

  // 8. A different company sees none of Acme's data.
  const ctxC = await context(b), C = await page(ctxC, errs);
  await signUp(C, OTHER);
  await C.getByLabel('Company name').fill('Bolt Co');
  await C.getByRole('button', {name:'Create company'}).click();
  await C.locator('#status.live').waitFor({timeout:10000});
  await C.getByRole('tab', {name:'Inventory'}).click(); await C.waitForTimeout(800);
  const cNames = await rowNames(C);
  check(!cNames.some(t => /Widget/.test(t)), 'another company sees none of Acme’s items');
  const sneaky = await C.evaluate(async () => {
    const r = await window.STOCKROOM.sb.from('docs').select('coll,id'); return (r.data || []).length;
  });
  check(sneaky === 0, 'another company gets no rows even when asking the database directly');

  // 9. Owner imports a backup with a photo and a logo.
  const imp = {format:'stockroom-import', version:1, company:{name:'Acme Supply', logo:'data:image/jpeg;base64,' + Buffer.from('fake').toString('base64')},
    docs:{items:{imp1:{sku:'IMP-0001', name:'Imported Gadget', qty:4, price:9, photoId:'oldphoto'}}, customers:{cimp:{name:'Imported Customer'}},
      settings:{business:{text:'Acme Supply\n1 Main St'}}},
    photos:{oldphoto:png().toString('base64')}};
  fs.writeFileSync('/tmp/stockroom-import.json', JSON.stringify(imp));
  await A.locator('#acctBtn').click();
  A.once('dialog', d => d.accept());
  await A.locator('.acct input[type=file][accept*=json]').setInputFiles('/tmp/stockroom-import.json');
  await A.waitForEvent('load', {timeout:15000});
  await A.locator('#status.live').waitFor({timeout:10000});
  await A.getByRole('tab', {name:'Inventory'}).click(); await A.waitForTimeout(800);
  check((await rowNames(A)).some(t => t.includes('Imported Gadget')), 'imported item appears');
  const impPhoto = await A.evaluate(async () => {
    const db = await window.claude.use('db'); const d = await db.doc('items/imp1').get(); return d.data().photoId;
  });
  check(/^[0-9a-f-]{36}\/[a-z0-9]{20}\.jpg$/.test(impPhoto), 'imported photo is re-uploaded and linked');
  check((await A.locator('.top img.logo').getAttribute('src')).includes(Buffer.from('fake').toString('base64')), 'imported logo is applied');

  // 10. Support can open any company, is clearly marked, and the owner can see the visit.
  const ctxS = await context(b), SP = await page(ctxS, errs);
  await signUp(SP, SUPPORT);
  await SP.getByLabel('Company name').waitFor();
  check(!(await SP.getByRole('button', {name:/^Support/}).count()), 'a normal account has no support option');
  makeSupport(SUPPORT);
  await SP.reload();
  await SP.getByRole('button', {name:'Support: open any company'}).click();
  await SP.getByRole('searchbox', {name:'Search companies'}).fill(OWNER);
  await SP.locator('.gco', {hasText:OWNER}).click();
  await SP.locator('#status.live').waitFor({timeout:10000});
  await SP.screenshot({path:'/tmp/stockroom-support.png'});
  check((await SP.locator('#supportBar').textContent()).includes('Support mode \u00b7 Acme Supply'), 'support mode bar names the company');
  await SP.getByRole('tab', {name:'Inventory'}).click(); await SP.waitForTimeout(800);
  check((await rowNames(SP)).some(t => t.includes('Imported Gadget')), 'support sees the company\u2019s items');
  check((await SP.locator('#status').textContent()).includes('Saved online') && !(await SP.locator('#status').textContent()).includes('Staff'), 'support has admin powers');
  await SP.reload(); await SP.locator('#status.live').waitFor({timeout:10000});
  check(await SP.locator('#supportBar').count() === 1, 'support mode survives a reload');
  // Support backs up every company in one file.
  await SP.locator('#acctBtn').click();
  const [allDl] = await Promise.all([SP.waitForEvent('download', {timeout:30000}), SP.getByRole('button', {name:'Back up all companies'}).click()]);
  const allFile = '/tmp/stockroom-all.json'; await allDl.saveAs(allFile);
  const all = JSON.parse(fs.readFileSync(allFile, 'utf8'));
  const acme = all.companies.find(x => x.team.some(m => m.email === OWNER));
  check(all.format === 'stockroom-backup-all' && all.companies.length >= 2, 'all-companies backup includes every company');
  check(acme && Object.values(acme.docs.items || {}).some(i => i.name === 'Imported Gadget'), 'all-companies backup has the company\u2019s items');
  check(acme && !(acme.docs.settings && acme.docs.settings.stockx), 'all-companies backup leaves out StockX logins');
  await SP.keyboard.press('Escape');
  if (await SP.locator('.backdrop').count()) await SP.locator('.backdrop .icon-btn').first().click();
  await SP.locator('#supportBar button').click();
  await SP.getByRole('heading', {name:'Choose a company'}).waitFor();
  check(true, 'exit leaves support mode');
  await A.reload(); await A.locator('#status.live').waitFor({timeout:10000});
  await A.locator('#acctBtn').click();
  await A.getByText('Support visits').waitFor({timeout:8000});
  check((await A.locator('.acct').textContent()).includes(SUPPORT), 'owner sees the support visit');
  check(!(await A.locator('.acct .mem:not(.hist) .who').allTextContents()).some(t => t.includes(SUPPORT)), 'support is not listed in the team');
  check(!(await A.getByRole('button', {name:'Back up all companies'}).count()), 'owners do not get the all-companies backup');
  // The owner can restore their company from the all-companies file.
  A.once('dialog', d => d.accept());
  await A.locator('.acct input[type=file][accept*=json]').setInputFiles(allFile);
  await A.waitForEvent('load', {timeout:15000});
  await A.locator('#status.live').waitFor({timeout:10000});
  await A.getByRole('tab', {name:'Inventory'}).click(); await A.waitForTimeout(600);
  check((await rowNames(A)).some(t => t.includes('Imported Gadget')), 'restoring from the all-companies file works');
  await A.getByRole('tab', {name:'Home'}).click(); await A.waitForTimeout(300);
  check(!(await A.getByText('No backup yet').count()), 'home screen has no backup reminder');
  await A.locator('#acctBtn').click();
  await A.keyboard.press('Escape');
  if (await A.locator('.backdrop').count()) await A.locator('.backdrop .icon-btn').first().click();

  // 11. Sign out returns to the sign-in screen; signing back in works.
  await A.locator('#acctBtn').click();
  await A.getByRole('button', {name:'Sign out'}).click();
  await A.getByRole('tab', {name:'Sign in'}).waitFor({timeout:8000});
  check(true, 'sign out shows sign-in screen');
  mark = errs.length;
  await A.getByLabel('Email').fill(OWNER); await A.getByLabel('Password').fill('wrong-password');
  await A.getByRole('button', {name:'Sign in'}).last().click();
  await A.locator('.gmsg.bad').waitFor();
  check((await A.locator('.gmsg.bad').textContent()).includes('Wrong email or password'), 'wrong password is explained');
  await A.waitForTimeout(300); errs.splice(mark);   // the expected 400
  await A.getByLabel('Password').fill(PW);
  await A.getByRole('button', {name:'Sign in'}).last().click();
  await A.locator('#status.live').waitFor({timeout:10000});
  check((await A.locator('.top h1 .b1').textContent()) === 'Acme Supply', 'signing back in opens the company');

  await A.screenshot({path:'/tmp/stockroom-owner.png'});
  await B.screenshot({path:'/tmp/stockroom-staff.png'});
} catch(e){
  results.push('FAIL test crashed: ' + (e && e.stack || e));
  let i = 0;
  for (const c of b.contexts()) for (const pg of c.pages()){
    const f = '/tmp/stockroom-crash-' + (i++) + '.png';
    await pg.screenshot({path:f}).catch(() => {});
    results.push('     screenshot ' + f + ': ' + (await pg.locator('#gate').textContent().catch(() => '')).slice(0, 200));
  }
} finally {
  await b.close();
}
const real = errs.filter(e => !/favicon|ERR_FAILED.*fonts/.test(e));
check(!real.length, 'no page errors' + (real.length ? ':\n  ' + real.join('\n  ') : ''));
console.log(results.join('\n'));
const failed = results.filter(r => r.startsWith('FAIL')).length;
console.log(failed + ' failed of ' + results.length);
process.exit(failed ? 1 : 0);
