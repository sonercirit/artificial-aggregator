import type { ParsedModelResult } from "./aa";
import { PARSER_VERSION } from "./aa";
import type { Bindings } from "../types";

export type FetchRunStatus = "running" | "success" | "error" | "skipped";

export type FetchRun = {
  id: number;
  source_url: string;
  status: FetchRunStatus;
  started_at: string;
  completed_at: string | null;
  duration_ms: number | null;
  http_status: number | null;
  html_bytes: number | null;
  html_sha256: string | null;
  html_gzip_bytes: number | null;
  raw_html_encoding: string;
  parser_version: string;
  model_count: number;
  result_count: number;
  error: string | null;
};

export type ModelResultRow = {
  id: number;
  run_id: number;
  model_key: string;
  source_id: string | null;
  slug: string | null;
  name: string;
  short_name: string | null;
  creator_name: string | null;
  creator_slug: string | null;
  release_date: string | null;
  knowledge_cutoff_date: string | null;
  total_cost: number | null;
  input_cost: number | null;
  output_cost: number | null;
  reasoning_cost: number | null;
  answer_cost: number | null;
  intelligence: number | null;
  coding: number | null;
  agentic: number | null;
  mmmu: number | null;
  price_input_1m: number | null;
  price_output_1m: number | null;
  active_params: number | null;
  is_open_weights: number | null;
  is_reasoning: number | null;
  raw_result_json: string;
  created_at: string;
};

export type TimelineResult = ParsedModelResult & {
  runId: number;
  runStartedAt: string;
  runCompletedAt: string | null;
};

export type ModelSummary = {
  model_key: string;
  name: string;
  samples: number;
  latest_at: string | null;
};

export type TimelineRun = {
  id: number;
  started_at: string;
  completed_at: string | null;
};

export type CompleteRunInput = {
  durationMs: number;
  httpStatus: number | null;
  htmlBytes: number | null;
  htmlSha256: string | null;
  htmlGzipBytes: number | null;
  modelCount: number;
  resultCount: number;
};

export type RunProgressInput = {
  httpStatus?: number | null;
  htmlBytes?: number | null;
  htmlSha256?: string | null;
  htmlGzipBytes?: number | null;
  modelCount?: number | null;
  resultCount?: number | null;
};

export type PruneStoredRunDataInput = {
  keepRuns?: number;
  keepRawRuns?: number;
  keepRawResultRuns?: number;
};

export type PruneStoredRunDataResult = {
  deletedRuns: number;
  deletedRawChunks: number;
  prunedRunMetadata: number;
  prunedRawResultJson: number;
};

export async function markStaleRunningRuns(
  env: Bindings,
  olderThanMs = 20 * 60 * 1000,
): Promise<number> {
  const now = new Date();
  const cutoff = new Date(now.getTime() - olderThanMs).toISOString();
  const nowIso = now.toISOString();
  const result = await env.DB.prepare(
    `UPDATE fetch_runs
     SET status = 'error',
         completed_at = ?,
         duration_ms = COALESCE(duration_ms, ?),
         error = 'Worker was canceled or timed out before it could record a failure. raw_chunks=' ||
           (SELECT COUNT(*) FROM raw_html_chunks WHERE raw_html_chunks.run_id = fetch_runs.id) ||
           ', model_rows=' ||
           (SELECT COUNT(*) FROM model_results WHERE model_results.run_id = fetch_runs.id)
     WHERE status = 'running' AND started_at < ?`,
  )
    .bind(nowIso, olderThanMs, cutoff)
    .run();

  return Number(result.meta.changes ?? 0);
}

export async function getActiveRun(env: Bindings): Promise<FetchRun | null> {
  const cutoff = new Date(Date.now() - 55 * 60 * 1000).toISOString();
  return env.DB.prepare(
    `SELECT * FROM fetch_runs
     WHERE status = 'running' AND started_at >= ?
     ORDER BY started_at DESC
     LIMIT 1`,
  )
    .bind(cutoff)
    .first<FetchRun>();
}

export async function createFetchRun(env: Bindings, sourceUrl: string): Promise<number> {
  const result = await env.DB.prepare(
    `INSERT INTO fetch_runs (source_url, status, parser_version)
     VALUES (?, 'running', ?)`,
  )
    .bind(sourceUrl, PARSER_VERSION)
    .run();

  const id = Number(result.meta.last_row_id);
  if (!Number.isFinite(id) || id <= 0) {
    throw new Error("D1 did not return a fetch run id");
  }
  return id;
}

