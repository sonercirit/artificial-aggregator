import type { ScoreOptions, ScoredRow } from "./aa";
import { CALCS, MODES, SORT_KEYS, scoreOptionsToSearchParams } from "./aa";
import type { FetchRun, ModelSummary, TimelineResult } from "./db";

export type RenderContext = {
  theme?: string | null;
  currentPath?: string;
};

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

const HELP = {
  theme: "Switch the UI color palette. Your selection is saved in this browser.",
  run: "Choose a stored fetch snapshot. Leave as latest to use the newest successful run with score/cost data.",
  mode: "The quality dimension used for ranking: combined averages AA intelligence, coding, and agentic scores when available.",
  calc: "How the final score is computed: raw ignores cost, sub subtracts a logarithmic cost penalty, and div divides quality by cost^power.",
  sort: "Column used to rank the comparison table and historic #1 winner timeline.",
  frontier:
    "Show only models on the Pareto frontier for the selected quality mode: no cheaper model has a higher selected quality score.",
  costWeight:
    "For sub scoring, quality points subtracted for each 10x increase above the cost floor.",
  costFloor:
    "Minimum benchmark cost used in cost-adjusted formulas. Costs below this are treated as this value.",
  costPower:
    "For div scoring, exponent applied to benchmark cost. Use 0.5 for sqrt(cost), 0 to ignore cost.",
  limit: "Maximum number of rows shown in the comparison table.",
  winner: "Tracks the top-ranked model for each successful snapshot using the current filters.",
} as const;

