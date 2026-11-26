import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { AppEnv } from "./env";
import { AppError } from "./errors";
import { sameOrigin } from "./middleware";

function app() {
  const hono = new Hono<AppEnv>();
  hono.onError((error, c) =>
    error instanceof AppError ? c.json({ error: { code: error.code } }, error.status) : c.text("error", 500),
  );
  hono.use("*", sameOrigin);
  hono.all("/change", (c) => c.text("done"));
  return hono;
}

const post = (headers: Record<string, string>) => app().request("/change", { method: "POST", headers });

describe("sameOrigin", () => {
  it("rejects changes from other sites", async () => {
    expect((await post({ origin: "https://evil.example.net" })).status).toBe(403);
    expect((await post({ origin: "http://localhost:3000.evil.example.net" })).status).toBe(403);
    expect((await post({ origin: "null" })).status).toBe(403);
    // No Origin: only a same-origin fetch is trusted.
    expect((await post({})).status).toBe(403);
    expect((await post({ "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect((await post({ "sec-fetch-site": "same-site" })).status).toBe(403);
    expect(
      (await app().request("/change", { method: "DELETE", headers: { origin: "https://evil.example.net" } }))
        .status,
    ).toBe(403);
    // A cookie does not make a request with a foreign origin acceptable.
    expect(
      (await post({ origin: "https://evil.example.net", cookie: "handbook.session_token=x" })).status,
    ).toBe(403);
  });

  it("accepts the app's own origin, reads, and bearer tokens", async () => {
    expect((await post({ origin: "http://localhost:3000" })).status).toBe(200);
    expect((await post({ "sec-fetch-site": "same-origin" })).status).toBe(200);
    expect((await app().request("/change", { headers: { origin: "https://evil.example.net" } })).status).toBe(
      200,
    );
    expect(
      (await post({ origin: "https://evil.example.net", authorization: "Bearer kn_pat_x" })).status,
    ).toBe(200);
  });
});
