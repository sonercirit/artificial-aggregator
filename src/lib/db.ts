/**
 * All D1 access. Queries use raw SQL on purpose: Drizzle owns the schema and
 * migrations (src/db/schema.ts), while the Worker keeps its hot path free of
 * query-builder overhead.
 */

import type { ParsedModelResult } from "./aa";
import { isScoreable, PARSER_VERSION } from "./aa";
import type { Bindings } from "../types";

export type FetchRunStatus = "running" | "success" | "error" | "skipped";

/** Row shape of fetch_runs; field names mirror the SQL columns. */
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

/** Row shape of model_results; field names mirror the SQL columns. */
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
  cost_per_task: number | null;
  input_cost_per_task: number | null;
  output_cost_per_task: number | null;
  reasoning_cost_per_task: number | null;
  answer_cost_per_task: number | null;
  time_per_task: number | null;
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

/** SQL mirror of isScoreable() in aa.ts; expects model_results aliased as mr. */
const SCOREABLE_SQL = `COALESCE(mr.cost_per_task, mr.total_cost) > 0
           AND mr.intelligence IS NOT NULL
           AND mr.coding IS NOT NULL`;

/** Explicit inverse of SCOREABLE_SQL (NOT would not match SQL NULL values). */
const UNSCOREABLE_SQL = `(COALESCE(mr.cost_per_task, mr.total_cost) IS NULL
           OR COALESCE(mr.cost_per_task, mr.total_cost) <= 0
           OR mr.intelligence IS NULL
           OR mr.coding IS NULL)`;

const DEFAULT_KEEP_RUNS = 900;
const DEFAULT_KEEP_RAW_RUNS = 72;
const DEFAULT_KEEP_RAW_RESULT_RUNS = 72;
/** Caps cleanup work so maintenance remains within D1's daily write allowance. */
const DEFAULT_MODEL_MAINTENANCE_ROWS = 600;
const DEFAULT_DELETE_RUNS_PER_PASS = 1;

// ---------------------------------------------------------------------------
// Run lifecycle
// ---------------------------------------------------------------------------

