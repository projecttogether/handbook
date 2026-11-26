import { lockLostSchema, type LockHolder } from "@handbook/shared/api/pages";

/**
 * The edit lock of the live editor (docs/architecture.md, "Edit locks and
 * drafts") as a state machine:
 *
 *   acquiring → held (renewing) → released
 *       ↓          ↓ 409 lock_lost
 *     locked     lost (someone else has it now)
 *   (someone else; editors may take over → held)
 *
 * A lock that ended without anybody taking it (a long pause, a sleeping
 * laptop) is `expired`: the editor keeps its token and takes the lock again
 * when the person types (→ held), unless someone else has it by then (→ lost).
 */
export type LockState =
  | { status: "acquiring" }
  | { status: "held"; token: string; renewSeconds: number }
  | { status: "expired"; token: string; renewSeconds: number }
  | { status: "locked"; holder: LockHolder }
  | { status: "lost"; by: string | null }
  | { status: "released" }
  | { status: "failed"; message: string };

export type LockEvent =
  | { type: "acquired"; token: string; renewSeconds: number }
  | { type: "locked"; holder: LockHolder }
  | { type: "expired" }
  | { type: "reclaimed" }
  | { type: "lost"; by: string | null }
  | { type: "released" }
  | { type: "failed"; message: string }
  | { type: "retry" };

export function lockReducer(state: LockState, event: LockEvent): LockState {
  switch (event.type) {
    case "acquired":
      return { status: "held", token: event.token, renewSeconds: event.renewSeconds };
    case "locked":
      return { status: "locked", holder: event.holder };
    case "expired":
      return state.status === "held" ? { ...state, status: "expired" } : state;
    case "reclaimed":
      return state.status === "expired" ? { ...state, status: "held" } : state;
    case "lost":
      // Only a held or expired lock can be lost; a released one stays released.
      return state.status === "held" || state.status === "expired" ? { status: "lost", by: event.by } : state;
    case "released":
      return { status: "released" };
    case "failed":
      return state.status === "held" ? state : { status: "failed", message: event.message };
    case "retry":
      return { status: "acquiring" };
  }
}

/** The holder of a 423 `page_locked` answer. */
export function readLockHolder(body: unknown): LockHolder | null {
  const lock = (body as { lock?: unknown } | null)?.lock as LockHolder | undefined;
  return lock && typeof lock === "object" && typeof lock.since === "string" && lock.user ? lock : null;
}

/**
 * What a 409 `lock_lost` answer (`lockLostSchema`) says: who has the lock
 * now, or `expired` when it ended without anybody taking it.
 */
export function readLost(body: unknown): { by: string } | "expired" | null {
  const parsed = lockLostSchema.safeParse(body);
  if (!parsed.success) return null;
  return parsed.data.takenOverBy ? { by: parsed.data.takenOverBy.name } : "expired";
}

/**
 * The token of a held or expired lock, for saving (an expired one may have
 * been taken again a moment ago); null otherwise.
 */
export function lockToken(state: LockState): string | null {
  return state.status === "held" || state.status === "expired" ? state.token : null;
}
