import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installReadCache } from "./helpers/cache";
import { Miniflare } from "miniflare";
import type { ParsedModelResult } from "../src/lib/aa";
import {
  completeFetchRun,
  getDefaultWinnerTimeline,
  getModelSummaries,
  getRepairableRawRuns,
  pruneStoredRunData,
  storeModelResults,
} from "../src/lib/db";
import { DEFAULT_SCORE_OPTIONS } from "../src/lib/scoring";
import { getWinnerTimeline } from "../src/lib/winners";
import type { Bindings } from "../src/types";

let miniflare: Miniflare;
let db: D1Database;
let env: Bindings;

beforeEach(async () => {
  miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: ["DB"],
  });
  db = await miniflare.getD1Database("DB");
  env = { DB: db } as Bindings;
  await applyMigrations(db);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await miniflare.dispose();
});

describe("model result storage", () => {
  it("stores only rows that can participate in score comparisons", async () => {
    await insertRun(db, 1, "success");

    const stored = await storeModelResults(env, 1, [
      model({ modelKey: "scoreable", rawResultJson: '{"kept":true}' }),
      model({ modelKey: "no-intel", intelligence: null, rawResultJson: '{"kept":false}' }),
      model({ modelKey: "no-cost", costPerTask: null, totalCost: null }),
    ]);

    expect(stored).toBe(1);
    const { results } = await db
      .prepare("SELECT model_key, raw_result_json FROM model_results ORDER BY model_key")
      .all<{ model_key: string; raw_result_json: string }>();
    expect(results).toEqual([{ model_key: "scoreable", raw_result_json: "{}" }]);
  });

  it("records the default winner when a run completes", async () => {
    await insertRun(db, 1, "error", 2);
    await insertRow(
      db,
      1,
      model({ modelKey: "budget", name: "Budget", intelligence: 40, costPerTask: 0.01 }),
    );
    await insertRow(
      db,
      1,
      model({ modelKey: "quality", name: "Quality", intelligence: 70, costPerTask: 1 }),
    );

    await completeFetchRun(env, 1, {
      durationMs: 10,
      httpStatus: 200,
      htmlBytes: 100,
      htmlSha256: "hash",
      htmlGzipBytes: 50,
      modelCount: 2,
      resultCount: 2,
      completedAt: "2026-01-01T00:01:00.000Z",
    });

    const run = await db
      .prepare("SELECT default_winner_model_key FROM fetch_runs WHERE id = 1")
      .first<{ default_winner_model_key: string | null }>();
    expect(run?.default_winner_model_key).toBe("quality");

    const timeline = await getDefaultWinnerTimeline(env, 10);
    expect(timeline.map((row) => [row.runId, row.modelKey])).toEqual([[1, "quality"]]);

    const queries: string[] = [];
    const trackingDb = {
      prepare(query: string) {
        queries.push(query);
        return db.prepare(query);
      },
    } as D1Database;
    const winners = await getWinnerTimeline(
      { DB: trackingDb } as Bindings,
      DEFAULT_SCORE_OPTIONS,
      10,
    );
    expect(winners.map((row) => row.modelKey)).toEqual(["quality"]);
    expect(queries).toHaveLength(1);
    expect(queries[0]).toContain("mr.model_key = fr.default_winner_model_key");
  });

  it("removes earlier batches when a later model batch fails", async () => {
    let deleteCalls = 0;
    let batchCalls = 0;
    const failingDb = {
      prepare(query: string) {
        return {
          bind(...values: unknown[]) {
            return {
              query,
              values,
              async run() {
                if (query.startsWith("DELETE FROM model_results")) deleteCalls++;
                return { meta: { changes: 0 } };
              },
            };
          },
        };
      },
      async batch() {
        batchCalls++;
        if (batchCalls === 2) throw new Error("D1_ERROR: Exceeded maximum DB size");
        return [];
      },
    } as unknown as D1Database;
    const results = Array.from({ length: 81 }, (_, index) => model({ modelKey: `model-${index}` }));

    await expect(storeModelResults({ DB: failingDb } as Bindings, 99, results)).rejects.toThrow(
      "Exceeded maximum DB size",
    );
    expect(batchCalls).toBe(2);
    expect(deleteCalls).toBe(2); // initial replacement + failure cleanup
  });
});

