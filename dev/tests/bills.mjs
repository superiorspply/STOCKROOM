// Bills: add a supplier invoice PDF, mark it complete or not and paid or not, write on it, and download it
// with the notes. Run against the local server (node dev/server.mjs): node dev/tests/bills.mjs
import {browser, context, page, SITE} from './helpers.mjs';
import {PDFDocument, StandardFonts} from 'pdf-lib';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const results = [], errs = [];
const check = (ok, msg) => { results.push((ok ? 'PASS ' : 'FAIL ') + msg); };
const run = Date.now().toString(36);
// A two-page supplier invoice made for the test.
const pdf = await PDFDocument.create(), font = await pdf.embedFont(StandardFonts.Helvetica);
for (const t of ['INVOICE 4471  ·  Acme Toy Supply  ·  Total $1,250.00', 'Page 2: terms']) pdf.addPage([612, 792]).drawText(t, {x:60, y:720, size:16, font});
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bills-')), file = path.join(dir, 'acme-invoice-4471.pdf');
fs.writeFileSync(file, await pdf.save());
const b = await browser();
try {
  const ctx = await context(b, {viewport:{width:1280, height:900}}), P = await page(ctx, errs);
  await P.goto(SITE);
  await P.getByRole('tab', {name:'Create account'}).click();
  await P.getByLabel('Email').fill(`bills-${run}@shop.test`); await P.getByLabel('Password').fill('correct-horse-9');
  await P.getByRole('button', {name:'Create account'}).last().click();
  await P.getByLabel('Company name').fill('Bills Test Co'); await P.getByRole('button', {name:'Create company'}).click();
  await P.locator('#status.live').waitFor({timeout:10000});
  await P.evaluate(async () => { const db = await window.claude.use('db'); await db.doc('items/w1').set({sku:'SS-1', name:'Widget', category:'Other products', qty:5, cost:100, price:250, tiers:[], createdAt:new Date().toISOString()}); });

  await P.getByRole('tab', {name:'Reports'}).click();
  await P.getByRole('button', {name:'Bills', exact:true}).click();
  await P.getByText('No bills yet').waitFor({timeout:10000});
  check(true, 'Reports has a Bills page, empty at first');

  // Add the PDF: it opens with its pages drawn.
  await P.locator('#billFile').setInputFiles(file);
  await P.locator('.billview[data-ready="1"]').waitFor({timeout:20000});
  check(await P.locator('.billview .bvpage').count() === 2, 'adding a PDF opens it with both pages');
  const items = await P.evaluate(async () => { const db = await window.claude.use('db'); return (await db.collection('items').get()).docs.map(d => d.data().qty); });
  check(items.length === 1 && items[0] === 5, 'adding a bill does not touch inventory');

  // Details: supplier, amount, received incomplete with what was missing.
  const side = P.locator('.bvside');
  await side.getByLabel('Supplier').fill('Acme Toy Supply'); await side.getByLabel('Supplier').blur();
  await side.getByLabel('Invoice #').fill('4471'); await side.getByLabel('Invoice #').blur();
  await side.getByLabel('Amount').fill('1250'); await side.getByLabel('Amount').blur();
  await side.getByRole('button', {name:'Incomplete'}).click();
  await side.getByLabel('What was missing or wrong').fill('2 cases short'); await side.getByLabel('What was missing or wrong').blur();

  // Write on it: a pen stroke and a typed note on page 1.
  const ink = P.locator('.bvpage[data-page="1"] .bvink'), box = await ink.boundingBox();
  await P.mouse.move(box.x + 80, box.y + 120); await P.mouse.down();
  for (let i = 1; i <= 10; i++) await P.mouse.move(box.x + 80 + i*20, box.y + 120 + i*4);
  await P.mouse.up();
  await P.getByRole('button', {name:'Text', exact:true}).click();
  await ink.click({position:{x:120, y:260}});
  await P.locator('.bvtext').fill('Short 2 cases - call Acme'); await P.keyboard.press('Enter');
  await P.getByText('Notes saved').waitFor({timeout:10000});
  if (process.env.SHOT) await P.screenshot({path:process.env.SHOT});

  // Paid.
  await side.getByRole('button', {name:'Mark as paid'}).click();
  await side.getByRole('button', {name:'Mark as unpaid'}).waitFor();
  const saved = await P.evaluate(async () => { const db = await window.claude.use('db'); const d = (await db.collection('bills').get()).docs[0].data(); return {vendor:d.vendor, number:d.number, amount:d.amount, received:d.received, missing:d.missing, paid:d.paid, paidOn:d.paidOn, marks:(d.marks['1']||[]).map(m => m.t), path:d.file.path}; });
  check(saved.vendor === 'Acme Toy Supply' && saved.number === '4471' && saved.amount === 1250, 'the supplier, invoice # and amount are saved');
  check(saved.received === 'incomplete' && saved.missing === '2 cases short', 'it records that the order came in incomplete and what was missing');
  check(saved.paid === true && /^\d{4}-\d{2}-\d{2}$/.test(saved.paidOn), 'it can be marked paid, with the day');
  check(saved.marks.includes('pen') && saved.marks.includes('text'), 'what was written on the page is saved with the bill');

  // Download with the notes written into the PDF.
  const [dl] = await Promise.all([P.waitForEvent('download', {timeout:20000}), P.getByRole('button', {name:'Download with notes'}).click()]);
  const out = await PDFDocument.load(fs.readFileSync(await dl.path()));
  check(/with-notes\.pdf$/.test(dl.suggestedFilename()) && out.getPageCount() === 2 && fs.statSync(await dl.path()).size > fs.statSync(file).size, 'Download with notes gives the PDF with the notes drawn in (' + dl.suggestedFilename() + ')');

  // Reopen: the notes come back, and the list shows its state.
  await P.getByRole('button', {name:'Close'}).last().click();
  const row = P.locator('.billrow').first();
  await row.waitFor();
  const rt = await row.textContent();
  check(/Acme Toy Supply/.test(rt) && /Paid/.test(rt) && /Incomplete/.test(rt) && /\$1,250\.00/.test(rt), 'the list shows the bill as paid and incomplete (' + rt.replace(/\s+/g, ' ').slice(0, 90) + ')');
  await P.getByRole('button', {name:'Incomplete', exact:true}).click();
  check(await P.locator('.billrow').count() === 1, 'bills can be filtered to the incomplete ones');
  await row.click();
  await P.locator('.billview[data-ready="1"]').waitFor({timeout:20000});
  const inked = await P.evaluate(() => { const c = document.querySelector('.bvpage[data-page="1"] .bvink'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i]) n++; return n; });
  check(inked > 200, 'opening it again shows the notes on the page');

  // A new stroke can be undone.
  await P.getByRole('button', {name:'Pen', exact:true}).click();
  const box2 = await P.locator('.bvpage[data-page="1"] .bvink').boundingBox();
  await P.mouse.move(box2.x + 300, box2.y + 300); await P.mouse.down(); await P.mouse.move(box2.x + 400, box2.y + 340); await P.mouse.up();
  await P.getByRole('button', {name:'Undo'}).click();
  await P.getByText('Notes saved').waitFor({timeout:10000});
  const after = await P.evaluate(async () => { const db = await window.claude.use('db'); return ((await db.collection('bills').get()).docs[0].data().marks['1'] || []).length; });
  check(after === 2, 'Undo takes back the last mark');
  // Delete.
  await P.locator('.bvside').getByRole('button', {name:'Delete bill'}).click();
  await P.locator('.bvconfirm').getByRole('button', {name:'Delete'}).click();
  await P.getByText('No bills yet').waitFor({timeout:10000});
  const gone = await P.evaluate(async p => { try { await (await window.claude.use('bills')).open(p); return false; } catch(e){ return true; } }, saved.path);
  check(gone, 'deleting a bill removes it and its file');
  await P.waitForTimeout(600);
  for (let i = errs.length - 1; i >= 0; i--) if (errs[i].includes(saved.path)) errs.splice(i, 1);   // the expected "not found" from that check
} catch(e){
  results.push('FAIL test crashed: ' + (e && e.stack || e));
} finally {
  await b.close();
  fs.rmSync(dir, {recursive:true, force:true});
}
if (errs.length) results.push('FAIL page errors: ' + errs.join(' | ')); else results.push('PASS no page errors');
console.log(results.join('\n'));
const failed = results.filter(r => r.startsWith('FAIL')).length;
console.log(failed + ' failed of ' + results.length);
process.exit(failed ? 1 : 0);
