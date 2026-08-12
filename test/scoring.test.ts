import { describe, expect, it } from "vitest";
import type { ParsedModelResult } from "../src/lib/aa";
import {
  DEFAULT_SCORE_OPTIONS,
  parseScoreOptions,
  qualityFor,
  scoreOptionsToSearchParams,
  scoreRows,
} from "../src/lib/scoring";

function model(overrides: Partial<ParsedModelResult> = {}): ParsedModelResult {
  return {
    modelKey: "m",
    sourceId: null,
    slug: null,
    name: "Model",
    shortName: null,
    creatorName: null,
    creatorSlug: null,
    releaseDate: null,
    cutoffDate: null,
    totalCost: 100,
    inputCost: null,
    outputCost: null,
    reasoningCost: null,
    answerCost: null,
    costPerTask: null,
    inputCostPerTask: null,
    outputCostPerTask: null,
    reasoningCostPerTask: null,
    answerCostPerTask: null,
    timePerTask: null,
    intelligence: 50,
    agentic: null,
    mmmu: null,
    priceInput1m: null,
    priceOutput1m: null,
    activeParams: null,
    isOpenWeights: null,
    isReasoning: null,
    rawResultJson: "{}",
    ...overrides,
  };
}

describe("parseScoreOptions", () => {
  it("returns the defaults for an empty query string", () => {
    expect(parseScoreOptions(new URLSearchParams())).toEqual(DEFAULT_SCORE_OPTIONS);
  });

  it("parses explicit values, including alias keys", () => {
    const options = parseScoreOptions(
      new URLSearchParams(
        "mode=mmmu&calc=div&sort=cost&pareto=only&pareto-by=time&cost-weight=5&costFloor=0.5&costPower=0.5&limit=25",
      ),
    );

    expect(options).toEqual({
      mode: "mmmu",
      calc: "div",
      sort: "cost",
      frontierOnly: true,
      frontierMetric: "time",
      costWeight: 5,
      costFloor: 0.5,
      costPower: 0.5,
      limit: 25,
    });
  });

  it("falls back on invalid enums and clamps the cost floor above zero", () => {
    const options = parseScoreOptions(
      new URLSearchParams("mode=bogus&calc=nope&sort=wat&costFloor=0"),
    );

    expect(options.mode).toBe(DEFAULT_SCORE_OPTIONS.mode);
    expect(options.calc).toBe(DEFAULT_SCORE_OPTIONS.calc);
    expect(options.sort).toBe(DEFAULT_SCORE_OPTIONS.sort);
    expect(options.frontierMetric).toBe(DEFAULT_SCORE_OPTIONS.frontierMetric);
    expect(options.costFloor).toBe(0.000001);
  });

  it("understands limit=all and clamps oversized limits", () => {
    expect(parseScoreOptions(new URLSearchParams("limit=all")).limit).toBe(10000);
    expect(parseScoreOptions(new URLSearchParams("limit=999999")).limit).toBe(10000);
    expect(parseScoreOptions(new URLSearchParams("limit=-5")).limit).toBe(
      DEFAULT_SCORE_OPTIONS.limit,
    );
  });

  it("round-trips through scoreOptionsToSearchParams", () => {
    const options = parseScoreOptions(
      new URLSearchParams(
        "mode=agentic&calc=sub&sort=value&frontier=1&frontierMetric=time&costWeight=7.5&limit=42",
      ),
    );

    expect(parseScoreOptions(scoreOptionsToSearchParams(options))).toEqual(options);
  });
});

describe("qualityFor", () => {
  it("selects the metric for single-metric modes", () => {
    const row = model({ intelligence: 60, agentic: 30, mmmu: 0.5 });

    expect(qualityFor(row, "intelligence")).toBe(60);
    expect(qualityFor(row, "agentic")).toBe(30);
    expect(qualityFor(row, "mmmu")).toBe(50);
  });

  it("returns null when the selected metric is missing", () => {
    expect(qualityFor(model({ agentic: null }), "agentic")).toBeNull();
    expect(qualityFor(model({ mmmu: null }), "mmmu")).toBeNull();
  });

  it("averages intelligence and agentic for combined, ignoring missing metrics", () => {
    expect(qualityFor(model({ intelligence: 60, agentic: null }), "combined")).toBe(60);
    expect(qualityFor(model({ intelligence: 60, agentic: 20 }), "combined")).toBe(40);
    expect(qualityFor(model({ intelligence: null, agentic: null }), "combined")).toBeNull();
  });
});