export async function updateFetchRunProgress(
  env: Bindings,
  runId: number,
  input: RunProgressInput,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE fetch_runs
     SET http_status = COALESCE(?, http_status),
         html_bytes = COALESCE(?, html_bytes),
         html_sha256 = COALESCE(?, html_sha256),
         html_gzip_bytes = COALESCE(?, html_gzip_bytes),
         model_count = COALESCE(?, model_count),
         result_count = COALESCE(?, result_count)
     WHERE id = ?`,
  )
    .bind(
      input.httpStatus ?? null,
      input.htmlBytes ?? null,
      input.htmlSha256 ?? null,
      input.htmlGzipBytes ?? null,
      input.modelCount ?? null,
      input.resultCount ?? null,
      runId,
    )
    .run();
}

export async function completeFetchRun(
  env: Bindings,
  runId: number,
  input: CompleteRunInput,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE fetch_runs
     SET status = 'success',
         completed_at = ?,
         duration_ms = ?,
         http_status = ?,
         html_bytes = ?,
         html_sha256 = ?,
         html_gzip_bytes = ?,
         model_count = ?,
         result_count = ?,
         error = NULL
     WHERE id = ?`,
  )
    .bind(
      new Date().toISOString(),
      input.durationMs,
      input.httpStatus,
      input.htmlBytes,
      input.htmlSha256,
      input.htmlGzipBytes,
      input.modelCount,
      input.resultCount,
      runId,
    )
    .run();
}

export async function failFetchRun(
  env: Bindings,
  runId: number,
  input: {
    error: string;
    durationMs: number;
    httpStatus?: number | null;
    htmlBytes?: number | null;
    htmlSha256?: string | null;
    htmlGzipBytes?: number | null;
  },
): Promise<void> {
  await env.DB.prepare(
    `UPDATE fetch_runs
     SET status = 'error',
         completed_at = ?,
         duration_ms = ?,
         http_status = COALESCE(?, http_status),
         html_bytes = COALESCE(?, html_bytes),
         html_sha256 = COALESCE(?, html_sha256),
         html_gzip_bytes = COALESCE(?, html_gzip_bytes),
         error = ?
     WHERE id = ?`,
  )
    .bind(
      new Date().toISOString(),
      input.durationMs,
      input.httpStatus ?? null,
      input.htmlBytes ?? null,
      input.htmlSha256 ?? null,
      input.htmlGzipBytes ?? null,
      input.error.slice(0, 4000),
      runId,
    )
    .run();
}

export async function pruneStoredRunData(
  env: Bindings,
  input: PruneStoredRunDataInput = {},
): Promise<PruneStoredRunDataResult> {
  const keepRuns = positiveLimit(input.keepRuns, 1500);
  const keepRawRuns = Math.min(positiveLimit(input.keepRawRuns, 72), keepRuns);
  const keepRawResultRuns = Math.min(positiveLimit(input.keepRawResultRuns, 500), keepRuns);

  const deletedRawChunks = await env.DB.prepare(
    `DELETE FROM raw_html_chunks
     WHERE run_id NOT IN (
       SELECT id FROM fetch_runs
       ORDER BY started_at DESC, id DESC
       LIMIT ?
     )`,
  )
    .bind(keepRawRuns)
    .run();

  const prunedRunMetadata = await env.DB.prepare(
    `UPDATE fetch_runs
     SET raw_html_encoding = 'pruned'
     WHERE raw_html_encoding <> 'pruned'
       AND id NOT IN (
         SELECT id FROM fetch_runs
         ORDER BY started_at DESC, id DESC
         LIMIT ?
       )`,
  )
    .bind(keepRawRuns)
    .run();

  const prunedRawResultJson = await env.DB.prepare(
    `UPDATE model_results
     SET raw_result_json = '{}'
     WHERE raw_result_json <> '{}'
       AND run_id NOT IN (
         SELECT id FROM fetch_runs
         ORDER BY started_at DESC, id DESC
         LIMIT ?
       )`,
  )
    .bind(keepRawResultRuns)
    .run();

  const deletedRuns = await env.DB.prepare(
    `DELETE FROM fetch_runs
     WHERE id NOT IN (
       SELECT id FROM fetch_runs
       ORDER BY started_at DESC, id DESC
       LIMIT ?
     )`,
  )
    .bind(keepRuns)
    .run();

  return {
    deletedRuns: dbChanges(deletedRuns),
    deletedRawChunks: dbChanges(deletedRawChunks),
    prunedRunMetadata: dbChanges(prunedRunMetadata),
    prunedRawResultJson: dbChanges(prunedRawResultJson),
  };
}

