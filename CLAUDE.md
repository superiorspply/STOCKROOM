# Stockroom

A multi-company inventory, orders and sales web app, live at https://stockroominc.com. It's a static site on GitHub Pages (custom domain set in the repo's Pages settings) with Supabase behind it for Postgres, auth, storage and realtime. Setup steps for the owner are in `SETUP.md`.

## Layout

- `index.html`: the whole app UI in one file (originally a claude.ai artifact). It talks to storage only through `window.claude.use('db'|'user'|'downloads'|'assets')`.
- `js/backend.js`: implements that `window.claude` runtime on Supabase:
  - a Firestore-like `db` (`doc/collection/onSnapshot/set/update/delete`)
  - roles
  - downloads
  - photo uploads, plus `window.photoSrc`
  - the sign-in gate, company picker, account/team sheet and backup import

  `STOCKROOM.brand()` and `STOCKROOM.logo()` give the current company's name and logo.
- `config.js`: Supabase URL and anon key (public by design).
- `icons/` and `manifest.webmanifest`: the app icon (`icons/icon.svg` is the source; the PNGs are rendered from it) and home-screen settings.
- `supabase/migrations/`: the schema. All app data lives in `docs(company_id, coll, id, data jsonb)`.
  - Row-level security uses `my_role(company_id)`. Roles are `owner`, `admin`, `staff` and `viewer`.
  - `settings/*` documents are writable by owner/admin only. `settings/stockx` is readable by owner/admin only.
  - Changes are broadcast on the private Realtime topic `company:<id>`.
  - Photos are stored at `photos/<company id>/<random>.jpg`.
  - Support access: users in `platform_admins` (added only via the SQL editor) act as `admin` in any company through `my_role`. `support_open` logs each visit to `support_log`, which the company's owner and admins can read.
- Bring in stock (`openBringIn` in `index.html`): CSV/Excel import (SheetJS loaded from cdnjs on demand) and invoice scanning, both feeding `openInvoiceReview`. New items get `source:'invoice'` and show "Needs photo & price" until they have a photo and price.
  - Scanning goes through the `invoices` runtime in `js/backend.js` to the edge function `supabase/functions/scan-invoice` (Claude Opus 5.5 with structured output). The function is deployed by the owner from the dashboard and holds the `ANTHROPIC_API_KEY` secret.
  - Access and the monthly limit are in `scan_settings` / `scan_log`, changed only by support via `support_set_scan`.
  - The dev server runs the function as-is against a stand-in Claude API at `/mock-anthropic`.
- `.github/workflows/site.yml`: runs the tests, then publishes `index.html`, `config.js`, `manifest.webmanifest`, `js/` and `icons/` to Pages on every push to `main`.

## Rules

- Never put customer or business data in this repo. The repo is public.
- Schema changes go in a **new** migration file. The owner applies it in the Supabase SQL editor, so tell them when one needs running.
- Keep `index.html` talking to storage only through the `window.claude` runtime, so the app logic and the backend stay separate.

## Testing

- Database security: `supabase/tests/run.sh`. It needs local PostgreSQL; `pg_ctlcluster 16 main start` starts it. CI runs this script too. Add a check to `supabase/tests/security_test.sql` for any new rule.
- Full app in a browser: see `dev/README.md`. Briefly:
  1. `cd dev && npm install`
  2. Put the `postgrest` binary on your PATH.
  3. `node dev/server.mjs &`
  4. `node dev/tests/e2e.mjs`

  The local server is real Postgres plus PostgREST running the real migration, with small stand-ins for auth, storage and realtime.
