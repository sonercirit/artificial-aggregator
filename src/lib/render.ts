/**
 * Server-side HTML for every page. Markup is plain template strings; the
 * class names, ids, and data attributes used here are load-bearing for
 * public/assets/app.css and app.js.
 */

import type { ScatterPoint, TimeSeriesPoint } from "./charts";
import { renderLogScatterChart, renderTimeSeriesChart } from "./charts";
import type { FetchRun, ModelSummary, TimelineResult } from "./db";
import {
  escapeHtml,
  fmt,
  formatBytes,
  formatDateTime,
  formatTaskCost,
  formatTaskTime,
  link,
  roundForDisplay,
  truncate,
} from "./html";
import type { FrontierMetric, ScoreOptions, ScoredRow } from "./scoring";
import { CALCS, FRONTIER_METRICS, MODES, SORT_KEYS, scoreOptionsToSearchParams } from "./scoring";

export type RenderContext = {
  theme?: string | null;
  currentPath?: string;
};

// ---------------------------------------------------------------------------
// Themes
// ---------------------------------------------------------------------------

// Each value must have a matching [data-theme] token block in app.css. The
// client script discovers this list from the rendered <select>, so this is
// the single source of truth.
const DEFAULT_THEME = "midnight";
const THEMES = [
  { value: "dark", label: "Dark" },
  { value: "light", label: "Light" },
  { value: "slate", label: "Slate" },
  { value: "midnight", label: "Midnight" },
  { value: "nord", label: "Nord" },
  { value: "dracula", label: "Dracula" },
  { value: "synthwave", label: "Synthwave" },
  { value: "cyberpunk", label: "Cyberpunk" },
  { value: "forest", label: "Forest" },
  { value: "emerald", label: "Emerald" },
  { value: "ocean", label: "Ocean" },
  { value: "sky", label: "Sky" },
  { value: "rose", label: "Rose" },
  { value: "sunset", label: "Sunset" },
  { value: "amber", label: "Amber" },
  { value: "grape", label: "Grape" },
  { value: "mono", label: "Mono" },
  { value: "coffee", label: "Coffee" },
  { value: "solarized", label: "Solarized" },
  { value: "high-contrast", label: "High Contrast" },
] as const;
export type ThemeValue = (typeof THEMES)[number]["value"];
const THEME_VALUES = THEMES.map((theme) => theme.value) as ThemeValue[];

export function normalizeTheme(value: string | null | undefined): ThemeValue {
  return THEME_VALUES.includes(value as ThemeValue) ? (value as ThemeValue) : DEFAULT_THEME;
}

// ---------------------------------------------------------------------------
// Help texts (rendered as "?" tooltips)
// ---------------------------------------------------------------------------

const HELP = {
  theme: "Switch the UI color palette. Your selection is saved in this browser.",
  run: "Choose a stored fetch snapshot. Leave as latest to use the newest successful run with score/cost data.",
  mode: "The quality dimension used for ranking: combined averages AA intelligence, coding, and agentic scores when available.",
  calc: "How the final score is computed: raw ignores cost, sub subtracts a logarithmic Cost per Task penalty, and div divides quality by cost^power.",
  sort: "Column used to rank the comparison table and historic #1 winner timeline.",
  frontier:
    "Show only models on the Pareto frontier for the selected quality mode and Pareto axis.",
  frontierMetric:
    "Choose the Pareto x-axis: Cost per Task finds models not beaten by cheaper models; Time per Task finds models not beaten by faster models.",
  costWeight:
    "For sub scoring, quality points subtracted for each 10x increase above the cost floor.",
  costFloor:
    "Minimum Cost per Task used in cost-adjusted formulas. Costs below this are treated as this value.",
  costPower:
    "For div scoring, exponent applied to Cost per Task. Use 0.5 for sqrt(cost), 0 to ignore cost.",
  limit: "Maximum number of rows shown in the comparison table.",
  winner: "Tracks the top-ranked model for each successful snapshot using the current filters.",
  scatter:
    "Every model in this snapshot plotted as the selected Pareto axis (log scale) versus the selected quality metric. Highlighted dots are the Pareto frontier; the staircase line shows the best quality available at or below each cost/time. Click a dot to open that model's timeline.",
} as const;

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

const SITE_ORIGIN = "https://artificialaggregator.com";
const SITE_DESCRIPTION =
  "Hourly Artificial Analysis snapshots: compare LLM quality scores against Cost per Task, Time per Task, and the Pareto frontier.";

