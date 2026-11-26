import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { config } from "../config";
import { getDb, getPool } from "./client";
import { runMigrations } from "./migrate";

describe("database connections", () => {
  it("limit statements and idle transactions, and notice dead connections", async () => {
    const result = await getDb().execute<{ statement: string; idle: string }>(
      sql`select current_setting('statement_timeout') as statement,
        current_setting('idle_in_transaction_session_timeout') as idle`,
    );
    expect(result.rows[0]).toEqual({ statement: "1min", idle: "1min" });
    expect(getPool().options).toMatchObject({ keepAlive: true, connectionTimeoutMillis: 10_000 });
  });

  it("apply migrations while every connection of the pool is busy", async () => {
    const busy = await Promise.all(
      Array.from({ length: config().DATABASE_POOL_SIZE }, () => getPool().connect()),
    );
    try {
      const waited = new Promise((resolve) => setTimeout(() => resolve("still waiting"), 5_000));
      await expect(Promise.race([runMigrations().then(() => "applied"), waited])).resolves.toBe("applied");
    } finally {
      for (const client of busy) client.release();
    }
  });
});