describe("cached history reads", () => {
  it("shares snapshots across scoring options and only reloads changed boundary batches", async () => {
    const { advance } = installReadCache();
    const statements = Array.from({ length: 105 }, (_, index) => {
      const id = index + 1;
      return [
        db
          .prepare(
            `INSERT INTO fetch_runs
           (id, source_url, status, started_at, completed_at, parser_version, default_winner_model_key)
           VALUES (?, 'test', 'success', '2026-01-01', '2026-01-01', 'test', 'quality')`,
          )
          .bind(id),
        db
          .prepare(
            `INSERT INTO model_results
           (run_id, model_key, name, cost_per_task, intelligence, raw_result_json)
           VALUES (?, 'quality', 'Quality', 1, 70, '{}'),
                  (?, 'budget', 'Budget', 0.01, 40, '{}')`,
          )
          .bind(id, id),
      ];
    }).flat();
    await db.batch(statements);

    const queries: string[] = [];
    const trackingEnv = {
      DB: {
        prepare(query: string) {
          queries.push(query);
          return db.prepare(query);
        },
      },
    } as Bindings;
    const valueOptions = { ...DEFAULT_SCORE_OPTIONS, calc: "div" as const };
    const qualityOptions = { ...DEFAULT_SCORE_OPTIONS, calc: "sub" as const, costWeight: 0 };

    const value = await getWinnerTimeline(trackingEnv, valueOptions, 100);
    expect(value).toHaveLength(100);
    expect(value.every((row) => row.modelKey === "budget")).toBe(true);
    expect(queries).toHaveLength(4); // run list + three stable id buckets

    const quality = await getWinnerTimeline(trackingEnv, qualityOptions, 100);
    expect(quality).toHaveLength(100);
    expect(quality.every((row) => row.modelKey === "quality")).toBe(true);
    expect(queries).toHaveLength(4); // different scoring, zero additional D1 reads

    await insertRun(db, 106, "success");
    await insertRow(db, 106, model({ modelKey: "new", intelligence: 80 }));
    await db
      .prepare(
        `UPDATE fetch_runs SET completed_at = '2026-01-02', default_winner_model_key = 'new' WHERE id = 106`,
      )
      .run();
    advance(61); // refresh run list; immutable snapshot data stays cached
    queries.length = 0;
    const updated = await getWinnerTimeline(trackingEnv, valueOptions, 100);
    expect(updated).toHaveLength(100);
    expect(updated.at(-1)?.modelKey).toBe("new");
    expect(updated.some((row) => row.runId === 6)).toBe(false);
    expect(queries).toHaveLength(3); // list + oldest/newest boundary, not the middle

    // Pruned runs must disappear even while their snapshot data is cached.
    await db.prepare("DELETE FROM fetch_runs WHERE id = 60").run();
    advance(61);
    const pruned = await getWinnerTimeline(trackingEnv, valueOptions, 100);
    expect(pruned.some((row) => row.runId === 60)).toBe(false);

    queries.length = 0;
    const summaries = await getModelSummaries(trackingEnv);
    expect(summaries.find((row) => row.model_key === "quality")?.samples).toBe(104);
    expect(await getModelSummaries(trackingEnv)).toEqual(summaries);
    expect(queries).toHaveLength(4); // run list + three summary buckets, then cache hit
    advance(3600);
    await getModelSummaries(trackingEnv);
    expect(queries).toHaveLength(5); // only run list; no hourly full-history scan
  });
});

