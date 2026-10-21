// Cart, invoice editing, orders list, sales lookup, date ranges and the shipping report.
// Run against the local server (node dev/server.mjs): node dev/tests/orders.mjs
import {browser, context, page, SITE} from './helpers.mjs';

const results = [], errs = [];
const check = (ok, msg) => { results.push((ok ? 'PASS ' : 'FAIL ') + msg); };
const run = Date.now().toString(36);
const b = await browser();
try {
  const ctx = await context(b), P = await page(ctx, errs);
  await P.goto(SITE);
  await P.getByRole('tab', {name:'Create account'}).click();
  await P.getByLabel('Email').fill(`orders-${run}@shop.test`); await P.getByLabel('Password').fill('correct-horse-9');
  await P.getByRole('button', {name:'Create account'}).last().click();
  await P.getByLabel('Company name').fill('Order Test Co'); await P.getByRole('button', {name:'Create company'}).click();
  await P.locator('#status.live').waitFor({timeout:10000});

  // Seed: two items, a customer, and older sales (with shipping) on known dates.
  const ago = d => { const t = new Date(); t.setHours(12, 0, 0, 0); t.setDate(t.getDate() - d); return t.toISOString(); };
  await P.evaluate(async ({ago}) => {
    const db = await window.claude.use('db');
    await db.doc('items/w1').set({sku:'SS-0001', name:'Widget', category:'Other products', qty:20, cost:1, price:5, priceMedium:null, priceLarge:null, tiers:[], createdAt:new Date().toISOString()});
    await db.doc('items/g1').set({sku:'SS-0002', name:'Gadget', category:'Other products', qty:10, cost:2, price:8, priceMedium:null, priceLarge:null, tiers:[], createdAt:new Date().toISOString()});
    await db.doc('customers/c1').set({name:'Jamie Rivera', type:'', handle:'@jamie', createdAt:new Date().toISOString()});
    const sale = (id, inv, at, name, qty, price, extra) => db.doc('sales/' + id).set(Object.assign({itemId:'w1', sku:'SS-0001', name, qty, size:'', sizeType:'', unitPrice:price, unitCost:1, total:qty * price, customerId:'c1', customerName:'Jamie Rivera', invoiceNo:inv, note:'', at}, extra || {}));
    await sale('o1', 'INV-0001', ago[0], 'Widget', 2, 5);
    await db.doc('invoices/INV-0001').set({shipping:7.5});
    await sale('o2', 'INV-0002', ago[1], 'Engraving', 1, 12, {itemId:'', sku:'CUSTOM', custom:true});
    await db.doc('invoices/INV-0002').set({shipping:4});
    await sale('o3', 'INV-0003', ago[2], 'Widget', 1, 5);
  }, {ago:[ago(100), ago(10), ago(3)]});
  await P.reload(); await P.locator('#status.live').waitFor({timeout:10000});

  // 1. Cart: "+ Add custom item" sits under the last line and the new line is focused.
  await P.getByRole('tab', {name:'Inventory'}).click();
  await P.locator('[data-cartid]').first().click();
  await P.locator('#cartBar').click();
  await P.getByRole('button', {name:'+ Add custom item'}).waitFor();
  check(await P.getByRole('button', {name:'+ Add custom item'}).count() === 1, 'cart has an Add custom item button under the items');
  await P.getByRole('button', {name:'+ Add custom item'}).click();
  await P.getByRole('button', {name:'+ Add custom item'}).click();
  const focused = await P.evaluate(() => { const names = document.querySelectorAll('.cline.custom input[type=text]'); return names.length === 2 && document.activeElement === names[1]; });
  check(focused, 'adding a custom item focuses its name, ready to type');
  const btnBelow = await P.evaluate(() => { const lines = [...document.querySelectorAll('.cline')]; const btn = document.querySelector('.btn.addline'); return btn.getBoundingClientRect().top > lines[lines.length - 1].getBoundingClientRect().top; });
  check(btnBelow, 'the button moves down below the newest line');
  await P.locator('.cline.custom').nth(1).getByRole('button', {name:'Remove custom item'}).click();
  await P.locator('.cline.custom input[type=text]').fill('Gift wrap');
  await P.locator('.cline.custom').getByLabel('Price each ($)').fill('3');
  await P.locator('.sheet select').first().selectOption({label:'Jamie Rivera (@jamie)'});
  await P.getByLabel('Shipping ($)').fill('6');
  await P.getByRole('button', {name:'Create invoice'}).click();
  await P.getByRole('heading', {name:/^Invoice INV-0004/}).waitFor({timeout:10000});
  check(true, 'invoice INV-0004 created from the cart');

  // 7. No "CUSTOM" label under custom items on the invoice.
  const html = await P.evaluate(async () => {
    const box = document.querySelector('.sheet'); return box ? box.textContent : '';
  });
  check(html.includes('Gift wrap') && !/CUSTOM/.test(html), 'invoice screen shows the custom item without a CUSTOM label');
  const [dl] = await Promise.all([P.waitForEvent('download'), P.getByRole('button', {name:'Save printable web page'}).click()]);
  const page2 = await (await import('node:fs')).promises.readFile(await dl.path(), 'utf8');
  check(page2.includes('Gift wrap') && !page2.includes('>CUSTOM<'), 'printable invoice has no CUSTOM label');

  // 2. Edit the invoice: change quantity, add an inventory item and a custom item, remove a line.
  const stock = async id => P.evaluate(async i => (await (await window.claude.use('db')).doc('items/' + i).get()).data().qty, id);
  const w0 = await stock('w1'), g0 = await stock('g1');
  await P.getByRole('button', {name:'Edit items'}).click();
  await P.getByRole('heading', {name:'Edit INV-0004'}).waitFor();
  await P.locator('.cline', {hasText:'Gadget'}).getByLabel('Quantity').fill('3');
  await P.getByLabel('Add an item from inventory').selectOption({label:'Widget · SS-0001 (20 left)'});
  await P.locator('.cline', {hasText:'Widget'}).getByLabel('Quantity').fill('2');
  await P.locator('.cline', {hasText:'Gift wrap'}).getByRole('button', {name:'Remove'}).click();
  await P.getByRole('button', {name:'+ Custom item'}).click();
  await P.locator('.cline.custom input[type=text]').fill('Rush fee');
  await P.locator('.cline.custom').getByLabel('Price each ($)').fill('10');
  await P.getByRole('button', {name:'Save changes'}).click();
  await P.getByRole('heading', {name:/^Invoice INV-0004/}).waitFor({timeout:10000});
  const after = await P.evaluate(async () => { const db = await window.claude.use('db'); return (await db.collection('sales').get()).docs.map(d => d.data()).filter(s => s.invoiceNo === 'INV-0004').map(s => s.name + ':' + s.qty + '@' + s.unitPrice).sort(); });
  check(JSON.stringify(after) === JSON.stringify(['Gadget:3@8', 'Rush fee:1@10', 'Widget:2@5']), 'invoice lines are updated, added and removed (' + after.join(', ') + ')');
  check(await stock('w1') === w0 - 2 && await stock('g1') === g0 - 2, 'stock follows the edit (Gadget -2 more, Widget -2)');
  const sheet = await P.locator('.sheet').textContent();
  check(sheet.includes('$50.00'), 'invoice total is recalculated with shipping ($50.00)');
  await P.keyboard.press('Escape'); if (await P.locator('.backdrop').count()) await P.locator('.backdrop .icon-btn').first().click();
  // Over-selling in an edit is refused.
  await P.evaluate(() => { const r = [...document.querySelectorAll('.tabs button')].find(b => b.dataset.tab === 'orders'); r.click(); });
  await P.locator('.oline', {hasText:'INV-0004'}).click();
  await P.getByRole('button', {name:'Invoice', exact:true}).click();
  await P.getByRole('button', {name:'Edit items'}).click();
  await P.locator('.cline', {hasText:'Widget'}).getByLabel('Quantity').fill('99');
  await P.getByRole('button', {name:'Save changes'}).click();
  check((await P.locator('.sheet .err').textContent()).includes('Only 18 more of SS-0001'), 'edit refuses to sell more than is in stock');
  await P.getByRole('button', {name:'Cancel'}).click();
  await P.keyboard.press('Escape'); if (await P.locator('.backdrop').count()) await P.locator('.backdrop .icon-btn').first().click();

  // 4. Orders: one line per order.
  await P.getByRole('tab', {name:'Orders'}).click();
  const lines = await P.locator('.oline').count();
  const h1 = await P.locator('.oline').first().evaluate(e => e.getBoundingClientRect().height);
  check(lines === 4 && h1 < 60, 'orders show as single compact lines (' + lines + ' rows, ' + Math.round(h1) + 'px tall)');
  await P.locator('.oline', {hasText:'INV-0001'}).click();
  await P.getByRole('heading', {name:'Order INV-0001'}).waitFor();
  check((await P.locator('.sheet').textContent()).includes('Record payment'), 'tapping an order opens its details and actions');
  await P.getByRole('button', {name:'Mark packed'}).click();
  const shippedBtn = await P.getByRole('button', {name:'Mark shipped'}).waitFor({timeout:5000}).then(() => true, () => false);
  check(shippedBtn, 'order actions work from the detail sheet');
  await P.keyboard.press('Escape'); if (await P.locator('.backdrop').count()) await P.locator('.backdrop .icon-btn').first().click();

  // 6. Sales lookup: search and every sale with its time, custom items included.
  await P.getByRole('tab', {name:'Sales'}).click();
  await P.getByRole('button', {name:'All time'}).click();
  await P.getByRole('button', {name:'Every sale'}).click();
  check(await P.locator('.sline').count() === 6, 'every sale is listed (' + await P.locator('.sline').count() + ')');
  check(/\d{1,2}:\d{2}/.test(await P.locator('.sline').first().textContent()), 'each sale shows its time');
  await P.getByLabel('Search sales').fill('engrav');
  await P.waitForTimeout(200);
  const eng = await P.locator('.sline').allTextContents();
  check(eng.length === 1 && eng[0].includes('Jamie Rivera') && eng[0].includes('Custom'), 'search finds a custom sale and who bought it');
  await P.getByLabel('Search sales').fill('jamie');
  await P.waitForTimeout(200);
  check(await P.locator('.sline').count() === 6, 'search by customer finds all their sales');
  await P.getByLabel('Search sales').fill('');

  // 3. Custom dates: one day, then a range.
  await P.getByRole('button', {name:'Pick dates…'}).click();
  await P.getByRole('heading', {name:'Pick dates'}).waitFor();
  const target = new Date(); target.setDate(target.getDate() - 10);
  const label = target.toLocaleDateString(undefined, {weekday:'long', month:'long', day:'numeric', year:'numeric'});
  const thisMonth = new Date().getMonth();
  if (target.getMonth() !== thisMonth) await P.getByRole('button', {name:'Previous month'}).click();
  await P.getByRole('button', {name:label}).click();
  check(await P.getByRole('button', {name:label}).getAttribute('aria-pressed') === 'true', 'tapping a day highlights it');
  await P.getByRole('button', {name:'Show these dates'}).click();
  await P.waitForTimeout(200);
  const one = await P.locator('.sline').allTextContents();
  check(one.length === 1 && one[0].includes('Engraving'), 'one picked day shows just that day’s sales');
  await P.getByRole('button', {name:/✎$/}).click();
  const start = new Date(); start.setDate(start.getDate() - 12);
  const end = new Date(); end.setDate(end.getDate() - 2);
  const nav = async d => { const want = d.getFullYear() * 12 + d.getMonth(); for (let i = 0; i < 3; i++){ const t = await P.locator('.cal-title').textContent(); const cur = new Date(t + ' 1'); const have = cur.getFullYear() * 12 + cur.getMonth(); if (have === want) return; await P.getByRole('button', {name: have > want ? 'Previous month' : 'Next month'}).click(); } };
  await nav(start); await P.getByRole('button', {name:start.toLocaleDateString(undefined, {weekday:'long', month:'long', day:'numeric', year:'numeric'})}).click();
  await nav(end); await P.getByRole('button', {name:end.toLocaleDateString(undefined, {weekday:'long', month:'long', day:'numeric', year:'numeric'})}).click();
  await P.screenshot({path:'/tmp/stockroom-calendar.png'});
  const rangeHint = await P.locator('.sheet .hint').last().textContent();
  check(rangeHint.includes('11 days'), 'picking two days highlights the range between (' + rangeHint + ')');
  await P.getByRole('button', {name:'Show these dates'}).click();
  await P.waitForTimeout(200);
  check(await P.locator('.sline').count() === 2, 'a date range shows the sales inside it (' + await P.locator('.sline').count() + ')');

  // 5. Shipping report.
  await P.getByRole('tab', {name:'Reports'}).click();
  await P.getByRole('button', {name:'Shipping', exact:true}).click();
  await P.getByRole('button', {name:'All time'}).click();
  const sum = await P.locator('.sum').first().textContent();
  check(sum.includes('$17.50') && sum.includes('3orders with shipping'), 'shipping report totals all shipping charged (' + sum + ')');
  check(await P.getByText('Per month').count() === 1, 'long ranges are grouped by month');
  await P.getByRole('button', {name:'30 days'}).click();
  const sum30 = await P.locator('.sum').first().textContent();
  check(sum30.includes('$10.00') && (await P.getByText('Per day').count()) === 1, 'last 30 days shows shipping per day (' + sum30 + ')');
  await P.screenshot({path:'/tmp/stockroom-shipping.png'});
  await P.getByRole('tab', {name:'Orders'}).click(); await P.screenshot({path:'/tmp/stockroom-orders.png'});

  // 8. Shoes: pick several sizes at once, and add another size from the cart.
  await P.evaluate(async () => {
    const db = await window.claude.use('db');
    await db.doc('items/s1').set({sku:'SS-0100', name:'Runner', category:'Sneakers', sizeType:'mens', qty:6, sizes:{'9':2, '10':1, '11':3}, cost:40, price:90, priceMedium:null, priceLarge:null, tiers:[], createdAt:new Date().toISOString()});
  });
  await P.getByRole('tab', {name:'Inventory'}).click();
  await P.locator('[data-cartid="s1"]').click();
  await P.getByRole('heading', {name:'Pick sizes · SS-0100'}).waitFor();
  await P.getByRole('button', {name:/^Size 9,/}).click();
  await P.getByRole('button', {name:/^Size 9,/}).click();
  await P.getByRole('button', {name:/^Size 11,/}).click();
  await P.screenshot({path:'/tmp/stockroom-sizes.png'});
  check(await P.getByRole('button', {name:'Size 9, 2 left, 2 in cart'}).count() === 1, 'size picker counts what is in the cart per size');
  await P.getByRole('button', {name:/^Size 9,/}).click();
  check(await P.getByText('Only 2 in stock in size 9.').count() === 1, 'size picker stops at the stock for that size');
  await P.getByRole('button', {name:'Done'}).click();
  await P.locator('#cartBar').click();
  const szs = () => P.evaluate(() => [...document.querySelectorAll('.cline select')].map(s => s.value + ':' + s.closest('.cline').querySelector('input[type=number]').value).join(','));
  check(await szs() === '9:2,11:1', 'cart has one line per size (' + await szs() + ')');
  await P.getByRole('button', {name:'+ Another size'}).first().click();
  check(await szs() === '9:2,10:1,11:1', 'Another size adds the next size not in the cart (' + await szs() + ')');
  check(await P.getByRole('button', {name:'+ Another size'}).count() === 0, 'Another size hides once every size is in the cart');
  await P.locator('.cline select').nth(1).selectOption('11');
  check(await szs() === '9:2,11:2', 'changing a line to a size already in the cart merges them (' + await szs() + ')');
  const qbox = P.locator('.cline').first().getByLabel('Quantity');
  await qbox.click(); await qbox.hover(); await P.mouse.wheel(0, -300); await P.waitForTimeout(150);
  const stillFocused = await qbox.evaluate(el => document.activeElement === el);
  check(!stillFocused && await qbox.inputValue() === '2', 'scrolling the mouse over a quantity lets go of the box, so the wheel cannot change it');
  await P.locator('.sheet select').first().selectOption({label:'Jamie Rivera (@jamie)'});
  await P.getByRole('button', {name:'Create invoice'}).click();
  await P.getByRole('heading', {name:/^Invoice INV-0005/}).waitFor({timeout:10000});
  const left = await P.evaluate(async () => { const db = await window.claude.use('db'); const d = await db.doc('items/s1').get(); return JSON.stringify([d.data().qty, d.data().sizes]); });
  check(left === '[2,{"10":1,"11":1}]', 'invoice takes each size out of stock (' + left + ')');
  await P.locator('.sheet').getByRole('button', {name:'Close'}).first().click();
  await ctx.setDefaultTimeout(5000);
  const ctxD = await context(b, {viewport:{width:1280, height:800}}), D = await page(ctxD, errs);
  await D.goto(SITE); await D.getByLabel('Email').fill(`orders-${run}@shop.test`); await D.getByLabel('Password').fill('correct-horse-9');
  await D.getByRole('button', {name:'Sign in'}).last().click(); await D.locator('#status.live').waitFor({timeout:10000});
  await D.getByRole('tab', {name:'Orders'}).click(); await D.waitForTimeout(300); await D.screenshot({path:'/tmp/stockroom-orders-desk.png'});
} catch(e){
  results.push('FAIL test crashed: ' + (e && e.stack || e));
  let i = 0; for (const c of b.contexts()) for (const pg of c.pages()) await pg.screenshot({path:'/tmp/stockroom-orders-crash-' + (i++) + '.png'}).catch(() => {});
} finally { await b.close(); }
check(!errs.length, 'no page errors' + (errs.length ? ':\n  ' + errs.join('\n  ') : ''));
console.log(results.join('\n'));
const failed = results.filter(r => r.startsWith('FAIL')).length;
console.log(failed + ' failed of ' + results.length);
process.exit(failed ? 1 : 0);