export function layout(title: string, body: string, context: RenderContext = {}): string {
  const theme = normalizeTheme(context.theme);
  const currentPath = context.currentPath ?? "/";
  const canonicalUrl = `${SITE_ORIGIN}${currentPath.split("?")[0]}`;
  const fullTitle = `${title} · Artificial Aggregator`;

  return `<!doctype html>
<html lang="en" data-theme="${escapeHtml(theme)}">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(fullTitle)}</title>
  <meta name="description" content="${escapeHtml(SITE_DESCRIPTION)}" />
  <link rel="canonical" href="${escapeHtml(canonicalUrl)}" />
  <meta property="og:site_name" content="Artificial Aggregator" />
  <meta property="og:title" content="${escapeHtml(fullTitle)}" />
  <meta property="og:description" content="${escapeHtml(SITE_DESCRIPTION)}" />
  <meta property="og:type" content="website" />
  <meta property="og:url" content="${escapeHtml(canonicalUrl)}" />
  <meta name="twitter:card" content="summary" />
  <link rel="icon" href="/assets/favicon.svg" type="image/svg+xml" />
  <link rel="stylesheet" href="/assets/app.css" />
  <script src="/assets/app.js" defer></script>
</head>
<body>
  <header>
    <nav>
      <a class="brand" href="/">Artificial Aggregator</a>
      <div class="nav-links">
        <a href="/runs">Runs</a>
        <a href="/history">Model timelines</a>
        <a href="/api/runs">API</a>
      </div>
      ${renderThemeSelect(theme, currentPath)}
    </nav>
  </header>
  <main>${body}</main>
  <footer class="site-footer">created by <a href="https://sonercir.it" target="_blank" rel="noopener noreferrer">sonercir.it</a> · <a href="https://github.com/sonercirit/artificial-aggregator" target="_blank" rel="noopener noreferrer">GitHub</a></footer>
</body>
</html>`;
}

