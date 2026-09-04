# Artificial Aggregator

Live at https://artificialaggregator.com/.

Cloudflare Worker web app for comparing Artificial Analysis model scores against Cost per Task and Time per Task.

- **Hono** handles the web/API routes.
- **Cloudflare D1 (SQLite)** stores hourly runs, normalized model results, and compressed raw HTML chunks.
- **Drizzle** owns the schema/migrations.
- A Cloudflare cron trigger runs the fetch job every hour.

## Setup

```bash
npm install
npm run cf:d1:create
```

Copy the D1 `database_id` from the create command into `wrangler.toml`, then apply migrations:

```bash
npm run db:apply:local
npm run db:apply:remote
```

For manual fetches, set an admin token:

```bash
wrangler secret put ADMIN_TOKEN
```

## Development

```bash
npm run dev
```

Checks (all three run in CI):

```bash
npm run typecheck
npm test
npm run format:check
```

Trigger a local/manual fetch:

```bash
curl -X POST "http://localhost:8787/admin/fetch?token=$ADMIN_TOKEN"
```

## Deploy

```bash
npm run deploy
```

This applies pending D1 migrations to the remote database and then uploads the
Worker, so schema changes ship with the code that needs them. Cloudflare's
GitHub build must therefore use `npm run deploy` as its deploy command rather
than the default `npx wrangler deploy`.

The cron in `wrangler.toml` runs at minute `0` every hour.

## Useful routes

- `/` latest comparison table with mode/cost scoring controls, Cost per Task and Time per Task columns, a log-scale Pareto-axis-vs-quality scatter with a cost/time Pareto frontier staircase, Pareto-frontier filter, tooltips, and 20 persisted UI themes
- `/runs` all fetch executions
- `/runs/:id` one execution
- `/runs/:id/raw` exact raw HTML for that execution (decompressed from D1 chunks)
- `/history` model list with timeline links
- `/models/:modelKey` historic timeline for one model
- `/api/runs`
- `/api/runs/:id/results`
- `/api/winners` historic #1 winner timeline for current scoring query params
- `/api/models/:modelKey/timeline`

Raw HTML is stored as gzip-compressed base64 chunks in D1 so large Artificial Analysis snapshots do not need to fit in a single SQLite row. Only scoreable model rows are normalized because every comparison/history query requires those same fields; duplicate per-model source JSON is not stored. To stay below D1's free-plan limits, scheduled maintenance runs before each fetch, retains raw HTML for the latest 72 runs, incrementally replaces legacy 500+ row snapshots, and keeps a rolling window of roughly 900 normalized runs for scoring/history. Sparse cleanup indexes prevent empty hourly maintenance passes from rescanning that history, and each run records its default winner for an indexed home-page timeline lookup.

Public D1 reads use the Workers Cache API (no extra bindings or migrations). Run lists and snapshot tables may lag by one minute; winner/model timelines and the history list by up to five minutes (plus the run-list TTL). Custom winner timelines and model-summary aggregates reuse immutable, 50-run ID buckets for 24 hours, so new snapshots normally reread only boundary buckets, not the full history. Cached data is shared across scoring options, HTML/API routes, and themes; rendered pages, raw HTML, admin operations, and maintenance are not cached. Cache storage is best-effort and per Cloudflare data center, so cold/evicted caches still incur D1 reads.