export function layout(title: string, body: string, context: RenderContext = {}): string {
  const theme = normalizeTheme(context.theme);
  const currentPath = context.currentPath ?? "/";

  return `<!doctype html>
<html lang="en" data-theme="${escapeAttr(theme)}">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)} · Artificial Aggregator</title>
  <link rel="icon" href="/assets/favicon.svg" type="image/svg+xml" />
  <link rel="stylesheet" href="/assets/app.css" />
  <script src="/assets/app.js" defer></script>
</head>
<body>
  <header>
    <nav>
      <a class="brand" href="/">Artificial Aggregator</a>
      <a href="/runs">Runs</a>
      <a href="/history">Model timelines</a>
      <a href="/api/runs">API</a>
      ${renderThemeSelect(theme, currentPath)}
    </nav>
  </header>
  <main>${body}</main>
  <footer class="site-footer">created by <a href="https://sonercir.it" target="_blank" rel="noopener noreferrer">sonercir.it</a></footer>
</body>
</html>`;
}

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
      <h1>AA score/cost comparison</h1>
      ${intro}
    </section>
    ${renderScoreForm(options, runs, selectedRunId)}
    ${topQualityModel ? `<p class="muted">Top quality model in this view: <strong>${escapeHtml(topQualityModel.name)}</strong> (${fmt(topQualityModel.quality, 1)} pts, ${formatMoney(topQualityModel.totalCost)}) · sorted by <strong>${escapeHtml(effectiveSortBy)}</strong></p>` : ""}
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
    <div class="table-wrap"><table>
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
    `<section class="hero"><h1>Historic model timelines</h1><p class="muted">Choose a model to inspect score, quality, and cost across all successful hourly snapshots.</p></section>
    <div class="table-wrap"><table>
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
  const scoreChart = renderLineChart({
    rows: timeline,
    title: "Score over time",
    value: (row) => row.calculated,
    tone: "score",
    format: (value) => fmt(value, scoreDigits),
    roundDigits: scoreDigits,
  });
  const costChart = renderLineChart({
    rows: timeline,
    title: "Cost over time",
    value: (row) => row.totalCost,
    tone: "cost",
    format: formatMoney,
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
        <td class="num">${formatMoney(row.totalCost)}</td>
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
    <section class="charts">${scoreChart}${costChart}</section>
    <div class="table-wrap"><table>
      <thead><tr>${thTip("Run", "Fetch execution id for this sample.")}${thTip("Fetched", "When this sample was fetched.")}${thTip("Score", "Final calculated score for the selected mode and cost formula.", "num")}${thTip("Quality", "Selected quality metric before cost adjustment.", "num")}${thTip("Cost", "AA intelligence-index benchmark cost in dollars.", "num")}${thTip("Intel", "Artificial Analysis intelligence index.", "num")}${thTip("Code", "Artificial Analysis coding index.", "num")}${thTip("Agent", "Artificial Analysis agentic index when available.", "num")}${thTip("MMMU%", "MMMU Pro score as a percentage when available.", "num")}</tr></thead>
      <tbody>${tableRows || `<tr><td colspan="9" class="empty">No timeline samples for this model.</td></tr>`}</tbody>
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

function renderThemeSelect(selectedTheme: ThemeValue, returnTo: string): string {
  const options = THEMES.map(
    (theme) =>
      `<option value="${escapeAttr(theme.value)}" ${theme.value === selectedTheme ? "selected" : ""}>${escapeHtml(theme.label)}</option>`,
  ).join("");

  return `<form class="theme-picker" method="get" action="/theme">
    <label>${labelWithTip("Theme", HELP.theme)}<select id="theme-select" name="theme" aria-label="Theme">${options}</select></label>
    <input type="hidden" name="returnTo" value="${escapeAttr(returnTo)}" />
    <button class="theme-submit" type="submit">Apply</button>
  </form>`;
}

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

  return `<form class="controls controls-categorized" method="get" action="/">
    ${controlGroup("Snapshot", "Pick the stored fetch snapshot to compare.", runControl)}
    ${controlGroup(
      "Scoring",
      "Choose the quality benchmark and final score formula.",
      `${selectControl("mode", "Mode", MODES, options.mode, HELP.mode)}${selectControl("calc", "Calc", CALCS, options.calc, HELP.calc)}`,
    )}
    ${controlGroup("Cost adjustment", "Tune formulas that account for benchmark cost.", costControls(options))}
    ${controlGroup(
      "Result set",
      "Control table filtering, ordering, and row count.",
      `${selectControl("sort", "Sort", SORT_KEYS, options.sort, HELP.sort)}${frontierFilterControl(options)}${limitControl(options)}`,
    )}
    <div class="controls-actions"><button type="submit">Update</button></div>
  </form>`;
}

function renderTimelineForm(options: ScoreOptions): string {
  return `<form class="controls controls-categorized compact" method="get">
    ${controlGroup(
      "Scoring",
      "Choose the quality benchmark and final score formula for this model.",
      `${selectControl("mode", "Mode", MODES, options.mode, HELP.mode)}${selectControl("calc", "Calc", CALCS, options.calc, HELP.calc)}`,
    )}
    ${controlGroup("Cost adjustment", "Tune formulas that account for benchmark cost.", costControls(options))}
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
  return `<label>${labelWithTip("Cost weight", HELP.costWeight)}<input type="number" step="0.1" name="costWeight" value="${escapeAttr(options.costWeight)}" /></label>
    <label>${labelWithTip("Cost floor", HELP.costFloor)}<input type="number" step="0.000001" name="costFloor" value="${escapeAttr(options.costFloor)}" /></label>
    <label>${labelWithTip("Cost power", HELP.costPower)}<input type="number" step="0.1" name="costPower" value="${escapeAttr(options.costPower)}" /></label>`;
}

