import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import type { ParsedModelResult } from "../src/lib/aa";
import { getRepairableRawRuns, pruneStoredRunData, storeModelResults } from "../src/lib/db";
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

describe("storage maintenance", () => {
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
