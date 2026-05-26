import { ARTIFICIAL_ANALYSIS_URL, parseHtmlToResults } from "./aa";
import {
  completeFetchRun,
  createFetchRun,
  failFetchRun,
  getActiveRun,
  markStaleRunningRuns,
  pruneStoredRunData,
  storeModelResults,
  storeRawHtmlChunks,
  updateFetchRunProgress,
} from "./db";
import { gzipStringToBase64Chunks, sha256Hex } from "./storage";
import type { Bindings } from "../types";

export type FetchJobResult = {
  runId: number | null;
  skipped: boolean;
  reason?: string;
  modelCount?: number;
  resultCount?: number;
};

const FETCH_TIMEOUT_MS = 20_000;
const RESPONSE_TEXT_TIMEOUT_MS = 20_000;
const COMPRESSION_TIMEOUT_MS = 20_000;
const RAW_HTML_WRITE_TIMEOUT_MS = 20_000;
const MODEL_WRITE_TIMEOUT_MS = 30_000;
const FINAL_UPDATE_TIMEOUT_MS = 10_000;
const FAILURE_UPDATE_TIMEOUT_MS = 5_000;
const PRUNE_TIMEOUT_MS = 30_000;

export async function runFetchJob(
  env: Bindings,
  options: { force?: boolean } = {},
): Promise<FetchJobResult> {
  const staleRuns = await withTimeout(
    markStaleRunningRuns(env),
    "mark stale running runs",
    FINAL_UPDATE_TIMEOUT_MS,
  );
  if (staleRuns > 0) {
    console.warn(`Marked ${staleRuns} stale running fetch run(s) as error`);
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
  const sourceUrl = env.AA_SOURCE_URL || ARTIFICIAL_ANALYSIS_URL;
  const runId = await withTimeout(createFetchRun(env, sourceUrl), "create fetch run", 5_000);
  console.log(`Fetch run ${runId} started`);

  let httpStatus: number | null = null;
  let htmlBytes: number | null = null;
  let htmlSha256: string | null = null;
  let htmlGzipBytes: number | null = null;

  try {
    const response = await withTimeout(
      fetch(sourceUrl, {
        headers: {
          accept: "text/html,application/xhtml+xml",
          "user-agent": "artificial-aggregator/0.1 (+https://workers.cloudflare.com/)",
        },
        redirect: "follow",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      }),
      `fetch ${sourceUrl}`,
      FETCH_TIMEOUT_MS + 1_000,
    );

    httpStatus = response.status;
    const html = await withTimeout(
      response.text(),
      "read Artificial Analysis response",
      RESPONSE_TEXT_TIMEOUT_MS,
    );
    const compressed = await withTimeout(
      gzipStringToBase64Chunks(html),
      "compress raw HTML",
      COMPRESSION_TIMEOUT_MS,
    );

    htmlBytes = compressed.originalBytes;
    htmlGzipBytes = compressed.gzipBytes;
    htmlSha256 = await withTimeout(sha256Hex(html), "hash raw HTML", 5_000);

    await withTimeout(
      updateFetchRunProgress(env, runId, {
        httpStatus,
        htmlBytes,
        htmlSha256,
        htmlGzipBytes,
      }),
      "record fetched HTML metadata",
      FINAL_UPDATE_TIMEOUT_MS,
    );

    // Store the exact fetched HTML before parsing so failed parser runs are
    // still auditable.
    await withTimeout(
      storeRawHtmlChunks(env, runId, compressed.chunks),
      "store raw HTML chunks",
      RAW_HTML_WRITE_TIMEOUT_MS,
    );

    if (!response.ok) {
      throw new Error(`Artificial Analysis returned HTTP ${response.status}`);
    }

    const results = parseHtmlToResults(html);
    await withTimeout(
      updateFetchRunProgress(env, runId, { modelCount: results.length, resultCount: 0 }),
      "record parsed model count",
      FINAL_UPDATE_TIMEOUT_MS,
    );
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
    console.error(`Fetch run ${runId} failed: ${message}`);
    try {
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
    } catch (failureError) {
      console.error(`Fetch run ${runId} failed and could not record failure`, failureError);
    }
    throw error;
  }
}

async function withTimeout<T>(promise: Promise<T>, label: string, timeoutMs: number): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}