function limitControl(options: ScoreOptions): string {
  return `<label>${labelWithTip("Limit", HELP.limit)}<input type="number" min="1" max="10000" name="limit" value="${escapeAttr(options.limit)}" /></label>`;
}

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
  const chartScore = (row: ScoredRow<TimelineResult>) =>
    roundForDisplay(row.calculated, scoreDigits);
  const values = winners.map(chartScore).filter((value): value is number => Number.isFinite(value));
  const width = 960;
  const height = 280;
  const pad = 58;
  const minX = Math.min(
    ...winners.map((row) => Date.parse(row.runCompletedAt ?? row.runStartedAt)),
  );
  const maxX = Math.max(
    ...winners.map((row) => Date.parse(row.runCompletedAt ?? row.runStartedAt)),
  );
  let minY = Math.min(...values);
  let maxY = Math.max(...values);
  ({ minY, maxY } = chartYDomain({ minY, maxY, yFormat: scoreFormat }));

  const scaleX = (date: string | null) => {
    const x = Date.parse(date ?? winners[0].runStartedAt);
    const t = maxX === minX ? 0.5 : (x - minX) / (maxX - minX);
    return pad + t * (width - pad * 2);
  };
  const scaleY = (value: number) => {
    const t = (value - minY) / (maxY - minY);
    return height - pad - t * (height - pad * 2);
  };

  const points = winners
    .map(
      (row) =>
        `${scaleX(row.runCompletedAt ?? row.runStartedAt).toFixed(1)},${scaleY(chartScore(row)).toFixed(1)}`,
    )
    .join(" ");
  const changes = winners.filter(
    (row, index) => index === 0 || row.modelKey !== winners[index - 1].modelKey,
  );
  const labels = changes
    .slice(-10)
    .map((row) => {
      const x = scaleX(row.runCompletedAt ?? row.runStartedAt);
      const y = scaleY(chartScore(row));
      return `<text class="winner-label" x="${x.toFixed(1)}" y="${Math.max(16, y - 10).toFixed(1)}">${escapeHtml(truncate(row.name, 22))}</text>`;
    })
    .join("");
  const circles = winners
    .map((row) => {
      const x = scaleX(row.runCompletedAt ?? row.runStartedAt).toFixed(1);
      const y = scaleY(chartScore(row)).toFixed(1);
      const fetched = formatDateTime(row.runCompletedAt ?? row.runStartedAt);
      const score = scoreFormat(row.calculated);
      const tip = `Run #${row.runId} · ${row.name} · X: ${fetched} · Y: ${score}`;
      return `<circle class="chart-entry" cx="${x}" cy="${y}" r="4" tabindex="0" aria-label="${escapeAttr(tip)}" data-tip="${escapeAttr(tip)}"><title>${escapeHtml(tip)}</title></circle>`;
    })
    .join("");
  const axes = renderChartAxes({
    minX,
    maxX,
    minY,
    maxY,
    width,
    height,
    pad,
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
        <td class="num">${formatMoney(row.totalCost)}</td>
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
    <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Historic number one winner score timeline">
      ${axes}
      <polyline class="winner-line" points="${points}" />
      <g class="winner-dots">${circles}</g>
      ${labels}
    </svg>
    <div class="winner-grid">
      <div>
        <h3>Recent winner changes</h3>
        <div class="winner-chips">${changeChips}</div>
      </div>
      <div class="table-wrap compact-table"><table>
        <thead><tr>${thTip("Run", "Fetch execution id for this winner.")}${thTip("Fetched", "When this winning snapshot was fetched.")}${thTip("Winner", "Top-ranked model for that snapshot.")}${thTip("Score", "Winner's final calculated score.", "num")}${thTip("Qual", "Winner's selected quality metric before cost adjustment.", "num")}${thTip("Cost", "Winner's benchmark cost in dollars.", "num")}</tr></thead>
        <tbody>${recentRows}</tbody>
      </table></div>
    </div>
  </section>`;
}

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
        <td class="num">${formatMoney(row.totalCost)}</td>
        <td class="num">${fmt(row.costPerQuality, 2)}</td>
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

  return `<div class="table-wrap score-table-wrap"><table class="score-table">
    <colgroup>
      <col class="rank-col">
      <col class="pareto-col">
      <col class="model-col">
      <col class="released-col">
      <col class="cost-col">
      <col class="cost-quality-col">
      <col class="quality-col">
      <col class="delta-col">
      <col class="metric-col">
      <col class="metric-col">
      <col class="metric-col">
      <col class="penalty-col">
      <col class="score-col">
    </colgroup>
    <thead><tr>${thTip("#", "Rank after applying the selected sort.", "num")}${thTip("Pareto", "On the Pareto frontier: no cheaper model has a higher selected quality score.", "center")}${thTip("Model", "Model name. Click to open its historic timeline.")}${thTip("Released", "Model release date reported by Artificial Analysis.")}${thTip("Cost$", "AA intelligence-index benchmark cost in dollars. Lower is cheaper.", "num")}${thTip("$/Q", "Dollars per selected quality point. Lower is better.", "num")}${thTip("Qual", "Selected quality metric before cost adjustment.", "num")}${thTip("ΔTop", "Quality gap versus the top-quality model in this run.", "num")}${thTip("Intel", "Artificial Analysis intelligence index.", "num")}${thTip("Code", "Artificial Analysis coding index.", "num")}${thTip("Agent", "Artificial Analysis agentic index when available.", "num")}${thTip("Pen", "Cost penalty subtracted in sub scoring. Zero for raw/div scoring display still shows the computed penalty.", "num")}${thTip("Score", "Final calculated score for the selected mode and cost formula.", "num")}</tr></thead>
    <tbody>${tableRows || `<tr><td colspan="13" class="empty">No scored rows for these options.</td></tr>`}</tbody>
  </table></div>`;
}

function renderLineChart(input: {
  rows: Array<ScoredRow<TimelineResult>>;
  title: string;
  value: (row: ScoredRow<TimelineResult>) => number | null;
  tone: "score" | "cost";
  format?: (value: number | null) => string;
  roundDigits?: number;
}): string {
  const { rows, title, value, tone, format = (v) => fmt(v, 1), roundDigits } = input;
  const chartValue = (row: ScoredRow<TimelineResult>) => {
    const v = value(row);
    return v == null || !Number.isFinite(v)
      ? null
      : roundDigits == null
        ? v
        : roundForDisplay(v, roundDigits);
  };
  const values = rows.map(chartValue).filter((v): v is number => v != null);

  if (rows.length === 0 || values.length === 0) {
    return `<article class="chart"><h2>${escapeHtml(title)}</h2><p class="empty">No chart data.</p></article>`;
  }

  const width = 760;
  const height = 240;
  const pad = 54;
  const minX = Math.min(...rows.map((row) => Date.parse(row.runCompletedAt ?? row.runStartedAt)));
  const maxX = Math.max(...rows.map((row) => Date.parse(row.runCompletedAt ?? row.runStartedAt)));
  let minY = Math.min(...values);
  let maxY = Math.max(...values);
  ({ minY, maxY } = chartYDomain({ minY, maxY, yFormat: format }));

  const scaleX = (date: string | null) => {
    const x = Date.parse(date ?? rows[0].runStartedAt);
    const t = maxX === minX ? 0.5 : (x - minX) / (maxX - minX);
    return pad + t * (width - pad * 2);
  };
  const scaleY = (v: number) => {
    const t = (v - minY) / (maxY - minY);
    return height - pad - t * (height - pad * 2);
  };

  const points = rows
    .map((row) => {
      const v = chartValue(row);
      return v == null
        ? null
        : `${scaleX(row.runCompletedAt ?? row.runStartedAt).toFixed(1)},${scaleY(v).toFixed(1)}`;
    })
    .filter((point): point is string => point != null)
    .join(" ");

  const metricLabel = title.replace(/ over time$/i, "");
  const circles = rows
    .map((row) => {
      const v = chartValue(row);
      if (v == null) return "";
      const x = scaleX(row.runCompletedAt ?? row.runStartedAt).toFixed(1);
      const y = scaleY(v).toFixed(1);
      const fetched = formatDateTime(row.runCompletedAt ?? row.runStartedAt);
      const formattedValue = format(v);
      const tip = `Run #${row.runId} · ${metricLabel} · X: ${fetched} · Y: ${formattedValue}`;
      return `<circle class="chart-entry chart-entry-${tone}" cx="${x}" cy="${y}" r="3" tabindex="0" aria-label="${escapeAttr(tip)}" data-tip="${escapeAttr(tip)}"><title>${escapeHtml(tip)}</title></circle>`;
    })
    .join("");
  const axes = renderChartAxes({
    minX,
    maxX,
    minY,
    maxY,
    width,
    height,
    pad,
    yFormat: format,
  });

  return `<article class="chart">
    <h2>${escapeHtml(title)}</h2>
    <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeAttr(title)}">
      ${axes}
      <polyline class="chart-line chart-line-${tone}" points="${points}" />
      <g class="chart-dots chart-dots-${tone}">${circles}</g>
    </svg>
  </article>`;
}

