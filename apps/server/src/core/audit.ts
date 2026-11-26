import { lt, sql } from "drizzle-orm";
import { config } from "../config";
import type { DbOrTx } from "../db/client";
import { auditLog } from "../db/schema";
import { isOperator, type Actor } from "../auth/principal";

/**
 * Records a change by an admin or owner, or by the operator command: that
 * shows as the actor `operator`, its command after the summary. `summary`
 * must never contain secrets.
 */
export async function audit(
  db: DbOrTx,
  actor: Actor | null,
  entry: { action: string; entityType: string; entityId?: string | null; summary: string },
) {
  const by = isOperator(actor)
    ? { actorUserId: null, actorEmail: "operator", summary: `${entry.summary} (${actor.command})` }
    : { actorUserId: actor?.id ?? null, actorEmail: actor?.email ?? null, summary: entry.summary };
  await db.insert(auditLog).values({
    ...by,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId ?? null,
    summary: by.summary.slice(0, 500),
  });
}

/** Deletes entries older than AUDIT_LOG_DAYS (the worker's cleanup); 0 keeps them all. */
export async function pruneAuditLog(db: DbOrTx, days = config().AUDIT_LOG_DAYS): Promise<number> {
  if (days === 0) return 0;
  const result = await db
    .delete(auditLog)
    .where(lt(auditLog.createdAt, sql`now() - make_interval(days => ${days})`));
  return result.rowCount ?? 0;
}
