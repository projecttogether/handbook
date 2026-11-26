import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { LockResponse } from "@handbook/shared/api/pages";
import { LOCK_EXPIRE_SECONDS, LOCK_IDLE_SECONDS, LOCK_RENEW_SECONDS } from "@handbook/shared/limits";
import type { DbOrTx } from "../db/client";
import { editLocks, users } from "../db/schema";
import { AppError } from "../http/errors";
import { actorOf, currentLock, iso, lockExpired } from "./views";

/**
 * Edit locks of the web editor (docs/architecture.md, "Edit locks and
 * drafts"). One row per page; the token identifies one open editor.
 */

type LockRow = typeof editLocks.$inferSelect;

export function lockResponse(token: string): LockResponse {
  return {
    token,
    renewSeconds: LOCK_RENEW_SECONDS,
    expireSeconds: LOCK_EXPIRE_SECONDS,
    idleSeconds: LOCK_IDLE_SECONDS,
  };
}

async function lockRow(tx: DbOrTx, pageId: string): Promise<LockRow | null> {
  const [row] = await tx.select().from(editLocks).where(eq(editLocks.pageId, pageId)).for("update");
  return row ?? null;
}

async function userActor(tx: DbOrTx, userId: string | null) {
  if (!userId) return null;
  const [user] = await tx
    .select({ id: users.id, name: users.name, email: users.email })
    .from(users)
    .where(eq(users.id, userId));
  return actorOf(user);
}

/** 423 `page_locked` with the holder. */
async function lockedError(tx: DbOrTx, pageId: string, viewerId: string): Promise<AppError> {
  const lock = await currentLock(tx, pageId, viewerId);
  const name = lock?.user.name ?? "Someone";
  return new AppError(423, "page_locked", `${name} is editing this page`, undefined, { lock });
}

async function writeLock(
  tx: DbOrTx,
  pageId: string,
  userId: string,
  token: string,
  previous: LockRow | null,
  takeover: boolean,
) {
  const values = {
    pageId,
    userId,
    token,
    acquiredAt: new Date(),
    renewedAt: new Date(),
    activityAt: new Date(),
    takenOverFromUserId: takeover && previous ? previous.userId : null,
    takenOverToken: takeover && previous ? previous.token : null,
  };
  await tx.insert(editLocks).values(values).onConflictDoUpdate({ target: editLocks.pageId, set: values });
}

/**
 * Takes the page's lock for the editor. Someone else's valid lock: 423. The
 * same person's lock (another tab) moves to this editor.
 */
export async function acquireLock(tx: DbOrTx, pageId: string, userId: string): Promise<LockResponse> {
  const existing = await lockRow(tx, pageId);
  if (existing && !lockExpired(existing) && existing.userId !== userId)
    throw await lockedError(tx, pageId, userId);
  const token = randomUUID();
  await writeLock(tx, pageId, userId, token, existing, existing !== null && !lockExpired(existing));
  return lockResponse(token);
}

/** An editor (or admin) takes the lock from whoever holds it. */
export async function takeOverLock(tx: DbOrTx, pageId: string, userId: string): Promise<LockResponse> {
  const existing = await lockRow(tx, pageId);
  const token = randomUUID();
  await writeLock(tx, pageId, userId, token, existing, existing !== null);
  return lockResponse(token);
}

/**
 * Keeps a lock alive. A lock that ended without anybody taking it is taken
 * again when the person typed (`active`); otherwise, and when someone else
 * holds it now, 409 `lock_lost` with who took it.
 */
export async function renewLock(
  tx: DbOrTx,
  pageId: string,
  userId: string,
  input: { token: string; active: boolean },
): Promise<{ ok: true; expiresAt: string }> {
  const existing = await lockRow(tx, pageId);
  const expired = existing ? lockExpired(existing) : true;
  if (existing && existing.token === input.token && !expired) {
    await tx
      .update(editLocks)
      .set({ renewedAt: sql`now()`, ...(input.active ? { activityAt: sql`now()` } : {}) })
      .where(eq(editLocks.pageId, pageId));
    return { ok: true, expiresAt: iso(new Date(Date.now() + LOCK_EXPIRE_SECONDS * 1000)) };
  }
  if ((!existing || expired) && input.active) {
    await writeLock(tx, pageId, userId, input.token, existing, false);
    return { ok: true, expiresAt: iso(new Date(Date.now() + LOCK_EXPIRE_SECONDS * 1000)) };
  }
  const takenOverBy = existing && !expired ? await userActor(tx, existing.userId) : null;
  throw new AppError(
    409,
    "lock_lost",
    takenOverBy
      ? `${takenOverBy.name} is editing this page now. Your text is kept as a draft.`
      : "Your edit lock ended. Your text is kept as a draft.",
    undefined,
    { takenOverBy },
  );
}

export async function releaseLock(tx: DbOrTx, pageId: string, token: string) {
  await tx.delete(editLocks).where(and(eq(editLocks.pageId, pageId), eq(editLocks.token, token)));
}

/**
 * Before a live save from the web: someone else's valid lock (another
 * person, or another tab without this token) refuses the save with 423.
 * Returns true when this editor holds the lock (to release it after saving).
 */
export async function checkLockForSave(
  tx: DbOrTx,
  pageId: string,
  userId: string,
  token: string | undefined,
): Promise<boolean> {
  const existing = await lockRow(tx, pageId);
  if (!existing || lockExpired(existing)) return false;
  if (token && existing.token === token) return true;
  throw await lockedError(tx, pageId, userId);
}