export async function createFetchRun(
  env: Bindings,
  sourceUrl: string,
  startedAt?: string,
): Promise<number> {
  const result = startedAt
    ? await env.DB.prepare(
        `INSERT INTO fetch_runs (source_url, status, parser_version, started_at)
         VALUES (?, 'running', ?, ?)`,
      )
        .bind(sourceUrl, PARSER_VERSION, startedAt)
        .run()
    : await env.DB.prepare(
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

export type RunProgressInput = {
  httpStatus?: number | null;
  htmlBytes?: number | null;
  htmlSha256?: string | null;
  htmlGzipBytes?: number | null;
  modelCount?: number | null;
  resultCount?: number | null;
};

/** Records whatever is known so far; null/omitted fields keep their stored value. */
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

export type CompleteRunInput = {
  durationMs: number;
  httpStatus: number | null;
  htmlBytes: number | null;
  htmlSha256: string | null;
  htmlGzipBytes: number | null;
  modelCount: number;
  resultCount: number;
  completedAt?: string;
};

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
      input.completedAt ?? new Date().toISOString(),
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

/**
 * Flags runs stuck in 'running' (Worker canceled/timed out before recording
 * an outcome) as errors, annotated with what they managed to store.
 */
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

/** A run still plausibly executing (started within the last 55 minutes). */
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

/**
 * Failed or abandoned runs whose raw HTML made it to storage but whose model
 * rows did not — these can be re-parsed from the stored snapshot.
 */
export async function getRepairableRawRuns(
  env: Bindings,
  limit = 2,
  olderThanMs = 20 * 60 * 1000,
): Promise<FetchRun[]> {
  const cutoff = new Date(Date.now() - olderThanMs).toISOString();
  const { results = [] } = await env.DB.prepare(
    `SELECT fr.*
     FROM fetch_runs fr
     WHERE fr.status IN ('running', 'error')
       AND (fr.status = 'error' OR fr.started_at < ?)
       AND fr.http_status BETWEEN 200 AND 299
       AND fr.raw_html_encoding <> 'pruned'
       -- Retrying a quota failure just fills the database again. Keep those
       -- runs as audit records and let the next fresh snapshot replace them.
       AND COALESCE(fr.error, '') NOT LIKE '%Exceeded maximum DB size%'
       AND EXISTS (
         SELECT 1 FROM raw_html_chunks rhc
         WHERE rhc.run_id = fr.id
       )
       AND NOT EXISTS (
         SELECT 1 FROM model_results mr
         WHERE mr.run_id = fr.id
       )
     ORDER BY fr.started_at DESC, fr.id DESC
     LIMIT ?`,
  )
    .bind(cutoff, limit)
    .all<FetchRun>();

  return results;
}

// ---------------------------------------------------------------------------
// Snapshot storage and retention
// ---------------------------------------------------------------------------

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
): Promise<number> {
  // Every read path filters on these same fields. Persisting the hundreds of
  // scoreless catalog entries from each hourly manifest only duplicates data
  // that the application can never display, and previously filled free-plan
  // D1 databases long before the run-retention window was reached.
  const storedResults = results.filter(isScoreable);
  if (storedResults.length === 0) {
    throw new Error("Artificial Analysis payload contained no scoreable model results");
  }

  await env.DB.prepare("DELETE FROM model_results WHERE run_id = ?").bind(runId).run();

  const statements = storedResults.map((result) =>
    env.DB.prepare(
      `INSERT INTO model_results (
        run_id, model_key, source_id, slug, name, short_name,
        creator_name, creator_slug, release_date, knowledge_cutoff_date,
        total_cost, input_cost, output_cost, reasoning_cost, answer_cost,
        cost_per_task, input_cost_per_task, output_cost_per_task,
        reasoning_cost_per_task, answer_cost_per_task, time_per_task,
        intelligence, coding, agentic, mmmu, price_input_1m, price_output_1m,
        active_params, is_open_weights, is_reasoning, raw_result_json
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?
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
        cost_per_task = excluded.cost_per_task,
        input_cost_per_task = excluded.input_cost_per_task,
        output_cost_per_task = excluded.output_cost_per_task,
        reasoning_cost_per_task = excluded.reasoning_cost_per_task,
        answer_cost_per_task = excluded.answer_cost_per_task,
        time_per_task = excluded.time_per_task,
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
      result.costPerTask,
      result.inputCostPerTask,
      result.outputCostPerTask,
      result.reasoningCostPerTask,
      result.answerCostPerTask,
      result.timePerTask,
      result.intelligence,
      result.coding,
      result.agentic,
      result.mmmu,
      result.priceInput1m,
      result.priceOutput1m,
      result.activeParams,
      boolToInt(result.isOpenWeights),
      boolToInt(result.isReasoning),
      // The exact source HTML is already retained in compressed chunks. The
      // per-row JSON duplicates most of every manifest and was the largest
      // contributor to D1 growth; normalized columns contain every field the
      // application reads.
      "{}",
    ),
  );

  try {
    await batchStatements(env, statements, 80);
  } catch (error) {
    // batchStatements uses several transactions for large manifests. If a
    // later batch fails (for example at the D1 size limit), do not strand the
    // earlier batches and permanently consume the remaining free pages.
    try {
      await env.DB.prepare("DELETE FROM model_results WHERE run_id = ?").bind(runId).run();
    } catch (cleanupError) {
      console.warn(`Could not clean partial model rows for run ${runId}`, cleanupError);
    }
    throw error;
  }

  return storedResults.length;
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

export type PruneStoredRunDataInput = {
  keepRuns?: number;
  keepRawRuns?: number;
  keepRawResultRuns?: number;
  maxModelRowsPerPass?: number;
  maxRunsPerPass?: number;
};

export type PruneStoredRunDataResult = {
  deletedRuns: number;
  deletedRawChunks: number;
  deletedIncompleteResults: number;
  deletedUnscoreableResults: number;
  prunedRunMetadata: number;
  prunedRawResultJson: number;
};

/**
 * Keeps D1 below its size limits: exact raw HTML survives for recent runs and
 * normalized score history survives the longest. It also drains duplicate raw
 * JSON and unscoreable rows written by older deployments. Model-row cleanup is
 * deliberately incremental so recovery cannot exhaust D1's free-plan daily
 * write allowance.
 *
 * Defaults: 72 raw-HTML runs and a rolling window of about 900 runs.
 */
export async function pruneStoredRunData(
  env: Bindings,
  input: PruneStoredRunDataInput = {},
): Promise<PruneStoredRunDataResult> {
  const keepRuns = positiveLimit(input.keepRuns, DEFAULT_KEEP_RUNS);
  const keepRawRuns = Math.min(positiveLimit(input.keepRawRuns, DEFAULT_KEEP_RAW_RUNS), keepRuns);
  const keepRawResultRuns = Math.min(
    positiveLimit(input.keepRawResultRuns, DEFAULT_KEEP_RAW_RESULT_RUNS),
    keepRuns,
  );
  let modelRowsRemaining = positiveLimit(input.maxModelRowsPerPass, DEFAULT_MODEL_MAINTENANCE_ROWS);
  const maxRunsPerPass = positiveLimit(input.maxRunsPerPass, DEFAULT_DELETE_RUNS_PER_PASS);

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

  // Delete at most one complete old snapshot before row-level cleanup. A
  // cascade releases contiguous table/index pages, which is the reliable way
  // to recover when SQLite has reached its maximum page count. Replacing one
  // legacy 500+ row snapshot with a scoreable-only snapshot also steadily
  // reduces the live data set without bursting D1's daily write allowance.
  const deletedRunsResult = await env.DB.prepare(
    `DELETE FROM fetch_runs
     WHERE id IN (
       SELECT id
       FROM fetch_runs
       WHERE id NOT IN (
         SELECT id FROM fetch_runs
         ORDER BY started_at DESC, id DESC
         LIMIT ?
       )
       ORDER BY started_at ASC, id ASC
       LIMIT ?
     )
     RETURNING id`,
  )
    .bind(keepRuns, maxRunsPerPass)
    .run<{ id: number }>();
  const deletedRuns = deletedRunsResult.results?.length ?? 0;
  if (deletedRuns > 0) modelRowsRemaining = 0;

  // Deletes release whole SQLite pages that can be reused even when the D1
  // file is already at its hard size limit. Start with legacy catalog rows;
  // unlike shrinking TEXT in-place, this creates room for the next snapshot.
  const deletedUnscoreableResults = await runLimitedModelMutation(
    env,
    `DELETE FROM model_results
     WHERE id IN (
       SELECT mr.id
       FROM model_results mr
       WHERE EXISTS (
         SELECT 1 FROM fetch_runs fr
         WHERE fr.id = mr.run_id AND fr.status IN ('success', 'error')
       )
         AND ${UNSCOREABLE_SQL}
       ORDER BY mr.run_id ASC, mr.id ASC
       LIMIT ?
     )`,
    modelRowsRemaining,
  );
  modelRowsRemaining -= deletedUnscoreableResults;

  // Remove rows left by a failed multi-batch write. They are neither a
  // successful snapshot nor repairable while any partial rows remain.
  const deletedIncompleteResults = await runLimitedModelMutation(
    env,
    `DELETE FROM model_results
     WHERE id IN (
       SELECT mr.id
       FROM model_results mr
       WHERE mr.run_id IN (
         SELECT fr.id FROM fetch_runs fr
         WHERE fr.status = 'error' AND fr.result_count = 0
       )
       ORDER BY mr.run_id ASC, mr.id ASC
       LIMIT ?
     )`,
    modelRowsRemaining,
  );
  modelRowsRemaining -= deletedIncompleteResults;

  // Compact legacy scoreable payloads after page-releasing work. New rows no
  // longer store this duplicate JSON, so this backlog only decreases.
  const prunedRawResultJson = await runLimitedModelMutation(
    env,
    `UPDATE model_results
     SET raw_result_json = '{}'
     WHERE id IN (
       SELECT mr.id
       FROM model_results mr
       WHERE mr.raw_result_json <> '{}'
         AND ${SCOREABLE_SQL}
         AND mr.run_id NOT IN (
           SELECT id FROM fetch_runs
           ORDER BY started_at DESC, id DESC
           LIMIT ?
         )
       ORDER BY mr.run_id ASC, mr.id ASC
       LIMIT ?
     )`,
    modelRowsRemaining,
    keepRawResultRuns,
  );

  return {
    deletedRuns,
    deletedRawChunks: dbChanges(deletedRawChunks),
    deletedIncompleteResults,
    deletedUnscoreableResults,
    prunedRunMetadata: dbChanges(prunedRunMetadata),
    prunedRawResultJson,
  };
}

// ---------------------------------------------------------------------------
// Read queries
// ---------------------------------------------------------------------------

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

export async function getLatestSuccessfulRun(env: Bindings): Promise<FetchRun | null> {
  return env.DB.prepare(
    `SELECT * FROM fetch_runs
     WHERE status = 'success'
       AND EXISTS (
         SELECT 1 FROM model_results mr
         WHERE mr.run_id = fetch_runs.id
           AND ${SCOREABLE_SQL}
       )
     ORDER BY completed_at DESC, id DESC
     LIMIT 1`,
  ).first<FetchRun>();
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
       AND ${SCOREABLE_SQL}
     GROUP BY mr.model_key
     ORDER BY LOWER(mr.name) ASC`,
  ).all<ModelSummary>();

  return results;
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
       AND ${SCOREABLE_SQL}
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
           AND ${SCOREABLE_SQL}
       )
     ORDER BY fr.completed_at DESC, fr.id DESC
     LIMIT ?`,
  )
    .bind(limit)
    .all<TimelineRun>();

  return results;
}

/**
 * Scoreable results for a batch of runs. Selects only the columns scoring
 * needs — fetching full rows for many runs at once overruns D1's response
 * size limits (callers batch run ids for the same reason).
 */
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
        mr.cost_per_task,
        mr.time_per_task,
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
       AND ${SCOREABLE_SQL}
     ORDER BY fr.completed_at ASC, fr.id ASC, LOWER(mr.name) ASC`,
  )
    .bind(...ids)
    .all<ScoreModelResultRow & TimelineColumns>();

  return results.map(rowToScoreTimelineResult);
}

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

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
  cost_per_task: number | null;
  time_per_task: number | null;
  intelligence: number | null;
  coding: number | null;
  agentic: number | null;
  mmmu: number | null;
};

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
    costPerTask: row.cost_per_task,
    inputCostPerTask: row.input_cost_per_task,
    outputCostPerTask: row.output_cost_per_task,
    reasoningCostPerTask: row.reasoning_cost_per_task,
    answerCostPerTask: row.answer_cost_per_task,
    timePerTask: row.time_per_task,
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

function rowToTimelineResult(row: ModelResultRow & TimelineColumns): TimelineResult {
  return {
    ...rowToModelResult(row),
    runId: row.timeline_run_id,
    runStartedAt: row.timeline_started_at,
    runCompletedAt: row.timeline_completed_at,
  };
}

/** Expands the narrow scoring projection back to the full result shape. */
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
    costPerTask: row.cost_per_task,
    inputCostPerTask: null,
    outputCostPerTask: null,
    reasoningCostPerTask: null,
    answerCostPerTask: null,
    timePerTask: row.time_per_task,
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function runLimitedModelMutation(
  env: Bindings,
  query: string,
  limit: number,
  ...leadingBindings: unknown[]
): Promise<number> {
  if (limit <= 0) return 0;

  const result = await env.DB.prepare(query)
    .bind(...leadingBindings, limit)
    .run();
  return dbChanges(result);
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
