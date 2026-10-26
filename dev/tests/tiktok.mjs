// TikTok Shop finance: connect (through the stand-in TikTok), sync, and the fee breakdown in Reports.
// Run against the local server (node dev/server.mjs): node dev/tests/tiktok.mjs
import {execFileSync} from 'node:child_process';
import {browser, context, page, SITE} from './helpers.mjs';
// Support switches TikTok Shop on for a company (done here straight in the database).
const enableTikTok = email => execFileSync('su', ['postgres', '-c', `psql -q -d ${process.env.DEV_DB || 'stockroom_dev'} -c "insert into public.tiktok_settings(company_id, enabled) select m.company_id, true from public.members m join auth.users u on u.id = m.user_id where u.email = '${email}' on conflict (company_id) do update set enabled = true"`]);

const API = 'http://localhost:54321';
const results = [], errs = [];
const check = (ok, msg) => { results.push((ok ? 'PASS ' : 'FAIL ') + msg); };
const run = Date.now().toString(36);
const b = await browser();
try {
  const ctx = await context(b), P = await page(ctx, errs);
  await P.goto(SITE);
  await P.getByRole('tab', {name:'Create account'}).click();
  await P.getByLabel('Email').fill(`tiktok-${run}@shop.test`); await P.getByLabel('Password').fill('correct-horse-9');
  await P.getByRole('button', {name:'Create account'}).last().click();
  await P.getByLabel('Company name').fill('TikTok Test Co'); await P.getByRole('button', {name:'Create company'}).click();
  await P.locator('#status.live').waitFor({timeout:10000});

  await P.getByRole('tab', {name:'Reports'}).click();
  await P.getByRole('button', {name:'Shipping', exact:true}).waitFor();
  await P.waitForTimeout(500);
  check(await P.getByRole('button', {name:'TikTok Shop'}).count() === 0, 'TikTok Shop is hidden until support switches it on');
  enableTikTok(`tiktok-${run}@shop.test`);
  await P.reload(); await P.locator('#status.live').waitFor({timeout:10000});
  await P.getByRole('tab', {name:'Reports'}).click();
  await P.getByRole('button', {name:'TikTok Shop'}).click();
  await P.getByRole('button', {name:'Connect TikTok Shop'}).click();
  // The stand-in TikTok sends the browser straight back to the site with ?code=…&state=…
  await P.getByText('Mock TikTok Shop').first().waitFor({timeout:15000});
  check(!/code=|state=/.test(P.url()), 'the code from TikTok is removed from the address bar');
  check(true, 'connecting through TikTok comes back to Reports, connected');
  await P.getByText(/^Updated /).first().waitFor({timeout:15000});
  await P.getByText('paid to you').first().waitFor({timeout:15000});
  const sum = await P.locator('.sum').first().textContent();
  check(sum.includes('$100.00') && sum.includes('$61.20') && sum.includes('39%'), 'totals show revenue, payout and what TikTok kept (' + sum + ')');
  const page1 = await P.locator('#list, main, body').first().textContent();
  check(page1.includes('Creator (affiliate) commission') && page1.includes('-$20.00'), 'creator commission shows as its own fee');
  check(page1.includes('TikTok commission') && page1.includes('Payment processing fee') && page1.includes('Shipped by TikTok fee'), 'every fee type is listed');
  check(page1.includes('Payouts') && page1.includes('paid'), 'payouts are listed');
  const card = async title => (await P.locator('.row.wide').filter({has:P.locator('.hh', {hasText:new RegExp('^' + title + '$')})}).first().textContent()) || '';
  check((await card('TikTok fees')).includes('-$8.90') && (await card('TikTok fees')).includes('TikTok commission'), 'TikTok fees are their own section with a subtotal');
  check((await card('Creator commissions')).includes('-$20.00'), 'creator commissions are their own section');
  check((await card('Shipping')).includes('-$9.90') && (await card('Shipping')).includes('Shipped by TikTok fee'), 'shipping costs are their own section');
  check((await card('Sales')).includes('$100.00'), 'sales are their own section');
  const paidCard = await card('= Paid to you');
  check(paidCard.includes('$61.20') && !paidCard.includes('does not add up'), 'the sections add up to the payout');
  const calls = await (await fetch(API + '/mock-tiktok/calls')).json();
  const stored = await P.evaluate(async () => { const tt = await window.claude.use('tiktok'); return (await tt.order('5770001'))[0].data; });
  check(!stored.sku_list && !stored.note && stored.currency === 'USD' && stored.fee_tax_breakdown.fee.platform_commission_amount === '-6.00', 'order lines are stored slim: amounts and short fields, not lists or long text');
  check(calls.some(c => c.includes('/finance/202501/')) && calls.some(c => c.includes('/finance/202309/statements/S1/statement_transactions')), 'falls back to an older TikTok API version when a newer one is not available');
  await P.getByRole('button', {name:/Order 5770001/}).click();
  await P.locator('.sheet').getByText('Creator commissions').waitFor({timeout:8000});
  const sheet = await P.locator('.sheet').textContent();
  check(sheet.includes('Shipping label cost') && sheet.includes('-$8.00') && sheet.includes('Creator commissions'), 'an order shows each money line, by section');
  await P.screenshot({path:'/tmp/stockroom-tiktok-order.png'});
  await P.locator('.sheet').getByRole('button', {name:'Close'}).click();
  await P.screenshot({path:'/tmp/stockroom-tiktok.png', fullPage:true});

  // A second sync doesn't duplicate anything.
  await P.getByRole('button', {name:'Sync now'}).click();
  await P.getByText('TikTok Shop is up to date').waitFor({timeout:10000});
  await P.getByRole('button', {name:/Order 5770001/}).first().waitFor({timeout:10000});
  const n = await P.getByRole('button', {name:/Order 5770001/}).count();
  check(n === 1, 'syncing again does not duplicate orders');

  P.once('dialog', d => d.accept());
  await P.getByRole('button', {name:'Disconnect'}).click();
  await P.getByRole('button', {name:'Connect TikTok Shop'}).waitFor({timeout:8000});
  check(true, 'disconnect returns to the connect screen');

  // A link with a stale or someone else's state does not connect.
  await P.goto(SITE + '?code=good-code&state=ttbogus');
  await P.locator('#status.live').waitFor({timeout:10000});
  await P.getByText(/TikTok Shop did not connect/).waitFor({timeout:8000});
  check(true, 'a bogus TikTok return link is refused');
} catch(e){
  results.push('FAIL test crashed: ' + (e && e.stack || e));
  let i = 0; for (const c of b.contexts()) for (const pg of c.pages()) await pg.screenshot({path:'/tmp/stockroom-tiktok-crash-' + (i++) + '.png'}).catch(() => {});
} finally { await b.close(); }
const real = errs.filter(e => !/tiktok/.test(e) || !/ 40[03] /.test(e));
check(!real.length, 'no page errors' + (real.length ? ':\n  ' + real.join('\n  ') : ''));
console.log(results.join('\n'));
const failed = results.filter(r => r.startsWith('FAIL')).length;
console.log(failed + ' failed of ' + results.length);
process.exit(failed ? 1 : 0);
