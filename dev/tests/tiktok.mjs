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
  check(sum.includes('$100.00') && sum.includes('$46.20') && sum.includes('39%'), 'tiles show sales, the share to fees and shipping, and what TikTok\'s statements paid out (' + sum + ')');
  const card = async title => (await P.locator('.row.wide').filter({has:P.locator('.hh', {hasText:new RegExp('^' + title + '$')})}).first().textContent()) || '';
  const tab = async name => { await P.locator('.tttabs').getByRole('tab', {name, exact:true}).click(); };
  const overview = await card('From sales to your payout');
  check(overview.includes('$56.20') && overview.includes('Reserve') && !overview.includes('does not add up') && overview.includes('TikTok fees') && overview.includes('Shipping'), 'the overview adds the sections up to the payout (' + overview + ')');
  check((await card('Biggest costs')).includes('Creator (affiliate) commission'), 'the overview lists the biggest costs');
  check(await P.locator('.tttabs').getByRole('tab').count() >= 6, 'tabs jump to each part of the report');
  const stc = await card('TikTok statement totals');
  check(stc.includes('Total settlement') && stc.includes('$46.20') && stc.includes('Revenue') && stc.includes('$100.00') && /Payable amount\$41\.20/.test(stc), 'TikTok\'s own statement totals are shown, with reserve and the payable amount (' + stc + ')');
  const chk = await card('Checked against TikTok');
  check(chk.includes('1 of 2 payouts match their order lines to the cent') && chk.includes('no order lines') && !chk.includes('differ'), 'each payout is checked against its order lines (' + chk + ')');
  await tab('TikTok fees');
  check((await card('TikTok fees')).includes('-$10.80') && (await card('TikTok fees')).includes('TikTok commission') && (await card('TikTok fees')).includes('Payment processing fee') && (await card('TikTok fees')).includes('Shipped by TikTok fee'), 'the TikTok fees tab shows each fee with a subtotal');
  await tab('Creator commissions');
  check((await card('Creator commissions')).includes('-$20.00'), 'creator commissions have their own tab');
  await tab('Shipping');
  const ship = await card('Shipping \\(net\\)');
  check(ship.includes('-$8.00') && !ship.includes('Fbm'), 'shipping has its own tab, without TikTok\'s repeated reference lines');
  check(/Paid by buyers\$5\.00/.test(ship) && /Covered by TikTok\$1\.00/.test(ship) && /Paid by you-\$14\.00/.test(ship), 'shipping is split into what buyers paid, what TikTok covered and what you paid (' + ship + ')');
  check((await P.locator('.tttiles').textContent()).includes('shipping buyers paid'), 'the tiles show shipping buyers paid and shipping you paid');
  await tab('Sales');
  check((await card('Sales')).includes('$100.00'), 'sales have their own tab');
  await tab('For reference');
  const ref = await card('For reference');
  check(ref.includes('Customer payment') && ref.includes('$107.50') && ref.includes('Fbm shipping cost') && ref.includes('Referral fee'), 'reference figures (and breakdown lines repeated at the top level) are listed apart, not added up');
  await tab('Payouts');
  const vs = await card('Payouts compared with order lines');
  check(vs.includes('-$10.00') && vs.includes('$46.20') && (await card('Payouts \\(2\\)')).includes('matches its order lines and -$5.00 reserve'), 'payouts are checked with their reserve, and money paid out without order lines shows as the gap between payouts and order lines (' + vs + ')');
  check((await card('Payouts \\(2\\)')).includes('paid'), 'payouts are listed');
  await P.getByRole('button', {name:'7 days', exact:true}).click();
  await P.getByText('From sales to your payout').or(P.getByText('Payouts compared with order lines')).first().waitFor({timeout:15000});
  check(await P.locator('.tttabs [aria-pressed="true"]').textContent() === 'Payouts', 'the tab picked stays picked when the dates change');
  await tab('Orders');
  const calls = await (await fetch(API + '/mock-tiktok/calls')).json();
  const stored = await P.evaluate(async () => { const tt = await window.claude.use('tiktok'); return (await tt.order('5770001'))[0].data; });
  check(!stored.sku_list && !stored.note && stored.currency === 'USD' && stored.fee_tax_breakdown.fee.platform_commission_amount === '-6.00', 'order lines are stored slim: amounts and short fields, not lists or long text');
  check(calls.some(c => c.includes('/finance/202501/')) && calls.some(c => c.includes('/finance/202309/statements/S1/statement_transactions')), 'falls back to an older TikTok API version when a newer one is not available');
  // The hourly job: only with the database's secret, and it syncs the connected company.
  const cronSecret = execFileSync('su', ['postgres', '-c', `psql -qtA -d ${process.env.DEV_DB || 'stockroom_dev'} -c "select secret from public.tiktok_cron"`]).toString().trim();
  const auto = h => fetch(API + '/functions/v1/tiktok', {method:'POST', headers:Object.assign({'Content-Type':'application/json'}, h), body:JSON.stringify({action:'auto'})});
  check((await auto({'x-cron-secret':'wrong'})).status === 403 && (await auto({})).status === 403, 'the hourly sync refuses calls without the database\'s secret');
  const ran = await (await auto({'x-cron-secret':cronSecret})).json();
  check(ran.companies && ran.companies.some(c => !c.error && c.left === 0 && c.statements >= 1), 'the hourly sync pulls every connected shop and adds it into the totals (' + JSON.stringify(ran) + ')');
  await P.getByRole('button', {name:/Order 5770001/}).click();
  await P.locator('.sheet').getByText('Creator commissions').waitFor({timeout:8000});
  const sheet = await P.locator('.sheet').textContent();
  check(sheet.includes('Shipping label cost') && sheet.includes('-$14.00') && sheet.includes('Creator commissions'), 'an order shows each money line, by section');
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
