import { sql } from "drizzle-orm";
import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const fetchRuns = sqliteTable(
  "fetch_runs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    sourceUrl: text("source_url").notNull(),
    status: text("status", { enum: ["running", "success", "error", "skipped"] })
      .notNull()
      .default("running"),
    startedAt: text("started_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
    completedAt: text("completed_at"),
    durationMs: integer("duration_ms"),
    httpStatus: integer("http_status"),
    htmlBytes: integer("html_bytes"),
    htmlSha256: text("html_sha256"),
    htmlGzipBytes: integer("html_gzip_bytes"),
    rawHtmlEncoding: text("raw_html_encoding").notNull().default("gzip-base64-chunks"),
    parserVersion: text("parser_version").notNull(),
    modelCount: integer("model_count").notNull().default(0),
    resultCount: integer("result_count").notNull().default(0),
    error: text("error"),
  },
  (table) => ({
    statusCompletedIdx: index("fetch_runs_status_completed_idx").on(
      table.status,
      table.completedAt,
    ),
    startedIdx: index("fetch_runs_started_idx").on(table.startedAt),
  }),
);

export const rawHtmlChunks = sqliteTable(
  "raw_html_chunks",
  {
    runId: integer("run_id")
      .notNull()
      .references(() => fetchRuns.id, { onDelete: "cascade" }),
    chunkIndex: integer("chunk_index").notNull(),
    data: text("data").notNull(),
    byteLength: integer("byte_length").notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.runId, table.chunkIndex] }),
  }),
);

export const modelResults = sqliteTable(
  "model_results",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    runId: integer("run_id")
      .notNull()
      .references(() => fetchRuns.id, { onDelete: "cascade" }),
    modelKey: text("model_key").notNull(),
    sourceId: text("source_id"),
    slug: text("slug"),
    name: text("name").notNull(),
    shortName: text("short_name"),
    creatorName: text("creator_name"),
    creatorSlug: text("creator_slug"),
    releaseDate: text("release_date"),
    knowledgeCutoffDate: text("knowledge_cutoff_date"),
    totalCost: real("total_cost"),
    inputCost: real("input_cost"),
    outputCost: real("output_cost"),
    reasoningCost: real("reasoning_cost"),
    answerCost: real("answer_cost"),
    costPerTask: real("cost_per_task"),
    inputCostPerTask: real("input_cost_per_task"),
    outputCostPerTask: real("output_cost_per_task"),
    reasoningCostPerTask: real("reasoning_cost_per_task"),
    answerCostPerTask: real("answer_cost_per_task"),
    timePerTask: real("time_per_task"),
    intelligence: real("intelligence"),
    agentic: real("agentic"),
    mmmu: real("mmmu"),
    priceInput1m: real("price_input_1m"),
    priceOutput1m: real("price_output_1m"),
    activeParams: real("active_params"),
    isOpenWeights: integer("is_open_weights", { mode: "boolean" }),
    isReasoning: integer("is_reasoning", { mode: "boolean" }),
    rawResultJson: text("raw_result_json").notNull(),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
  },
  (table) => ({
    runModelUnique: uniqueIndex("model_results_run_model_unique").on(table.runId, table.modelKey),
    runIdx: index("model_results_run_idx").on(table.runId),
    modelIdx: index("model_results_model_idx").on(table.modelKey),
    nameIdx: index("model_results_name_idx").on(table.name),
  }),
);
