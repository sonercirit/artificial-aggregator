export const ARTIFICIAL_ANALYSIS_URL = "https://artificialanalysis.ai/models";
export const PARSER_VERSION = "aa-next-rsc-default-data-v2";

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

export type ParsedModelResult = {
  modelKey: string;
  sourceId: string | null;
  slug: string | null;
  name: string;
  shortName: string | null;
  creatorName: string | null;
  creatorSlug: string | null;
  releaseDate: string | null;
  cutoffDate: string | null;
  totalCost: number | null;
  inputCost: number | null;
  outputCost: number | null;
  reasoningCost: number | null;
  answerCost: number | null;
  intelligence: number | null;
  coding: number | null;
  agentic: number | null;
  mmmu: number | null;
  priceInput1m: number | null;
  priceOutput1m: number | null;
  activeParams: number | null;
  isOpenWeights: boolean | null;
  isReasoning: boolean | null;
  rawResultJson: string;
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

export function parseHtmlToResults(html: string): ParsedModelResult[] {
  const results = extractModelsFromHtml(html)
    .map(normalizeModel)
    .filter((model) => {
      return model.modelKey.length > 0 && model.name.length > 0;
    });

  if (results.length > 0 && !results.some(isScoreableResult)) {
    throw new Error("Parsed Artificial Analysis payload did not include score/cost fields");
  }

  return results;
}

export function extractModelsFromHtml(html: string): unknown[] {
  const defaultData = extractArrayFromHtmlPayload(html, "defaultData");
  if (defaultData && defaultData.some(hasModelScoreFields)) return defaultData;

  const models = extractArrayFromHtmlPayload(html, "models");
  if (models) return models;
  if (defaultData) return defaultData;

  throw new Error("Could not find Artificial Analysis models payload in HTML");
}

export function parseScoreOptions(params: URLSearchParams): ScoreOptions {
  const mode = enumParam(params, "mode", MODES, DEFAULT_SCORE_OPTIONS.mode);
  const calc = enumParam(params, "calc", CALCS, DEFAULT_SCORE_OPTIONS.calc);
  const sort = enumParam(params, "sort", SORT_KEYS, DEFAULT_SCORE_OPTIONS.sort);

  return {
    mode,
    calc,
    sort,
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

export function scoreRows<T extends ParsedModelResult>(
  results: T[],
  options: ScoreOptions,
): ScoreResult<T> {
  const modeRows = results
    .map((result) => {
      const quality = qualityFor(result, options.mode);
      return quality == null ? null : ({ ...result, quality } as T & { quality: number });
    })
    .filter(isNotNull)
    .filter((result) => {
      return (
        isNumber(result.totalCost) &&
        result.totalCost > 0 &&
        isNumber(result.intelligence) &&
        isNumber(result.coding)
      );
    }) as ScoredRow<T>[];

  if (modeRows.length === 0) {
    return { rows: [], topQualityModel: null, effectiveSortBy: options.sort };
  }

  const topQualityModel = modeRows.reduce((best, row) => (row.quality > best.quality ? row : best));

  for (const row of modeRows) {
    const safeCost = Math.max(row.totalCost ?? 0, options.costFloor);
    row.costPenalty = options.costWeight * Math.log10(safeCost / options.costFloor);
    row.pointsPerK = (row.quality * 1000) / (row.totalCost ?? safeCost);
    row.costPerQuality = (row.totalCost ?? safeCost) / row.quality;
    row.deltaTop = row.quality - topQualityModel.quality;
    row.costVsTop = (row.totalCost ?? safeCost) / (topQualityModel.totalCost ?? safeCost);
    row.calculated =
      options.calc === "raw"
        ? row.quality
        : options.calc === "sub"
          ? row.quality - row.costPenalty
          : row.quality / Math.pow(safeCost, options.costPower);
    row.frontier = false;
  }

  let bestQualitySoFar = -Infinity;
  for (const row of [...modeRows].sort(
    (a, b) => (a.totalCost ?? 0) - (b.totalCost ?? 0) || b.quality - a.quality,
  )) {
    row.frontier = row.quality > bestQualitySoFar + 1e-9;
    if (row.quality > bestQualitySoFar) bestQualitySoFar = row.quality;
  }

  const sortFns: Record<SortKey, (row: ScoredRow<T>) => number | string | null> = {
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

  const effectiveSortBy = sortFns[options.sort] ? options.sort : "score";
  const sortFn = sortFns[effectiveSortBy];
  const ascendingSorts = new Set<SortKey>(["cost", "cqp", "name"]);
  const stringSorts = new Set<SortKey>(["released", "name"]);

  const sortableRows = options.frontierOnly ? modeRows.filter((row) => row.frontier) : modeRows;

  const rows = [...sortableRows].sort((a, b) => {
    const av = sortFn(a);
    const bv = sortFn(b);

    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;

    if (stringSorts.has(effectiveSortBy)) {
      const direction = ascendingSorts.has(effectiveSortBy) ? 1 : -1;
      return direction * String(av).localeCompare(String(bv));
    }

    return ascendingSorts.has(effectiveSortBy) ? Number(av) - Number(bv) : Number(bv) - Number(av);
  });

  return { rows, topQualityModel, effectiveSortBy };
}

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

function extractArrayFromHtmlPayload(html: string, keyName: string): unknown[] | null {
  const markers = [`\\",\\"${keyName}\\":[{`, `\\"${keyName}\\":[{`, `"${keyName}":[{`];

  for (const marker of markers) {
    const position = html.indexOf(marker);
    if (position === -1) continue;

    // The first marker includes the escaped leading `","`; skip it so the
    // decoded text starts at `"keyName":[` just like the original CLI did.
    const start = marker.startsWith('\\",') ? position + 4 : position;
    const clean = html.slice(start).replaceAll('\\"', '"').replaceAll("\\\\", "\\");

    return parseArrayFromCleanPayload(clean, keyName);
  }

  return null;
}

function parseArrayFromCleanPayload(clean: string, keyName: string): unknown[] {
  const key = `"${keyName}":[`;
  const keyPosition = clean.indexOf(key);
  if (keyPosition === -1) {
    throw new Error(
      `Found ${keyName} marker, but decoded payload did not contain a ${keyName} array`,
    );
  }

  const arrayStart = keyPosition + key.length - 1;
  let depth = 0;

  for (let i = arrayStart; i < clean.length; i++) {
    const char = clean[i];

    if (char === '"' && !isEscaped(clean, i)) {
      i++;
      while (i < clean.length && (clean[i] !== '"' || isEscaped(clean, i))) {
        i++;
      }
      continue;
    }

    if (char === "[") {
      depth++;
    } else if (char === "]") {
      depth--;
      if (depth === 0) {
        const arrayJson = clean
          .slice(arrayStart, i + 1)
          .replace(/"\$undefined"/g, "null")
          .replace(/"\$NaN"/g, "null");
        const parsed = JSON.parse(arrayJson);
        if (!Array.isArray(parsed)) {
          throw new Error(`Artificial Analysis ${keyName} payload was not an array`);
        }
        return parsed;
      }
    }
  }

  throw new Error(`Could not find the end of the Artificial Analysis ${keyName} array`);
}

function normalizeModel(input: unknown): ParsedModelResult {
  const model = asRecord(input);
  const cost = firstRecord(model.intelligence_index_cost, model.intelligenceIndexCost);
  const creator = firstRecord(model.model_creators, model.creator);
  const sourceId = stringOrNull(model.id);
  const slug = stringOrNull(model.slug);
  const shortName = stringOrNull(model.short_name) ?? stringOrNull(model.shortName);
  const name = stringOrNull(model.name) ?? shortName ?? slug ?? sourceId ?? "";
  const modelKey = slug ?? sourceId ?? slugify(name);
  const releaseDate = stringOrNull(model.release_date) ?? stringOrNull(model.releaseDate);
  const cutoffDate =
    stringOrNull(model.knowledge_cutoff_date) ?? stringOrNull(model.knowledgeCutoffDate);
  const totalCost = numberOrNull(cost.total_cost) ?? numberOrNull(cost.totalCost);
  const inputCost = numberOrNull(cost.input_cost) ?? numberOrNull(cost.inputCost);
  const outputCost = numberOrNull(cost.output_cost) ?? numberOrNull(cost.outputCost);
  const reasoningCost = numberOrNull(cost.reasoning_cost) ?? numberOrNull(cost.reasoningCost);
  const answerCost = numberOrNull(cost.answer_cost) ?? numberOrNull(cost.answerCost);
  const intelligence =
    numberOrNull(model.intelligence_index) ?? numberOrNull(model.intelligenceIndex);
  const coding = numberOrNull(model.coding_index) ?? numberOrNull(model.codingIndex);
  const agentic = numberOrNull(model.agentic_index) ?? numberOrNull(model.agenticIndex);
  const mmmu = numberOrNull(model.mmmu_pro) ?? numberOrNull(model.mmmuPro);
  const priceInput1m =
    numberOrNull(model.price_1m_input_tokens) ?? numberOrNull(model.priceInput1m);
  const priceOutput1m =
    numberOrNull(model.price_1m_output_tokens) ?? numberOrNull(model.priceOutput1m);
  const activeParams =
    numberOrNull(model.activeParams) ?? numberOrNull(model.inference_parameters_active_billions);
  const isOpenWeights = booleanOrNull(model.is_open_weights) ?? booleanOrNull(model.isOpenWeights);
  const isReasoning = booleanOrNull(model.reasoning_model) ?? booleanOrNull(model.isReasoning);

  const rawResult = {
    id: sourceId,
    slug,
    model_url: stringOrNull(model.model_url) ?? stringOrNull(model.modelUrl),
    hosts_url: stringOrNull(model.hosts_url) ?? stringOrNull(model.hostsUrl),
    name,
    short_name: shortName,
    creator_name: stringOrNull(creator.name),
    creator_slug: stringOrNull(creator.slug),
    release_date: releaseDate,
    knowledge_cutoff_date: cutoffDate,
    intelligence_index: intelligence,
    coding_index: coding,
    agentic_index: agentic,
    mmmu_pro: mmmu,
    intelligence_index_cost: cost,
    price_1m_input_tokens: priceInput1m,
    price_1m_output_tokens: priceOutput1m,
    activeParams,
    is_open_weights: isOpenWeights,
    reasoning_model: isReasoning,
  };

  return {
    modelKey,
    sourceId,
    slug,
    name,
    shortName,
    creatorName: stringOrNull(creator.name),
    creatorSlug: stringOrNull(creator.slug),
    releaseDate,
    cutoffDate,
    totalCost,
    inputCost,
    outputCost,
    reasoningCost,
    answerCost,
    intelligence,
    coding,
    agentic,
    mmmu,
    priceInput1m,
    priceOutput1m,
    activeParams,
    isOpenWeights,
    isReasoning,
    rawResultJson: JSON.stringify(rawResult),
  };
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

function isScoreableResult(result: ParsedModelResult): boolean {
  return (
    isNumber(result.totalCost) &&
    result.totalCost > 0 &&
    isNumber(result.intelligence) &&
    isNumber(result.coding)
  );
}

function hasModelScoreFields(input: unknown): boolean {
  const model = asRecord(input);
  const cost = firstRecord(model.intelligence_index_cost, model.intelligenceIndexCost);

  return (
    numberOrNull(model.intelligence_index) != null ||
    numberOrNull(model.intelligenceIndex) != null ||
    numberOrNull(model.coding_index) != null ||
    numberOrNull(model.codingIndex) != null ||
    numberOrNull(cost.total_cost) != null ||
    numberOrNull(cost.totalCost) != null
  );
}

function firstRecord(...values: unknown[]): Record<string, unknown> {
  for (const value of values) {
    const record = asRecord(value);
    if (Object.keys(record).length > 0) return record;
  }

  return {};
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function isEscaped(value: string, quoteIndex: number): boolean {
  let backslashes = 0;
  for (let i = quoteIndex - 1; i >= 0 && value[i] === "\\"; i--) {
    backslashes++;
  }
  return backslashes % 2 === 1;
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function numberOrNull(value: unknown): number | null {
  return isNumber(value) ? value : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function booleanOrNull(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function isNotNull<T>(value: T | null): value is T {
  return value !== null;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
