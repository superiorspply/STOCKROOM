# Putting Stockroom online

Stockroom runs as a website at **https://stockroominc.com**. The domain is registered with Squarespace and points at GitHub Pages; the old address, https://superiorspply.github.io/STOCKROOM/, forwards there.

- **GitHub Pages** hosts the site for free. Each time `main` changes, GitHub checks the code and republishes the site in about a minute.
- **Supabase** stores the data, handles accounts and holds product photos. The free plan is enough to start.

You only do these steps once.

## 1. Create the Supabase project

1. Go to [supabase.com](https://supabase.com), sign up and click **New project**.
2. Name it `stockroom`, choose a strong database password (save it somewhere safe) and pick the region closest to you. Click **Create new project** and wait about 2 minutes.

## 2. Set up the database

1. In the project, open **SQL Editor** in the left sidebar and click **New query**.
2. Open [`supabase/migrations/20261020000000_stockroom.sql`](supabase/migrations/20261020000000_stockroom.sql) on GitHub, click the **Copy raw file** button and paste it into the editor.
3. Click **Run**. You should see "Success. No rows returned".

## 3. Set up sign-in

1. Go to **Authentication → URL Configuration**:
   - **Site URL:** `https://stockroominc.com/`
   - Under **Redirect URLs**, click **Add URL** and add `https://stockroominc.com/` and `https://www.stockroominc.com/`.
2. Go to **Authentication → Sign In / Providers → Email**.
   - The simplest option is to turn **Confirm email** off. People can then use the site as soon as they create an account.
   - If you leave it on, Supabase's built-in email sends only a few messages per hour. That's fine for a small team, but with many sign-ups you'll want to connect your own email sender under **Authentication → Emails → SMTP Settings**.

## 4. Connect the site to Supabase

1. Go to **Project Settings → API** (on some projects it's **Data API** and **API Keys**).
2. Copy the **Project URL** and the **anon public** key.
3. Send both to Claude and ask it to put them in `config.js`. Or edit [`config.js`](config.js) on GitHub yourself and paste them between the quotes.

Both values are safe to publish. The anon key can only do what the database's security rules allow.

## 5. Turn on GitHub Pages

1. In the GitHub repo, go to **Settings → Pages**.
2. Under **Build and deployment → Source**, choose **GitHub Actions**.
3. Go to the **Actions** tab, click **Test and publish site**, then **Run workflow**. When it turns green, the site is live.

## 6. Move your Superiorspply data in

1. Open the site, click **Create account**, and create your company **Superiorspply**.
2. Tap the **person icon** (top right) → **Import a backup file**, and choose `superiorspply-stockroom-import.json` (the file Claude gave you). This brings in your items, photos, customers, sales, invoices and logo.

## 7. Invite your team

Tap the **person icon → Invite someone**, pick a role, tap **Create invite link** and send the link. Each link works once and expires after 7 days.

| Role   | Can do |
|--------|--------|
| Owner  | Everything, including the team and company settings |
| Admin  | Everything except changing other admins |
| Staff  | Sells, adds stock and clocks in. Cannot see costs or change settings |
| Viewer | Looks only. Cannot change anything |

## Support access (seeing every company)

To open any company and help fix things, give your own account support access. Do this once, after you've signed up on the site:

1. If you haven't already, run [`supabase/migrations/20261020010000_support_access.sql`](https://raw.githubusercontent.com/superiorspply/STOCKROOM/main/supabase/migrations/20261020010000_support_access.sql) in the **SQL Editor**: copy the whole page, paste it in, and click **Run**.
2. In a new query, run this with your sign-in email:

   ```sql
   insert into platform_admins select id from auth.users where email = 'you@example.com';
   ```

3. Reload the site. The company picker now has **Support: open any company**. You can also get there from the person icon → **Switch company**.

While you're inside someone else's company, a red **Support mode** bar shows at the top. You can fix things there like an admin, but you can't delete the company or change its owner. Each visit is logged, and the company's owner and admins can see it under **Support visits** in their account menu. You never appear in their team list.

To remove support access later: `delete from platform_admins where user_id = (select id from auth.users where email = 'you@example.com');`

## Bringing in stock from invoices and spreadsheets

On the **Inventory** tab, owners and admins have a **Bring in stock** button with two options:

- **Import a spreadsheet** (CSV or Excel) works straight away. You pick which columns hold the name, quantity and cost.
- **Scan an invoice** (photo or PDF) uses Claude to read the invoice, so it needs the one-time setup below.

Both lead to the same review screen. Lines that match an item you already have add to its stock and update its average cost. New items are created and labelled **Needs photo & price** until you add a photo and a selling price with **Edit**.

### Setting up invoice scanning (once)

1. **Get a Claude API key**
   1. Sign up at [console.anthropic.com](https://console.anthropic.com).
   2. Add a payment method under **Billing**.
   3. Under **Limits**, set a monthly spend limit, for example $20.
   4. Create a key under **API Keys** and copy it. It starts with `sk-ant-`. Keep it private, and never paste it into the site's code or config.js.
2. **Run the database update.** In the Supabase **SQL Editor**, run [`supabase/migrations/20261021000000_invoice_scanning.sql`](https://raw.githubusercontent.com/superiorspply/STOCKROOM/main/supabase/migrations/20261021000000_invoice_scanning.sql): copy the whole page, paste it, and click **Run**.
3. **Store the key in Supabase.** Go to **Edge Functions → Secrets** and add a secret named `ANTHROPIC_API_KEY` whose value is your key.
4. **Add the scanning function**
   1. Go to **Edge Functions → Deploy a new function → Via Editor**.
   2. Name it exactly `scan-invoice`.
   3. Replace the sample code with everything in [`supabase/functions/scan-invoice/index.ts`](https://raw.githubusercontent.com/superiorspply/STOCKROOM/main/supabase/functions/scan-invoice/index.ts).
   4. Click **Deploy**.
   5. In the function's **Details**, turn **Verify JWT** off. The function checks sign-in itself through the database.
5. **Turn scanning on for a company.** As support, open the company, then go to the person icon → **Support tools**. Tick **Invoice scanning**, set the scans per month, and click **Save**. Scanning is off for every company until you do this, so you decide who can use it.

**Cost:** each scan is one request to Claude Opus 5.5 and usually costs a few cents, depending on the invoice's length. Scans that fail don't count toward the monthly limit. Anthropic's spend limit from step 1 is your hard cap.

## Operator (AI assistant)

The **Operator** button at the top of Stockroom opens a chat. Type or tap the microphone and talk to it, for example:

- "Who owes us money?"
- "What sold best this week?"
- "Invoice Dom for 200 squishy butters at $2."
- "Dom paid $1,000 Zelle on INV-0042."

It answers from your Stockroom data. It can create invoices, record payments, add customers and change stock. It can also draft texts for you to send.

Before any change, it shows a card with exactly what it will do, and nothing is saved until you tap **Confirm**. It works through your own login, so it can only see and do what you can; staff don't see costs or profit. It can't send messages itself: **Open in Messages** opens the text for you to send.

### Setting up the Operator (once)

It uses the same Claude API key as invoice scanning (`ANTHROPIC_API_KEY`).

1. **Run the database update.** In the Supabase **SQL Editor**, run [`supabase/migrations/20261114000000_operator.sql`](https://raw.githubusercontent.com/superiorspply/STOCKROOM/main/supabase/migrations/20261114000000_operator.sql).
2. **Add the Operator function**
   1. Go to **Edge Functions → Deploy a new function → Via Editor**.
   2. Name it exactly `operator`.
   3. Replace the sample code with everything in [`supabase/functions/operator/index.ts`](https://raw.githubusercontent.com/superiorspply/STOCKROOM/main/supabase/functions/operator/index.ts).
   4. Click **Deploy**.
   5. In the function's **Details**, turn **Verify JWT** off.
3. **Turn it on for a company.** As support, go to the person icon → **Support tools**. Tick **Operator (AI assistant)**, set the requests per month (3,000 to start), and click **Save**. Then refresh Stockroom, and the **Operator** button appears.

**Cost:** every reply from the Operator is one request to Claude Opus 5.5. Looking something up and then answering is usually 2 or 3 requests, and each costs about 1–3 cents. Failed requests don't count toward the monthly limit, and Anthropic's spend limit is your hard cap.

## TikTok Shop finance

**Reports → TikTok Shop** shows what TikTok really pays you:
- every payout
- each order's money lines: TikTok commission, payment processing, creator (affiliate) commission, shipping, refunds and adjustments
- totals for any dates

Only owners and admins can see it, and only in companies where support has switched it on: as support, open the company, then go to the person icon → **Support tools** → **TikTok Shop** and click **Save**. It is off for every other company. Once a company is connected, it updates automatically every hour (step 6 below) and whenever someone opens the page, and **Sync now** pulls the latest straight away.

### Setting up TikTok Shop (once)

1. **Create the app in TikTok Shop Partner Center** (partner.us.tiktokshop.com for a US shop)
   1. Register as a developer using the **in-house seller** option.
   2. Create a **Custom** app.
   3. Set the **Redirect URL** to `https://stockroominc.com/`.
   4. Under **Manage API**, request **Finance** (finance information) and **Authorization** (shop information).
   5. Once TikTok approves the app, copy its **App Key**, **App Secret** and **Authorization link**.
2. **Run the database updates.** In the Supabase **SQL Editor**, run [`supabase/migrations/20261026000000_tiktok_finance.sql`](https://raw.githubusercontent.com/superiorspply/STOCKROOM/main/supabase/migrations/20261026000000_tiktok_finance.sql), then [`supabase/migrations/20261026010000_tiktok_access.sql`](https://raw.githubusercontent.com/superiorspply/STOCKROOM/main/supabase/migrations/20261026010000_tiktok_access.sql), then [`supabase/migrations/20261026020000_tiktok_report.sql`](https://raw.githubusercontent.com/superiorspply/STOCKROOM/main/supabase/migrations/20261026020000_tiktok_report.sql), then [`supabase/migrations/20261026030000_tiktok_rollup.sql`](https://raw.githubusercontent.com/superiorspply/STOCKROOM/main/supabase/migrations/20261026030000_tiktok_rollup.sql), then [`supabase/migrations/20261026040000_tiktok_prepare_batches.sql`](https://raw.githubusercontent.com/superiorspply/STOCKROOM/main/supabase/migrations/20261026040000_tiktok_prepare_batches.sql), then [`supabase/migrations/20261026050000_tiktok_report_fast.sql`](https://raw.githubusercontent.com/superiorspply/STOCKROOM/main/supabase/migrations/20261026050000_tiktok_report_fast.sql), then [`supabase/migrations/20261026060000_tiktok_payouts_fast.sql`](https://raw.githubusercontent.com/superiorspply/STOCKROOM/main/supabase/migrations/20261026060000_tiktok_payouts_fast.sql), then [`supabase/migrations/20261026070000_tiktok_statement_dates.sql`](https://raw.githubusercontent.com/superiorspply/STOCKROOM/main/supabase/migrations/20261026070000_tiktok_statement_dates.sql), then [`supabase/migrations/20261026080000_tiktok_resend_fast.sql`](https://raw.githubusercontent.com/superiorspply/STOCKROOM/main/supabase/migrations/20261026080000_tiktok_resend_fast.sql), then [`supabase/migrations/20261026090000_tiktok_statement_totals.sql`](https://raw.githubusercontent.com/superiorspply/STOCKROOM/main/supabase/migrations/20261026090000_tiktok_statement_totals.sql), then [`supabase/migrations/20261026100000_tiktok_payout_reserve.sql`](https://raw.githubusercontent.com/superiorspply/STOCKROOM/main/supabase/migrations/20261026100000_tiktok_payout_reserve.sql), then [`supabase/migrations/20261026110000_tiktok_statement_day.sql`](https://raw.githubusercontent.com/superiorspply/STOCKROOM/main/supabase/migrations/20261026110000_tiktok_statement_day.sql), then [`supabase/migrations/20261026120000_tiktok_auto_sync.sql`](https://raw.githubusercontent.com/superiorspply/STOCKROOM/main/supabase/migrations/20261026120000_tiktok_auto_sync.sql), then [`supabase/migrations/20261026130000_tiktok_sync_timeout.sql`](https://raw.githubusercontent.com/superiorspply/STOCKROOM/main/supabase/migrations/20261026130000_tiktok_sync_timeout.sql), then [`supabase/migrations/20261026140000_tiktok_statement_lines.sql`](https://raw.githubusercontent.com/superiorspply/STOCKROOM/main/supabase/migrations/20261026140000_tiktok_statement_lines.sql), then [`supabase/migrations/20261026150000_tiktok_sync_once.sql`](https://raw.githubusercontent.com/superiorspply/STOCKROOM/main/supabase/migrations/20261026150000_tiktok_sync_once.sql), then [`supabase/migrations/20261104000000_tiktok_daily_sales.sql`](https://raw.githubusercontent.com/superiorspply/STOCKROOM/main/supabase/migrations/20261104000000_tiktok_daily_sales.sql). For each: copy the whole page, paste it, and click **Run**.
3. **Store the app details in Supabase.** Go to **Edge Functions → Secrets** and add three secrets:
   - `TIKTOK_APP_KEY`: the App Key
   - `TIKTOK_APP_SECRET`: the App Secret
   - `TIKTOK_AUTH_URL`: the Authorization link

   Never put the App Secret in the site's code or config.js.
4. **Add the TikTok function**
   1. Go to **Edge Functions → Deploy a new function → Via Editor**.
   2. Name it exactly `tiktok`.
   3. Replace the sample code with everything in [`supabase/functions/tiktok/index.ts`](https://raw.githubusercontent.com/superiorspply/STOCKROOM/main/supabase/functions/tiktok/index.ts).
   4. Click **Deploy**.
   5. In the function's **Details**, turn **Verify JWT** off. The function checks sign-in itself through the database.
5. **Connect.** In Stockroom, go to **Reports → TikTok Shop → Connect TikTok Shop**, log in to TikTok, and approve. You come back to Stockroom, and the first sync pulls the last 90 days.
6. **Fill the payout checks (once).** After `20261026140000_tiktok_statement_lines.sql`, run [`supabase/setup/tiktok_statement_lines_fill.sql`](https://raw.githubusercontent.com/superiorspply/STOCKROOM/main/supabase/setup/tiktok_statement_lines_fill.sql) again and again until `statements_left` is 0, with the TikTok page closed.
7. **Keep it synced every hour.** In the **SQL Editor**, run [`supabase/setup/tiktok_auto_sync.sql`](https://raw.githubusercontent.com/superiorspply/STOCKROOM/main/supabase/setup/tiktok_auto_sync.sql). It schedules a job that calls the TikTok function every hour with a secret only the database and the function can read, so the numbers are up to date even when nobody opens the page.

The TikTok tokens are kept in a table that only the server function can read. Disconnecting removes them, and finance data already pulled stays.

### TV dashboard

The **TV** button at the top of Stockroom (owners and admins) opens a full-screen dashboard for a TV:

- today's TikTok sales, orders and items, counted on TikTok's day (Pacific time) like Seller Center's Data Analysis
- each new order popping up with a chime
- best sellers, sales by hour, the sales goal, and today's Stockroom invoices along the bottom

It checks TikTok for new orders every 20 seconds. Move the mouse to show the buttons; they hide again after a few seconds.

**Your TikTok LIVE on the TV.** TikTok doesn't let other sites embed a LIVE, so the dashboard shows it by sharing a browser tab. On the Mac connected to the TV:

1. In Chrome, open your LIVE in one tab.
2. Open Stockroom in another tab and click **TV**.
3. Click **Show our live** and pick the LIVE tab.

The LIVE tab plays its own sound, so the dashboard stays silent apart from the order chime (**Sound on/off**).

**Live orders need TikTok's Order permission (once).**

1. In TikTok Shop Partner Center, open the Stockroom app.
2. Add the **Order** permission (order information, read), and save.
3. If TikTok asks, submit the change for review.
4. In Stockroom, go to **Reports → TikTok Shop**, disconnect, then **Connect TikTok Shop** again, so the connection includes the new permission.
5. Deploy the latest [`supabase/functions/tiktok/index.ts`](https://raw.githubusercontent.com/superiorspply/STOCKROOM/main/supabase/functions/tiktok/index.ts) to the `tiktok` function. No database change is needed.

Until then, the TV shows the error TikTok gives, and everything else still works.

## The domain (stockroominc.com)

These steps are already done. They're here in case the domain ever needs setting up again.

1. **Squarespace** (account.squarespace.com/domains → stockroominc.com → DNS → DNS Settings). Under **Custom records**, the domain has:
   - four **A** records for host `@`: `185.199.108.153`, `185.199.109.153`, `185.199.110.153` and `185.199.111.153`
   - a **CNAME** record for host `www`, pointing to `superiorspply.github.io`
2. **GitHub**: in the repo, **Settings → Pages → Custom domain** is set to `stockroominc.com`, with **Enforce HTTPS** ticked.
3. **Supabase**: **Authentication → URL Configuration** uses the stockroominc.com addresses (see step 3 above).

## Other businesses

Anyone can open the site, create an account and set up their own company. Each company's inventory, customers, sales and team are completely separate. Nobody can see another company's data except people you've given support access to (see above). It's worth saying so in any terms you show customers.

## Good to know

- **Free plan pause:** Supabase pauses free projects after a week with no activity. If that happens, open the Supabase dashboard and click **Restore**. Upgrading to the Pro plan stops the pausing.
- **Backups:** the app's **Back up now** button saves a file you can import again later. Supabase's paid plans also back up the database daily.
- **Photo links:** product photos are viewable by anyone who has a photo's exact link. The links are random and impossible to guess, and nothing else is public.
- **Ask and Live:** these were turned off for the website, since they need a paid Claude API key.