export async function storeRawHtmlChunks(
  env: Bindings,
  runId: number,
  chunks: string[],
): Promise<void> {
  await env.DB.prepare("DELETE FROM raw_html_chunks WHERE run_id = ?").bind(runId).run();

  const statements = chunks.map((chunk, index) =>
    env.DB.prepare(
      `INSERT INTO raw_html_chunks (run_id, chunk_index, data, byte_length)
       VALUES (?, ?, ?, ?)`,
    ).bind(runId, index, chunk, chunk.length),
  );

  await batchStatements(env, statements, 50);
}

export async function storeModelResults(
  env: Bindings,
  runId: number,
  results: ParsedModelResult[],
): Promise<void> {
  await env.DB.prepare("DELETE FROM model_results WHERE run_id = ?").bind(runId).run();

  const statements = results.map((result) =>
    env.DB.prepare(
      `INSERT INTO model_results (
        run_id, model_key, source_id, slug, name, short_name,
        creator_name, creator_slug, release_date, knowledge_cutoff_date,
        total_cost, input_cost, output_cost, reasoning_cost, answer_cost,
        intelligence, coding, agentic, mmmu, price_input_1m, price_output_1m,
        active_params, is_open_weights, is_reasoning, raw_result_json
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?
      )
      ON CONFLICT(run_id, model_key) DO UPDATE SET
        source_id = excluded.source_id,
        slug = excluded.slug,
        name = excluded.name,
        short_name = excluded.short_name,
        creator_name = excluded.creator_name,
        creator_slug = excluded.creator_slug,
        release_date = excluded.release_date,
        knowledge_cutoff_date = excluded.knowledge_cutoff_date,
        total_cost = excluded.total_cost,
        input_cost = excluded.input_cost,
        output_cost = excluded.output_cost,
        reasoning_cost = excluded.reasoning_cost,
        answer_cost = excluded.answer_cost,
        intelligence = excluded.intelligence,
        coding = excluded.coding,
        agentic = excluded.agentic,
        mmmu = excluded.mmmu,
        price_input_1m = excluded.price_input_1m,
        price_output_1m = excluded.price_output_1m,
        active_params = excluded.active_params,
        is_open_weights = excluded.is_open_weights,
        is_reasoning = excluded.is_reasoning,
        raw_result_json = excluded.raw_result_json`,
    ).bind(
      runId,
      result.modelKey,
      result.sourceId,
      result.slug,
      result.name,
      result.shortName,
      result.creatorName,
      result.creatorSlug,
      result.releaseDate,
      result.cutoffDate,
      result.totalCost,
      result.inputCost,
      result.outputCost,
      result.reasoningCost,
      result.answerCost,
      result.intelligence,
      result.coding,
      result.agentic,
      result.mmmu,
      result.priceInput1m,
      result.priceOutput1m,
      result.activeParams,
      boolToInt(result.isOpenWeights),
      boolToInt(result.isReasoning),
      result.rawResultJson,
    ),
  );

  await batchStatements(env, statements, 80);
}

export async function getLatestSuccessfulRun(env: Bindings): Promise<FetchRun | null> {
  return env.DB.prepare(
    `SELECT * FROM fetch_runs
     WHERE status = 'success'
       AND EXISTS (
         SELECT 1 FROM model_results mr
         WHERE mr.run_id = fetch_runs.id
           AND mr.total_cost > 0
           AND mr.intelligence IS NOT NULL
           AND mr.coding IS NOT NULL
       )
     ORDER BY completed_at DESC, id DESC
     LIMIT 1`,
  ).first<FetchRun>();
}

export async function getRun(env: Bindings, runId: number): Promise<FetchRun | null> {
  return env.DB.prepare("SELECT * FROM fetch_runs WHERE id = ?").bind(runId).first<FetchRun>();
}

