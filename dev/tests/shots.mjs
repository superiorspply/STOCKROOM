// Screenshots of the account sheet for a visual check: node dev/tests/shots.mjs <out dir>
import {browser, context, page, SITE} from './helpers.mjs';
const out = process.argv[2] || '/tmp', errs = [], b = await browser(), ctx = await context(b, {viewport:{width:375, height:812}}), p = await page(ctx, errs);
await p.goto(SITE);
await p.getByRole('tab', {name:'Create account'}).click();
await p.getByLabel('Email').fill('shots' + Date.now() + '@x.test'); await p.getByLabel('Password').fill('correct-horse-9');
await p.getByRole('button', {name:'Create account'}).last().click();
await p.screenshot({path: out + '/shot-company.png'});
await p.getByLabel('Company name').fill('Superior Supply Co'); await p.getByRole('button', {name:'Create company'}).click();
await p.locator('#status.live').waitFor();
await p.screenshot({path: out + '/shot-home.png'});
await p.locator('#acctBtn').click(); await p.getByRole('button', {name:'Create invite link'}).click(); await p.waitForTimeout(400);
await p.screenshot({path: out + '/shot-account.png'});
console.log(errs.join('\n') || 'no errors'); await b.close();
