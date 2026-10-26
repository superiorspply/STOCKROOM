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

## TikTok Shop finance

**Reports → TikTok Shop** shows what TikTok really pays you:
- every payout
- each order's money lines: TikTok commission, payment processing, creator (affiliate) commission, shipping, refunds and adjustments
- totals for any dates

Only owners and admins can see it, and only in companies where support has switched it on: as support, open the company, then go to the person icon → **Support tools** → **TikTok Shop** and click **Save**. It is off for every other company. Once a company is connected, it updates automatically whenever someone opens the page (at most once an hour), and **Sync now** pulls the latest straight away.

### Setting up TikTok Shop (once)

1. **Create the app in TikTok Shop Partner Center** (partner.us.tiktokshop.com for a US shop)
   1. Register as a developer using the **in-house seller** option.
   2. Create a **Custom** app.
   3. Set the **Redirect URL** to `https://stockroominc.com/`.
   4. Under **Manage API**, request **Finance** (finance information) and **Authorization** (shop information).
   5. Once TikTok approves the app, copy its **App Key**, **App Secret** and **Authorization link**.
2. **Run the database updates.** In the Supabase **SQL Editor**, run [`supabase/migrations/20261026000000_tiktok_finance.sql`](https://raw.githubusercontent.com/superiorspply/STOCKROOM/main/supabase/migrations/20261026000000_tiktok_finance.sql), then [`supabase/migrations/20261026010000_tiktok_access.sql`](https://raw.githubusercontent.com/superiorspply/STOCKROOM/main/supabase/migrations/20261026010000_tiktok_access.sql), then [`supabase/migrations/20261026020000_tiktok_report.sql`](https://raw.githubusercontent.com/superiorspply/STOCKROOM/main/supabase/migrations/20261026020000_tiktok_report.sql), then [`supabase/migrations/20261026030000_tiktok_rollup.sql`](https://raw.githubusercontent.com/superiorspply/STOCKROOM/main/supabase/migrations/20261026030000_tiktok_rollup.sql), then [`supabase/migrations/20261026040000_tiktok_prepare_batches.sql`](https://raw.githubusercontent.com/superiorspply/STOCKROOM/main/supabase/migrations/20261026040000_tiktok_prepare_batches.sql), then [`supabase/migrations/20261026050000_tiktok_report_fast.sql`](https://raw.githubusercontent.com/superiorspply/STOCKROOM/main/supabase/migrations/20261026050000_tiktok_report_fast.sql), then [`supabase/migrations/20261026060000_tiktok_payouts_fast.sql`](https://raw.githubusercontent.com/superiorspply/STOCKROOM/main/supabase/migrations/20261026060000_tiktok_payouts_fast.sql), then [`supabase/migrations/20261026070000_tiktok_statement_dates.sql`](https://raw.githubusercontent.com/superiorspply/STOCKROOM/main/supabase/migrations/20261026070000_tiktok_statement_dates.sql), then [`supabase/migrations/20261026080000_tiktok_resend_fast.sql`](https://raw.githubusercontent.com/superiorspply/STOCKROOM/main/supabase/migrations/20261026080000_tiktok_resend_fast.sql). For each: copy the whole page, paste it, and click **Run**.
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

The TikTok tokens are kept in a table that only the server function can read. Disconnecting removes them, and finance data already pulled stays.

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
