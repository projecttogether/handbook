import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "../db/client";
import { auditLog, credentials, users } from "../db/schema";
import { createSpace, createUser, request, resetDatabase } from "../test/helpers";

vi.mock("../auth/resolve", () => import("../test/resolve-mock"));

describe("tokens", () => {
  beforeEach(resetDatabase);

  it("creates, lists and revokes personal tokens in the web app only", async () => {
    const ada = await createUser({ name: "Ada" });
    await createSpace({ slug: "it" });
    const created = await request("POST", "/api/v1/tokens", {
      userId: ada.id,
      body: { name: "Claude Code", expiresInDays: 30 },
    });
    expect(created.status).toBe(201);
    expect(created.body.secret).toMatch(/^kn_pat_/);
    expect(created.body.prefix).toMatch(/^kn_pat_.{4}…$/);
    expect(new Date(created.body.expiresAt).getTime()).toBeGreaterThan(Date.now() + 29 * 86_400_000);
    const stored = await getDb().select().from(credentials).where(eq(credentials.id, created.body.id));
    expect(stored[0]?.tokenHash).not.toContain(created.body.secret);

    // The token works as an agent of Ada: it reads, but cannot manage tokens.
    const token = created.body.secret as string;
    expect((await request("GET", "/api/v1/me", { token })).body).toMatchObject({ id: ada.id });
    expect((await request("GET", "/api/v1/tokens", { token })).status).toBe(403);
    expect((await request("GET", "/api/v1/connect-info", { token })).body).toEqual({
      appUrl: "http://localhost:3000",
      mcpUrl: "http://localhost:3000/mcp",
    });

    const list = await request("GET", "/api/v1/tokens", { userId: ada.id });
    expect(list.body.items).toEqual([expect.objectContaining({ id: created.body.id, name: "Claude Code" })]);
    expect(list.body.items[0].secret).toBeUndefined();

    // Others cannot revoke it; Ada can.
    const other = await createUser();
    expect((await request("DELETE", `/api/v1/tokens/${created.body.id}`, { userId: other.id })).status).toBe(
      404,
    );
    expect((await request("DELETE", `/api/v1/tokens/${created.body.id}`, { userId: ada.id })).status).toBe(
      204,
    );
    expect((await request("GET", "/api/v1/me", { token })).status).toBe(401);
  });

  it("stops tokens of blocked people and expired tokens", async () => {
    const ada = await createUser();
    const token = (
      await request("POST", "/api/v1/tokens", {
        userId: ada.id,
        body: { name: "Agent", expiresInDays: null },
      })
    ).body.secret as string;
    expect((await request("GET", "/api/v1/me", { token })).status).toBe(200);
    await getDb().update(users).set({ blockedAt: new Date() }).where(eq(users.id, ada.id));
    expect((await request("GET", "/api/v1/me", { token })).status).toBe(401);
    await getDb().update(users).set({ blockedAt: null }).where(eq(users.id, ada.id));
    await getDb()
      .update(credentials)
      .set({ expiresAt: new Date(Date.now() - 1000) });
    expect((await request("GET", "/api/v1/me", { token })).status).toBe(401);
  });

  it("lets admins manage read-only service tokens", async () => {
    const admin = await createUser({ isAdmin: true, email: "admin@example.org" });
    const person = await createUser();
    await createSpace({ slug: "it" });
    expect(
      (await request("POST", "/api/v1/admin/service-tokens", { userId: person.id, body: { name: "Bot" } }))
        .status,
    ).toBe(403);
    const created = await request("POST", "/api/v1/admin/service-tokens", {
      userId: admin.id,
      body: { name: "Support bot", expiresInDays: null },
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      name: "Support bot",
      createdBy: "admin@example.org",
      expiresAt: null,
    });
    const secret = created.body.secret as string;
    expect(secret).toMatch(/^kn_svc_/);
    expect((await request("GET", "/api/v1/spaces", { token: secret })).status).toBe(200);
    expect(
      (await request("POST", "/api/v1/change-sets", { token: secret, body: { space: "it", title: "x" } }))
        .status,
    ).toBe(403);
    expect((await request("GET", "/api/v1/me", { token: secret })).status).toBe(403);

    const list = await request("GET", "/api/v1/admin/service-tokens", { userId: admin.id });
    expect(list.body.items).toHaveLength(1);
    expect(
      (await request("DELETE", `/api/v1/admin/service-tokens/${created.body.id}`, { userId: admin.id }))
        .status,
    ).toBe(204);
    expect((await request("GET", "/api/v1/spaces", { token: secret })).status).toBe(401);
    const entries = await getDb().select().from(auditLog);
    expect(entries.map((entry) => entry.action).sort()).toEqual([
      "service_token.create",
      "service_token.revoke",
    ]);

    // An admin's personal token is an agent: no admin rights.
    const adminToken = (
      await request("POST", "/api/v1/tokens", { userId: admin.id, body: { name: "Agent" } })
    ).body.secret;
    expect((await request("GET", "/api/v1/admin/service-tokens", { token: adminToken })).status).toBe(403);
  });
});
