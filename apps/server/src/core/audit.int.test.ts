import { beforeEach, describe, expect, it } from "vitest";
import { asc, sql } from "drizzle-orm";
import { getDb } from "../db/client";
import { auditLog } from "../db/schema";
import { resetDatabase } from "../test/helpers";
import { pruneExpired } from "../worker/prune";
import { pruneAuditLog } from "./audit";

async function entry(summary: string, daysAgo: number) {
  await getDb()
    .insert(auditLog)
    .values({
      action: "space.created",
      entityType: "space",
      summary,
      createdAt: sql`now() - make_interval(days => ${daysAgo})`,
    });
}

const summaries = async () =>
  (await getDb().select().from(auditLog).orderBy(asc(auditLog.summary))).map((row) => row.summary);

describe("audit log retention", () => {
  beforeEach(resetDatabase);

  it("deletes entries older than AUDIT_LOG_DAYS in the worker's cleanup (default 365)", async () => {
    await entry("last week", 7);
    await entry("almost a year ago", 364);
    await entry("more than a year ago", 366);
    await pruneExpired(getDb());
    expect(await summaries()).toEqual(["almost a year ago", "last week"]);

    expect(await pruneAuditLog(getDb(), 30)).toBe(1);
    expect(await summaries()).toEqual(["last week"]);
  });

  it("keeps everything with 0", async () => {
    await entry("ten years ago", 3650);
    expect(await pruneAuditLog(getDb(), 0)).toBe(0);
    expect(await summaries()).toEqual(["ten years ago"]);
  });
});
