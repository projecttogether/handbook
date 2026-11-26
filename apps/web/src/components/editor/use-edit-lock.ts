import { useCallback, useEffect, useReducer, useRef } from "react";
import type { LockResponse } from "@handbook/shared/api/pages";
import { LOCK_RENEW_SECONDS } from "@handbook/shared/limits";
import { errorMessage } from "@/lib/api";
import { apiErrorOf, rawRequest } from "./raw-api";
import { lockReducer, readLockHolder, readLost, type LockEvent, type LockState } from "./lock";

/** The lock event of a refused renewal: someone else has the lock, or it ended. */
function refusedRenewal(status: number, body: unknown): LockEvent | null {
  if (status === 409) {
    const lost = readLost(body);
    if (lost === "expired") return { type: "expired" };
    return { type: "lost", by: lost?.by ?? null };
  }
  if (status === 423) return { type: "lost", by: readLockHolder(body)?.user.name ?? null };
  if (status === 404) return { type: "lost", by: null };
  return null;
}

/**
 * Takes and keeps the edit lock of a page while the live editor is open:
 * renews it every LOCK_RENEW_SECONDS (saying whether the person typed since
 * the last renewal), notices when someone took it over, takes it again on
 * the next keystroke when it ended after a pause, and releases it on
 * unmount (best effort, also while the page closes).
 */
export function useEditLock(pageId: string, enabled: boolean) {
  const [state, dispatch] = useReducer(lockReducer, { status: "acquiring" } as LockState);
  const typed = useRef(false);
  const reclaiming = useRef(false);
  // Only the latest acquisition counts (React may mount the editor twice in development).
  const attempt = useRef(0);
  const stateRef = useRef(state);
  stateRef.current = state;

  const acquire = useCallback(
    async (takeover: boolean) => {
      const current = ++attempt.current;
      try {
        const response = await rawRequest("POST", `/pages/${pageId}/lock${takeover ? "/takeover" : ""}`);
        if (current !== attempt.current) return;
        if (response.ok) {
          const lock = response.body as LockResponse;
          dispatch({
            type: "acquired",
            token: lock.token,
            renewSeconds: lock.renewSeconds || LOCK_RENEW_SECONDS,
          });
          return;
        }
        const holder = response.status === 423 ? readLockHolder(response.body) : null;
        if (holder) dispatch({ type: "locked", holder });
        else dispatch({ type: "failed", message: apiErrorOf(response).message });
      } catch (error) {
        if (current === attempt.current) dispatch({ type: "failed", message: errorMessage(error) });
      }
    },
    [pageId],
  );

  useEffect(() => {
    if (!enabled) return;
    // A tick later: a mount that React undoes at once (development) never asks.
    const timer = window.setTimeout(() => void acquire(false), 0);
    return () => window.clearTimeout(timer);
  }, [acquire, enabled]);

  const held = state.status === "held";
  const token = state.status === "held" ? state.token : null;
  const renewSeconds = state.status === "held" ? state.renewSeconds : LOCK_RENEW_SECONDS;

  useEffect(() => {
    if (!held || !token) return;
    const timer = window.setInterval(() => {
      const active = typed.current;
      typed.current = false;
      void rawRequest("POST", `/pages/${pageId}/lock/renew`, { body: { token, active } })
        .then((response) => {
          if (response.ok) return;
          const event = refusedRenewal(response.status, response.body);
          if (event) dispatch(event);
        })
        .catch(() => undefined);
    }, renewSeconds * 1000);
    return () => window.clearInterval(timer);
  }, [held, token, renewSeconds, pageId]);

  const releaseToken = useCallback(
    (token: string) =>
      void rawRequest("DELETE", `/pages/${pageId}/lock?token=${encodeURIComponent(token)}`, {
        keepalive: true,
      }).catch(() => undefined),
    [pageId],
  );

  const release = useCallback(() => {
    attempt.current += 1;
    const current = stateRef.current;
    if (current.status !== "held" && current.status !== "expired") return;
    dispatch({ type: "released" });
    releaseToken(current.token);
  }, [releaseToken]);

  // Release when the editor closes: unmount, or the browser tab goes away.
  useEffect(() => {
    if (!enabled) return;
    window.addEventListener("pagehide", release);
    return () => {
      window.removeEventListener("pagehide", release);
      release();
    };
  }, [enabled, release]);

  /** Takes an expired lock again: the server grants it to its token when the person typed. */
  const reclaim = useCallback(() => {
    const current = stateRef.current;
    if (current.status !== "expired" || reclaiming.current) return;
    reclaiming.current = true;
    const started = attempt.current;
    void rawRequest("POST", `/pages/${pageId}/lock/renew`, { body: { token: current.token, active: true } })
      .then((response) => {
        if (attempt.current !== started) {
          // Saved or closed meanwhile: give back the lock the server just granted.
          if (response.ok) releaseToken(current.token);
          return;
        }
        if (response.ok) return dispatch({ type: "reclaimed" });
        const event = refusedRenewal(response.status, response.body);
        if (event && event.type !== "expired") dispatch(event);
      })
      .catch(() => undefined)
      .finally(() => {
        reclaiming.current = false;
      });
  }, [pageId, releaseToken]);

  return {
    state,
    /** Call on every keystroke: the next renewal tells the server the person is active. */
    markActivity: useCallback(() => {
      typed.current = true;
      reclaim();
    }, [reclaim]),
    takeOver: useCallback(() => acquire(true), [acquire]),
    retry: useCallback(() => {
      dispatch({ type: "retry" });
      void acquire(false);
    }, [acquire]),
    release,
    /** A save found someone else's lock (423): they have the page now. */
    lostTo: useCallback((by: string | null) => dispatch({ type: "lost", by }), []),
    /** After a successful save, the server released the lock. */
    forget: useCallback(() => {
      attempt.current += 1;
      dispatch({ type: "released" });
    }, []),
  };
}