function renderThemeSelect(selectedTheme: ThemeValue, returnTo: string): string {
  const options = THEMES.map(
    (theme) =>
      `<option value="${escapeHtml(theme.value)}" ${theme.value === selectedTheme ? "selected" : ""}>${escapeHtml(theme.label)}</option>`,
  ).join("");

  // Plain form submission to /theme works without JS; app.js hijacks the
  // select for instant switching and hides the submit button.
  return `<form class="theme-picker" method="get" action="/theme">
    <label>${labelWithTip("Theme", HELP.theme)}<select id="theme-select" name="theme" aria-label="Theme">${options}</select></label>
    <input type="hidden" name="returnTo" value="${escapeHtml(returnTo)}" />
    <button class="theme-submit" type="submit">Apply</button>
  </form>`;
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

export function renderHome(
  input: {
    run: FetchRun | null;
    runs: FetchRun[];
    rows: ScoredRow[];
    options: ScoreOptions;
    selectedRunId: number | null;
    topQualityModel: ScoredRow | null;
    effectiveSortBy: string;
    winnerTimeline: Array<ScoredRow<TimelineResult>>;
  },
  context: RenderContext = {},
): string {
  const {
    run,
    runs,
    rows,
    options,
    selectedRunId,
    topQualityModel,
    effectiveSortBy,
    winnerTimeline,
  } = input;
  const visibleRows = rows.slice(0, options.limit);

  const intro = run
    ? `<p class="muted">Snapshot ${link(`/runs/${run.id}`, `#${run.id}`)} fetched ${formatDateTime(run.completed_at ?? run.started_at)} · ${formatBytes(run.html_bytes)} raw HTML · ${run.result_count} models</p>`
    : `<p class="notice">No scoreable fetch runs yet. Apply migrations, then wait for the hourly cron or trigger <code>POST /admin/fetch</code>.</p>`;

  return layout(
    "Scores",
    `<section class="hero">
      <h1>AA score/cost/time comparison</h1>
      ${intro}
    </section>
    ${renderScoreForm(options, runs, selectedRunId)}
    ${topQualityModel ? `<p class="muted">Top quality model in this view: <strong>${escapeHtml(topQualityModel.name)}</strong> (${fmt(topQualityModel.quality, 1)} pts, ${formatTaskCost(topQualityModel.costForScoring)}/task${topQualityModel.timePerTask == null ? "" : `, ${formatTaskTime(topQualityModel.timePerTask)}/task`}) · sorted by <strong>${escapeHtml(effectiveSortBy)}</strong></p>` : ""}
    ${run ? renderCostQualityScatter(rows, options) : ""}
    ${run ? renderWinnerTimeline(winnerTimeline, options, effectiveSortBy) : ""}
    ${run ? renderScoresTable(visibleRows, options) : ""}`,
    context,
  );
}

export function renderRuns(runs: FetchRun[], context: RenderContext = {}): string {
  const rows = runs
    .map(
      (run) => `<tr>
        <td>${link(`/runs/${run.id}`, `#${run.id}`)}</td>
        <td><span class="status ${escapeHtml(run.status)}">${escapeHtml(run.status)}</span></td>
        <td>${formatDateTime(run.started_at)}</td>
        <td>${formatDateTime(run.completed_at)}</td>
        <td class="num">${run.duration_ms == null ? "-" : `${run.duration_ms}ms`}</td>
        <td class="num">${run.http_status ?? "-"}</td>
        <td class="num">${run.result_count}</td>
        <td class="num">${formatBytes(run.html_bytes)}</td>
        <td>${run.html_sha256 ? `<code title="${escapeHtml(run.html_sha256)}">${escapeHtml(run.html_sha256.slice(0, 12))}</code>` : "-"}</td>
        <td>${run.status === "success" ? (hasRawHtml(run) ? link(`/runs/${run.id}/raw`, "raw HTML") : "raw pruned") : escapeHtml(run.error ?? "")}</td>
      </tr>`,
    )
    .join("");

  return layout(
    "Runs",
    `<section class="hero"><h1>Fetch runs</h1><p class="muted">Every hourly execution stores compressed raw HTML chunks and normalized model results.</p></section>
    <div class="table-wrap" role="region" aria-label="Fetch runs table" tabindex="0"><table class="runs-table">
      <thead><tr>${thTip("Run", "Fetch execution id.")}${thTip("Status", "Current outcome of the fetch execution.")}${thTip("Started", "When this fetch execution started.")}${thTip("Completed", "When this fetch execution finished.")}${thTip("Duration", "Total execution time.", "num")}${thTip("HTTP", "HTTP status returned by the source page.", "num")}${thTip("Models", "Number of normalized model results stored.", "num")}${thTip("HTML", "Raw HTML snapshot size before gzip compression.", "num")}${thTip("SHA-256", "Hash of the exact raw HTML snapshot.")}${thTip("Raw/Error", "Download raw HTML for successful runs, or view the error for failed runs.")}</tr></thead>
      <tbody>${rows || `<tr><td colspan="10" class="empty">No runs yet.</td></tr>`}</tbody>
    </table></div>`,
    context,
  );
}

export function renderRunDetail(
  input: {
    run: FetchRun;
    rows: ScoredRow[];
    options: ScoreOptions;
    topQualityModel: ScoredRow | null;
  },
  context: RenderContext = {},
): string {
  const { run, rows, options, topQualityModel } = input;
  const params = scoreOptionsToSearchParams(options);
  params.set("run", String(run.id));

  return layout(
    `Run #${run.id}`,
    `<section class="hero">
      <h1>Run #${run.id}</h1>
      <p class="muted">${escapeHtml(run.status)} · fetched ${formatDateTime(run.completed_at ?? run.started_at)} · ${formatBytes(run.html_bytes)} raw HTML · ${run.result_count} models</p>
      <p>${link(`/?${params.toString()}`, "Open this run in comparison view")} · ${hasRawHtml(run) ? `${link(`/runs/${run.id}/raw`, "Download raw HTML")} · ` : ""}${link(`/api/runs/${run.id}/results`, "JSON results")}</p>
      ${run.error ? `<p class="notice danger">${escapeHtml(run.error)}</p>` : ""}
    </section>
    ${topQualityModel ? `<p class="muted">Top quality: <strong>${escapeHtml(topQualityModel.name)}</strong> (${fmt(topQualityModel.quality, 1)} pts)</p>` : ""}
    ${renderCostQualityScatter(rows, options)}
    ${renderScoresTable(rows.slice(0, options.limit), options)}`,
    context,
  );
}

export function renderHistory(models: ModelSummary[], context: RenderContext = {}): string {
  const rows = models
    .map(
      (model) => `<tr>
        <td>${link(`/models/${encodeURIComponent(model.model_key)}`, model.name)}</td>
        <td><code>${escapeHtml(model.model_key)}</code></td>
        <td class="num">${model.samples}</td>
        <td>${formatDateTime(model.latest_at)}</td>
      </tr>`,
    )
    .join("");

  return layout(
    "Model timelines",
    `<section class="hero"><h1>Historic model timelines</h1><p class="muted">Choose a model to inspect score, quality, Cost per Task, and Time per Task across successful hourly snapshots.</p></section>
    <div class="table-wrap" role="region" aria-label="Historic model timelines table" tabindex="0"><table class="history-table">
      <thead><tr>${thTip("Model", "Model name. Click to open its historic timeline.")}${thTip("Key", "Stable model key used to join results across snapshots.")}${thTip("Samples", "Number of successful snapshots containing this model.", "num")}${thTip("Latest sample", "Most recent successful snapshot containing this model.")}</tr></thead>
      <tbody>${rows || `<tr><td colspan="4" class="empty">No model results yet.</td></tr>`}</tbody>
    </table></div>`,
    context,
  );
}

export function renderModelTimeline(
  input: {
    modelKey: string;
    timeline: Array<ScoredRow<TimelineResult>>;
    options: ScoreOptions;
  },
  context: RenderContext = {},
): string {
  const { modelKey, timeline, options } = input;
  const latest = timeline[timeline.length - 1];
  const title = latest?.name ?? modelKey;

  const scoreDigits = options.calc === "div" ? 4 : 1;
  const scoreChart = renderMetricChart({
    rows: timeline,
    title: "Score over time",
    value: (row) => row.calculated,
    tone: "score",
    format: (value) => fmt(value, scoreDigits),
    roundDigits: scoreDigits,
  });
  const costChart = renderMetricChart({
    rows: timeline,
    title: "Cost per task over time",
    value: (row) => row.costForScoring,
    tone: "cost",
    format: formatTaskCost,
  });
  const timeChart = renderMetricChart({
    rows: timeline,
    title: "Time per task over time",
    value: (row) => row.timePerTask,
    tone: "time",
    format: formatTaskTime,
  });

  const tableRows = timeline
    .slice()
    .reverse()
    .map(
      (row) => `<tr>
        <td>${link(`/runs/${row.runId}`, `#${row.runId}`)}</td>
        <td>${formatDateTime(row.runCompletedAt ?? row.runStartedAt)}</td>
        <td class="num">${fmt(row.calculated, options.calc === "div" ? 4 : 1)}</td>
        <td class="num">${fmt(row.quality, 1)}</td>
        <td class="num">${formatTaskCost(row.costForScoring)}</td>
        <td class="num">${formatTaskTime(row.timePerTask)}</td>
        <td class="num">${fmt(row.intelligence, 1)}</td>
        <td class="num">${fmt(row.coding, 1)}</td>
        <td class="num">${fmt(row.agentic, 1)}</td>
        <td class="num">${row.mmmu == null ? "-" : fmt(row.mmmu * 100, 1)}</td>
      </tr>`,
    )
    .join("");

  return layout(
    `${title} timeline`,
    `<section class="hero">
      <h1>${escapeHtml(title)}</h1>
      <p class="muted"><code>${escapeHtml(modelKey)}</code> · ${timeline.length} samples · ${escapeHtml(options.mode)} / ${escapeHtml(options.calc)}</p>
      ${renderTimelineForm(options)}
    </section>
    <section class="charts">${scoreChart}${costChart}${timeChart}</section>
    <div class="table-wrap" role="region" aria-label="Model timeline samples table" tabindex="0"><table class="timeline-table">
      <thead><tr>${thTip("Run", "Fetch execution id for this sample.")}${thTip("Fetched", "When this sample was fetched.")}${thTip("Score", "Final calculated score for the selected mode and cost formula.", "num")}${thTip("Quality", "Selected quality metric before cost adjustment.", "num")}${thTip("Cost/task", "AA weighted average Cost per Task in dollars. Falls back to legacy benchmark cost for older snapshots.", "num")}${thTip("Time/task", "AA weighted average Time per Task.", "num")}${thTip("Intel", "Artificial Analysis intelligence index.", "num")}${thTip("Code", "Artificial Analysis coding index.", "num")}${thTip("Agent", "Artificial Analysis agentic index when available.", "num")}${thTip("MMMU%", "MMMU Pro score as a percentage when available.", "num")}</tr></thead>
      <tbody>${tableRows || `<tr><td colspan="10" class="empty">No timeline samples for this model.</td></tr>`}</tbody>
    </table></div>`,
    context,
  );
}

export function renderErrorPage(
  title: string,
  message: string,
  context: RenderContext = {},
): string {
  return layout(
    title,
    `<section class="hero"><h1>${escapeHtml(title)}</h1><p class="notice danger">${escapeHtml(message)}</p></section>`,
    context,
  );
}

// ---------------------------------------------------------------------------
// Pareto-axis vs quality scatter
// ---------------------------------------------------------------------------

function renderCostQualityScatter(rows: ScoredRow[], options: ScoreOptions): string {
  const params = scoreOptionsToSearchParams(options);
  const axis = paretoAxis(options.frontierMetric);
  const plottable = rows.filter((row) => {
    const x = axis.value(row);
    return x != null && Number.isFinite(x) && x > 0 && Number.isFinite(row.quality);
  });
  if (plottable.length === 0) return "";

  const points: ScatterPoint[] = plottable.map((row) => ({
    x: axis.value(row) as number,
    y: row.quality,
    tip: `${row.name} · Cost/task: ${formatTaskCost(row.costForScoring)} · Time/task: ${formatTaskTime(row.timePerTask)} · Quality: ${fmt(row.quality, 1)}${row.frontier ? " · Pareto frontier" : ""}`,
    href: `/models/${encodeURIComponent(row.modelKey)}?${params.toString()}`,
    label: row.frontier ? truncate(row.shortName ?? row.name, 18) : undefined,
    emphasized: row.frontier,
  }));

  // The frontier staircase: best quality available at or below each cost/time.
  const frontier = plottable
    .filter((row) => row.frontier)
    .sort((a, b) => (axis.value(a) as number) - (axis.value(b) as number));
  const staircase: Array<{ x: number; y: number }> = [];
  for (const [index, row] of frontier.entries()) {
    const x = axis.value(row) as number;
    if (index > 0) staircase.push({ x, y: frontier[index - 1].quality });
    staircase.push({ x, y: row.quality });
  }

  const svg = renderLogScatterChart({
    points,
    line: staircase,
    width: 960,
    height: 430,
    pad: 58,
    ariaLabel: `${axis.label} versus quality scatter with Pareto frontier`,
    lineClass: "scatter-frontier-line",
    dotClass: "chart-entry scatter-dot",
    emphasizedDotClass: "scatter-dot-frontier",
    labelClass: "scatter-label",
    xAxisLabel: `${axis.axisLabel}, log scale`,
    yAxisLabel: `${options.mode} quality`,
    xFormat: axis.format,
    yFormat: (value) => fmt(value, 0),
  });

  return `<section class="scatter-panel">
    <h2>${headingWithTip(`${axis.shortLabel} vs quality`, HELP.scatter)}</h2>
    <p class="muted">${plottable.length} models · ${frontier.length} on the Pareto frontier · <strong>${escapeHtml(options.mode)}</strong> quality vs ${escapeHtml(axis.label)}</p>
    <div class="chart-scroll chart-scroll-wide" role="region" aria-label="Scrollable ${escapeHtml(axis.shortLabel)} versus quality chart" tabindex="0">${svg}</div>
  </section>`;
}

function paretoAxis(metric: FrontierMetric): {
  value: (row: ScoredRow) => number | null;
  label: string;
  shortLabel: string;
  axisLabel: string;
  format: (value: number) => string;
} {
  return metric === "time"
    ? {
        value: (row) => row.timePerTask,
        label: "Time per Task",
        shortLabel: "Time/task",
        axisLabel: "time per task",
        format: formatTaskTime,
      }
    : {
        value: (row) => row.costForScoring,
        label: "Cost per Task",
        shortLabel: "Cost/task",
        axisLabel: "cost per task",
        format: formatMoneyTick,
      };
}

/** Compact dollar labels for log-axis ticks: $0.01, $0.10, $1, $10. */
function formatMoneyTick(value: number): string {
  if (!Number.isFinite(value)) return "-";
  if (value >= 1000) {
    const thousands = value / 1000;
    return `$${(thousands >= 10 ? thousands.toFixed(0) : thousands.toFixed(1)).replace(/\.0$/, "")}k`;
  }
  if (value >= 1) return `$${value.toFixed(value >= 10 ? 0 : value % 1 === 0 ? 0 : 2)}`;
  if (value >= 0.1) return `$${value.toFixed(2)}`;
  return `$${value.toFixed(3).replace(/0$/, "")}`;
}

// ---------------------------------------------------------------------------
// Winner panel
// ---------------------------------------------------------------------------

function renderWinnerTimeline(
  winners: Array<ScoredRow<TimelineResult>>,
  options: ScoreOptions,
  effectiveSortBy: string,
): string {
  if (winners.length === 0) {
    return `<section class="winner-panel"><h2>${headingWithTip("Historic #1 winner", HELP.winner)}</h2><p class="empty">No historic winner data for these filters yet.</p></section>`;
  }

  const latest = winners[winners.length - 1];
  const scoreDigits = options.calc === "div" ? 4 : 1;
  const scoreFormat = (value: number | null | undefined) => fmt(value, scoreDigits);
  const winnerTime = (row: ScoredRow<TimelineResult>) =>
    Date.parse(row.runCompletedAt ?? row.runStartedAt);

  // A "change" is a snapshot whose winner differs from the previous one;
  // recent changes get chart labels and the chip list.
  const changes = winners.filter(
    (row, index) => index === 0 || row.modelKey !== winners[index - 1].modelKey,
  );
  const labeled = new Set(changes.slice(-10));

  const points: TimeSeriesPoint[] = [];
  for (const row of winners) {
    const value = roundForDisplay(row.calculated, scoreDigits);
    if (!Number.isFinite(value)) continue;
    points.push({
      time: winnerTime(row),
      value,
      tip: `Run #${row.runId} · ${row.name} · X: ${formatDateTime(row.runCompletedAt ?? row.runStartedAt)} · Y: ${scoreFormat(row.calculated)}`,
      label: labeled.has(row) ? truncate(row.name, 22) : undefined,
    });
  }

  const svg = renderTimeSeriesChart({
    points,
    timeDomain: {
      min: Math.min(...winners.map(winnerTime)),
      max: Math.max(...winners.map(winnerTime)),
    },
    width: 960,
    height: 280,
    pad: 58,
    ariaLabel: "Historic number one winner score timeline",
    lineClass: "winner-line",
    dotsClass: "winner-dots",
    dotClass: "chart-entry",
    dotRadius: 4,
    labelClass: "winner-label",
    yFormat: scoreFormat,
  });

  const changeChips = changes
    .slice(-12)
    .reverse()
    .map(
      (
        row,
      ) => `<a class="winner-chip" href="/models/${encodeURIComponent(row.modelKey)}?${scoreOptionsToSearchParams(options).toString()}">
        <strong>${escapeHtml(row.name)}</strong>
        <span>${formatDateTime(row.runCompletedAt ?? row.runStartedAt)} · ${scoreFormat(row.calculated)}</span>
      </a>`,
    )
    .join("");
  const recentRows = winners
    .slice(-8)
    .reverse()
    .map(
      (row) => `<tr>
        <td>${link(`/runs/${row.runId}`, `#${row.runId}`)}</td>
        <td>${formatDateTime(row.runCompletedAt ?? row.runStartedAt)}</td>
        <td>${link(`/models/${encodeURIComponent(row.modelKey)}?${scoreOptionsToSearchParams(options).toString()}`, row.name)}</td>
        <td class="num">${scoreFormat(row.calculated)}</td>
        <td class="num">${fmt(row.quality, 1)}</td>
        <td class="num">${formatTaskCost(row.costForScoring)}</td>
        <td class="num">${formatTaskTime(row.timePerTask)}</td>
      </tr>`,
    )
    .join("");

  return `<section class="winner-panel">
    <div class="winner-head">
      <div>
        <h2>${headingWithTip("Historic #1 winner", HELP.winner)}</h2>
        <p class="muted">Top row for each successful snapshot using the current mode/calc/cost settings and <strong>${escapeHtml(effectiveSortBy)}</strong> sort.</p>
      </div>
      <div class="winner-latest">
        <span>Latest #1</span>
        ${link(`/models/${encodeURIComponent(latest.modelKey)}?${scoreOptionsToSearchParams(options).toString()}`, latest.name)}
        <strong>${scoreFormat(latest.calculated)}</strong>
      </div>
    </div>
    <div class="chart-scroll chart-scroll-wide" role="region" aria-label="Scrollable historic winner chart" tabindex="0">${svg}</div>
    <div class="winner-grid">
      <div>
        <h3>Recent winner changes</h3>
        <div class="winner-chips">${changeChips}</div>
      </div>
      <div class="table-wrap compact-table" role="region" aria-label="Recent historic winners table" tabindex="0"><table>
        <thead><tr>${thTip("Run", "Fetch execution id for this winner.")}${thTip("Fetched", "When this winning snapshot was fetched.")}${thTip("Winner", "Top-ranked model for that snapshot.")}${thTip("Score", "Winner's final calculated score.", "num")}${thTip("Qual", "Winner's selected quality metric before cost adjustment.", "num")}${thTip("Cost/task", "Winner's Cost per Task in dollars.", "num")}${thTip("Time/task", "Winner's Time per Task.", "num")}</tr></thead>
        <tbody>${recentRows}</tbody>
      </table></div>
    </div>
  </section>`;
}

// ---------------------------------------------------------------------------
// Score table
// ---------------------------------------------------------------------------

function renderScoresTable(rows: ScoredRow[], options: ScoreOptions): string {
  const params = scoreOptionsToSearchParams(options);
  const tableRows = rows
    .map((row, index) => {
      const timelineUrl = `/models/${encodeURIComponent(row.modelKey)}?${params.toString()}`;
      return `<tr class="${row.frontier ? "frontier" : ""}">
        <td class="num">${index + 1}</td>
        <td class="center">${row.frontier ? '<span title="Pareto frontier">✓</span>' : ""}</td>
        <td>${link(timelineUrl, row.name)}<br><small>${escapeHtml(row.creatorName ?? "")}</small></td>
        <td>${escapeHtml(row.releaseDate ?? "-")}</td>
        <td class="num">${formatTaskCost(row.costForScoring)}</td>
        <td class="num">${formatTaskTime(row.timePerTask)}</td>
        <td class="num">${fmt(row.costPerQuality, 4)}</td>
        <td class="num">${fmt(row.quality, 1)}</td>
        <td class="num">${fmtDelta(row.deltaTop)}</td>
        <td class="num">${fmt(row.intelligence, 1)}</td>
        <td class="num">${fmt(row.coding, 1)}</td>
        <td class="num">${fmt(row.agentic, 1)}</td>
        <td class="num">${fmt(row.costPenalty, 1)}</td>
        <td class="num strong">${fmt(row.calculated, options.calc === "div" ? 4 : 1)}</td>
      </tr>`;
    })
    .join("");

  return `<div class="table-wrap score-table-wrap" role="region" aria-label="Model score comparison table" tabindex="0"><table class="score-table">
    <colgroup>
      <col class="rank-col">
      <col class="pareto-col">
      <col class="model-col">
      <col class="released-col">
      <col class="cost-col">
      <col class="time-col">
      <col class="cost-quality-col">
      <col class="quality-col">
      <col class="delta-col">
      <col class="metric-col">
      <col class="metric-col">
      <col class="metric-col">
      <col class="penalty-col">
      <col class="score-col">
    </colgroup>
    <thead><tr>${thTip("#", "Rank after applying the selected sort.", "num")}${thTip("Pareto", "On the selected Pareto frontier: no lower-cost or faster model has a higher selected quality score.", "center")}${thTip("Model", "Model name. Click to open its historic timeline.")}${thTip("Released", "Model release date reported by Artificial Analysis.")}${thTip("Cost/task", "AA weighted average Cost per Intelligence Index task in dollars. Lower is cheaper; legacy snapshots fall back to total benchmark cost.", "num")}${thTip("Time/task", "AA weighted average Time per Intelligence Index task. Lower is faster.", "num")}${thTip("$/Q", "Cost per selected quality point. Lower is better.", "num")}${thTip("Qual", "Selected quality metric before cost adjustment.", "num")}${thTip("ΔTop", "Quality gap versus the top-quality model in this run.", "num")}${thTip("Intel", "Artificial Analysis intelligence index.", "num")}${thTip("Code", "Artificial Analysis coding index.", "num")}${thTip("Agent", "Artificial Analysis agentic index when available.", "num")}${thTip("Pen", "Cost penalty subtracted in sub scoring. Zero for raw/div scoring display still shows the computed penalty.", "num")}${thTip("Score", "Final calculated score for the selected mode and cost formula.", "num")}</tr></thead>
    <tbody>${tableRows || `<tr><td colspan="14" class="empty">No scored rows for these options.</td></tr>`}</tbody>
  </table></div>`;
}

// ---------------------------------------------------------------------------
// Timeline metric charts
// ---------------------------------------------------------------------------

function renderMetricChart(input: {
  rows: Array<ScoredRow<TimelineResult>>;
  title: string;
  value: (row: ScoredRow<TimelineResult>) => number | null;
  tone: "score" | "cost" | "time";
  format?: (value: number | null) => string;
  roundDigits?: number;
}): string {
  const { rows, title, value, tone, format = (v) => fmt(v, 1), roundDigits } = input;
  const metricLabel = title.replace(/ over time$/i, "");

  const points: TimeSeriesPoint[] = [];
  for (const row of rows) {
    const raw = value(row);
    if (raw == null || !Number.isFinite(raw)) continue;
    const v = roundDigits == null ? raw : roundForDisplay(raw, roundDigits);
    const fetched = row.runCompletedAt ?? row.runStartedAt;
    points.push({
      time: Date.parse(fetched),
      value: v,
      tip: `Run #${row.runId} · ${metricLabel} · X: ${formatDateTime(fetched)} · Y: ${format(v)}`,
    });
  }

  if (points.length === 0) {
    return `<article class="chart"><h2>${escapeHtml(title)}</h2><p class="empty">No chart data.</p></article>`;
  }

  const svg = renderTimeSeriesChart({
    points,
    timeDomain: {
      min: Math.min(...rows.map((row) => Date.parse(row.runCompletedAt ?? row.runStartedAt))),
      max: Math.max(...rows.map((row) => Date.parse(row.runCompletedAt ?? row.runStartedAt))),
    },
    width: 760,
    height: 240,
    pad: 54,
    ariaLabel: title,
    lineClass: `chart-line chart-line-${tone}`,
    dotsClass: `chart-dots chart-dots-${tone}`,
    dotClass: `chart-entry chart-entry-${tone}`,
    dotRadius: 3,
    yFormat: (v) => format(v),
  });

  return `<article class="chart">
    <h2>${escapeHtml(title)}</h2>
    <div class="chart-scroll chart-scroll-compact" role="region" aria-label="Scrollable ${escapeHtml(title)} chart" tabindex="0">${svg}</div>
  </article>`;
}

