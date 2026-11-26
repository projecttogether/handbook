import { eq, sql } from "drizzle-orm";
import type { DbOrTx } from "../db/client";
import { settings } from "../db/schema";

/** App state by key, e.g. `search` (the languages the search index was built with). */
export async function getSetting(db: DbOrTx, key: string): Promise<Record<string, unknown> | undefined> {
  const [row] = await db.select().from(settings).where(eq(settings.key, key));
  return row?.value;
}

export async function putSetting(db: DbOrTx, key: string, value: Record<string, unknown>) {
  await db
    .insert(settings)
    .values({ key, value })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: sql`now()` } });
}
