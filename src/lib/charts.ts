/**
 * SVG charts shared by the server-side renderers: the time-series chart used
 * by the winner panel and model timeline pages, and the log-x scatter chart
 * used for the cost/quality Pareto view. Both render hoverable dots carrying
 * data-tip text for the client-side tooltip, optional point labels, and
 * gridded axes.
 */

import { escapeHtml } from "./html";

export type TimeSeriesPoint = {
  /** Epoch milliseconds. */
  time: number;
  /** Plotted value; round it to the displayed digits before passing it in. */
  value: number;
  /** Tooltip/aria text for the point's dot. */
  tip: string;
  /** Optional annotation rendered above the dot. */
  label?: string;
};

export type TimeSeriesChartInput = {
  points: TimeSeriesPoint[];
  /** X-axis domain in epoch ms; defaults to the min/max point time. */
  timeDomain?: { min: number; max: number };
  width: number;
  height: number;
  pad: number;
  ariaLabel: string;
  lineClass: string;
  dotsClass: string;
  dotClass: string;
  dotRadius: number;
  labelClass?: string;
  yFormat: (value: number) => string;
};

export function renderTimeSeriesChart(input: TimeSeriesChartInput): string {
  const { points, width, height, pad, yFormat } = input;
  const times = points.map((point) => point.time);
  const minX = input.timeDomain?.min ?? Math.min(...times);
  const maxX = input.timeDomain?.max ?? Math.max(...times);
  const values = points.map((point) => point.value);
  const { minY, maxY } = chartYDomain({
    minY: Math.min(...values),
    maxY: Math.max(...values),
    yFormat,
  });

  const scaleX = (time: number) => {
    const t = maxX === minX ? 0.5 : (time - minX) / (maxX - minX);
    return pad + t * (width - pad * 2);
  };
  const scaleY = (value: number) => {
    const t = (value - minY) / (maxY - minY);
    return height - pad - t * (height - pad * 2);
  };

  const line = points
    .map((point) => `${scaleX(point.time).toFixed(1)},${scaleY(point.value).toFixed(1)}`)
    .join(" ");

  const circles = points
    .map((point) => {
      const x = scaleX(point.time).toFixed(1);
      const y = scaleY(point.value).toFixed(1);
      const tip = escapeHtml(point.tip);
      return `<circle class="${input.dotClass}" cx="${x}" cy="${y}" r="${input.dotRadius}" tabindex="0" aria-label="${tip}" data-tip="${tip}"><title>${tip}</title></circle>`;
    })
    .join("");

  const labels = points
    .map((point) => {
      if (point.label == null) return "";
      const x = scaleX(point.time);
      const y = scaleY(point.value);
      return `<text class="${input.labelClass ?? ""}" x="${x.toFixed(1)}" y="${Math.max(16, y - 10).toFixed(1)}">${escapeHtml(point.label)}</text>`;
    })
    .join("");

  const axes = renderChartAxes({ minX, maxX, minY, maxY, width, height, pad, yFormat });

  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(input.ariaLabel)}">
      ${axes}
      <polyline class="${input.lineClass}" points="${line}" />
      <g class="${input.dotsClass}">${circles}</g>${labels ? `\n      ${labels}` : ""}
    </svg>`;
}

// ---------------------------------------------------------------------------
// Log-x scatter chart
// ---------------------------------------------------------------------------

export type ScatterPoint = {
  /** Horizontal value; must be positive (plotted on a log10 axis). */
  x: number;
  /** Vertical value. */
  y: number;
  /** Tooltip/aria text for the point's dot. */
  tip: string;
  /** Optional link target; the dot becomes a clickable anchor. */
  href?: string;
  /** Optional annotation rendered above the dot. */
  label?: string;
  /** Emphasized points render larger and add emphasizedDotClass. */
  emphasized?: boolean;
};

export type LogScatterChartInput = {
  points: ScatterPoint[];
  /** Optional polyline in data coordinates (e.g. a Pareto staircase). */
  line?: Array<{ x: number; y: number }>;
  width: number;
  height: number;
  pad: number;
  ariaLabel: string;
  lineClass: string;
  dotClass: string;
  emphasizedDotClass: string;
  labelClass: string;
  xAxisLabel: string;
  yAxisLabel: string;
  xFormat: (value: number) => string;
  yFormat: (value: number) => string;
};

export function renderLogScatterChart(input: LogScatterChartInput): string {
  const { width, height, pad, xFormat, yFormat } = input;
  const points = input.points.filter(
    (point) => Number.isFinite(point.x) && point.x > 0 && Number.isFinite(point.y),
  );
  if (points.length === 0) return "";

  const logs = points.map((point) => Math.log10(point.x));
  let minLogX = Math.min(...logs);
  let maxLogX = Math.max(...logs);
  if (maxLogX - minLogX < 1e-9) {
    // A single cost value still gets a readable axis: pad by 2x both ways.
    minLogX -= Math.log10(2);
    maxLogX += Math.log10(2);
  } else {
    const margin = (maxLogX - minLogX) * 0.05;
    minLogX -= margin;
    maxLogX += margin;
  }

  const values = points.map((point) => point.y);
  const yMargin = (Math.max(...values) - Math.min(...values)) * 0.06;
  // Non-negative data keeps a non-negative axis: padding below zero would
  // render a misleading "-0" tick for metrics that cannot go negative.
  const paddedMin = Math.min(...values) - yMargin;
  const { minY, maxY } = chartYDomain({
    minY: values.every((value) => value >= 0) ? Math.max(0, paddedMin) : paddedMin,
    maxY: Math.max(...values) + yMargin,
    yFormat,
  });

  const plotLeft = pad;
  const plotRight = width - pad;
  const plotTop = pad;
  const plotBottom = height - pad;
  const scaleX = (x: number) => {
    const t = (Math.log10(x) - minLogX) / (maxLogX - minLogX);
    return plotLeft + t * (plotRight - plotLeft);
  };
  const scaleY = (value: number) => {
    const t = (value - minY) / (maxY - minY);
    return plotBottom - t * (plotBottom - plotTop);
  };

  const xTicks = logTickValues(Math.pow(10, minLogX), Math.pow(10, maxLogX));
  const yTicks = tickValues(minY, maxY, 5);
  const grids = [
    ...yTicks.map((tick) => {
      const y = scaleY(tick).toFixed(1);
      return `<line class="axis-grid" x1="${plotLeft}" y1="${y}" x2="${plotRight}" y2="${y}" />`;
    }),
    ...xTicks.map((tick) => {
      const x = scaleX(tick).toFixed(1);
      return `<line class="axis-grid" x1="${x}" y1="${plotTop}" x2="${x}" y2="${plotBottom}" />`;
    }),
  ].join("");
  const tickLabels = [
    ...yTicks.map((tick) => {
      const y = (scaleY(tick) + 4).toFixed(1);
      return `<text class="axis-value y-axis-value" x="${plotLeft - 8}" y="${y}" text-anchor="end">${escapeHtml(yFormat(tick))}</text>`;
    }),
    ...xTicks.map((tick) => {
      const x = scaleX(tick).toFixed(1);
      return `<text class="axis-value x-axis-value" x="${x}" y="${plotBottom + 20}" text-anchor="middle">${escapeHtml(xFormat(tick))}</text>`;
    }),
  ].join("");
  const captions = `<text class="axis-caption" x="${((plotLeft + plotRight) / 2).toFixed(1)}" y="${plotBottom + 38}" text-anchor="middle">${escapeHtml(input.xAxisLabel)}</text>
      <text class="axis-caption" transform="translate(13 ${((plotTop + plotBottom) / 2).toFixed(1)}) rotate(-90)" text-anchor="middle">${escapeHtml(input.yAxisLabel)}</text>`;

  const line =
    input.line && input.line.length > 1
      ? `<polyline class="${input.lineClass}" points="${input.line
          .map((vertex) => `${scaleX(vertex.x).toFixed(1)},${scaleY(vertex.y).toFixed(1)}`)
          .join(" ")}" />`
      : "";

  // Emphasized dots render after the rest so they stay on top of clusters.
  const dots = [...points]
    .sort((a, b) => Number(a.emphasized ?? false) - Number(b.emphasized ?? false))
    .map((point) => {
      const x = scaleX(point.x).toFixed(1);
      const y = scaleY(point.y).toFixed(1);
      const tip = escapeHtml(point.tip);
      const classes = point.emphasized
        ? `${input.dotClass} ${input.emphasizedDotClass}`
        : input.dotClass;
      const circle = `<circle class="${classes}" cx="${x}" cy="${y}" r="${point.emphasized ? 5 : 3.5}" tabindex="0" aria-label="${tip}" data-tip="${tip}"><title>${tip}</title></circle>`;
      return point.href ? `<a href="${escapeHtml(point.href)}">${circle}</a>` : circle;
    })
    .join("");

  const labels = renderScatterLabels(points, scaleX, scaleY, input.labelClass, height);

  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(input.ariaLabel)}">
      <g class="axis-grid-lines">${grids}</g>
      <line class="axis-line" x1="${plotLeft}" y1="${plotBottom}" x2="${plotRight}" y2="${plotBottom}" />
      <line class="axis-line" x1="${plotLeft}" y1="${plotTop}" x2="${plotLeft}" y2="${plotBottom}" />
      <g class="axis-values">${tickLabels}</g>
      ${captions}
      ${line}
      <g>${dots}</g>${labels ? `\n      ${labels}` : ""}
    </svg>`;
}

/**
 * Labels default to sitting above their dot; when consecutive labels (left
 * to right) would collide horizontally, every other one drops below its dot
 * instead, so clustered frontier points stay readable.
 */
function renderScatterLabels(
  points: ScatterPoint[],
  scaleX: (x: number) => number,
  scaleY: (y: number) => number,
  labelClass: string,
  height: number,
): string {
  const labeled = points.filter((point) => point.label != null).sort((a, b) => a.x - b.x);

  const texts: string[] = [];
  let previousX = Number.NEGATIVE_INFINITY;
  let previousBelow = false;

  for (const point of labeled) {
    const x = scaleX(point.x);
    const dotY = scaleY(point.y);
    const below: boolean = x - previousX < 110 && !previousBelow;
    const y = below ? Math.min(height - 4, dotY + 20) : Math.max(16, dotY - 12);

    texts.push(
      `<text class="${labelClass}" x="${x.toFixed(1)}" y="${y.toFixed(1)}" text-anchor="middle">${escapeHtml(point.label ?? "")}</text>`,
    );
    previousX = x;
    previousBelow = below;
  }

  return texts.join("");
}

/**
 * Ticks for a log10 axis: a 1-2-5 sequence per decade, thinned to plain
 * powers of ten when the domain spans too many decades for that.
 */
function logTickValues(min: number, max: number): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max) || min <= 0 || max < min) return [];

  let ticks: number[] = [];
  for (let exp = Math.floor(Math.log10(min)); exp <= Math.ceil(Math.log10(max)); exp++) {
    for (const mantissa of [1, 2, 5]) {
      const value = mantissa * Math.pow(10, exp);
      if (value >= min * 0.999 && value <= max * 1.001) ticks.push(value);
    }
  }

  if (ticks.length > 8) {
    ticks = ticks.filter((value) => {
      const log = Math.log10(value);
      return Math.abs(log - Math.round(log)) < 1e-9;
    });
  }
  while (ticks.length > 8) {
    ticks = ticks.filter((_, index) => index % 2 === 0);
  }

  return ticks.length > 0 ? ticks : [min, max];
}

// ---------------------------------------------------------------------------
// Axes
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Domains and ticks
// ---------------------------------------------------------------------------

/**
 * Expands a degenerate or too-narrow y-range until the tick labels are all
 * distinct under the caller's formatter — otherwise a flat series renders
 * five identical axis labels stacked on one gridline.
 */
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

function tickValues(min: number, max: number, count: number): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [];
  if (count <= 1 || min === max) return [min];

  return Array.from({ length: count }, (_, index) => min + ((max - min) * index) / (count - 1));
}

/** Tick label granularity tracks the plotted span: time, day+time, day, or date. */
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
