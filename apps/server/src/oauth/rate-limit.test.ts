import { describe, expect, it } from "vitest";
import { RateLimiter, rateLimitKey } from "./rate-limit";

describe("RateLimiter", () => {
  it("allows a burst, then refills at the rate per minute", () => {
    let now = 0;
    const limiter = new RateLimiter({ burst: 3, perMinute: 2 }, () => now);
    expect([limiter.take("a"), limiter.take("a"), limiter.take("a")]).toEqual([0, 0, 0]);
    expect(limiter.take("a")).toBe(30);
    // Other addresses have their own bucket.
    expect(limiter.take("b")).toBe(0);
    now += 29_000;
    expect(limiter.take("a")).toBe(1);
    now += 2_000;
    expect(limiter.take("a")).toBe(0);
    expect(limiter.take("a")).toBeGreaterThan(0);
    // Never more than the burst, however long it waited.
    now += 3_600_000;
    expect([limiter.take("a"), limiter.take("a"), limiter.take("a"), limiter.take("a")]).toEqual([
      0, 0, 0, 30,
    ]);
  });

  it("forgets everything on clear", () => {
    const limiter = new RateLimiter({ burst: 1, perMinute: 1 }, () => 0);
    limiter.take("a");
    expect(limiter.take("a")).toBeGreaterThan(0);
    limiter.clear();
    expect(limiter.take("a")).toBe(0);
  });
});

describe("rateLimitKey", () => {
  it("counts IPv4 by address and IPv6 by /64 network", () => {
    expect(rateLimitKey("203.0.113.7")).toBe("203.0.113.7");
    expect(rateLimitKey("::ffff:203.0.113.7")).toBe("203.0.113.7");
    expect(rateLimitKey("2001:db8:1:2::1")).toBe("2001:db8:1:2::/64");
    expect(rateLimitKey("2001:db8:1:2:aaaa:bbbb:cccc:dddd")).toBe("2001:db8:1:2::/64");
    expect(rateLimitKey("2001:db8:1:3::1")).not.toBe(rateLimitKey("2001:db8:1:2::1"));
    expect(rateLimitKey(null)).toBe("unknown");
  });
});
