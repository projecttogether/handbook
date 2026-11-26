import { createHash, randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { resetConfigForTests } from "../config";
import { getDb } from "../db/client";
import { credentials, oauthGrants, users } from "../db/schema";
import { createToken, createUser, request, resetDatabase, testApp } from "../test/helpers";

vi.mock("../auth/resolve", () => import("../test/resolve-mock"));

const REDIRECT = "https://client.example.org/callback";
const MCP_HEADERS = { accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" };
const DAY = 86_400_000;

async function form(fields: Record<string, string>) {
  const response = await testApp().request("/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  });
  return { status: response.status, body: (await response.json()) as Record<string, string> };
}

/** Connects an app for a person through the whole OAuth flow; returns its tokens. */
async function connectApp(userId: string) {
  const registered = await testApp().request("/oauth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      redirect_uris: [REDIRECT],
      client_name: "Claude",
      token_endpoint_auth_method: "none",
    }),
  });
  const clientId = ((await registered.json()) as { client_id: string }).client_id;
  const verifier = randomBytes(32).toString("base64url");
  const query = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
  });
  const started = await testApp().request(`/oauth/authorize?${query.toString()}`);
  const requestId = new URL(started.headers.get("location")!).searchParams.get("request")!;
  const approved = await request("POST", `/api/v1/oauth/requests/${requestId}/approve`, { userId });
  const code = new URL(approved.body.redirectUrl).searchParams.get("code")!;
  const tokens = await form({
    grant_type: "authorization_code",
    code,
    code_verifier: verifier,
    redirect_uri: REDIRECT,
    client_id: clientId,
  });
  expect(tokens.status).toBe(200);
  return { clientId, access: tokens.body.access_token!, refresh: tokens.body.refresh_token! };
}

const mcp = (token: string | undefined, headers: Record<string, string> = {}) =>
  request("POST", "/mcp", {
    token,
    body: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
    headers: { ...MCP_HEADERS, ...headers },
  });

const lastSignedIn = (userId: string, daysAgo: number) =>
  getDb()
    .update(users)
    .set({ lastSignInAt: new Date(Date.now() - daysAgo * DAY) })
    .where(eq(users.id, userId));

describe("agents and their person's access", () => {
  beforeEach(resetDatabase);
  afterEach(() => {
    delete process.env.AGENT_SIGN_IN_DAYS;
    resetConfigForTests();
  });

  it("stop working when the person has not signed in for AGENT_SIGN_IN_DAYS", async () => {
    const ada = await createUser({ name: "Ada" });
    const token = await createToken(ada.id, "Claude Code");
    const app = await connectApp(ada.id);

    await lastSignedIn(ada.id, 29);
    expect((await request("GET", "/api/v1/me", { token })).status).toBe(200);
    expect((await mcp(app.access)).status).toBe(200);

    await lastSignedIn(ada.id, 31);
    const stale = await request("GET", "/api/v1/me", { token });
    expect(stale.status).toBe(401);
    expect(stale.body.error).toEqual({
      code: "sign_in_needed",
      message: "Sign in to Handbook again: agents work for 30 days after your last sign-in.",
    });
    const viaMcp = await mcp(app.access);
    expect(viaMcp.status).toBe(401);
    expect(viaMcp.body.error.message).toBe(stale.body.error.message);
    expect(viaMcp.headers.get("www-authenticate")).toContain("resource_metadata=");
    const refreshed = await form({
      grant_type: "refresh_token",
      refresh_token: app.refresh,
      client_id: app.clientId,
    });
    expect(refreshed.body.error).toBe("invalid_grant");

    // Never signed in (named by email, token created some other way): the same.
    await getDb().update(users).set({ lastSignInAt: null }).where(eq(users.id, ada.id));
    expect((await request("GET", "/api/v1/me", { token })).status).toBe(401);

    // Signing in again brings them back; 0 turns the limit off.
    await lastSignedIn(ada.id, 0);
    expect((await request("GET", "/api/v1/me", { token })).status).toBe(200);
    await lastSignedIn(ada.id, 400);
    process.env.AGENT_SIGN_IN_DAYS = "0";
    resetConfigForTests();
    expect((await request("GET", "/api/v1/me", { token })).status).toBe(200);
  });

  it("are revoked for good when the person is blocked", async () => {
    const admin = await createUser({ isAdmin: true });
    const rita = await createUser({ name: "Rita" });
    const token = await createToken(rita.id);
    const app = await connectApp(rita.id);
    expect((await mcp(app.access)).status).toBe(200);

    const block = (blocked: boolean) =>
      request("PATCH", `/api/v1/admin/people/${rita.id}`, { userId: admin.id, body: { blocked } });
    expect((await block(true)).status).toBe(200);
    expect((await block(false)).status).toBe(200);

    // Unblocked, with a fresh sign-in: the old token and connection stay ended.
    expect((await request("GET", "/api/v1/me", { userId: rita.id })).status).toBe(200);
    expect((await request("GET", "/api/v1/me", { token })).status).toBe(401);
    expect((await mcp(app.access)).status).toBe(401);
    const refreshed = await form({
      grant_type: "refresh_token",
      refresh_token: app.refresh,
      client_id: app.clientId,
    });
    expect(refreshed.body.error).toBe("invalid_grant");
    const left = await getDb().select().from(credentials).where(eq(credentials.userId, rita.id));
    expect(left.length).toBeGreaterThan(0);
    for (const credential of left) expect(credential.revokedAt).not.toBeNull();
    const [grant] = await getDb().select().from(oauthGrants).where(eq(oauthGrants.userId, rita.id));
    expect(grant!.revokedAt).not.toBeNull();
  });

  it("keeps service tokens apart from the admin who created them", async () => {
    const admin = await createUser({ isAdmin: true });
    const created = await request("POST", "/api/v1/admin/service-tokens", {
      userId: admin.id,
      body: { name: "Support bot", expiresInDays: null },
    });
    await lastSignedIn(admin.id, 400);
    expect((await request("GET", "/api/v1/spaces", { token: created.body.secret })).status).toBe(200);
  });
});
