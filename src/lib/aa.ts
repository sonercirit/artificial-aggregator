/**
 * Artificial Analysis snapshot parser.
 *
 * The source page is a Next.js RSC payload: the model list is embedded in the
 * HTML as an escaped JSON array. This module locates that array, decodes it,
 * and normalizes each entry into a stable, storage-ready shape.
 */

export const ARTIFICIAL_ANALYSIS_URL = "https://artificialanalysis.ai/models";

/** Stored with every run; bump when the extraction/normalization rules change. */
export const PARSER_VERSION = "aa-next-rsc-default-data-v2";

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

/**
 * A result that can participate in score/cost ranking. The same predicate is
 * mirrored in SQL by db.ts (total_cost > 0, intelligence and coding present).
 */
export function isScoreable(result: ParsedModelResult): boolean {
  return (
    isNumber(result.totalCost) &&
    result.totalCost > 0 &&
    isNumber(result.intelligence) &&
    isNumber(result.coding)
  );
}

export function parseHtmlToResults(html: string): ParsedModelResult[] {
  const results = extractModelsFromHtml(html)
    .map(normalizeModel)
    .filter((model) => model.modelKey.length > 0 && model.name.length > 0);

  if (results.length > 0 && !results.some(isScoreable)) {
    throw new Error("Parsed Artificial Analysis payload did not include score/cost fields");
  }

  return results;
}

// ---------------------------------------------------------------------------
// Payload extraction
// ---------------------------------------------------------------------------

function extractModelsFromHtml(html: string): unknown[] {
  // Prefer "defaultData" when it actually carries scores; older payloads used
  // a "models" array instead.
  const defaultData = extractArrayFromHtmlPayload(html, "defaultData");
  if (defaultData && defaultData.some(hasModelScoreFields)) return defaultData;

  const models = extractArrayFromHtmlPayload(html, "models");
  if (models) return models;
  if (defaultData) return defaultData;

  throw new Error("Could not find Artificial Analysis models payload in HTML");
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

  // Walk the text to find the matching closing bracket, skipping over string
  // literals (which may contain brackets) and honoring escape sequences.
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

function isEscaped(value: string, quoteIndex: number): boolean {
  let backslashes = 0;
  for (let i = quoteIndex - 1; i >= 0 && value[i] === "\\"; i--) {
    backslashes++;
  }
  return backslashes % 2 === 1;
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

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

// The payload has shipped both snake_case and camelCase field names over
// time, so every lookup tries both spellings.
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

  // Snapshot of the normalized source fields, stored verbatim for audits.
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

// ---------------------------------------------------------------------------
// Value coercion
// ---------------------------------------------------------------------------

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

function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
