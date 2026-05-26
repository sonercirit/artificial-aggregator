import { Hono } from "hono";
import type { ScoreOptions, ScoredRow } from "./lib/aa";
import { parseScoreOptions, scoreRows } from "./lib/aa";
import type { TimelineResult } from "./lib/db";
import {
  getLatestSuccessfulRun,
  getModelSummaries,
  getRawHtmlBase64Chunks,
  getResultsForRun,
  getRun,
  getRuns,
  getSuccessfulTimelineRuns,
  getTimelineForModel,
  getTimelineResultsForRuns,
} from "./lib/db";
import { runFetchJob } from "./lib/job";
import type { RenderContext } from "./lib/render";
import {
  normalizeTheme,
  renderErrorPage,
  renderHistory,
  renderHome,
  renderModelTimeline,
  renderRunDetail,
  renderRuns,
} from "./lib/render";
import { gunzipBase64ChunksToString } from "./lib/storage";
import type { Bindings } from "./types";

const app = new Hono<{ Bindings: Bindings }>();
const THEME_COOKIE = "aa-theme";
const THEME_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;
const WINNER_RUN_CHUNK_SIZE = 50;

app.use("*", async (c, next) => {
  const url = new URL(c.req.url);
  if (url.hostname === "www.artificialaggregator.com") {
    url.hostname = "artificialaggregator.com";
    return c.redirect(url.toString(), 301);
  }

  await next();
});

app.get("/assets/*", async (c) => c.env.ASSETS.fetch(c.req.raw));
app.get("/favicon.ico", (c) => c.redirect("/assets/favicon.svg", 301));

app.get("/theme", (c) => {
  const url = new URL(c.req.url);
  const theme = normalizeTheme(url.searchParams.get("theme"));
  const returnTo = safeReturnTo(url.searchParams.get("returnTo"));

  c.header("Set-Cookie", themeCookie(theme));
  return c.redirect(returnTo, 303);
});

app.get("/", async (c) => {
  const url = new URL(c.req.url);
  const context = getRenderContext(c.req.raw);
  const options = parseScoreOptions(url.searchParams);
  const requestedRunId = positiveInt(url.searchParams.get("run"));
  const runs = await getRuns(c.env, 250);
  const run = requestedRunId
    ? await getRun(c.env, requestedRunId)
    : await getLatestSuccessfulRun(c.env);

  if (!run || run.status !== "success") {
    return c.html(
      renderHome(
        {
          run: null,
          runs,
          rows: [],
          options,
          selectedRunId: requestedRunId,
          topQualityModel: null,
          effectiveSortBy: options.sort,
          winnerTimeline: [],
        },
        context,
      ),
      run ? 404 : 200,
    );
  }

  const [results, winnerTimeline] = await Promise.all([
    getResultsForRun(c.env, run.id),
    buildWinnerTimelineForRecentRuns(c.env, options, 500),
  ]);
  const scored = scoreRows(results, options);

  return c.html(
    renderHome(
      {
        run,
        runs,
        rows: scored.rows,
        options,
        selectedRunId: run.id,
        topQualityModel: scored.topQualityModel,
        effectiveSortBy: scored.effectiveSortBy,
        winnerTimeline,
      },
      context,
    ),
  );
});

app.get("/runs", async (c) => {
  const runs = await getRuns(c.env, 250);
  return c.html(renderRuns(runs, getRenderContext(c.req.raw)));
});

app.get("/runs/:id", async (c) => {
  const context = getRenderContext(c.req.raw);
  const runId = positiveInt(c.req.param("id"));
  if (!runId) return c.html(renderErrorPage("Not found", "Invalid run id", context), 404);

  const run = await getRun(c.env, runId);
  if (!run)
    return c.html(renderErrorPage("Not found", `Run #${runId} does not exist`, context), 404);

  const options = parseScoreOptions(new URL(c.req.url).searchParams);
  const results = await getResultsForRun(c.env, run.id);
  const scored = scoreRows(results, options);

  return c.html(
    renderRunDetail(
      {
        run,
        rows: scored.rows,
        options,
        topQualityModel: scored.topQualityModel,
      },
      context,
    ),
  );
});

app.get("/runs/:id/raw", async (c) => {
  const runId = positiveInt(c.req.param("id"));
  if (!runId) return c.text("Invalid run id", 400);

  const run = await getRun(c.env, runId);
  if (!run) return c.text("Run not found", 404);
  if (run.raw_html_encoding === "pruned") {
    return c.text("Raw HTML was pruned for this run", 410);
  }

  const chunks = await getRawHtmlBase64Chunks(c.env, runId);
  if (chunks.length === 0) return c.text("Raw HTML not found for this run", 404);

  const html = await gunzipBase64ChunksToString(chunks);
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "private, max-age=0",
      "x-aa-run-id": String(run.id),
      "x-aa-html-sha256": run.html_sha256 ?? "",
    },
  });
});

app.get("/history", async (c) => {
  const models = await getModelSummaries(c.env);
  return c.html(renderHistory(models, getRenderContext(c.req.raw)));
});

app.get("/models/:modelKey", async (c) => {
  const modelKey = c.req.param("modelKey");
  const options = { ...parseScoreOptions(new URL(c.req.url).searchParams), frontierOnly: false };
  const timeline = await getTimelineForModel(c.env, modelKey, 2000);
  const scored = scoreRows(timeline, { ...options, sort: "score", limit: 2000 }).rows.sort((a, b) =>
    String(a.runCompletedAt ?? a.runStartedAt).localeCompare(
      String(b.runCompletedAt ?? b.runStartedAt),
    ),
  );

  return c.html(
    renderModelTimeline({ modelKey, timeline: scored, options }, getRenderContext(c.req.raw)),
  );
});

