/**
 * Score options (parsed from query strings) and the ranking math that turns
 * parsed model results into scored, sorted, Pareto-annotated rows.
 */

import type { ParsedModelResult } from "./aa";
import { isScoreable } from "./aa";

export const MODES = ["combined", "coding", "intelligence", "agentic", "mmmu"] as const;
export type Mode = (typeof MODES)[number];

export const CALCS = ["raw", "sub", "div"] as const;
export type Calc = (typeof CALCS)[number];

export const SORT_KEYS = [
  "score",
  "quality",
  "value",
  "cqp",
  "cost",
  "intel",
  "coding",
  "agentic",
  "mmmu",
  "released",
  "name",
] as const;
export type SortKey = (typeof SORT_KEYS)[number];

export type ScoreOptions = {
  mode: Mode;
  calc: Calc;
  costWeight: number;
  costFloor: number;
  costPower: number;
  sort: SortKey;
  frontierOnly: boolean;
  limit: number;
};

export const DEFAULT_SCORE_OPTIONS: ScoreOptions = {
  mode: "combined",
  calc: "raw",
  costWeight: 10,
  costFloor: 1,
  costPower: 1,
  sort: "score",
  frontierOnly: false,
  limit: 100,
};

export type ScoredRow<T extends ParsedModelResult = ParsedModelResult> = T & {
  quality: number;
  costPenalty: number;
  pointsPerK: number;
  costPerQuality: number;
  deltaTop: number;
  costVsTop: number;
  calculated: number;
  frontier: boolean;
};

export type ScoreResult<T extends ParsedModelResult = ParsedModelResult> = {
  rows: ScoredRow<T>[];
  topQualityModel: ScoredRow<T> | null;
  effectiveSortBy: SortKey;
};

/** Anything carrying run timestamps; used to order timeline rows chronologically. */
export type RunTimestamped = {
  runStartedAt: string;
  runCompletedAt: string | null;
};

export function compareByRunTime(a: RunTimestamped, b: RunTimestamped): number {
  return String(a.runCompletedAt ?? a.runStartedAt).localeCompare(
    String(b.runCompletedAt ?? b.runStartedAt),
  );
}

// ---------------------------------------------------------------------------
// Query-string parsing
// ---------------------------------------------------------------------------

export function parseScoreOptions(params: URLSearchParams): ScoreOptions {
  return {
    mode: enumParam(params, "mode", MODES, DEFAULT_SCORE_OPTIONS.mode),
    calc: enumParam(params, "calc", CALCS, DEFAULT_SCORE_OPTIONS.calc),
    sort: enumParam(params, "sort", SORT_KEYS, DEFAULT_SCORE_OPTIONS.sort),
    costWeight: numberParam(
      params,
      ["costWeight", "cost-weight"],
      DEFAULT_SCORE_OPTIONS.costWeight,
    ),
    costFloor: Math.max(
      numberParam(params, ["costFloor", "cost-floor"], DEFAULT_SCORE_OPTIONS.costFloor),
      0.000001,
    ),
    costPower: numberParam(params, ["costPower", "cost-power"], DEFAULT_SCORE_OPTIONS.costPower),
    frontierOnly: booleanParam(
      params,
      ["frontier", "frontierOnly", "frontier-only", "pareto", "paretoOnly", "pareto-only"],
      DEFAULT_SCORE_OPTIONS.frontierOnly,
    ),
    limit: limitParam(params),
  };
}

export function scoreOptionsToSearchParams(options: ScoreOptions): URLSearchParams {
  const params = new URLSearchParams();
  params.set("mode", options.mode);
  params.set("calc", options.calc);
  params.set("sort", options.sort);
  params.set("frontier", options.frontierOnly ? "1" : "0");
  params.set("costWeight", String(options.costWeight));
  params.set("costFloor", String(options.costFloor));
  params.set("costPower", String(options.costPower));
  params.set("limit", String(options.limit));
  return params;
}

function enumParam<const T extends readonly string[]>(
  params: URLSearchParams,
  key: string,
  values: T,
  fallback: T[number],
): T[number] {
  const value = params.get(key)?.toLowerCase();
  return values.includes(value ?? "") ? (value as T[number]) : fallback;
}

function numberParam(
  params: URLSearchParams,
  keyOrKeys: string | string[],
  fallback: number,
): number {
  const keys = Array.isArray(keyOrKeys) ? keyOrKeys : [keyOrKeys];

  for (const key of keys) {
    const raw = params.get(key);
    if (raw == null || raw.trim() === "") continue;

    const value = Number(raw);
    if (Number.isFinite(value)) return value;
  }

  return fallback;
}

function booleanParam(
  params: URLSearchParams,
  keyOrKeys: string | string[],
  fallback: boolean,
): boolean {
  const keys = Array.isArray(keyOrKeys) ? keyOrKeys : [keyOrKeys];

  for (const key of keys) {
    if (!params.has(key)) continue;

    const value = (params.get(key) ?? "").trim().toLowerCase();
    if (["", "1", "true", "yes", "on", "only", "frontier", "pareto"].includes(value)) {
      return true;
    }
    if (["0", "false", "no", "off", "all", "none"].includes(value)) {
      return false;
    }
  }

  return fallback;
}

