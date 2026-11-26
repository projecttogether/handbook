import { writeFile } from "node:fs/promises";
import { config } from "../config";
import { getDb } from "../db/client";
import { logger } from "../logger";
import { monitored } from "../error-reporting";
import { reindexIfLanguagesChanged } from "../search/reindex";
import { pruneExpired } from "./prune";

export type Stop = () => Promise<void>;

/** A repeating job; `hung` tells whether its current run takes far longer than it ever should. */
export type Scheduled = { name: string; stop: Stop; hung: () => boolean };

/**
 * Repeats a job every `minutes`, first after `firstDelayMs`; errors are
 * logged, never thrown. A run longer than `maxRunMinutes` counts as hung.
 */
export function every(
  schedule: { name: string; minutes: number; firstDelayMs: number; maxRunMinutes: number },
  job: () => Promise<unknown>,
): Scheduled {
  const { name } = schedule;
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<unknown> | undefined;
  let startedAt: number | undefined;
  let stopped = false;
  const run = () => {
    startedAt = Date.now();
    running = job()
      .catch((error: unknown) => logger.error({ err: error, task: name }, "scheduled job failed"))
      .finally(() => {
        running = undefined;
        startedAt = undefined;
        if (!stopped) timer = setTimeout(run, schedule.minutes * 60_000);
      });
  };
  timer = setTimeout(run, schedule.firstDelayMs);
  return {
    name,
    stop: async () => {
      stopped = true;
      clearTimeout(timer);
      await running;
    },
    hung: () => startedAt !== undefined && Date.now() - startedAt > schedule.maxRunMinutes * 60_000,
  };
}

/**
 * Calls `touch` every 5 seconds while no job hangs, so a health check of the
 * heartbeat file notices a worker whose event loop or jobs are stuck.
 */
export function startHeartbeat(jobs: Scheduled[], touch: () => unknown): () => void {
  let reported = false;
  const beat = () => {
    const hung = jobs.find((job) => job.hung());
    if (hung) {
      if (!reported) logger.error({ task: hung.name }, "scheduled job hangs; heartbeat stopped");
      reported = true;
      return;
    }
    reported = false;
    touch();
  };
  beat();
  const interval = setInterval(beat, 5_000);
  return () => clearInterval(interval);
}

/**
 * The worker: rebuilds the search index when SEARCH_LANGUAGES changed, and
 * removes what expired (edit locks, sign-in requests and tokens of
 * connected apps, unused uploads).
 */
export function startWorker(): Stop {
  const jobs = [
    every({ name: "search-languages", minutes: 24 * 60, firstDelayMs: 1_000, maxRunMinutes: 4 * 60 }, () =>
      reindexIfLanguagesChanged(getDb()),
    ),
    every({ name: "prune", minutes: 60, firstDelayMs: 60_000, maxRunMinutes: 30 }, () =>
      monitored("handbook-prune", { minutes: 60 }, () => pruneExpired(getDb())),
    ),
  ];
  const heartbeat = config().WORKER_HEARTBEAT_FILE;
  const stopHeartbeat = heartbeat
    ? startHeartbeat(jobs, () => void writeFile(heartbeat, "").catch(() => undefined))
    : undefined;
  logger.info("worker started");
  return async () => {
    stopHeartbeat?.();
    await Promise.all(jobs.map((job) => job.stop()));
  };
}
