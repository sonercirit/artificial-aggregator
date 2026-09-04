/**
 * Historic "#1 winner" timeline: the top-ranked model of every successful
 * snapshot under the caller's scoring options.
 */

import type { TimelineResult } from "./db";
import {
  batchRunIds,
  getDefaultWinnerTimeline,
  getSuccessfulTimelineRuns,
  getTimelineResultsForRuns,
} from "./db";
import type { ScoreOptions, ScoredRow } from "./scoring";
import { compareByRunTime, scoreRows } from "./scoring";
import type { Bindings } from "../types";

export async function getWinnerTimeline(
  env: Bindings,
  options: ScoreOptions,
  runLimit: number,
): Promise<Array<ScoredRow<TimelineResult>>> {
  if (usesPrecomputedDefaultWinner(options)) {
    const results = await getDefaultWinnerTimeline(env, runLimit);
    return winnerPerRun(results, options).sort(compareByRunTime);
  }

  const runs = await getSuccessfulTimelineRuns(env, runLimit);
  const winners: Array<ScoredRow<TimelineResult>> = [];

  for (const runIds of batchRunIds(runs.map((run) => run.id))) {
    const results = await getTimelineResultsForRuns(env, runIds);
    winners.push(...winnerPerRun(results, options));
  }

  return winners.sort(compareByRunTime);
}

/** The persisted key is specifically the winner for the site's default view. */
function usesPrecomputedDefaultWinner(options: ScoreOptions): boolean {
  return (
    options.mode === "intelligence" &&
    options.calc === "raw" &&
    options.sort === "score" &&
    !options.frontierOnly
  );
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
