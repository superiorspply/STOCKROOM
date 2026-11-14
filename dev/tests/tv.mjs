// TV dashboard: today's TikTok orders (from the stand-in TikTok), a new order arriving with a pop-up,
// the shared LIVE tab, and leaving TV mode.
// Run against the local server (node dev/server.mjs): node dev/tests/tv.mjs
import {execFileSync} from 'node:child_process';
import {browser, context, page, SITE} from './helpers.mjs';
const enableTikTok = email => execFileSync('su', ['postgres', '-c', `psql -q -d ${process.env.DEV_DB || 'stockroom_dev'} -c "insert into public.tiktok_settings(company_id, enabled) select m.company_id, true from public.members m join auth.users u on u.id = m.user_id where u.email = '${email}' on conflict (company_id) do update set enabled = true"`]);

const API = 'http://localhost:54321';
const results = [], errs = [];
const check = (ok, msg) => { results.push((ok ? 'PASS ' : 'FAIL ') + msg); };
const run = Date.now().toString(36);
const b = await browser();
try {
  const ctx = await context(b, {viewport:{width:1920, height:1080}});
  // The browser's screen-share picker can't be clicked in a test: hand back a moving canvas as "the LIVE tab".
  await ctx.addInitScript(() => {
    try { localStorage.setItem('ss_tvpoll', '2500'); } catch(e){}
    navigator.mediaDevices.getDisplayMedia = async () => {
      const c = document.createElement('canvas'); c.width = 320; c.height = 180; const x = c.getContext('2d');
      setInterval(() => { x.fillStyle = '#' + ((Math.random() * 0xffffff) | 0).toString(16).padStart(6, '0'); x.fillRect(0, 0, 320, 180); }, 100);
      return c.captureStream(10);
    };
  });
  const P = await page(ctx, errs);
  await fetch(API + '/mock-tiktok/add-order', {method:'POST', body:JSON.stringify({reset:true})});   // the 150 orders the stand-in starts with
  await P.goto(SITE);
  await P.getByRole('tab', {name:'Create account'}).click();
  await P.getByLabel('Email').fill(`tv-${run}@shop.test`); await P.getByLabel('Password').fill('correct-horse-9');
  await P.getByRole('button', {name:'Create account'}).last().click();
  await P.getByLabel('Company name').fill('TV Test Co'); await P.getByRole('button', {name:'Create company'}).click();
  await P.locator('#status.live').waitFor({timeout:10000});
  enableTikTok(`tv-${run}@shop.test`);
  await P.reload(); await P.locator('#status.live').waitFor({timeout:10000});
  await P.getByRole('tab', {name:'Reports'}).click();
  await P.getByRole('button', {name:'TikTok Shop'}).click();
  await P.getByRole('button', {name:'Connect TikTok Shop'}).click();
  await P.getByText('Mock TikTok Shop').first().waitFor({timeout:15000});

  await P.getByRole('button', {name:'TV', exact:true}).click();
  const tv = P.locator('#tv');
  await tv.waitFor();
  await tv.getByText(/150 orders/).waitFor({timeout:20000});
  const today = await tv.locator('.today').textContent();
  check(today.includes('$1,750.00') && today.includes('150 orders') && today.includes('150 items'), 'TV mode adds up today\'s TikTok orders, paging through all of them (' + today.slice(0, 90) + ')');
  check((await tv.locator('.tops').textContent()).includes('1. Squishy Butter100'), 'the best sellers today are listed');
  check(await tv.locator('.feed .o').count() >= 10, 'the latest orders are listed');
  check(await tv.locator('.hours i').count() === 24, 'orders by hour are drawn');

  await fetch(API + '/mock-tiktok/add-order', {method:'POST', body:JSON.stringify({name:'Mega Squishy', price:120})});
  await tv.getByText(/New order · Mega Squishy · \$120\.00/).waitFor({timeout:10000});
  check(true, 'a new TikTok order pops up on the TV');
  await tv.getByText('$1,870.00').waitFor({timeout:5000});
  check((await tv.locator('.feed .o').first().textContent()).includes('Mega Squishy'), 'the new order goes to the top of the list and into the total');

  await tv.getByRole('button', {name:'Show our live'}).last().click();
  await P.waitForFunction(() => { const v = document.querySelector('#tv video'); return v && !v.hidden && v.videoWidth > 0; }, null, {timeout:10000});
  check(await tv.locator('.onair.on').count() === 1, 'the shared LIVE tab plays on the TV and LIVE lights up');

  await tv.getByRole('button', {name:'Test sound'}).click();
  check(await tv.getByRole('slider', {name:'Order sound volume'}).count() === 1, 'the order sound can be tested and its volume set');
  if (process.env.SHOT) await P.screenshot({path:process.env.SHOT});
  // The order map: today's orders by state, shipped ones on the way, delivered ones landed.
  await tv.getByRole('button', {name:'Map view'}).click();
  await P.waitForFunction(() => document.querySelector('#tv .tvmap')?.dataset.ready === '1', null, {timeout:20000});
  await tv.locator('.gstats').getByText('On the way').waitFor({timeout:10000});
  await tv.locator('.gstats .g b').filter({hasText:/^37$/}).waitFor({timeout:10000});
  const gs = await tv.locator('.gstats').textContent();
  check(/151Orders today/.test(gs) && /38On the way/.test(gs) && /37Delivered today/.test(gs) && /8States today/.test(gs), 'the map counts today\'s orders, those on the way, delivered ones and states (' + gs + ')');
  check(/1\. (TX|CA|FL|NY|IL|OH|WA|GA)19/.test(await tv.locator('.gside .tops').textContent()), 'the top states are listed');
  check(await tv.locator('.globe canvas').count() >= 1 && await tv.locator('.tvlive').isHidden(), 'the globe is drawn, in place of the live and sales view');
  await fetch(API + '/mock-tiktok/add-order', {method:'POST', body:JSON.stringify({ship:'577001000'})});
  await tv.locator('.gstats .y b').filter({hasText:/^39$/}).waitFor({timeout:10000});
  check(true, 'a newly shipped order starts flying on the map');
  if (process.env.SHOT2) { await P.waitForTimeout(2500); await P.screenshot({path:process.env.SHOT2}); }
  await tv.getByRole('button', {name:'Dashboard'}).click();
  check(await tv.locator('.tvlive').isVisible() && await tv.locator('.tvmap').isHidden(), 'Dashboard goes back to the live and sales view');
  await tv.getByRole('button', {name:'Exit TV'}).click();
  check(await P.locator('#tv').count() === 0, 'Exit TV goes back to Stockroom');
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
