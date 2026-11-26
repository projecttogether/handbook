import { lt, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { editLocks, oauthRequests } from "../db/schema";
import { pruneExpiredCredentials } from "../auth/credentials";
import { pruneUnusedUploads } from "../files/storage";
import { pruneUnusedClients } from "../oauth/clients";
import { pruneAuditLog } from "../core/audit";
import { LOCK_EXPIRE_SECONDS, LOCK_IDLE_SECONDS } from "@handbook/shared/limits";

/**
 * Removes expired edit locks, sign-in requests and tokens, unused OAuth
 * clients, unused uploads and old audit log entries.
 */
export async function pruneExpired(db: Db) {
  await db
    .delete(editLocks)
    .where(
      sql`${editLocks.renewedAt} < now() - make_interval(secs => ${LOCK_EXPIRE_SECONDS}) or ${editLocks.activityAt} < now() - make_interval(secs => ${LOCK_IDLE_SECONDS})`,
    );
  await db.delete(oauthRequests).where(lt(oauthRequests.expiresAt, sql`now() - interval '1 day'`));
  await pruneUnusedClients(db);
  await pruneExpiredCredentials(db);
  await pruneUnusedUploads(db);
  await pruneAuditLog(db);
}
