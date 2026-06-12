import { describe, expect, it } from "vitest";
import type { LogScatterChartInput, TimeSeriesChartInput } from "../src/lib/charts";
import { renderLogScatterChart, renderTimeSeriesChart } from "../src/lib/charts";

const HOUR = 60 * 60 * 1000;
const T0 = Date.parse("2026-06-01T00:00:00Z");

function timeSeriesInput(overrides: Partial<TimeSeriesChartInput> = {}): TimeSeriesChartInput {
  return {
    points: [
      { time: T0, value: 10, tip: 'first "<&>" point', label: "Start" },
      { time: T0 + HOUR, value: 12, tip: "second point" },
      { time: T0 + 2 * HOUR, value: 11, tip: "third point" },
    ],
    width: 400,
    height: 200,
    pad: 40,
    ariaLabel: "test series",
    lineClass: "line",
    dotsClass: "dots",
    dotClass: "dot",
    dotRadius: 3,
    labelClass: "label",
    yFormat: (value) => value.toFixed(1),
    ...overrides,
  };
}

function scatterInput(overrides: Partial<LogScatterChartInput> = {}): LogScatterChartInput {
  return {
    points: [
      { x: 1, y: 30, tip: "cheap" },
      { x: 100, y: 60, tip: "frontier", emphasized: true, label: "Front", href: "/models/f" },
      { x: 1000, y: 50, tip: "pricey" },
    ],
    width: 400,
    height: 200,
    pad: 40,
    ariaLabel: "test scatter",
    lineClass: "stairs",
    dotClass: "dot",
    emphasizedDotClass: "dot-front",
    labelClass: "label",
    xAxisLabel: "cost",
    yAxisLabel: "quality",
    xFormat: (value) => `$${value}`,
    yFormat: (value) => value.toFixed(0),
    ...overrides,
  };
}

describe("renderTimeSeriesChart", () => {
  it("renders a polyline, escaped tooltips, labels, and axes without NaN coordinates", () => {
    const svg = renderTimeSeriesChart(timeSeriesInput());

    expect(svg).toContain("<polyline");
    expect(svg.match(/<circle/g)).toHaveLength(3);
    expect(svg).toContain("first &quot;&lt;&amp;&gt;&quot; point");
    expect(svg).toContain(">Start</text>");
    expect(svg).toContain('class="axis-value y-axis-value"');
    expect(svg).not.toContain("NaN");
  });

  it("keeps y-axis tick labels distinct for a flat series", () => {
    const svg = renderTimeSeriesChart(
      timeSeriesInput({
        points: [
          { time: T0, value: 5, tip: "a" },
          { time: T0 + HOUR, value: 5, tip: "b" },
        ],
      }),
    );

    const labels = [...svg.matchAll(/y-axis-value"[^>]*>([^<]+)</g)].map((match) => match[1]);
    expect(labels.length).toBeGreaterThan(1);
    expect(new Set(labels).size).toBe(labels.length);
  });
});

describe("renderLogScatterChart", () => {
  it("returns an empty string when no point is plottable", () => {
    expect(renderLogScatterChart(scatterInput({ points: [] }))).toBe("");
    expect(
      renderLogScatterChart(scatterInput({ points: [{ x: 0, y: 1, tip: "zero cost" }] })),
    ).toBe("");
  });

  it("drops non-positive x values instead of breaking the log scale", () => {
    const svg = renderLogScatterChart(
      scatterInput({
        points: [
          { x: 10, y: 30, tip: "valid" },
          { x: -5, y: 40, tip: "negative" },
        ],
      }),
    );

    expect(svg.match(/<circle/g)).toHaveLength(1);
    expect(svg).not.toContain("NaN");
  });

  it("renders dots, emphasis, links, labels, captions, and money ticks", () => {
    const svg = renderLogScatterChart(scatterInput());

    expect(svg.match(/<circle/g)).toHaveLength(3);
    expect(svg).toContain('class="dot dot-front"');
    expect(svg).toContain('r="5"');
    expect(svg).toContain('<a href="/models/f">');
    expect(svg).toContain(">Front</text>");
    expect(svg).toContain(">cost</text>");
    expect(svg).toContain(">quality</text>");
    expect(svg).toMatch(/>\$\d+</);
    expect(svg).not.toContain("NaN");
  });

  it("renders the staircase polyline through the given vertices", () => {
    const svg = renderLogScatterChart(
      scatterInput({
        line: [
          { x: 1, y: 30 },
          { x: 100, y: 30 },
          { x: 100, y: 60 },
        ],
      }),
    );

    const match = svg.match(/<polyline class="stairs" points="([^"]+)"/);
    expect(match).not.toBeNull();
    expect(match![1].split(" ")).toHaveLength(3);
  });

  it("handles a single point without producing a degenerate domain", () => {
    const svg = renderLogScatterChart(scatterInput({ points: [{ x: 50, y: 42, tip: "only" }] }));

    expect(svg).toContain("<circle");
    expect(svg).not.toContain("NaN");
  });

  it("staggers labels that would collide horizontally", () => {
    const svg = renderLogScatterChart(
      scatterInput({
        points: [
          { x: 100, y: 50, tip: "a", label: "Alpha" },
          { x: 105, y: 51, tip: "b", label: "Beta" },
        ],
      }),
    );

    const ys = [...svg.matchAll(/class="label" x="[\d.]+" y="([\d.]+)"/g)].map((match) =>
      Number(match[1]),
    );
    expect(ys).toHaveLength(2);
    // The second label drops below its dot instead of overlapping the first.
    expect(Math.abs(ys[1] - ys[0])).toBeGreaterThan(20);
  });

  it("does not pad a non-negative domain below zero", () => {
    const svg = renderLogScatterChart(
      scatterInput({
        points: [
          { x: 1, y: 1, tip: "low" },
          { x: 1000, y: 80, tip: "high" },
        ],
      }),
    );

    expect(svg).not.toMatch(/>-\d/);
  });
});
