/**
 * Historic "#1 winner" timeline: the top-ranked model of every successful
 * snapshot under the caller's scoring options.
 */

import type { TimelineResult } from "./db";
import { getSuccessfulTimelineRuns, getTimelineResultsForRuns } from "./db";
import type { ScoreOptions, ScoredRow } from "./scoring";
import { compareByRunTime, scoreRows } from "./scoring";
import type { Bindings } from "../types";

/** Runs scored per D1 round-trip; keeps result sets within D1's limits. */
const RUN_BATCH_SIZE = 50;

export async function getWinnerTimeline(
  env: Bindings,
  options: ScoreOptions,
  runLimit: number,
): Promise<Array<ScoredRow<TimelineResult>>> {
  const runs = await getSuccessfulTimelineRuns(env, runLimit);
  const winners: Array<ScoredRow<TimelineResult>> = [];

  for (let i = 0; i < runs.length; i += RUN_BATCH_SIZE) {
    const runIds = runs.slice(i, i + RUN_BATCH_SIZE).map((run) => run.id);
    const results = await getTimelineResultsForRuns(env, runIds);
    winners.push(...winnerPerRun(results, options));
  }

  return winners.sort(compareByRunTime);
}

function winnerPerRun(
  results: TimelineResult[],
  options: ScoreOptions,
): Array<ScoredRow<TimelineResult>> {
  const byRun = new Map<number, TimelineResult[]>();
  for (const result of results) {
    const bucket = byRun.get(result.runId);
    if (bucket) {
      bucket.push(result);
    } else {
      byRun.set(result.runId, [result]);
    }
  }

  const winners: Array<ScoredRow<TimelineResult>> = [];
  for (const runResults of byRun.values()) {
    const winner = scoreRows(runResults, options).rows[0];
    if (winner) winners.push(winner);
  }

  return winners;
}
