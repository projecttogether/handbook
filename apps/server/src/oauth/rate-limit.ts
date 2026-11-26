import ipaddr from "ipaddr.js";

/**
 * Per-address limits of the OAuth endpoints anyone can call (registration,
 * authorization, token, revocation). Token buckets in memory: an address
 * may send `burst` requests at once, refilled at `perMinute`. Each process
 * counts on its own; with several web processes an address gets that many
 * times the limit.
 */
export type RateLimit = { burst: number; perMinute: number };

export const OAUTH_RATE_LIMITS = {
  // Each registration stores a client; apps register once per connection.
  register: { burst: 30, perMinute: 2 },
  // Each sign-in stores a request and may read a client metadata document.
  authorize: { burst: 30, perMinute: 10 },
  // Apps refresh their tokens from their own servers, many people's from one address.
  token: { burst: 60, perMinute: 60 },
  revoke: { burst: 30, perMinute: 30 },
} satisfies Record<string, RateLimit>;

/** Addresses remembered per limit; beyond, the longest unused are forgotten. */
const MAX_ADDRESSES = 10_000;

/**
 * What a limit counts by: the IP address, IPv6 addresses by their /64
 * network (one host usually has all of it); "unknown" without an address.
 */
export function rateLimitKey(address: string | null): string {
  if (!address) return "unknown";
  try {
    const parsed = ipaddr.process(address);
    if (parsed.kind() === "ipv6") {
      const parts = (parsed as ipaddr.IPv6).parts.slice(0, 4);
      return `${parts.map((part) => part.toString(16)).join(":")}::/64`;
    }
    return parsed.toString();
  } catch {
    return address;
  }
}

type Bucket = { tokens: number; at: number };

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly limit: RateLimit,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Counts a request of `key`. Returns 0 when it may go ahead, else the
   * seconds until the next request will be allowed.
   */
  take(key: string): number {
    const now = this.now();
    const perMs = this.limit.perMinute / 60_000;
    const bucket = this.buckets.get(key);
    const tokens = bucket
      ? Math.min(this.limit.burst, bucket.tokens + (now - bucket.at) * perMs)
      : this.limit.burst;
    // Re-inserting keeps the map ordered from least to most recently used.
    this.buckets.delete(key);
    if (tokens < 1) {
      this.buckets.set(key, { tokens, at: now });
      return Math.max(1, Math.ceil((1 - tokens) / perMs / 1000));
    }
    this.buckets.set(key, { tokens: tokens - 1, at: now });
    if (this.buckets.size > MAX_ADDRESSES) {
      const oldest = this.buckets.keys().next().value;
      if (oldest !== undefined) this.buckets.delete(oldest);
    }
    return 0;
  }

  /** Tests only: forget every address. */
  clear() {
    this.buckets.clear();
  }
}