function renderChartAxes(input: {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  width: number;
  height: number;
  pad: number;
  yFormat: (value: number) => string;
  xTickCount?: number;
  yTickCount?: number;
}): string {
  const {
    minX,
    maxX,
    minY,
    maxY,
    width,
    height,
    pad,
    yFormat,
    xTickCount = 5,
    yTickCount = 5,
  } = input;
  const plotLeft = pad;
  const plotRight = width - pad;
  const plotTop = pad;
  const plotBottom = height - pad;
  const scaleX = (x: number) => {
    const t = maxX === minX ? 0.5 : (x - minX) / (maxX - minX);
    return plotLeft + t * (plotRight - plotLeft);
  };
  const scaleY = (value: number) => {
    const t = (value - minY) / (maxY - minY);
    return plotBottom - t * (plotBottom - plotTop);
  };
  const xTicks = tickValues(minX, maxX, xTickCount);
  const yTicks = tickValues(minY, maxY, yTickCount);
  const xGrids = xTicks
    .map((tick) => {
      const x = scaleX(tick).toFixed(1);
      return `<line class="axis-grid" x1="${x}" y1="${plotTop}" x2="${x}" y2="${plotBottom}" />`;
    })
    .join("");
  const yGrids = yTicks
    .map((tick) => {
      const y = scaleY(tick).toFixed(1);
      return `<line class="axis-grid" x1="${plotLeft}" y1="${y}" x2="${plotRight}" y2="${y}" />`;
    })
    .join("");
  const xLabels = xTicks
    .map((tick) => {
      const x = scaleX(tick).toFixed(1);
      return `<text class="axis-value x-axis-value" x="${x}" y="${plotBottom + 20}" text-anchor="middle">${escapeHtml(formatAxisDateTick(tick, minX, maxX))}</text>`;
    })
    .join("");
  const yLabels = yTicks
    .map((tick) => {
      const y = scaleY(tick);
      return `<text class="axis-value y-axis-value" x="${plotLeft - 8}" y="${(y + 4).toFixed(1)}" text-anchor="end">${escapeHtml(yFormat(tick))}</text>`;
    })
    .join("");

  return `<g class="axis-grid-lines">${yGrids}${xGrids}</g>
      <line class="axis-line" x1="${plotLeft}" y1="${plotBottom}" x2="${plotRight}" y2="${plotBottom}" />
      <line class="axis-line" x1="${plotLeft}" y1="${plotTop}" x2="${plotLeft}" y2="${plotBottom}" />
      <g class="axis-values">${yLabels}${xLabels}</g>`;
}

