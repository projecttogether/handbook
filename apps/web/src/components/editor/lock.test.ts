import { describe, expect, it } from "vitest";
import { lockReducer, lockToken, readLockHolder, readLost, type LockState } from "./lock";

const holder = {
  user: { id: null, name: "Kim", email: null },
  since: "2026-11-17T10:42:00.000Z",
  mine: false,
};

describe("edit lock", () => {
  it("moves from acquiring to held, lost and released", () => {
    let state: LockState = { status: "acquiring" };
    state = lockReducer(state, { type: "acquired", token: "t1", renewSeconds: 30 });
    expect(lockToken(state)).toBe("t1");
    state = lockReducer(state, { type: "lost", by: "Kim" });
    expect(state).toEqual({ status: "lost", by: "Kim" });
    expect(lockToken(state)).toBeNull();
    // A late failure does not hide that the lock was lost.
    expect(lockReducer(state, { type: "lost", by: "Lee" })).toEqual(state);
  });

  it("shows someone else's lock and allows a takeover", () => {
    let state = lockReducer({ status: "acquiring" }, { type: "locked", holder });
    expect(state).toEqual({ status: "locked", holder });
    state = lockReducer(state, { type: "acquired", token: "t2", renewSeconds: 30 });
    expect(state.status).toBe("held");
  });

  it("does not lose a released lock and keeps a held lock on failed renewals", () => {
    expect(lockReducer({ status: "released" }, { type: "lost", by: null })).toEqual({ status: "released" });
    const held: LockState = { status: "held", token: "t", renewSeconds: 30 };
    expect(lockReducer(held, { type: "failed", message: "offline" })).toBe(held);
  });

  it("reads holders and who took over", () => {
    expect(readLockHolder({ error: { code: "page_locked" }, lock: holder })).toEqual(holder);
    expect(readLockHolder({})).toBeNull();
    const lost = (takenOverBy: unknown) => ({
      error: { code: "lock_lost", message: "Kim is editing this page now." },
      takenOverBy,
    });
    expect(readLost(lost({ id: null, name: "Kim", email: null }))).toEqual({ by: "Kim" });
    expect(readLost(lost(null))).toBe("expired");
    expect(readLost({ by: "Max" })).toBeNull();
    expect(readLost(null)).toBeNull();
  });

  it("keeps an expired lock's token to take it again", () => {
    const held: LockState = { status: "held", token: "t", renewSeconds: 30 };
    const expired = lockReducer(held, { type: "expired" });
    expect(expired).toEqual({ status: "expired", token: "t", renewSeconds: 30 });
    expect(lockReducer(expired, { type: "reclaimed" })).toEqual(held);
    // Saving sends it: the lock may have been taken again a moment ago.
    expect(lockToken(expired)).toBe("t");
    expect(lockReducer(expired, { type: "lost", by: "Kim" })).toEqual({ status: "lost", by: "Kim" });
    // Only a held lock expires, and only an expired one is taken again.
    expect(lockReducer({ status: "released" }, { type: "expired" })).toEqual({ status: "released" });
    expect(lockReducer(held, { type: "reclaimed" })).toBe(held);
  });
});
