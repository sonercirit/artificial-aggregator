/**
 * The hourly fetch job: snapshot the Artificial Analysis models page, store
 * the raw HTML and normalized results, and keep the run history healthy.
 *
 * Every step is individually time-boxed so a hung fetch or D1 call cannot
 * silently eat the Worker's wall-clock budget — a timed-out step fails the
 * run with a recorded error instead.
 */

import { ARTIFICIAL_ANALYSIS_URL, parseHtmlToResults } from "./aa";
import type { FetchRun } from "./db";
import {
  completeFetchRun,
  createFetchRun,
  failFetchRun,
  getActiveRun,
  getRawHtmlBase64Chunks,
  getRepairableRawRuns,
  markStaleRunningRuns,
  pruneStoredRunData,
  storeModelResults,
  storeRawHtmlChunks,
  updateFetchRunProgress,
} from "./db";
import { gunzipBase64ChunksToString, gzipStringToBase64Chunks, sha256Hex } from "./storage";
import type { Bindings } from "../types";

export type FetchJobResult = {
  runId: number | null;
  skipped: boolean;
  reason?: string;
  modelCount?: number;
  resultCount?: number;
};

const FETCH_TIMEOUT_MS = 20_000;
const FETCH_ATTEMPTS = 2;
const FETCH_RETRY_DELAY_MS = 1_000;
const RESPONSE_TEXT_TIMEOUT_MS = 20_000;
const COMPRESSION_TIMEOUT_MS = 20_000;
const RAW_HTML_WRITE_TIMEOUT_MS = 20_000;
const MODEL_WRITE_TIMEOUT_MS = 30_000;
const REPAIR_RAW_RUN_LIMIT = 2;
const REPAIR_TIMEOUT_MS = 60_000;
const FINAL_UPDATE_TIMEOUT_MS = 10_000;
const FAILURE_UPDATE_TIMEOUT_MS = 5_000;
const PRUNE_TIMEOUT_MS = 30_000;

/** A run is considered abandoned (stale, repairable) after this long. */
const STALE_RUN_MS = 20 * 60 * 1000;