function limitParam(params: URLSearchParams): number {
  const value = params.get("limit") ?? String(DEFAULT_SCORE_OPTIONS.limit);
  if (["all", "none", "inf", "infinite"].includes(value.toLowerCase())) {
    return 10000;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.min(parsed, 10000)
    : DEFAULT_SCORE_OPTIONS.limit;
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/** The selected quality metric, or null when the row lacks the data for it. */
export function qualityFor(result: ParsedModelResult, mode: Mode): number | null {
  if (mode === "intelligence") return numberOrNull(result.intelligence);
  if (mode === "coding") return numberOrNull(result.coding);
  if (mode === "agentic") return numberOrNull(result.agentic);
  if (mode === "mmmu") {
    const mmmu = numberOrNull(result.mmmu);
    return mmmu == null ? null : mmmu * 100;
  }

  const parts = [result.intelligence, result.coding].map(numberOrNull).filter(isNotNull);
  const agentic = numberOrNull(result.agentic);
  if (agentic != null) parts.push(agentic);

  if (parts.length === 0) return null;
  return parts.reduce((sum, value) => sum + value, 0) / parts.length;
}

type ScoreableEntry<T extends ParsedModelResult> = {
  result: T;
  quality: number;
  totalCost: number;
};

export function scoreRows<T extends ParsedModelResult>(
  results: T[],
  options: ScoreOptions,
): ScoreResult<T> {
  // Rows must have the selected quality metric and pass the scoreable
  // predicate (positive cost, intelligence and coding present).
  const entries: Array<ScoreableEntry<T>> = [];
  for (const result of results) {
    const quality = qualityFor(result, options.mode);
    if (quality == null || !isScoreable(result)) continue;
    entries.push({ result, quality, totalCost: result.totalCost as number });
  }

  if (entries.length === 0) {
    return { rows: [], topQualityModel: null, effectiveSortBy: options.sort };
  }

  let topIndex = 0;
  for (let i = 1; i < entries.length; i++) {
    if (entries[i].quality > entries[topIndex].quality) topIndex = i;
  }
  const top = entries[topIndex];

  const frontier = frontierFlags(entries);

  const rows = entries.map(({ result, quality, totalCost }, index): ScoredRow<T> => {
    const safeCost = Math.max(totalCost, options.costFloor);
    const costPenalty = options.costWeight * Math.log10(safeCost / options.costFloor);
    const calculated =
      options.calc === "raw"
        ? quality
        : options.calc === "sub"
          ? quality - costPenalty
          : quality / Math.pow(safeCost, options.costPower);

    return {
      ...result,
      quality,
      costPenalty,
      pointsPerK: (quality * 1000) / totalCost,
      costPerQuality: totalCost / quality,
      deltaTop: quality - top.quality,
      costVsTop: totalCost / top.totalCost,
      calculated,
      frontier: frontier[index],
    };
  });

  return {
    rows: sortRows(options.frontierOnly ? rows.filter((row) => row.frontier) : rows, options.sort),
    topQualityModel: rows[topIndex],
    effectiveSortBy: options.sort,
  };
}

/**
 * Pareto frontier: walking models from cheapest to priciest (quality breaks
 * cost ties), a model is on the frontier when no cheaper model matches or
 * beats its quality.
 */
function frontierFlags<T extends ParsedModelResult>(entries: Array<ScoreableEntry<T>>): boolean[] {
  const order = entries.map((_, index) => index);
  order.sort(
    (a, b) =>
      entries[a].totalCost - entries[b].totalCost || entries[b].quality - entries[a].quality,
  );

  const flags = new Array<boolean>(entries.length).fill(false);
  let bestQualitySoFar = -Infinity;
  for (const index of order) {
    const { quality } = entries[index];
    flags[index] = quality > bestQualitySoFar + 1e-9;
    if (quality > bestQualitySoFar) bestQualitySoFar = quality;
  }

  return flags;
}

const ASCENDING_SORTS = new Set<SortKey>(["cost", "cqp", "name"]);
const STRING_SORTS = new Set<SortKey>(["released", "name"]);

function sortRows<T extends ParsedModelResult>(
  rows: Array<ScoredRow<T>>,
  sortBy: SortKey,
): Array<ScoredRow<T>> {
  const sortValues: Record<SortKey, (row: ScoredRow<T>) => number | string | null> = {
    score: (row) => row.calculated,
    quality: (row) => row.quality,
    value: (row) => row.pointsPerK,
    cqp: (row) => row.costPerQuality,
    cost: (row) => row.totalCost,
    intel: (row) => row.intelligence,
    coding: (row) => row.coding,
    agentic: (row) => row.agentic,
    mmmu: (row) => (row.mmmu == null ? null : row.mmmu * 100),
    released: (row) => row.releaseDate,
    name: (row) => row.name,
  };
  const sortValue = sortValues[sortBy];

  return [...rows].sort((a, b) => {
    const av = sortValue(a);
    const bv = sortValue(b);

    // Rows missing the sort value always go last.
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;

    if (STRING_SORTS.has(sortBy)) {
      const direction = ASCENDING_SORTS.has(sortBy) ? 1 : -1;
      return direction * String(av).localeCompare(String(bv));
    }

    return ASCENDING_SORTS.has(sortBy) ? Number(av) - Number(bv) : Number(bv) - Number(av);
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isNotNull<T>(value: T | null): value is T {
  return value !== null;
}
