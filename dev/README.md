# Local test server

`server.mjs` runs the site against a local stand-in for Supabase, so changes can be tested without touching the real project.

- **Real:** PostgreSQL with the real migration and security rules, and [PostgREST](https://postgrest.org), the database API Supabase itself uses.
- **Run as-is:** the edge functions in `supabase/functions/`, at `/functions/v1/<name>` (with a small Deno stand-in). Their Claude calls go to a stand-in at `/mock-anthropic`, which returns a fixed invoice and remembers the last request (GET `/mock-anthropic` shows it).
- **Simplified:** sign-in (`/auth/v1`), photo storage (`/storage/v1`) and live updates (`/realtime/v1`, broadcast only). These follow the same protocols the Supabase client library uses.

## Setup

1. Start PostgreSQL 16 locally: `pg_ctlcluster 16 main start`. The server uses `su postgres` to create its database.
2. Download the PostgREST binary from its [releases page](https://github.com/PostgREST/postgrest/releases) (`postgrest-v12.2.3-linux-static-x64.tar.xz`). Put it on your PATH, or set `POSTGREST=/path/to/postgrest`.
3. Run `cd dev && npm install`.

## Run

```sh
node dev/server.mjs        # site on http://localhost:8080, API on :54321 (starts from an empty database each time)
node dev/tests/e2e.mjs     # full browser test: sign-up, company, items + photos, invites, roles, live updates, isolation, import
node dev/tests/shots.mjs /tmp   # screenshots of the sign-up and account screens
```

The browser tests serve the CDN libraries (Supabase client, jsPDF) from `node_modules`, so they run offline.
