/**
 * Artificial Analysis snapshot parser.
 *
 * The source page is a Next.js RSC payload. Historically the full model list
 * was embedded in the HTML as an escaped JSON array. Newer pages only embed a
 * short `initialModels` preview and load the complete list from AES-GCM
 * encrypted, gzip-compressed `/data/*.txt` manifests referenced in the HTML.
 *
 * This module locates every candidate payload (embedded arrays + manifests),
 * decrypts manifests when a fetch helper is provided, and normalizes each
 * entry into a stable, storage-ready shape.
 */

export const ARTIFICIAL_ANALYSIS_URL = "https://artificialanalysis.ai/models";

/** Stored with every run; bump when the extraction/normalization rules change. */
export const PARSER_VERSION = "aa-next-rsc-manifest-aes-gcm-v4";

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
  costPerTask: number | null;
  inputCostPerTask: number | null;
  outputCostPerTask: number | null;
  reasoningCostPerTask: number | null;
  answerCostPerTask: number | null;
  /** Seconds per Intelligence Index task. */
  timePerTask: number | null;
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

export type ManifestRef = {
  path: string;
  key: string;
};

export type ParseHtmlOptions = {
  /** Turn a relative manifest path into an absolute URL. Defaults to AA origin. */
  resolveUrl?: (path: string) => string;
  /** Fetch a binary manifest body. Required to load encrypted `/data/*.txt` payloads. */
  fetchBinary?: (url: string) => Promise<ArrayBuffer>;
};

/**
 * Cost used by ranking and Pareto math: prefer AA's newer Cost per Task,
 * falling back to the legacy whole-benchmark cost for older stored snapshots.
 */
export function costForRanking(result: ParsedModelResult): number | null {
  return numberOrNull(result.costPerTask) ?? numberOrNull(result.totalCost);
}

/**
 * A result that can participate in score/cost ranking. The same predicate is
 * mirrored in SQL by db.ts (COALESCE(cost_per_task, total_cost) > 0,
 * intelligence and coding present).
 */
export function isScoreable(result: ParsedModelResult): boolean {
  const cost = costForRanking(result);
  return cost != null && cost > 0 && isNumber(result.intelligence) && isNumber(result.coding);
}

/**
 * Parse model results from a models-page HTML snapshot.
 *
 * When `fetchBinary` is provided, encrypted `/data/*.txt` manifests referenced
 * by the page are also loaded; the candidate with the most scoreable models
 * wins (full manifest lists beat the short embedded preview).
 */
export async function parseHtmlToResults(
  html: string,
  options: ParseHtmlOptions = {},
): Promise<ParsedModelResult[]> {
  const candidates: unknown[][] = extractEmbeddedModelArrays(html);

  if (options.fetchBinary) {
    const manifests = extractManifestsFromHtml(html);
    for (const manifest of manifests) {
      try {
        const models = await loadManifestModels(manifest, options);
        if (models.length > 0) candidates.push(models);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`Could not load Artificial Analysis manifest ${manifest.path}: ${message}`);
      }
    }
  }

  const best = pickBestNormalized(candidates);
  if (!best) {
    throw new Error("Could not find Artificial Analysis models payload in HTML");
  }

  if (best.length > 0 && !best.some(isScoreable)) {
    throw new Error("Parsed Artificial Analysis payload did not include score/cost fields");
  }

  return best;
}

/** Synchronous HTML-only parse used by unit tests and older snapshots. */
export function parseEmbeddedHtmlToResults(html: string): ParsedModelResult[] {
  const best = pickBestNormalized(extractEmbeddedModelArrays(html));
  if (!best) {
    throw new Error("Could not find Artificial Analysis models payload in HTML");
  }

  if (best.length > 0 && !best.some(isScoreable)) {
    throw new Error("Parsed Artificial Analysis payload did not include score/cost fields");
  }

  return best;
}

// ---------------------------------------------------------------------------
// Payload extraction
// ---------------------------------------------------------------------------

function extractEmbeddedModelArrays(html: string): unknown[][] {
  const candidates: unknown[][] = [];

  // Prefer score-bearing keys first; `models` is often a slim id/slug index.
  for (const keyName of ["defaultData", "initialModels", "models"]) {
    const array = extractArrayFromHtmlPayload(html, keyName);
    if (array) candidates.push(array);
  }

  return candidates;
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

/**
 * Locate encrypted data manifests embedded in the RSC flight payload.
 *
 * Shape: `"manifest":{"path":"/data/<id>.txt","key":"<64 hex chars>"}`
 */
export function extractManifestsFromHtml(html: string): ManifestRef[] {
  const clean = html.replaceAll('\\"', '"').replaceAll("\\\\", "\\");
  const pattern =
    /"manifest"\s*:\s*\{\s*"path"\s*:\s*"(\/data\/[^"]+)"\s*,\s*"key"\s*:\s*"([0-9a-fA-F]{64})"/g;
  const seen = new Set<string>();
  const manifests: ManifestRef[] = [];

  for (const match of clean.matchAll(pattern)) {
    const path = match[1];
    const key = match[2].toLowerCase();
    const id = `${path}:${key}`;
    if (seen.has(id)) continue;
    seen.add(id);
    manifests.push({ path, key });
  }

  return manifests;
}