describe("storage maintenance", () => {
  it("uses sparse partial indexes for legacy cleanup", async () => {
    const unscoreablePlan = await explainQueryPlan(
      db,
      `SELECT mr.id
       FROM model_results mr
       WHERE EXISTS (
         SELECT 1 FROM fetch_runs fr
         WHERE fr.id = mr.run_id AND fr.status IN ('success', 'error')
       )
         AND (COALESCE(mr.cost_per_task, mr.total_cost) IS NULL
           OR COALESCE(mr.cost_per_task, mr.total_cost) <= 0
           OR mr.intelligence IS NULL)
       ORDER BY mr.run_id ASC, mr.id ASC
       LIMIT 600`,
    );
    const rawJsonPlan = await explainQueryPlan(
      db,
      `SELECT mr.id
       FROM model_results mr
       WHERE mr.raw_result_json <> '{}'
         AND COALESCE(mr.cost_per_task, mr.total_cost) > 0
         AND mr.intelligence IS NOT NULL
       ORDER BY mr.run_id ASC, mr.id ASC
       LIMIT 600`,
    );

    expect(unscoreablePlan).toContain("model_results_unscoreable_cleanup_idx");
    expect(rawJsonPlan).toContain("model_results_raw_json_cleanup_idx");
  });

  it("deletes one complete old snapshot before row-level cleanup", async () => {
    for (let id = 1; id <= 4; id++) {
      await insertRun(db, id, "success", 1, `2026-01-0${id}T00:00:00.000Z`);
      await insertRow(
        db,
        id,
        model({ modelKey: `model-${id}`, intelligence: id === 2 ? null : 50 }),
      );
    }

    const result = await pruneStoredRunData(env, {
      keepRuns: 3,
      keepRawRuns: 3,
      keepRawResultRuns: 3,
      maxModelRowsPerPass: 10,
      maxRunsPerPass: 1,
    });

    expect(result.deletedRuns).toBe(1);
    expect(result.deletedUnscoreableResults).toBe(0);
    expect(await storedKeys(db)).toEqual([
      ["model-2", "{}"],
      ["model-3", "{}"],
      ["model-4", "{}"],
    ]);
  });

  it("uses its bounded row budget for legacy rows, partial rows, then raw JSON", async () => {
    await insertRun(db, 1, "success", 2, "2026-01-01T00:00:00.000Z");
    await insertRun(db, 2, "error", 0, "2026-01-02T00:00:00.000Z");
    await insertRun(db, 3, "success", 1, "2026-01-03T00:00:00.000Z");
    await insertRow(db, 1, model({ modelKey: "old-scoreable", rawResultJson: '{"old":1}' }));
    await insertRow(db, 1, model({ modelKey: "old-unscoreable", intelligence: null }));
    await insertRow(db, 2, model({ modelKey: "partial" }));
    await insertRow(db, 3, model({ modelKey: "new-scoreable", rawResultJson: '{"new":1}' }));

    const first = await pruneStoredRunData(env, {
      keepRuns: 3,
      keepRawRuns: 1,
      keepRawResultRuns: 1,
      maxModelRowsPerPass: 2,
    });

    expect(first.deletedUnscoreableResults).toBe(1);
    expect(first.deletedIncompleteResults).toBe(1);
    expect(first.prunedRawResultJson).toBe(0);
    expect(await storedKeys(db)).toEqual([
      ["old-scoreable", '{"old":1}'],
      ["new-scoreable", '{"new":1}'],
    ]);

    const second = await pruneStoredRunData(env, {
      keepRuns: 3,
      keepRawRuns: 1,
      keepRawResultRuns: 1,
      maxModelRowsPerPass: 1,
    });
    expect(second.prunedRawResultJson).toBe(1);
    expect(await storedKeys(db)).toEqual([
      ["old-scoreable", "{}"],
      ["new-scoreable", '{"new":1}'],
    ]);
  });

  it("does not repeatedly repair runs that failed at the D1 size limit", async () => {
    await insertRun(db, 1, "error", 0, "2026-01-01T00:00:00.000Z", "ordinary failure");
    await insertRun(
      db,
      2,
      "error",
      0,
      "2026-01-02T00:00:00.000Z",
      "Repair failed: D1_ERROR: Exceeded maximum DB size",
    );
    for (const runId of [1, 2]) {
      await db
        .prepare(
          "INSERT INTO raw_html_chunks (run_id, chunk_index, data, byte_length) VALUES (?, 0, 'x', 1)",
        )
        .bind(runId)
        .run();
      await db.prepare("UPDATE fetch_runs SET http_status = 200 WHERE id = ?").bind(runId).run();
    }

    const runs = await getRepairableRawRuns(env, 10);
    expect(runs.map((run) => run.id)).toEqual([1]);
  });
});

async function applyMigrations(database: D1Database): Promise<void> {
  for (const path of [
    "../drizzle/0000_bright_spitfire.sql",
    "../drizzle/0001_grey_jack_flag.sql",
    "../drizzle/0002_nifty_invisible_woman.sql",
    "../drizzle/0003_tan_toxin.sql",
  ]) {
    const sql = await readText(new URL(path, import.meta.url));
    for (const statement of sql.split("--> statement-breakpoint")) {
      if (statement.trim()) await database.prepare(statement).run();
    }
  }
}

async function readText(url: URL): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  return readFile(url, "utf8");
}

async function insertRun(
  database: D1Database,
  id: number,
  status: "success" | "error",
  resultCount = 0,
  startedAt = "2026-01-01T00:00:00.000Z",
  error: string | null = null,
): Promise<void> {
  await database
    .prepare(
      `INSERT INTO fetch_runs
       (id, source_url, status, started_at, parser_version, result_count, error)
       VALUES (?, 'https://example.test', ?, ?, 'test', ?, ?)`,
    )
    .bind(id, status, startedAt, resultCount, error)
    .run();
}

async function insertRow(
  database: D1Database,
  runId: number,
  result: ParsedModelResult,
): Promise<void> {
  await database
    .prepare(
      `INSERT INTO model_results
       (run_id, model_key, name, total_cost, cost_per_task, intelligence, raw_result_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      runId,
      result.modelKey,
      result.name,
      result.totalCost,
      result.costPerTask,
      result.intelligence,
      result.rawResultJson,
    )
    .run();
}

async function storedKeys(database: D1Database): Promise<[string, string][]> {
  const { results } = await database
    .prepare("SELECT model_key, raw_result_json FROM model_results ORDER BY id")
    .all<{ model_key: string; raw_result_json: string }>();
  return results.map((row) => [row.model_key, row.raw_result_json]);
}

async function explainQueryPlan(database: D1Database, query: string): Promise<string> {
  const { results } = await database
    .prepare(`EXPLAIN QUERY PLAN ${query}`)
    .all<{ detail: string }>();
  return results.map((row) => row.detail).join("\n");
}

function model(overrides: Partial<ParsedModelResult> = {}): ParsedModelResult {
  return {
    modelKey: "model",
    sourceId: null,
    slug: null,
    name: "Model",
    shortName: null,
    creatorName: null,
    creatorSlug: null,
    releaseDate: null,
    cutoffDate: null,
    totalCost: 1,
    inputCost: null,
    outputCost: null,
    reasoningCost: null,
    answerCost: null,
    costPerTask: 0.1,
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