export async function getRuns(env: Bindings, limit = 100): Promise<FetchRun[]> {
  const { results = [] } = await env.DB.prepare(
    `SELECT * FROM fetch_runs
     ORDER BY started_at DESC, id DESC
     LIMIT ?`,
  )
    .bind(limit)
    .all<FetchRun>();
  return results;
}

export async function getResultsForRun(env: Bindings, runId: number): Promise<ParsedModelResult[]> {
  const { results = [] } = await env.DB.prepare(
    `SELECT * FROM model_results
     WHERE run_id = ?
     ORDER BY name ASC`,
  )
    .bind(runId)
    .all<ModelResultRow>();

  return results.map(rowToModelResult);
}

export async function getTimelineForModel(
  env: Bindings,
  modelKey: string,
  limit = 1000,
): Promise<TimelineResult[]> {
  const { results = [] } = await env.DB.prepare(
    `SELECT
        mr.*,
        fr.id AS timeline_run_id,
        fr.started_at AS timeline_started_at,
        fr.completed_at AS timeline_completed_at
     FROM model_results mr
     JOIN fetch_runs fr ON fr.id = mr.run_id
     WHERE mr.model_key = ?
       AND fr.status = 'success'
       AND mr.total_cost > 0
       AND mr.intelligence IS NOT NULL
       AND mr.coding IS NOT NULL
     ORDER BY fr.completed_at ASC, fr.id ASC
     LIMIT ?`,
  )
    .bind(modelKey, limit)
    .all<ModelResultRow & TimelineColumns>();

  return results.map(rowToTimelineResult);
}

export async function getSuccessfulTimelineRuns(
  env: Bindings,
  limit = 500,
): Promise<TimelineRun[]> {
  const { results = [] } = await env.DB.prepare(
    `SELECT fr.id, fr.started_at, fr.completed_at
     FROM fetch_runs fr
     WHERE fr.status = 'success'
       AND EXISTS (
         SELECT 1 FROM model_results mr
         WHERE mr.run_id = fr.id
           AND mr.total_cost > 0
           AND mr.intelligence IS NOT NULL
           AND mr.coding IS NOT NULL
       )
     ORDER BY fr.completed_at DESC, fr.id DESC
     LIMIT ?`,
  )
    .bind(limit)
    .all<TimelineRun>();

  return results;
}

export async function getTimelineResultsForRuns(
  env: Bindings,
  runIds: number[],
): Promise<TimelineResult[]> {
  const ids = [...new Set(runIds)].filter((id) => Number.isInteger(id) && id > 0);
  if (ids.length === 0) return [];

  const placeholders = ids.map(() => "?").join(", ");
  const { results = [] } = await env.DB.prepare(
    `SELECT
        mr.run_id,
        mr.model_key,
        mr.name,
        mr.creator_name,
        mr.release_date,
        mr.total_cost,
        mr.intelligence,
        mr.coding,
        mr.agentic,
        mr.mmmu,
        fr.id AS timeline_run_id,
        fr.started_at AS timeline_started_at,
        fr.completed_at AS timeline_completed_at
     FROM model_results mr
     JOIN fetch_runs fr ON fr.id = mr.run_id
     WHERE mr.run_id IN (${placeholders})
       AND fr.status = 'success'
       AND mr.total_cost > 0
       AND mr.intelligence IS NOT NULL
       AND mr.coding IS NOT NULL
     ORDER BY fr.completed_at ASC, fr.id ASC, LOWER(mr.name) ASC`,
  )
    .bind(...ids)
    .all<ScoreModelResultRow & TimelineColumns>();

  return results.map(rowToScoreTimelineResult);
}

export async function getResultsForSuccessfulRuns(
  env: Bindings,
  runLimit = 500,
): Promise<TimelineResult[]> {
  const runs = await getSuccessfulTimelineRuns(env, runLimit);
  const allResults: TimelineResult[] = [];

  for (let i = 0; i < runs.length; i += 50) {
    const runIds = runs.slice(i, i + 50).map((run) => run.id);
    allResults.push(...(await getTimelineResultsForRuns(env, runIds)));
  }

  return allResults.sort(compareTimelineResults);
}

