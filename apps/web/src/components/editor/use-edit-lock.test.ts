import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useEditLock } from "./use-edit-lock";

const PAGE = "0b5a3e5e-3c1f-4d8e-9f3a-111111111111";
const lockLost = (takenOverBy: unknown) => ({
  status: 409,
  body: { error: { code: "lock_lost", message: "Your edit lock ended." }, takenOverBy },
});

type Reply = { status: number; body: unknown };

/** Answers lock requests in order from `replies[path]`; records the bodies sent. */
function serve(replies: Record<string, Reply[]>) {
  const sent: { path: string; body: unknown }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const path = url.replace("/api/v1", "").split("?")[0]!;
      sent.push({ path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const reply = replies[path]?.shift() ?? { status: 200, body: { ok: true } };
      return new Response(JSON.stringify(reply.body), { status: reply.status });
    }),
  );
  return sent;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("useEditLock", () => {
  it("takes the lock again when the person types after it ended", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const sent = serve({
      [`/pages/${PAGE}/lock`]: [
        { status: 200, body: { token: "t1", renewSeconds: 30, expireSeconds: 120, idleSeconds: 1800 } },
      ],
      // The laptop slept: the first renewal finds the lock ended, nobody took it.
      [`/pages/${PAGE}/lock/renew`]: [lockLost(null), { status: 200, body: { ok: true } }],
    });
    const { result } = renderHook(() => useEditLock(PAGE, true));
    await waitFor(() => expect(result.current.state.status).toBe("held"));

    await act(() => vi.advanceTimersByTimeAsync(30_000));
    await waitFor(() => expect(result.current.state.status).toBe("expired"));

    act(() => result.current.markActivity());
    await waitFor(() =>
      expect(result.current.state).toEqual({ status: "held", token: "t1", renewSeconds: 30 }),
    );
    expect(sent.at(-1)).toEqual({ path: `/pages/${PAGE}/lock/renew`, body: { token: "t1", active: true } });
  });

  it("says who has the lock when someone else took it during the pause", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    serve({
      [`/pages/${PAGE}/lock`]: [
        { status: 200, body: { token: "t1", renewSeconds: 30, expireSeconds: 120, idleSeconds: 1800 } },
      ],
      [`/pages/${PAGE}/lock/renew`]: [lockLost(null), lockLost({ id: null, name: "Kim", email: null })],
    });
    const { result } = renderHook(() => useEditLock(PAGE, true));
    await waitFor(() => expect(result.current.state.status).toBe("held"));
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    await waitFor(() => expect(result.current.state.status).toBe("expired"));

    act(() => result.current.markActivity());
    await waitFor(() => expect(result.current.state).toEqual({ status: "lost", by: "Kim" }));
  });

  it("gives back a lock taken again while the editor closed", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let answerReclaim: (response: Response) => void = () => {};
    const sent: string[] = [];
    let renewals = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        sent.push(`${init?.method} ${url.replace("/api/v1", "")}`);
        if (url.endsWith("/lock")) {
          return new Response(
            JSON.stringify({ token: "t1", renewSeconds: 30, expireSeconds: 120, idleSeconds: 1800 }),
          );
        }
        if (url.endsWith("/lock/renew")) {
          renewals += 1;
          if (renewals === 1) return new Response(JSON.stringify(lockLost(null).body), { status: 409 });
          return new Promise<Response>((resolve) => (answerReclaim = resolve));
        }
        return new Response(null, { status: 204 });
      }),
    );
    const { result, unmount } = renderHook(() => useEditLock(PAGE, true));
    await waitFor(() => expect(result.current.state.status).toBe("held"));
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    await waitFor(() => expect(result.current.state.status).toBe("expired"));

    act(() => result.current.markActivity());
    await waitFor(() => expect(renewals).toBe(2));
    // The editor closes while the server grants the lock again.
    unmount();
    answerReclaim(new Response(JSON.stringify({ ok: true })));
    await waitFor(() =>
      expect(sent.filter((request) => request === `DELETE /pages/${PAGE}/lock?token=t1`)).toHaveLength(2),
    );
  });

  it("reports a takeover as lost", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    serve({
      [`/pages/${PAGE}/lock`]: [
        { status: 200, body: { token: "t1", renewSeconds: 30, expireSeconds: 120, idleSeconds: 1800 } },
      ],
      [`/pages/${PAGE}/lock/renew`]: [lockLost({ id: null, name: "Kim", email: null })],
    });
    const { result } = renderHook(() => useEditLock(PAGE, true));
    await waitFor(() => expect(result.current.state.status).toBe("held"));
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    await waitFor(() => expect(result.current.state).toEqual({ status: "lost", by: "Kim" }));
  });
});
