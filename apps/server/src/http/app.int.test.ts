import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { DrizzleQueryError } from "drizzle-orm";
import pg from "pg";
import type { AppEnv } from "./env";
import { concurrentChangeResponse } from "./app";
import { getPool } from "../db/client";
import { createSpace, createUser, request, resetDatabase, testApp } from "../test/helpers";

vi.mock("../auth/resolve", () => import("../test/resolve-mock"));

/** A failed query as Drizzle reports it, with a PostgreSQL error of `code`. */
function failedQuery(code: string) {
  const error = new pg.DatabaseError('constraint "uq_secret_name" on (value)=(private)', 0, "error");
  error.code = code;
  error.constraint = "uq_secret_name";
  return new DrizzleQueryError("update spaces set name = $1", ["private"], error);
}

describe("error responses", () => {
  beforeEach(resetDatabase);

  it("answer a create at a path another one took at the same time with 409", async () => {
    const editor = await createUser();
    const space = await createSpace({ slug: "it", members: { [editor.id]: "editor" } });
    // Another request creates the page and has not committed yet.
    const other = await getPool().connect();
    try {
      await other.query("begin");
      await other.query(
        "insert into pages (space_id, path, revision, title, markdown) values ($1, 'vpn', 1, 'VPN', '')",
        [space.id],
      );
      const pending = request("POST", "/api/v1/spaces/it/pages", {
        userId: editor.id,
        body: { slug: "vpn", markdown: "---\ntitle: VPN\n---\n" },
      });
      // Its insert waits for the other transaction, which then commits.
      for (let waiting = 0; waiting === 0;) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        const result = await getPool().query<{ count: number }>(
          "select count(*)::int as count from pg_stat_activity where wait_event_type = 'Lock' and datname = current_database()",
        );
        waiting = result.rows[0]!.count;
      }
      await other.query("commit");
      const response = await pending;
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe("concurrent_change");
    } finally {
      other.release();
    }
  });

  it("answer deadlocks and serialization failures with 409, without database details", async () => {
    for (const code of ["23505", "40P01", "40001"]) {
      const app = new Hono<AppEnv>();
      app.onError((error, c) => concurrentChangeResponse(error, c) ?? c.text("Other error", 500));
      app.get("/", () => {
        throw failedQuery(code);
      });
      const response = await app.request("/");
      expect(response.status).toBe(409);
      const text = await response.text();
      expect(JSON.parse(text)).toEqual({
        error: {
          code: "concurrent_change",
          message: "Someone else changed this at the same time. Try again.",
        },
      });
      expect(text).not.toMatch(/uq_secret_name|private|spaces/);
    }
    const app = new Hono<AppEnv>();
    app.onError((error, c) => concurrentChangeResponse(error, c) ?? c.text("Other error", 500));
    app.get("/", () => {
      throw failedQuery("23503");
    });
    expect((await app.request("/")).status).toBe(500);
  });
});

it("answers text PostgreSQL cannot store (a NUL character) with 400, not 500", async () => {
  await resetDatabase();
  const editor = await createUser();
  await createSpace({ slug: "it", members: { [editor.id]: "editor" } });
  const search = await request("GET", "/api/v1/search?q=a%00b", { userId: editor.id });
  expect(search.status).toBe(400);
  expect(search.body.error.code).toBe("bad_request");
  const created = await request("POST", "/api/v1/spaces/it/pages", {
    userId: editor.id,
    body: { markdown: "---\ntitle: Notes\n---\n\nte\u0000xt\n" },
  });
  expect(created.status).toBe(400);
  // In a JSON column (a property's label) PostgreSQL names it differently (22P05).
  const admin = await createUser({ isAdmin: true });
  const updated = await request("PATCH", "/api/v1/spaces/it", {
    userId: admin.id,
    body: { properties: [{ key: "team", label: "Te\u0000am", type: "text" }] },
  });
  expect(updated.status).toBe(400);
});

it("limits the body of a sign-in request", async () => {
  const response = await testApp().request("/api/auth/sign-in/social", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost:3000" },
    body: JSON.stringify({ provider: "oidc" }).padEnd(64 * 1024 + 1),
  });
  expect(response.status).toBe(413);
  expect(await response.json()).toMatchObject({ error: { code: "payload_too_large" } });
});

it("marks private API responses and the Markdown directory as non-cacheable", async () => {
  const user = await createUser();
  for (const path of ["/api/v1/spaces", "/api/v1/tokens", "/llms.txt"]) {
    const response = await request("GET", path, { userId: user.id });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
  }
});
