import path from "node:path";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { config } from "../config";
import { SERVER_ROOT } from "../paths";
import { connectionOptions } from "./client";
import { logger } from "../logger";

export function migrationsFolder(): string {
  return config().MIGRATIONS_DIR ?? path.join(SERVER_ROOT, "drizzle");
}

/**
 * Applies the SQL migrations under an advisory lock, so parallel deploys
 * wait for each other. Lock and migrations share a connection of their own,
 * outside the pool (which may have a single connection) and without its
 * statement timeout (migrations may take long).
 */
export async function runMigrations() {
  const client = new pg.Client(connectionOptions());
  client.on("error", (error) => logger.warn({ err: error }, "database client error"));
  await client.connect();
  try {
    await client.query("select pg_advisory_lock(hashtext('handbook.migrations'))");
    logger.info({ folder: migrationsFolder() }, "applying database migrations");
    await migrate(drizzle(client), { migrationsFolder: migrationsFolder() });
    logger.info("database migrations applied");
  } finally {
    // Ending the session also releases the lock.
    await client.end().catch(() => undefined);
  }
}