async function loadManifestModels(
  manifest: ManifestRef,
  options: ParseHtmlOptions,
): Promise<unknown[]> {
  if (!options.fetchBinary) {
    throw new Error("fetchBinary is required to load manifests");
  }

  const resolveUrl =
    options.resolveUrl ?? ((path: string) => new URL(path, ARTIFICIAL_ANALYSIS_URL).toString());
  const url = resolveUrl(manifest.path);
  const encrypted = await options.fetchBinary(url);
  const payload = await decryptManifestPayload(encrypted, manifest.key);
  return modelsFromManifestPayload(payload);
}

/**
 * Decrypt an AA `/data/*.txt` body: AES-256-GCM with the hex key, IV =
 * SHA-256(key)[0..12], ciphertext||tag, then gzip.
 */
export async function decryptManifestPayload(
  encrypted: ArrayBuffer,
  keyHex: string,
): Promise<unknown> {
  const keyBytes = hexToBytes(keyHex);
  if (keyBytes.byteLength !== 32) {
    throw new Error(`Expected 32-byte AES key, got ${keyBytes.byteLength}`);
  }

  const iv = new Uint8Array(await crypto.subtle.digest("SHA-256", toArrayBuffer(keyBytes))).slice(
    0,
    12,
  );
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(keyBytes),
    { name: "AES-GCM" },
    false,
    ["decrypt"],
  );

  let plain: ArrayBuffer;
  try {
    plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv, tagLength: 128 },
      cryptoKey,
      encrypted,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`AES-GCM decrypt failed for Artificial Analysis manifest: ${message}`);
  }

  const stream = new Response(plain).body?.pipeThrough(new DecompressionStream("gzip"));
  if (!stream) {
    throw new Error("DecompressionStream is unavailable in this runtime");
  }

  const text = await new Response(stream).text();
  return JSON.parse(text);
}

function modelsFromManifestPayload(payload: unknown): unknown[] {
  if (Array.isArray(payload)) {
    // Endpoint/host manifests are arrays of host-model rows, not model scores.
    // Only treat them as model lists when entries look like models.
    if (payload.some(hasModelScoreFields) || payload.some(looksLikeModelRow)) {
      return payload;
    }
    return [];
  }

  const record = asRecord(payload);
  for (const key of ["models", "defaultData", "initialModels", "data"]) {
    const value = record[key];
    if (Array.isArray(value)) return value;
  }

  return [];
}

function pickBestNormalized(candidates: unknown[][]): ParsedModelResult[] | null {
  let best: ParsedModelResult[] | null = null;
  let bestScoreable = -1;
  let bestTotal = -1;

  for (const candidate of candidates) {
    const results = candidate
      .map(normalizeModel)
      .filter((model) => model.modelKey.length > 0 && model.name.length > 0);
    const scoreable = results.filter(isScoreable).length;

    if (
      best == null ||
      scoreable > bestScoreable ||
      (scoreable === bestScoreable && results.length > bestTotal)
    ) {
      best = results;
      bestScoreable = scoreable;
      bestTotal = results.length;
    }
  }

  return best;
}

function hasModelScoreFields(input: unknown): boolean {
  const model = asRecord(input);
  const cost = firstRecord(model.intelligence_index_cost, model.intelligenceIndexCost);
  const taskCostSource = firstRecord(
    model.intelligence_index_cost_per_task,
    model.intelligenceIndexCostPerTask,
  );
  const taskCost = costComponentRecord(taskCostSource);

  return (
    numberOrNull(model.intelligence_index) != null ||
    numberOrNull(model.intelligenceIndex) != null ||
    numberOrNull(model.coding_index) != null ||
    numberOrNull(model.codingIndex) != null ||
    numberOrNull(cost.total) != null ||
    numberOrNull(cost.total_cost) != null ||
    numberOrNull(cost.totalCost) != null ||
    numberOrNull(taskCost.total) != null ||
    numberOrNull(taskCost.total_cost) != null ||
    numberOrNull(taskCost.totalCost) != null ||
    numberOrNull(model.intelligence_index_cost_per_task) != null ||
    numberOrNull(model.intelligenceIndexCostPerTask) != null
  );
}