describe("scoreRows", () => {
  const options = { ...DEFAULT_SCORE_OPTIONS };

  it("computes raw, sub, and div calculated scores", () => {
    const rows = [model({ intelligence: 50, totalCost: 100 })];

    const raw = scoreRows(rows, { ...options, calc: "raw" }).rows[0];
    expect(raw.calculated).toBe(50);

    // costWeight 10, floor 0.01: penalty = 10 * log10(100 / 0.01) = 40.
    const sub = scoreRows(rows, { ...options, calc: "sub" }).rows[0];
    expect(sub.costPenalty).toBeCloseTo(40);
    expect(sub.calculated).toBeCloseTo(10);

    const div = scoreRows(rows, { ...options, calc: "div", costPower: 0.5 }).rows[0];
    expect(div.calculated).toBeCloseTo(50 / Math.sqrt(100));
  });

  it("derives value metrics and deltas against the top-quality model", () => {
    const result = scoreRows(
      [
        model({ modelKey: "top", name: "Top", intelligence: 70, totalCost: 200 }),
        model({ modelKey: "mid", name: "Mid", intelligence: 50, totalCost: 50 }),
      ],
      options,
    );

    expect(result.topQualityModel?.modelKey).toBe("top");
    const mid = result.rows.find((row) => row.modelKey === "mid");
    expect(mid?.deltaTop).toBe(-20);
    expect(mid?.costForScoring).toBe(50);
    expect(mid?.costVsTop).toBeCloseTo(0.25);
    expect(mid?.pointsPerK).toBeCloseTo((50 * 1000) / 50);
    expect(mid?.costPerQuality).toBeCloseTo(1);
  });

  it("prefers Cost per Task over legacy total cost", () => {
    const result = scoreRows(
      [
        model({ modelKey: "legacy-expensive", totalCost: 1, costPerTask: 0.5 }),
        model({ modelKey: "legacy-cheap", totalCost: 0.1, costPerTask: 2 }),
      ],
      { ...options, sort: "cost" },
    );

    expect(result.rows.map((row) => row.modelKey)).toEqual(["legacy-expensive", "legacy-cheap"]);
    expect(result.rows[0].costForScoring).toBe(0.5);
  });

  it("excludes rows that are not scoreable or lack the selected metric", () => {
    const result = scoreRows(
      [
        model({ modelKey: "ok" }),
        model({ modelKey: "free", totalCost: 0 }),
        model({ modelKey: "no-agentic", agentic: null }),
      ],
      { ...options, mode: "agentic" },
    );

    expect(result.rows).toHaveLength(0);

    const combined = scoreRows(
      [model({ modelKey: "ok" }), model({ modelKey: "free", totalCost: 0 })],
      options,
    );
    expect(combined.rows.map((row) => row.modelKey)).toEqual(["ok"]);
  });

  it("flags the Pareto frontier correctly", () => {
    const result = scoreRows(
      [
        model({ modelKey: "cheap", intelligence: 50, totalCost: 1 }),
        model({ modelKey: "worse-pricier", intelligence: 40, totalCost: 5 }),
        model({ modelKey: "better-pricier", intelligence: 60, totalCost: 10 }),
        model({ modelKey: "duplicate", intelligence: 60, totalCost: 10 }),
      ],
      options,
    );

    const frontierKeys = result.rows.filter((row) => row.frontier).map((row) => row.modelKey);
    expect(frontierKeys).toContain("cheap");
    expect(frontierKeys).toContain("better-pricier");
    expect(frontierKeys).not.toContain("worse-pricier");
    // Only one of two identical cost/quality rows can be on the frontier.
    expect(frontierKeys).not.toContain("duplicate");
  });

  it("returns only frontier rows when frontierOnly is set", () => {
    const result = scoreRows(
      [
        model({ modelKey: "cheap", intelligence: 50, totalCost: 1 }),
        model({ modelKey: "dominated", intelligence: 40, totalCost: 5 }),
      ],
      { ...options, frontierOnly: true },
    );

    expect(result.rows.map((row) => row.modelKey)).toEqual(["cheap"]);
    expect(result.topQualityModel?.modelKey).toBe("cheap");
  });

  it("can compute the Pareto frontier by Time per Task", () => {
    const result = scoreRows(
      [
        model({ modelKey: "fastest", intelligence: 40, totalCost: 10, timePerTask: 5 }),
        model({ modelKey: "fast", intelligence: 60, totalCost: 20, timePerTask: 10 }),
        model({
          modelKey: "dominated",
          intelligence: 50,
          totalCost: 1,
          timePerTask: 50,
        }),
        model({
          modelKey: "slow-best",
          intelligence: 70,
          totalCost: 2,
          timePerTask: 100,
        }),
        model({ modelKey: "missing-time", intelligence: 80, totalCost: 3 }),
      ],
      { ...options, frontierMetric: "time", frontierOnly: true, sort: "time" },
    );

    expect(result.rows.map((row) => row.modelKey)).toEqual(["fastest", "fast", "slow-best"]);
  });

  it("sorts ascending for cost, time, and name, descending for quality and released", () => {
    const rows = [
      model({
        modelKey: "b",
        name: "Bravo",
        totalCost: 5,
        timePerTask: 30,
        intelligence: 30,
        releaseDate: "2025-01-01",
      }),
      model({
        modelKey: "a",
        name: "Alpha",
        totalCost: 50,
        timePerTask: 10,
        intelligence: 70,
        releaseDate: "2026-01-01",
      }),
      model({
        modelKey: "c",
        name: "Charlie",
        totalCost: 1,
        timePerTask: 20,
        intelligence: 50,
        releaseDate: null,
      }),
    ];

    const byCost = scoreRows(rows, { ...options, sort: "cost" }).rows.map((row) => row.modelKey);
    expect(byCost).toEqual(["c", "b", "a"]);

    const byName = scoreRows(rows, { ...options, sort: "name" }).rows.map((row) => row.modelKey);
    expect(byName).toEqual(["a", "b", "c"]);

    const byTime = scoreRows(rows, { ...options, sort: "time" }).rows.map((row) => row.modelKey);
    expect(byTime).toEqual(["a", "c", "b"]);

    const byQuality = scoreRows(rows, { ...options, sort: "quality" }).rows.map(
      (row) => row.modelKey,
    );
    expect(byQuality).toEqual(["a", "c", "b"]);

    // Newest release first; rows missing the sort value go last.
    const byReleased = scoreRows(rows, { ...options, sort: "released" }).rows.map(
      (row) => row.modelKey,
    );
    expect(byReleased).toEqual(["a", "b", "c"]);
  });

  it("handles empty input", () => {
    const result = scoreRows([], options);

    expect(result.rows).toEqual([]);
    expect(result.topQualityModel).toBeNull();
    expect(result.effectiveSortBy).toBe(options.sort);
  });
});