// ---------------------------------------------------------------------------
// Form controls
// ---------------------------------------------------------------------------

function renderScoreForm(
  options: ScoreOptions,
  runs: FetchRun[],
  selectedRunId: number | null,
): string {
  const runControl = `<label>${labelWithTip("Run", HELP.run)}
      <select name="run">
        <option value="">Latest scoreable</option>
        ${runs
          .map(
            (run) =>
              `<option value="${run.id}" ${selectedRunId === run.id ? "selected" : ""}>#${run.id} · ${escapeHtml(run.status)} · ${formatDateTime(run.completed_at ?? run.started_at)}</option>`,
          )
          .join("")}
      </select>
    </label>`;

  return `<form class="controls controls-categorized score-controls" method="get" action="/">
    ${controlGroup("Snapshot", "Pick the stored fetch snapshot to compare.", runControl)}
    ${controlGroup(
      "Scoring",
      "Choose the quality benchmark and final score formula.",
      `${selectControl("mode", "Mode", MODES, options.mode, HELP.mode)}${selectControl("calc", "Calc", CALCS, options.calc, HELP.calc)}`,
    )}
    ${controlGroup("Cost adjustment", "Tune formulas that account for Cost per Task.", costControls(options))}
    ${controlGroup(
      "Result set",
      "Control table filtering, ordering, and row count.",
      `${selectControl("sort", "Sort", SORT_KEYS, options.sort, HELP.sort)}${frontierFilterControl(options)}${frontierMetricControl(options)}${limitControl(options)}`,
    )}
    <div class="controls-actions"><button type="submit">Update</button></div>
  </form>`;
}

function renderTimelineForm(options: ScoreOptions): string {
  return `<form class="controls controls-categorized timeline-controls compact" method="get">
    ${controlGroup(
      "Scoring",
      "Choose the quality benchmark and final score formula for this model.",
      `${selectControl("mode", "Mode", MODES, options.mode, HELP.mode)}${selectControl("calc", "Calc", CALCS, options.calc, HELP.calc)}`,
    )}
    ${controlGroup("Cost adjustment", "Tune formulas that account for Cost per Task.", costControls(options))}
    <div class="controls-actions"><button type="submit">Update</button></div>
  </form>`;
}

function controlGroup(title: string, description: string, body: string): string {
  return `<fieldset class="control-group">
    <legend>${escapeHtml(title)}</legend>
    <p class="control-group-description">${escapeHtml(description)}</p>
    <div class="control-group-grid">${body}</div>
  </fieldset>`;
}

function costControls(options: ScoreOptions): string {
  return `<label>${labelWithTip("Cost weight", HELP.costWeight)}<input type="number" step="0.1" name="costWeight" value="${escapeHtml(options.costWeight)}" /></label>
    <label>${labelWithTip("Cost floor", HELP.costFloor)}<input type="number" step="0.000001" name="costFloor" value="${escapeHtml(options.costFloor)}" /></label>
    <label>${labelWithTip("Cost power", HELP.costPower)}<input type="number" step="0.1" name="costPower" value="${escapeHtml(options.costPower)}" /></label>`;
}

function limitControl(options: ScoreOptions): string {
  return `<label>${labelWithTip("Limit", HELP.limit)}<input type="number" min="1" max="10000" name="limit" value="${escapeHtml(options.limit)}" /></label>`;
}

function frontierFilterControl(options: ScoreOptions): string {
  return `<label>${labelWithTip("Pareto", HELP.frontier)}
    <select name="frontier">
      <option value="0" ${options.frontierOnly ? "" : "selected"}>All models</option>
      <option value="1" ${options.frontierOnly ? "selected" : ""}>Frontier only</option>
    </select>
  </label>`;
}

function frontierMetricControl(options: ScoreOptions): string {
  return selectControl(
    "frontierMetric",
    "Pareto axis",
    FRONTIER_METRICS,
    options.frontierMetric,
    HELP.frontierMetric,
  );
}

function selectControl<T extends readonly string[]>(
  name: string,
  label: string,
  values: T,
  selected: T[number],
  help?: string,
): string {
  return `<label>${labelWithTip(label, help)}
    <select name="${escapeHtml(name)}">
      ${values
        .map(
          (value) =>
            `<option value="${escapeHtml(value)}" ${value === selected ? "selected" : ""}>${escapeHtml(value)}</option>`,
        )
        .join("")}
    </select>
  </label>`;
}

// ---------------------------------------------------------------------------
// Tooltip and cell helpers
// ---------------------------------------------------------------------------

function labelWithTip(label: string, help?: string): string {
  return `<span class="label-row">${escapeHtml(label)}${help ? tip(help) : ""}</span>`;
}

function headingWithTip(label: string, help: string): string {
  return `<span class="heading-row">${escapeHtml(label)}${tip(help)}</span>`;
}

function thTip(label: string, help: string, className = ""): string {
  const classAttr = className
    ? ` class="${escapeHtml(`${className} has-custom-tip`)}"`
    : ` class="has-custom-tip"`;
  return `<th${classAttr}><span class="th-label">${escapeHtml(label)}${tip(help)}</span></th>`;
}

// The title attribute is the no-JS fallback; app.js strips it and shows the
// floating tooltip from data-tip instead.
function tip(help: string): string {
  return `<span class="tooltip" tabindex="0" aria-label="${escapeHtml(help)}" title="${escapeHtml(help)}" data-tip="${escapeHtml(help)}">?</span>`;
}

function fmtDelta(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "-";
  return value >= -0.005 ? "0.0" : value.toFixed(1);
}

function hasRawHtml(run: FetchRun): boolean {
  return run.raw_html_encoding !== "pruned";
}
