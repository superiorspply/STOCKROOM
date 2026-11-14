// Stockroom Operator: switched on by support, answers from the data, and makes changes only after Confirm.
// Claude is the stand-in at /mock-anthropic, which calls the tools for a few phrases.
// Run against the local server (node dev/server.mjs): node dev/tests/operator.mjs
import {execFileSync} from 'node:child_process';
import {browser, context, page, SITE} from './helpers.mjs';
const psql = sql => execFileSync('su', ['postgres', '-c', `psql -q -d ${process.env.DEV_DB || 'stockroom_dev'} -c "${sql}"`]);

const API = 'http://localhost:54321';
const results = [], errs = [];
const check = (ok, msg) => { results.push((ok ? 'PASS ' : 'FAIL ') + msg); };
const run = Date.now().toString(36), email = `operator-${run}@shop.test`;
const b = await browser();
try {
  const ctx = await context(b), P = await page(ctx, errs);
  await P.goto(SITE);
  await P.getByRole('tab', {name:'Create account'}).click();
  await P.getByLabel('Email').fill(email); await P.getByLabel('Password').fill('correct-horse-9');
  await P.getByRole('button', {name:'Create account'}).last().click();
  await P.getByLabel('Company name').fill('Operator Test Co'); await P.getByRole('button', {name:'Create company'}).click();
  await P.locator('#status.live').waitFor({timeout:10000});
  await P.evaluate(async () => {
    const db = await window.claude.use('db');
    await db.doc('items/w1').set({sku:'SS-0001', name:'Widget', category:'Other products', qty:20, cost:10, price:25, priceMedium:null, priceLarge:null, tiers:[], createdAt:new Date().toISOString()});
    await db.doc('customers/dom').set({name:'Dom', type:'', handle:'@dom', phone:'5551234567', createdAt:new Date().toISOString()});
    await db.doc('sales/s1').set({itemId:'', sku:'CUSTOM', name:'Old order', qty:1, size:'', sizeType:'', unitPrice:1000, unitCost:600, total:1000, customerId:'dom', customerName:'Dom', invoiceNo:'INV-0001', note:'', custom:true, at:new Date(Date.now() - 5 * 864e5).toISOString()});
  });
  await P.waitForTimeout(500);
  check(await P.locator('#opBtn').isHidden(), 'the Operator is hidden until support switches it on');
  psql(`insert into public.operator_settings(company_id, enabled) select m.company_id, true from public.members m join auth.users u on u.id = m.user_id where u.email = '${email}' on conflict (company_id) do update set enabled = true`);
  await P.reload(); await P.locator('#status.live').waitFor({timeout:10000});
  await P.locator('#opBtn').waitFor({state:'visible', timeout:10000});
  await P.locator('#opBtn').click();
  const sheet = P.locator('.sheet');
  const box = sheet.getByLabel('Message to the Operator');
  const ask = async t => { await box.fill(t); await box.press('Enter'); };
  const lastSaid = () => sheet.locator('.opmsg.ai').last().textContent();

  await sheet.getByRole('button', {name:'Who owes us money?'}).click();
  await sheet.getByText(/Owed: INV-0001 Dom \$1000/).waitFor({timeout:10000});
  check(true, 'it answers questions from the data (who owes money)');

  await ask('Invoice Dom for 2 Widget');
  const card = sheet.locator('.opcard').last();
  await card.getByRole('button', {name:'Create invoice'}).waitFor({timeout:10000});
  const ct = await card.textContent();
  check(ct.includes('New invoice for Dom') && ct.includes('2 × Widget @ $25.00') && ct.includes('$50.00'), 'a new invoice is shown for confirming first (' + ct.slice(0, 90) + ')');
  const before = await P.evaluate(async () => (await (await window.claude.use('db')).collection('sales').get()).docs.length);
  check(before === 1, 'nothing is written before Confirm');
  await card.getByRole('button', {name:'Create invoice'}).click();
  await sheet.getByText('Created INV-0002 for $50.').waitFor({timeout:10000});
  const after = await P.evaluate(async () => { const db = await window.claude.use('db'); const s = (await db.collection('sales').get()).docs.map(d => d.data()); return {s:s.filter(x => x.invoiceNo === 'INV-0002'), qty:(await db.doc('items/w1').get()).data().qty}; });
  check(after.s.length === 1 && after.s[0].qty === 2 && after.s[0].customerId === 'dom' && after.qty === 18, 'after Confirm the invoice is created and stock goes down');
  check(await card.getByRole('button', {name:'Open INV-0002'}).count() === 1, 'the card links to the new invoice');

  await ask('Invoice Dom for 1 Widget');
  await sheet.locator('.opcard:not(.done)').getByRole('button', {name:'Cancel'}).click();
  await sheet.getByText('OK, I cancelled that.').waitFor({timeout:10000});
  const n3 = await P.evaluate(async () => (await (await window.claude.use('db')).collection('sales').get()).docs.map(d => d.data()).filter(x => x.invoiceNo === 'INV-0003').length);
  check(n3 === 0, 'Cancel leaves everything as it was');

  await ask('Invoice Dom for 500 Widget');
  await sheet.getByText('Problem: Only 18 of SS-0001 in stock.').waitFor({timeout:10000});
  check(true, 'it cannot sell more than is in stock');

  await ask('Dom paid $1000 Zelle on INV-0001');
  const pay = sheet.locator('.opcard:not(.done)');
  await pay.getByRole('button', {name:'Record payment'}).waitFor({timeout:10000});
  check((await pay.textContent()).includes('Paid in full'), 'the payment card shows the invoice will be paid in full');
  await pay.getByRole('button', {name:'Record payment'}).click();
  await sheet.getByText(/Recorded the payment on INV-0001\. It is paid in full\./).waitFor({timeout:10000});
  const inv = await P.evaluate(async () => (await (await window.claude.use('db')).doc('invoices/INV-0001').get()).data());
  check(inv.paid === true && inv.payments[0].method === 'Zelle' && inv.payments[0].amount === 1000, 'after Confirm the payment is recorded');

  const cards = await sheet.locator('.opcard').count();
  await ask('text Dom that the order is ready');
  await sheet.locator('.opcard').nth(cards).waitFor({timeout:10000});
  const msg = sheet.locator('.opcard').last();
  await msg.getByRole('link', {name:'Open in Messages'}).waitFor({timeout:10000});
  check((await msg.getByRole('link', {name:'Open in Messages'}).getAttribute('href')).startsWith('sms:5551234567'), 'a drafted message opens in Messages with the customer\'s number');

  const req = await (await fetch(API + '/mock-anthropic')).json();
  const ms = req.body.messages, tools = req.body.tools.map(t => t.name);
  check(ms.some(m => m.role === 'assistant' && m.content.some(c => c.type === 'thinking' && c.signature === 'mock-signature'))
    && ms.some(m => m.role === 'user' && Array.isArray(m.content) && m.content.some(c => c.type === 'tool_result')), 'the whole conversation, with Claude\'s own blocks and the tool results, goes back each turn');
  check(tools.includes('create_invoice') && tools.includes('record_payment') && req.body.model === 'claude-opus-5-5', 'the server sets the model and tools');

  if (process.env.SHOT) await P.screenshot({path:process.env.SHOT});
  await sheet.getByRole('button', {name:'New chat'}).click();
  check(await sheet.locator('.opmsg').count() === 1, 'New chat starts over');
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
