import { afterEach, describe, expect, it, vi } from "vitest";
import { every, startHeartbeat } from "./index";

describe("worker heartbeat", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("stops while a job runs far longer than it ever should", async () => {
    vi.useFakeTimers();
    let finish = () => {};
    const job = every({ name: "prune", minutes: 60, firstDelayMs: 1_000, maxRunMinutes: 30 }, () => {
      return new Promise<void>((resolve) => {
        finish = resolve;
      });
    });
    const touches: number[] = [];
    const stopHeartbeat = startHeartbeat([job], () => touches.push(Date.now()));

    await vi.advanceTimersByTimeAsync(29 * 60_000);
    const beforeHang = touches.length;
    expect(beforeHang).toBeGreaterThan(300);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    const afterHang = touches.length;
    expect(afterHang - beforeHang).toBeLessThan(15);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(touches.length).toBe(afterHang);

    // Once the job ends, the heartbeat goes on.
    finish();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(touches.length).toBeGreaterThan(afterHang + 10);
    stopHeartbeat();
    await job.stop();
  });
});
