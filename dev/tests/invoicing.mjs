// Previous balance on new invoices, invoice dates, and any dates on the home screen.
// Run against the local server (node dev/server.mjs): node dev/tests/invoicing.mjs
import {browser, context, page, SITE} from './helpers.mjs';

const results = [], errs = [];
const check = (ok, msg) => { results.push((ok ? 'PASS ' : 'FAIL ') + msg); };
const run = Date.now().toString(36);
const b = await browser();
const ymd = t => { const d = new Date(t); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
const daysAgo = n => { const t = new Date(); t.setHours(12, 0, 0, 0); t.setDate(t.getDate() - n); return t; };
try {
  const ctx = await context(b), P = await page(ctx, errs);
  await P.goto(SITE);
  await P.getByRole('tab', {name:'Create account'}).click();
  await P.getByLabel('Email').fill(`invoicing-${run}@shop.test`); await P.getByLabel('Password').fill('correct-horse-9');
  await P.getByRole('button', {name:'Create account'}).last().click();
  await P.getByLabel('Company name').fill('Invoicing Test Co'); await P.getByRole('button', {name:'Create company'}).click();
  await P.locator('#status.live').waitFor({timeout:10000});

  // Dom owes $1,000 on invoice 1 (5 days ago, unpaid).
  await P.evaluate(async at => {
    const db = await window.claude.use('db');
    await db.doc('items/w1').set({sku:'SS-0001', name:'Widget', category:'Other products', qty:20, cost:1000, price:2500, priceMedium:null, priceLarge:null, tiers:[], createdAt:new Date().toISOString()});
    await db.doc('customers/dom').set({name:'Dom', type:'', handle:'', createdAt:new Date().toISOString()});
    await db.doc('sales/s1').set({itemId:'', sku:'CUSTOM', name:'Old order', qty:1, size:'', sizeType:'', unitPrice:1000, unitCost:600, total:1000, customerId:'dom', customerName:'Dom', invoiceNo:'INV-0001', note:'', custom:true, at});
  }, daysAgo(5).toISOString());
  await P.reload(); await P.locator('#status.live').waitFor({timeout:10000});

  // 3. Home: any dates. Pick the day of invoice 1 only.
  await P.getByRole('button', {name:'Pick dates…'}).click();
  const d5 = daysAgo(5);
  if (d5.getMonth() !== new Date().getMonth()) await P.getByRole('button', {name:'Previous month'}).click();
  await P.getByRole('button', {name:d5.toLocaleDateString(undefined, {weekday:'long', month:'long', day:'numeric', year:'numeric'})}).click();
  await P.getByRole('button', {name:'Show these dates'}).click();
  await P.locator('.hbig').waitFor();
  const hero = await P.locator('.hero').textContent();
  check(hero.includes('$1,000.00') && /✎/.test(hero), 'the home screen shows any picked dates (' + hero.slice(0, 80) + ')');

  // 1 + 2. Cart: Dom's unpaid $1,000 is offered; the invoice date can be set to the day of the sale.
  await P.getByRole('tab', {name:'Inventory'}).click();
  await P.locator('[data-cartid]').first().click();
  await P.locator('#cartBar').click();
  await P.locator('.sheet select').first().selectOption({label:'Dom'});
  const carry = P.locator('.carrybox');
  await carry.waitFor({timeout:5000});
  check((await carry.textContent()).includes('$1,000.00') && (await carry.textContent()).includes('INV-0001'), 'the cart offers to add the customer\'s unpaid balance');
  check(!(await carry.getByRole('checkbox').first().isChecked()), 'it is off until ticked (or made the default)');
  await carry.getByRole('checkbox').first().check();
  await carry.getByRole('checkbox').nth(1).check();   // always do this
  await P.getByText('Unpaid balances will be added to new invoices').waitFor({timeout:5000});
  await P.getByLabel('Invoice date').fill(ymd(daysAgo(2)));
  await P.getByRole('button', {name:'Create invoice'}).click();
  await P.getByRole('heading', {name:/^Invoice INV-0002/}).waitFor({timeout:10000});
  const inv2 = await P.locator('.sheet').textContent();
  check(inv2.includes('Previous balance') && inv2.includes('INV-0001') && /Total owed\$3,500\.00/.test(inv2), 'the new invoice shows the previous balance and $3,500 owed in all');
  check(/Total owed\$3,500\.00/.test(await P.locator('.invhero').textContent()), 'the top of the invoice shows the total owed');
  const at2 = await P.evaluate(async () => { const db = await window.claude.use('db'); const s = await db.collection('sales').get(); return s.docs.map(d => d.data()).filter(x => x.invoiceNo === 'INV-0002').map(x => x.at); });
  check(at2.length === 1 && ymd(at2[0]) === ymd(daysAgo(2)), 'the sale is dated the picked day, so reports count it then');

  // 2. Change an existing invoice's date.
  await P.locator('.sheet').getByLabel('Invoice date').fill(ymd(daysAgo(3)));
  await P.locator('.sheet').getByLabel('Invoice date').dispatchEvent('change');
  await P.getByText(/INV-0002 now dated/).waitFor({timeout:8000});
  await P.waitForTimeout(800);   // the invoice reopens with its new date
  const at3 = await P.evaluate(async () => { const db = await window.claude.use('db'); const s = await db.collection('sales').get(); return s.docs.map(d => d.data()).filter(x => x.invoiceNo === 'INV-0002').map(x => x.at); });
  check(ymd(at3[0]) === ymd(daysAgo(3)), 'changing an invoice\'s date moves its sales to that day');

  // A payment through invoice 2 pays the oldest balance first.
  await P.getByRole('heading', {name:/^Invoice INV-0002/}).waitFor({timeout:8000});
  await P.locator('.sheet').getByRole('button', {name:'Record payment'}).click();
  await P.getByLabel('Zelle amount').fill('1200');
  await P.getByRole('button', {name:'Save payment'}).click();
  await P.getByText(/1,200\.00 recorded · \$2,300\.00 still due/).waitFor({timeout:8000});
  const pays = await P.evaluate(async () => { const db = await window.claude.use('db'); const a = (await db.doc('invoices/INV-0001').get()).data(), b = (await db.doc('invoices/INV-0002').get()).data(); return {a, b}; });
  check(pays.a.paid === true && pays.a.payments[0].amount === 1000 && /Paid with INV-0002/.test(pays.a.payments[0].note), 'the payment pays off invoice 1 first');
  check(!pays.b.paid && pays.b.payments[0].amount === 200, 'the rest goes on invoice 2');
  await P.getByRole('heading', {name:/^Invoice INV-0002/}).waitFor({timeout:8000});
  const after = await P.locator('.sheet').textContent();
  check(!after.includes('Previous balance') && after.includes('$2,300.00'), 'once invoice 1 is paid, invoice 2 shows only its own balance');

  // Printed invoice shows the previous balance while there is one: a new invoice for Dom, default now on.
  await P.locator('.sheet').getByRole('button', {name:'Close'}).first().click().catch(() => {});
  await P.keyboard.press('Escape');
  await P.locator('[data-cartid]').first().click();
  await P.locator('#cartBar').click();
  await P.locator('.sheet select').first().selectOption({label:'Dom'});
  await P.locator('.carrybox').waitFor({timeout:5000});
  check(await P.locator('.carrybox').getByRole('checkbox').first().isChecked(), 'with the setting on, the box is ticked for new invoices');
  await P.getByRole('button', {name:'Create invoice'}).click();
  await P.getByRole('heading', {name:/^Invoice INV-0003/}).waitFor({timeout:10000});
  const [dl] = await Promise.all([P.waitForEvent('download'), P.getByRole('button', {name:'Save printable web page'}).click()]);
  const fs = await import('node:fs');
  const page3 = fs.readFileSync(await dl.path(), 'utf8');
  check(page3.includes('Previous balance') && page3.includes('INV-0002') && page3.includes('Total owed') && page3.includes('$4,800.00'), 'the printed invoice shows the previous balance and total owed');
} catch(e){
  results.push('FAIL test crashed: ' + (e && e.stack || e));
} finally {
  await b.close();
}
if (errs.length) results.push('FAIL page errors: ' + errs.join(' | ')); else results.push('PASS no page errors');
console.log(results.join('\n'));
const failed = results.filter(r => r.startsWith('FAIL')).length;
console.log(failed + ' failed of ' + results.length);
process.exit(failed ? 1 : 0);