function chartYDomain(input: {
  minY: number;
  maxY: number;
  yFormat: (value: number) => string;
  yTickCount?: number;
}): { minY: number; maxY: number } {
  let { minY, maxY } = input;
  const { yFormat, yTickCount = 5 } = input;

  if (!Number.isFinite(minY) || !Number.isFinite(maxY)) return { minY, maxY };
  if (minY > maxY) [minY, maxY] = [maxY, minY];

  const center = (minY + maxY) / 2;
  let halfRange = (maxY - minY) / 2;

  if (halfRange === 0) {
    halfRange = Math.max(Math.abs(center) * 0.01, 0.01);
  } else {
    halfRange = Math.max(halfRange, Math.max(Math.abs(center) * 1e-6, 1e-9));
  }

  let low = center - halfRange;
  let high = center + halfRange;

  for (let index = 0; index < 32; index++) {
    if (!hasDuplicateTickLabels(low, high, yFormat, yTickCount)) {
      return { minY: low, maxY: high };
    }

    halfRange *= 2;
    low = center - halfRange;
    high = center + halfRange;
  }

  return { minY: low, maxY: high };
}

function hasDuplicateTickLabels(
  minY: number,
  maxY: number,
  yFormat: (value: number) => string,
  yTickCount: number,
): boolean {
  const labels = tickValues(minY, maxY, yTickCount).map(yFormat);
  return new Set(labels).size !== labels.length;
}