export async function runFetchJob(
  env: Bindings,
  options: { force?: boolean } = {},
): Promise<FetchJobResult> {
  await runMaintenance(env);

  if (!options.force) {
    const activeRun = await getActiveRun(env);
    if (activeRun) {
      return {
        runId: activeRun.id,
        skipped: true,
        reason: `run ${activeRun.id} is still marked running`,
      };
    }
  }

  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  const sourceUrl = env.AA_SOURCE_URL || ARTIFICIAL_ANALYSIS_URL;
  console.log(`Fetch job started for ${sourceUrl}`);

  // Failure-path bookkeeping: whatever was captured before the error is
  // persisted so the run stays auditable and repairable.
  let runId: number | null = null;
  let httpStatus: number | null = null;
  let htmlBytes: number | null = null;
  let htmlSha256: string | null = null;
  let htmlGzipBytes: number | null = null;
  let compressedChunks: string[] | null = null;
  let rawHtmlStored = false;

  try {
    const { response, html } = await fetchSourceHtml(sourceUrl);
    httpStatus = response.status;

    const compressed = await withTimeout(
      gzipStringToBase64Chunks(html),
      "compress raw HTML",
      COMPRESSION_TIMEOUT_MS,
    );

    compressedChunks = compressed.chunks;
    htmlBytes = compressed.originalBytes;
    htmlGzipBytes = compressed.gzipBytes;
    htmlSha256 = await withTimeout(sha256Hex(html), "hash raw HTML", 5_000);

    if (!response.ok) {
      throw new Error(`Artificial Analysis returned HTTP ${response.status}`);
    }

    const results = parseHtmlToResults(html);
    runId = await withTimeout(createFetchRun(env, sourceUrl, startedAt), "create fetch run", 5_000);
    console.log(`Fetch run ${runId} started`);

    await withTimeout(
      updateFetchRunProgress(env, runId, {
        httpStatus,
        htmlBytes,
        htmlSha256,
        htmlGzipBytes,
        modelCount: results.length,
        resultCount: 0,
      }),
      "record fetched HTML metadata",
      FINAL_UPDATE_TIMEOUT_MS,
    );

    // Store the exact fetched HTML before model rows so failed parser/storage
    // runs are still auditable and can be repaired from the raw snapshot.
    await withTimeout(
      storeRawHtmlChunks(env, runId, compressedChunks),
      "store raw HTML chunks",
      RAW_HTML_WRITE_TIMEOUT_MS,
    );
    rawHtmlStored = true;

    await withTimeout(
      storeModelResults(env, runId, results),
      "store model results",
      MODEL_WRITE_TIMEOUT_MS,
    );

    await withTimeout(
      completeFetchRun(env, runId, {
        durationMs: Date.now() - started,
        httpStatus,
        htmlBytes,
        htmlSha256,
        htmlGzipBytes,
        modelCount: results.length,
        resultCount: results.length,
      }),
      "complete fetch run",
      FINAL_UPDATE_TIMEOUT_MS,
    );

    console.log(`Fetch run ${runId} completed with ${results.length} model result(s)`);
    return {
      runId,
      skipped: false,
      modelCount: results.length,
      resultCount: results.length,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Fetch run ${runId ?? "unrecorded"} failed: ${message}`);
    try {
      if (runId == null) {
        runId = await withTimeout(
          createFetchRun(env, sourceUrl, startedAt),
          "create failed fetch run",
          5_000,
        );
      }

      if (runId != null) {
        await recordFailureArtifacts(env, runId, {
          httpStatus,
          htmlBytes,
          htmlSha256,
          htmlGzipBytes,
          compressedChunks,
          rawHtmlStored,
        });
        await withTimeout(
          failFetchRun(env, runId, {
            error: message,
            durationMs: Date.now() - started,
            httpStatus,
            htmlBytes,
            htmlSha256,
            htmlGzipBytes,
          }),
          "record fetch failure",
          FAILURE_UPDATE_TIMEOUT_MS,
        );
      }
    } catch (failureError) {
      console.error(
        `Fetch run ${runId ?? "unrecorded"} failed and could not record failure`,
        failureError,
      );
    }
    throw error;
  }
}

/** Pre-flight housekeeping: flag stale runs, repair raw-only runs, prune storage. */
async function runMaintenance(env: Bindings): Promise<void> {
  const staleRuns = await withTimeout(
    markStaleRunningRuns(env),
    "mark stale running runs",
    FINAL_UPDATE_TIMEOUT_MS,
  );
  if (staleRuns > 0) {
    console.warn(`Marked ${staleRuns} stale running fetch run(s) as error`);
  }

  try {
    const repairedRuns = await withTimeout(
      repairRawOnlyRuns(env),
      "repair raw-only fetch runs",
      REPAIR_TIMEOUT_MS,
    );
    if (repairedRuns > 0) {
      console.log(`Repaired ${repairedRuns} raw-only fetch run(s)`);
    }
  } catch (error) {
    console.warn("Could not repair raw-only fetch runs", error);
  }

  const pruned = await withTimeout(
    pruneStoredRunData(env),
    "prune old stored run data",
    PRUNE_TIMEOUT_MS,
  );
  const prunedItems =
    pruned.deletedRuns +
    pruned.deletedRawChunks +
    pruned.prunedRunMetadata +
    pruned.prunedRawResultJson;
  if (prunedItems > 0) {
    console.log(
      `Pruned stored run data: ${pruned.deletedRuns} run(s), ${pruned.deletedRawChunks} raw chunk(s), ${pruned.prunedRawResultJson} raw model payload(s)`,
    );
  }
}

// ---------------------------------------------------------------------------
// Repairing raw-only runs
// ---------------------------------------------------------------------------

/**
 * A "raw-only" run stored its HTML snapshot but died before writing model
 * rows. Re-parse the stored snapshot and complete the run retroactively.
 */
async function repairRawOnlyRuns(env: Bindings): Promise<number> {
  const runs = await getRepairableRawRuns(env, REPAIR_RAW_RUN_LIMIT);
  let repaired = 0;

  for (const run of runs) {
    try {
      const chunks = await getRawHtmlBase64Chunks(env, run.id);
      if (chunks.length === 0) continue;

      const html = await gunzipBase64ChunksToString(chunks);
      const results = parseHtmlToResults(html);

      await withTimeout(
        updateFetchRunProgress(env, run.id, {
          modelCount: results.length,
          resultCount: 0,
        }),
        `record repaired model count for run ${run.id}`,
        FINAL_UPDATE_TIMEOUT_MS,
      );
      await withTimeout(
        storeModelResults(env, run.id, results),
        `store repaired model results for run ${run.id}`,
        MODEL_WRITE_TIMEOUT_MS,
      );
      await withTimeout(
        completeFetchRun(env, run.id, {
          durationMs: repairedDurationMs(run),
          httpStatus: run.http_status,
          htmlBytes: run.html_bytes,
          htmlSha256: run.html_sha256,
          htmlGzipBytes: run.html_gzip_bytes,
          modelCount: results.length,
          resultCount: results.length,
          completedAt: repairedCompletedAt(run),
        }),
        `complete repaired fetch run ${run.id}`,
        FINAL_UPDATE_TIMEOUT_MS,
      );

      repaired++;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`Could not repair raw-only fetch run ${run.id}: ${message}`);
      await withTimeout(
        failFetchRun(env, run.id, {
          error: `Repair failed: ${message}`,
          durationMs: run.duration_ms ?? 0,
          httpStatus: run.http_status,
          htmlBytes: run.html_bytes,
          htmlSha256: run.html_sha256,
          htmlGzipBytes: run.html_gzip_bytes,
        }),
        `record repair failure for run ${run.id}`,
        FAILURE_UPDATE_TIMEOUT_MS,
      );
    }
  }

  return repaired;
}

// A stale run's recorded completion/duration reflect when it was flagged,
// not when it actually ran; fall back to its start time in that case.
function repairedCompletedAt(run: FetchRun): string {
  if (run.completed_at && run.duration_ms != null && run.duration_ms < STALE_RUN_MS) {
    return run.completed_at;
  }

  return run.started_at;
}

function repairedDurationMs(run: FetchRun): number {
  if (run.duration_ms != null && run.duration_ms < STALE_RUN_MS) return run.duration_ms;

  const completedAt = Date.parse(repairedCompletedAt(run));
  const startedAt = Date.parse(run.started_at);
  if (Number.isFinite(completedAt) && Number.isFinite(startedAt) && completedAt >= startedAt) {
    return completedAt - startedAt;
  }

  return 0;
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

async function fetchSourceHtml(sourceUrl: string): Promise<{ response: Response; html: string }> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt++) {
    try {
      return await fetchSourceHtmlAttempt(sourceUrl, attempt);
    } catch (error) {
      lastError = error;
      if (attempt >= FETCH_ATTEMPTS) break;

      const message = error instanceof Error ? error.message : String(error);
      console.warn(
        `Fetch attempt ${attempt}/${FETCH_ATTEMPTS} failed (${message}); retrying in ${FETCH_RETRY_DELAY_MS}ms`,
      );
      await sleep(FETCH_RETRY_DELAY_MS);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function fetchSourceHtmlAttempt(
  sourceUrl: string,
  attempt: number,
): Promise<{ response: Response; html: string }> {
  const controller = new AbortController();
  const attemptLabel = `attempt ${attempt}/${FETCH_ATTEMPTS}`;

  const response = await withTimeout(
    fetch(sourceUrl, {
      headers: {
        accept: "text/html,application/xhtml+xml",
        "cache-control": "no-cache",
        "user-agent": "artificial-aggregator/0.1 (+https://workers.cloudflare.com/)",
      },
      redirect: "follow",
      signal: controller.signal,
    }),
    `fetch ${sourceUrl} (${attemptLabel})`,
    FETCH_TIMEOUT_MS,
    () => controller.abort(),
  );

  const html = await withTimeout(
    response.text(),
    `read Artificial Analysis response (${attemptLabel})`,
    RESPONSE_TEXT_TIMEOUT_MS,
    () => controller.abort(),
  );

  return { response, html };
}

// ---------------------------------------------------------------------------
// Failure handling
// ---------------------------------------------------------------------------

type FailureArtifacts = {
  httpStatus: number | null;
  htmlBytes: number | null;
  htmlSha256: string | null;
  htmlGzipBytes: number | null;
  compressedChunks: string[] | null;
  rawHtmlStored: boolean;
};

async function recordFailureArtifacts(
  env: Bindings,
  runId: number,
  artifacts: FailureArtifacts,
): Promise<void> {
  if (
    artifacts.httpStatus != null ||
    artifacts.htmlBytes != null ||
    artifacts.htmlSha256 != null ||
    artifacts.htmlGzipBytes != null
  ) {
    await withTimeout(
      updateFetchRunProgress(env, runId, {
        httpStatus: artifacts.httpStatus,
        htmlBytes: artifacts.htmlBytes,
        htmlSha256: artifacts.htmlSha256,
        htmlGzipBytes: artifacts.htmlGzipBytes,
      }),
      "record failed fetch metadata",
      FAILURE_UPDATE_TIMEOUT_MS,
    );
  }

  if (artifacts.compressedChunks && !artifacts.rawHtmlStored) {
    await withTimeout(
      storeRawHtmlChunks(env, runId, artifacts.compressedChunks),
      "store failed raw HTML chunks",
      RAW_HTML_WRITE_TIMEOUT_MS,
    );
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function withTimeout<T>(
  promise: Promise<T>,
  label: string,
  timeoutMs: number,
  onTimeout?: () => void,
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      try {
        onTimeout?.();
      } catch (error) {
        console.warn(`Timeout cleanup failed for ${label}`, error);
      }
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
