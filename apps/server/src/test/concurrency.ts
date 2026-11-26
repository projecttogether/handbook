import { sql } from "drizzle-orm";
import { getDb, type Tx } from "../db/client";

/**
 * Two transactions in a fixed order, for race tests: one holds its locks
 * open while another runs into them.
 */

/**
 * Runs `work` in a transaction and keeps it open (with its locks) until
 * `commit()`. `ready` resolves once `work` finished, or rejects when it failed.
 */
export function heldTransaction<T>(work: (tx: Tx) => Promise<T>) {
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reached = () => {};
  const inside = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const result = getDb().transaction(async (tx) => {
    const value = await work(tx);
    reached();
    await gate;
    return value;
  });
  return {
    ready: Promise.race([inside, result.then(() => undefined)]),
    commit: () => {
      release();
      return result;
    },
  };
}

/**
 * Waits until `work` waits for a row lock of another transaction, or has
 * finished (when nothing stopped it). Gives up after about five seconds.
 */
export async function blockedOrDone(work: Promise<unknown>) {
  let done = false;
  work.then(
    () => (done = true),
    () => (done = true),
  );
  for (let attempt = 0; attempt < 500 && !done; attempt += 1) {
    const result = await getDb().execute<{ waiting: number }>(
      sql`select count(*)::int as waiting from pg_stat_activity
        where datname = current_database() and wait_event_type = 'Lock'`,
    );
    if (Number(result.rows[0]?.waiting ?? 0) > 0) return "blocked";
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return done ? "done" : "timeout";
}

/** Settles a promise to its value or error, so a test can check either without unhandled rejections. */
export function settle<T>(work: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  return work.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
}