app.get("/api/runs", async (c) => {
  const runs = await getRuns(c.env, 250);
  return c.json({ runs });
});

app.get("/api/runs/:id/results", async (c) => {
  const runId = positiveInt(c.req.param("id"));
  if (!runId) return c.json({ error: "Invalid run id" }, 400);

  const run = await getRun(c.env, runId);
  if (!run) return c.json({ error: "Run not found" }, 404);

  const options = parseScoreOptions(new URL(c.req.url).searchParams);
  const results = await getResultsForRun(c.env, run.id);
  const scored = scoreRows(results, options);

  return c.json({
    run,
    options,
    effectiveSortBy: scored.effectiveSortBy,
    topQualityModel: scored.topQualityModel,
    rows: scored.rows.slice(0, options.limit),
  });
});

app.get("/api/winners", async (c) => {
  const url = new URL(c.req.url);
  const options = parseScoreOptions(url.searchParams);
  const runLimit = positiveInt(url.searchParams.get("runs")) ?? 500;
  const winners = await buildWinnerTimelineForRecentRuns(c.env, options, Math.min(runLimit, 2000));

  return c.json({ options, winners });
});

app.get("/api/models/:modelKey/timeline", async (c) => {
  const modelKey = c.req.param("modelKey");
  const options = { ...parseScoreOptions(new URL(c.req.url).searchParams), frontierOnly: false };
  const timeline = await getTimelineForModel(c.env, modelKey, 2000);
  const scored = scoreRows(timeline, { ...options, sort: "score", limit: 2000 }).rows.sort((a, b) =>
    String(a.runCompletedAt ?? a.runStartedAt).localeCompare(
      String(b.runCompletedAt ?? b.runStartedAt),
    ),
  );

  return c.json({ modelKey, options, timeline: scored });
});

app.post("/admin/fetch", async (c) => {
  const auth = c.req.header("authorization") ?? "";
  const token = new URL(c.req.url).searchParams.get("token");
  const expected = c.env.ADMIN_TOKEN;

  if (!expected) {
    return c.json({ error: "ADMIN_TOKEN is not configured" }, 403);
  }

  if (auth !== `Bearer ${expected}` && token !== expected) {
    return c.json({ error: "Forbidden" }, 403);
  }

  const result = await runFetchJob(c.env, { force: true });
  return c.json(result);
});

app.get("/healthz", (c) => c.json({ ok: true }));

app.notFound((c) =>
  c.html(
    renderErrorPage("Not found", "This page does not exist.", getRenderContext(c.req.raw)),
    404,
  ),
);

app.onError((error, c) => {
  console.error(error);
  return c.html(renderErrorPage("Error", error.message, getRenderContext(c.req.raw)), 500);
});

export default {
  fetch: app.fetch,
  scheduled(_event: ScheduledController, env: Bindings, ctx: ExecutionContext) {
    ctx.waitUntil(
      runFetchJob(env).catch((error) => {
        console.error("Scheduled fetch failed", error);
      }),
    );
  },
};

async function buildWinnerTimelineForRecentRuns(
  env: Bindings,
  options: ScoreOptions,
  runLimit: number,
): Promise<Array<ScoredRow<TimelineResult>>> {
  const runs = await getSuccessfulTimelineRuns(env, runLimit);
  const winners: Array<ScoredRow<TimelineResult>> = [];

  for (let i = 0; i < runs.length; i += WINNER_RUN_CHUNK_SIZE) {
    const runIds = runs.slice(i, i + WINNER_RUN_CHUNK_SIZE).map((run) => run.id);
    const results = await getTimelineResultsForRuns(env, runIds);
    winners.push(...buildWinnerTimeline(results, options));
  }

  return winners.sort(compareTimelineRows);
}

function buildWinnerTimeline(
  results: TimelineResult[],
  options: ScoreOptions,
): Array<ScoredRow<TimelineResult>> {
  const runs = new Map<number, TimelineResult[]>();

  for (const result of results) {
    const bucket = runs.get(result.runId);
    if (bucket) {
      bucket.push(result);
    } else {
      runs.set(result.runId, [result]);
    }
  }

  const winners: Array<ScoredRow<TimelineResult>> = [];
  for (const runResults of runs.values()) {
    const scored = scoreRows(runResults, options);
    const winner = scored.rows[0];
    if (winner) winners.push(winner);
  }

  return winners.sort(compareTimelineRows);
}

function compareTimelineRows(a: TimelineResult, b: TimelineResult): number {
  return String(a.runCompletedAt ?? a.runStartedAt).localeCompare(
    String(b.runCompletedAt ?? b.runStartedAt),
  );
}

function getRenderContext(request: Request): RenderContext {
  const url = new URL(request.url);
  return {
    theme: getCookieValue(request.headers.get("cookie"), THEME_COOKIE),
    currentPath: `${url.pathname}${url.search}`,
  };
}

function getCookieValue(header: string | null, name: string): string | null {
  if (!header) return null;

  for (const cookie of header.split(";")) {
    const [rawName, ...rawValue] = cookie.trim().split("=");
    if (rawName !== name) continue;

    try {
      return decodeURIComponent(rawValue.join("="));
    } catch (_) {
      return rawValue.join("=");
    }
  }

  return null;
}

function themeCookie(theme: string): string {
  return `${THEME_COOKIE}=${encodeURIComponent(theme)}; Path=/; Max-Age=${THEME_COOKIE_MAX_AGE}; SameSite=Lax`;
}

function safeReturnTo(value: string | null): string {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return "/";

  try {
    const url = new URL(value, "https://artificialaggregator.com");
    return `${url.pathname}${url.search}${url.hash}`;
  } catch (_) {
    return "/";
  }
}

function positiveInt(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}
