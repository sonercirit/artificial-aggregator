/**
 * SVG time-series chart shared by the winner panel and the model timeline
 * pages. Renders a line, hoverable dots carrying data-tip text for the
 * client-side tooltip, optional point labels, and gridded axes.
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