export async function getModelSummaries(env: Bindings): Promise<ModelSummary[]> {
  const { results = [] } = await env.DB.prepare(
    `SELECT
        mr.model_key,
        mr.name,
        COUNT(*) AS samples,
        MAX(fr.completed_at) AS latest_at
     FROM model_results mr
     JOIN fetch_runs fr ON fr.id = mr.run_id
     WHERE fr.status = 'success'
       AND mr.total_cost > 0
       AND mr.intelligence IS NOT NULL
       AND mr.coding IS NOT NULL
     GROUP BY mr.model_key
     ORDER BY LOWER(mr.name) ASC`,
  ).all<ModelSummary>();

  return results;
}

export async function getRawHtmlBase64Chunks(env: Bindings, runId: number): Promise<string[]> {
  const { results = [] } = await env.DB.prepare(
    `SELECT data FROM raw_html_chunks
     WHERE run_id = ?
     ORDER BY chunk_index ASC`,
  )
    .bind(runId)
    .all<{ data: string }>();

  return results.map((row) => row.data);
}

type TimelineColumns = {
  timeline_run_id: number;
  timeline_started_at: string;
  timeline_completed_at: string | null;
};

type ScoreModelResultRow = {
  run_id: number;
  model_key: string;
  name: string;
  creator_name: string | null;
  release_date: string | null;
  total_cost: number | null;
  intelligence: number | null;
  coding: number | null;
  agentic: number | null;
  mmmu: number | null;
};

function rowToTimelineResult(row: ModelResultRow & TimelineColumns): TimelineResult {
  return {
    ...rowToModelResult(row),
    runId: row.timeline_run_id,
    runStartedAt: row.timeline_started_at,
    runCompletedAt: row.timeline_completed_at,
  };
}

function rowToScoreTimelineResult(row: ScoreModelResultRow & TimelineColumns): TimelineResult {
  return {
    modelKey: row.model_key,
    sourceId: null,
    slug: null,
    name: row.name,
    shortName: null,
    creatorName: row.creator_name,
    creatorSlug: null,
    releaseDate: row.release_date,
    cutoffDate: null,
    totalCost: row.total_cost,
    inputCost: null,
    outputCost: null,
    reasoningCost: null,
    answerCost: null,
    intelligence: row.intelligence,
    coding: row.coding,
    agentic: row.agentic,
    mmmu: row.mmmu,
    priceInput1m: null,
    priceOutput1m: null,
    activeParams: null,
    isOpenWeights: null,
    isReasoning: null,
    rawResultJson: "",
    runId: row.timeline_run_id,
    runStartedAt: row.timeline_started_at,
    runCompletedAt: row.timeline_completed_at,
  };
}

function compareTimelineResults(a: TimelineResult, b: TimelineResult): number {
  return String(a.runCompletedAt ?? a.runStartedAt).localeCompare(
    String(b.runCompletedAt ?? b.runStartedAt),
  );
}

function rowToModelResult(row: ModelResultRow): ParsedModelResult {
  return {
    modelKey: row.model_key,
    sourceId: row.source_id,
    slug: row.slug,
    name: row.name,
    shortName: row.short_name,
    creatorName: row.creator_name,
    creatorSlug: row.creator_slug,
    releaseDate: row.release_date,
    cutoffDate: row.knowledge_cutoff_date,
    totalCost: row.total_cost,
    inputCost: row.input_cost,
    outputCost: row.output_cost,
    reasoningCost: row.reasoning_cost,
    answerCost: row.answer_cost,
    intelligence: row.intelligence,
    coding: row.coding,
    agentic: row.agentic,
    mmmu: row.mmmu,
    priceInput1m: row.price_input_1m,
    priceOutput1m: row.price_output_1m,
    activeParams: row.active_params,
    isOpenWeights: intToBool(row.is_open_weights),
    isReasoning: intToBool(row.is_reasoning),
    rawResultJson: row.raw_result_json,
  };
}

async function batchStatements(
  env: Bindings,
  statements: D1PreparedStatement[],
  groupSize: number,
): Promise<void> {
  for (let i = 0; i < statements.length; i += groupSize) {
    await env.DB.batch(statements.slice(i, i + groupSize));
  }
}

function boolToInt(value: boolean | null): number | null {
  return value == null ? null : value ? 1 : 0;
}

function intToBool(value: number | null): boolean | null {
  return value == null ? null : Boolean(value);
}

function dbChanges(result: D1Result): number {
  return Number(result.meta.changes ?? 0);
}

function positiveLimit(value: number | undefined, fallback: number): number {
  if (value == null || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.floor(value));
}
