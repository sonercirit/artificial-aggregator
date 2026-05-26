# Artificial Aggregator

Live at https://artificialaggregator.com/.

Cloudflare Worker web app for comparing Artificial Analysis model scores against benchmark costs.

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

Trigger a local/manual fetch:

```bash
curl -X POST "http://localhost:8787/admin/fetch?token=$ADMIN_TOKEN"
```

## Deploy

```bash
npm run deploy
```

The cron in `wrangler.toml` runs at minute `0` every hour.

## Useful routes

- `/` latest comparison table with mode/cost scoring controls, Pareto-frontier filter, tooltips, and 20 persisted UI themes
- `/runs` all fetch executions
- `/runs/:id` one execution
- `/runs/:id/raw` exact raw HTML for that execution (decompressed from D1 chunks)
- `/history` model list with timeline links
- `/models/:modelKey` historic timeline for one model
- `/api/runs`
- `/api/runs/:id/results`
- `/api/winners` historic #1 winner timeline for current scoring query params
- `/api/models/:modelKey/timeline`

Raw HTML is stored as gzip-compressed base64 chunks in D1 so large Artificial Analysis snapshots do not need to fit in a single SQLite row. To stay below D1 size limits, scheduled fetches retain raw HTML for the latest 72 runs, compact raw per-model JSON after 500 runs, and keep the latest 1500 runs for scoring/history.