function looksLikeModelRow(input: unknown): boolean {
  const model = asRecord(input);
  return (
    (stringOrNull(model.slug) != null || stringOrNull(model.id) != null) &&
    (stringOrNull(model.name) != null || stringOrNull(model.shortName) != null)
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
  const taskCostSource = firstRecord(
    model.intelligence_index_cost_per_task,
    model.intelligenceIndexCostPerTask,
  );
  const taskCost = costComponentRecord(taskCostSource);
  const creator = firstRecord(model.model_creators, model.creator);
  const sourceId = stringOrNull(model.id);
  const slug = stringOrNull(model.slug);
  const shortName = stringOrNull(model.short_name) ?? stringOrNull(model.shortName);
  const name = stringOrNull(model.name) ?? shortName ?? slug ?? sourceId ?? "";
  const modelKey = slug ?? sourceId ?? slugify(name);
  const releaseDate = stringOrNull(model.release_date) ?? stringOrNull(model.releaseDate);
  const cutoffDate =
    stringOrNull(model.knowledge_cutoff_date) ?? stringOrNull(model.knowledgeCutoffDate);
  const totalCost =
    numberOrNull(cost.total) ?? numberOrNull(cost.total_cost) ?? numberOrNull(cost.totalCost);
  const inputCost =
    numberOrNull(cost.input) ?? numberOrNull(cost.input_cost) ?? numberOrNull(cost.inputCost);
  const outputCost =
    numberOrNull(cost.output) ?? numberOrNull(cost.output_cost) ?? numberOrNull(cost.outputCost);
  const reasoningCost =
    numberOrNull(cost.reasoning) ??
    numberOrNull(cost.reasoning_cost) ??
    numberOrNull(cost.reasoningCost);
  const answerCost =
    numberOrNull(cost.answer) ?? numberOrNull(cost.answer_cost) ?? numberOrNull(cost.answerCost);
  const costPerTask =
    numberOrNull(taskCost.total) ??
    numberOrNull(taskCost.total_cost) ??
    numberOrNull(taskCost.totalCost) ??
    numberOrNull(model.intelligence_index_cost_per_task) ??
    numberOrNull(model.intelligenceIndexCostPerTask);
  const inputCostPerTask =
    numberOrNull(taskCost.input) ??
    numberOrNull(taskCost.input_cost) ??
    numberOrNull(taskCost.inputCost);
  const outputCostPerTask =
    numberOrNull(taskCost.output) ??
    numberOrNull(taskCost.output_cost) ??
    numberOrNull(taskCost.outputCost);
  const reasoningCostPerTask =
    numberOrNull(taskCost.reasoning) ??
    numberOrNull(taskCost.reasoning_cost) ??
    numberOrNull(taskCost.reasoningCost);
  const answerCostPerTask =
    numberOrNull(taskCost.answer) ??
    numberOrNull(taskCost.answer_cost) ??
    numberOrNull(taskCost.answerCost);
  const timePerTask =
    numberOrNull(model.intelligence_index_time_per_task) ??
    numberOrNull(model.intelligenceIndexTimePerTask);
  const intelligence =
    numberOrNull(model.intelligence_index) ?? numberOrNull(model.intelligenceIndex);
  const coding = numberOrNull(model.coding_index) ?? numberOrNull(model.codingIndex);
  const agentic = numberOrNull(model.agentic_index) ?? numberOrNull(model.agenticIndex);
  const mmmu = numberOrNull(model.mmmu_pro) ?? numberOrNull(model.mmmuPro);
  const priceInput1m =
    numberOrNull(model.price_1m_input_tokens) ??
    numberOrNull(model.price1mInputTokens) ??
    numberOrNull(model.priceInput1m);
  const priceOutput1m =
    numberOrNull(model.price_1m_output_tokens) ??
    numberOrNull(model.price1mOutputTokens) ??
    numberOrNull(model.priceOutput1m);
  const activeParams =
    numberOrNull(model.activeParams) ??
    numberOrNull(model.inferenceParametersActiveBillions) ??
    numberOrNull(model.inference_parameters_active_billions);
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
    intelligence_index_cost_per_task: taskCostSource,
    intelligence_index_time_per_task: timePerTask,
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
    costPerTask,
    inputCostPerTask,
    outputCostPerTask,
    reasoningCostPerTask,
    answerCostPerTask,
    timePerTask,
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

function costComponentRecord(source: Record<string, unknown>): Record<string, unknown> {
  return firstRecord(source.cost, source.cost_per_task, source.costPerTask, source);
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

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new Error("Hex key must have even length");
  }

  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    const byte = Number.parseInt(hex.slice(i, i + 2), 16);
    if (!Number.isFinite(byte)) {
      throw new Error("Hex key contains non-hex characters");
    }
    bytes[i / 2] = byte;
  }
  return bytes;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}