function roundForDisplay(value: number, digits: number): number {
  if (!Number.isFinite(value)) return value;

  const safeDigits = Math.min(100, Math.max(0, Math.floor(digits)));
  return Number(value.toFixed(safeDigits));
}

function tickValues(min: number, max: number, count: number): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [];
  if (count <= 1 || min === max) return [min];

  return Array.from({ length: count }, (_, index) => min + ((max - min) * index) / (count - 1));
}

function formatAxisDateTick(value: number, min: number, max: number): string {
  if (!Number.isFinite(value)) return "";

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";

  const iso = date.toISOString();
  const span = Math.abs(max - min);
  const day = 24 * 60 * 60 * 1000;

  if (span <= day) return iso.slice(11, 16);
  if (span <= 32 * day) return `${iso.slice(5, 10)} ${iso.slice(11, 16)}`;
  if (span <= 370 * day) return iso.slice(5, 10);
  return iso.slice(0, 10);
}

function frontierFilterControl(options: ScoreOptions): string {
  return `<label>${labelWithTip("Pareto", HELP.frontier)}
    <select name="frontier">
      <option value="0" ${options.frontierOnly ? "" : "selected"}>All models</option>
      <option value="1" ${options.frontierOnly ? "selected" : ""}>Frontier only</option>
    </select>
  </label>`;
}

function selectControl<T extends readonly string[]>(
  name: string,
  label: string,
  values: T,
  selected: T[number],
  help?: string,
): string {
  return `<label>${labelWithTip(label, help)}
    <select name="${escapeAttr(name)}">
      ${values
        .map(
          (value) =>
            `<option value="${escapeAttr(value)}" ${value === selected ? "selected" : ""}>${escapeHtml(value)}</option>`,
        )
        .join("")}
    </select>
  </label>`;
}

function labelWithTip(label: string, help?: string): string {
  return `<span class="label-row">${escapeHtml(label)}${help ? tip(help) : ""}</span>`;
}

function headingWithTip(label: string, help: string): string {
  return `<span class="heading-row">${escapeHtml(label)}${tip(help)}</span>`;
}

function thTip(label: string, help: string, className = ""): string {
  const classAttr = className
    ? ` class="${escapeAttr(`${className} has-custom-tip`)}"`
    : ` class="has-custom-tip"`;
  return `<th${classAttr}><span class="th-label">${escapeHtml(label)}${tip(help)}</span></th>`;
}

function tip(help: string): string {
  return `<span class="tooltip" tabindex="0" aria-label="${escapeAttr(help)}" title="${escapeAttr(help)}" data-tip="${escapeAttr(help)}">?</span>`;
}

function link(href: string, label: string): string {
  return `<a href="${escapeAttr(href)}">${escapeHtml(label)}</a>`;
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, Math.max(0, maxLength - 1))}…`;
}

function fmt(value: number | null | undefined, digits = 1): string {
  return value == null || !Number.isFinite(value) ? "-" : value.toFixed(digits);
}

function fmtDelta(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "-";
  return value >= -0.005 ? "0.0" : value.toFixed(1);
}

function formatMoney(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "-";
  if (value >= 1000) return `$${value.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
  if (value >= 100) return `$${value.toFixed(0)}`;
  if (value >= 10) return `$${value.toFixed(1)}`;
  return `$${value.toFixed(2)}`;
}

function formatBytes(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "-";
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(2)} MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${value} B`;
}

function hasRawHtml(run: FetchRun): boolean {
  return run.raw_html_encoding !== "pruned";
}

function formatDateTime(value: string | null | undefined): string {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toISOString().replace("T", " ").slice(0, 19);
}

function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeAttr(value: unknown): string {
  return escapeHtml(value);
}
