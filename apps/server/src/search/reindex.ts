import { and, eq, isNull } from "drizzle-orm";
import { config } from "../config";
import type { Db } from "../db/client";
import { pages, spaces } from "../db/schema";
import { getSetting, putSetting } from "../core/settings";
import { logger } from "../logger";
import { reindexPage } from "../pages/core";

/**
 * Rebuilds the search index when SEARCH_LANGUAGES changed since it was
 * built. Runs at the start of the worker; cheap when nothing changed.
 */
export async function reindexIfLanguagesChanged(db: Db) {
  const wanted = config().searchConfigs.join(",");
  const stored = await getSetting(db, "search");
  if (stored?.languages === wanted) return;
  for (const space of await db.select().from(spaces)) {
    const rows = await db
      .select({ id: pages.id })
      .from(pages)
      .where(and(eq(pages.spaceId, space.id), isNull(pages.deletedAt)));
    // One short transaction per page: a save waits for one page at most.
    for (const row of rows) await db.transaction((tx) => reindexPage(tx, space, row.id));
  }
  await putSetting(db, "search", { languages: wanted });
  if (stored) logger.info({ languages: wanted }, "search index rebuilt for new languages");
}
