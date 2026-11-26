import { createHash, randomBytes } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { inArray } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetConfigForTests } from "../config";
import { getDb } from "../db/client";
import { oauthClients } from "../db/schema";
import { createUser, request, resetDatabase, testApp } from "../test/helpers";
import { pruneExpired } from "../worker/prune";
import { DOCUMENT_MAX_CONCURRENT } from "./clients";
import { OAUTH_RATE_LIMITS } from "./rate-limit";
import { resetRateLimitsForTests } from "./routes";

vi.mock("../auth/resolve", () => import("../test/resolve-mock"));

const REDIRECT = "https://client.example.org/callback";
const MCP_HEADERS = { accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" };

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

async function form(
  path: string,
  fields: Record<string, string> | URLSearchParams,
  headers: Record<string, string> = {},
) {
  const response = await testApp().request(path, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(fields).toString(),
  });
  const text = await response.text();
  return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) : null };
}

async function authorize(params: Record<string, string>, headers: Record<string, string> = {}) {
  const response = await testApp().request(`/oauth/authorize?${new URLSearchParams(params).toString()}`, {
    headers,
  });
  return {
    status: response.status,
    headers: response.headers,
    location: response.headers.get("location"),
    text: await response.text(),
  };
}

async function register(body: Record<string, unknown>, headers: Record<string, string> = {}) {
  const response = await testApp().request("/oauth/register", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    headers: response.headers,
    body: (await response.json()) as Record<string, string>,
  };
}

/** A public client (no secret) with the test redirect URI; returns its client_id. */
async function registerPublic(name = "Test client") {
  const registered = await register({
    redirect_uris: [REDIRECT],
    client_name: name,
    token_endpoint_auth_method: "none",
  });
  expect(registered.status).toBe(201);
  return registered.body.client_id!;
}

/** Connects a person with a public client and exchanges the code; returns the token response. */
async function connectAndExchange(userId: string, clientId: string) {
  const { code, verifier } = await connect(userId, clientId);
  const tokens = await form("/oauth/token", {
    grant_type: "authorization_code",
    code,
    code_verifier: verifier,
    client_id: clientId,
  });
  expect(tokens.status).toBe(200);
  return tokens.body as { access_token: string; refresh_token: string };
}

async function mcpCall(token: string | undefined, method = "tools/list") {
  return request("POST", "/mcp", {
    token,
    body: { jsonrpc: "2.0", id: 1, method, params: {} },
    headers: MCP_HEADERS,
  });
}

/** Signs a person in through the whole flow and returns the token response. */
async function connect(userId: string, clientId: string, extra: Record<string, string> = {}) {
  const { verifier, challenge } = pkce();
  const started = await authorize({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "state-1",
    resource: "http://localhost:3000/mcp",
    ...extra,
  });
  expect(started.status).toBe(302);
  const requestId = new URL(started.location!).searchParams.get("request")!;
  const consent = await request("GET", `/api/v1/oauth/requests/${requestId}`, { userId });
  expect(consent.status).toBe(200);
  const approved = await request("POST", `/api/v1/oauth/requests/${requestId}/approve`, { userId });
  const redirect = new URL(approved.body.redirectUrl);
  expect(redirect.searchParams.get("state")).toBe("state-1");
  expect(redirect.searchParams.get("iss")).toBe("http://localhost:3000");
  const code = redirect.searchParams.get("code")!;
  return { code, verifier, requestId, consent: consent.body };
}

describe("OAuth for connected apps", () => {
  beforeEach(async () => {
    resetRateLimitsForTests();
    await resetDatabase();
  });
  afterEach(() => {
    delete process.env.OAUTH_ALLOW_PRIVATE_CLIENT_URLS;
    delete process.env.TRUST_PROXY;
    resetConfigForTests();
  });

  it("publishes metadata with CORS", async () => {
    const resource = await testApp().request("/.well-known/oauth-protected-resource/mcp", {
      headers: { origin: "https://claude.ai" },
    });
    expect(resource.headers.get("access-control-allow-origin")).toBe("*");
    expect(await resource.json()).toMatchObject({
      resource: "http://localhost:3000/mcp",
      authorization_servers: ["http://localhost:3000"],
    });
    const server = await (await testApp().request("/.well-known/oauth-authorization-server")).json();
    expect(server).toMatchObject({
      issuer: "http://localhost:3000",
      code_challenge_methods_supported: ["S256"],
      client_id_metadata_document_supported: true,
      token_endpoint_auth_methods_supported: expect.arrayContaining(["none"]),
    });
    const preflight = await testApp().request("/oauth/token", {
      method: "OPTIONS",
      headers: { origin: "https://claude.ai", "access-control-request-method": "POST" },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("registers, authorizes with PKCE, refreshes, and revokes", async () => {
    const ada = await createUser({ name: "Ada" });
    const registered = await testApp().request("/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        redirect_uris: [REDIRECT],
        client_name: "Test client",
        token_endpoint_auth_method: "none",
      }),
    });
    expect(registered.status).toBe(201);
    const client = (await registered.json()) as { client_id: string; client_secret?: string };
    expect(client.client_secret).toBeUndefined();

    const { code, verifier, requestId, consent } = await connect(ada.id, client.client_id);
    expect(consent).toEqual({
      id: requestId,
      clientName: "Test client",
      clientHost: null,
      redirectHost: "client.example.org",
      registration: "dynamic",
      expiresAt: expect.any(String),
    });

    // Another person cannot use the same consent screen.
    const other = await createUser();
    expect((await request("GET", `/api/v1/oauth/requests/${requestId}`, { userId: other.id })).status).toBe(
      404,
    );

    expect(
      (
        await form("/oauth/token", {
          grant_type: "authorization_code",
          code,
          code_verifier: "x".repeat(43),
          client_id: client.client_id,
        })
      ).body,
    ).toMatchObject({ error: "invalid_grant" });
    const tokens = await form("/oauth/token", {
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT,
      client_id: client.client_id,
    });
    expect(tokens.status).toBe(200);
    expect(tokens.headers.get("cache-control")).toBe("no-store");
    expect(tokens.body).toMatchObject({ token_type: "Bearer", expires_in: 3600, scope: "handbook" });
    // The code works once.
    expect(
      (
        await form("/oauth/token", {
          grant_type: "authorization_code",
          code,
          code_verifier: verifier,
          client_id: client.client_id,
        })
      ).status,
    ).toBe(400);
    // Reusing the code revoked what it gave.
    expect((await mcpCall(tokens.body.access_token)).status).toBe(401);

    const second = await connect(ada.id, client.client_id);
    const fresh = await form("/oauth/token", {
      grant_type: "authorization_code",
      code: second.code,
      code_verifier: second.verifier,
      client_id: client.client_id,
    });
    expect((await mcpCall(fresh.body.access_token)).status).toBe(200);

    const apps = await request("GET", "/api/v1/connected-apps", { userId: ada.id });
    expect(apps.body.items).toEqual([
      expect.objectContaining({ clientName: "Test client", redirectHost: "client.example.org" }),
    ]);

    const refreshed = await form("/oauth/token", {
      grant_type: "refresh_token",
      refresh_token: fresh.body.refresh_token,
      client_id: client.client_id,
    });
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.refresh_token).not.toBe(fresh.body.refresh_token);

    expect(
      (await request("DELETE", `/api/v1/connected-apps/${apps.body.items[0].id}`, { userId: ada.id })).status,
    ).toBe(204);
    expect((await mcpCall(refreshed.body.access_token)).status).toBe(401);
    const afterDisconnect = await form("/oauth/token", {
      grant_type: "refresh_token",
      refresh_token: refreshed.body.refresh_token,
      client_id: client.client_id,
    });
    expect(afterDisconnect.body).toMatchObject({ error: "invalid_grant" });
  });

  it("checks confidential clients, redirect URIs and PKCE", async () => {
    const ada = await createUser();
    const registered = await testApp().request("/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: [REDIRECT] }),
    });
    const client = (await registered.json()) as {
      client_id: string;
      client_secret: string;
      token_endpoint_auth_method: string;
    };
    expect(client.token_endpoint_auth_method).toBe("client_secret_basic");
    expect(client.client_secret).toMatch(/^kn_cs_/);

    const bad = await testApp().request("/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["http://evil.example.org/callback"] }),
    });
    expect(await bad.json()).toMatchObject({ error: "invalid_redirect_uri" });

    const wrongRedirect = await authorize({
      response_type: "code",
      client_id: client.client_id,
      redirect_uri: "https://other.example.org/cb",
      code_challenge: pkce().challenge,
      code_challenge_method: "S256",
    });
    expect(wrongRedirect.status).toBe(400);
    expect(wrongRedirect.location).toBeNull();
    const noPkce = await authorize({
      response_type: "code",
      client_id: client.client_id,
      redirect_uri: REDIRECT,
      state: "s",
    });
    expect(noPkce.status).toBe(400);
    expect(noPkce.location).toBeNull();

    const { code, verifier } = await connect(ada.id, client.client_id);
    const basic = (secret: string) =>
      `Basic ${Buffer.from(`${client.client_id}:${secret}`).toString("base64")}`;
    const refused = await form(
      "/oauth/token",
      { grant_type: "authorization_code", code, code_verifier: verifier },
      { authorization: basic("wrong") },
    );
    expect(refused.status).toBe(401);
    expect(refused.body).toMatchObject({ error: "invalid_client" });
    const accepted = await form(
      "/oauth/token",
      { grant_type: "authorization_code", code, code_verifier: verifier },
      { authorization: basic(client.client_secret) },
    );
    expect(accepted.status).toBe(200);

    // Denying sends the person back with access_denied.
    const { challenge } = pkce();
    const started = await authorize({
      response_type: "code",
      client_id: client.client_id,
      redirect_uri: REDIRECT,
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    const requestId = new URL(started.location!).searchParams.get("request")!;
    const denied = await request("POST", `/api/v1/oauth/requests/${requestId}/deny`, { userId: ada.id });
    expect(new URL(denied.body.redirectUrl).searchParams.get("error")).toBe("access_denied");
  });

  it("reads client metadata documents, and refuses private addresses", async () => {
    const ada = await createUser();
    let served = 0;
    const server = http.createServer((_request, response) => {
      served += 1;
      const port = (server.address() as AddressInfo).port;
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          client_id: `http://127.0.0.1:${port}/client.json`,
          client_name: "Document client",
          redirect_uris: [REDIRECT],
          token_endpoint_auth_method: "none",
        }),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const clientId = `http://127.0.0.1:${(server.address() as AddressInfo).port}/client.json`;
    try {
      // Without the development switch: http and private addresses are refused.
      const refused = await authorize({ response_type: "code", client_id: clientId, redirect_uri: REDIRECT });
      expect(refused.status).toBe(400);
      expect(refused.text).toContain("https");
      const privateHttps = await authorize({
        response_type: "code",
        client_id: "https://127.0.0.1:9/client.json",
        redirect_uri: REDIRECT,
      });
      expect(privateHttps.status).toBe(400);
      expect(privateHttps.text).toContain("private network");
      expect(served).toBe(0);

      process.env.OAUTH_ALLOW_PRIVATE_CLIENT_URLS = "true";
      resetConfigForTests();
      const { code, verifier, consent } = await connect(ada.id, clientId);
      expect(consent).toMatchObject({
        clientName: "Document client",
        clientHost: new URL(clientId).host,
        redirectHost: "client.example.org",
        registration: "metadata_document",
      });
      const tokens = await form("/oauth/token", {
        grant_type: "authorization_code",
        code,
        code_verifier: verifier,
        client_id: clientId,
      });
      expect(tokens.status).toBe(200);
      // Cached for an hour: a second sign-in does not fetch again.
      await connect(ada.id, clientId);
      expect(served).toBe(1);
    } finally {
      server.close();
    }
  });
  it("shows errors before consent on its own page instead of redirecting to the app", async () => {
    const clientId = await registerPublic();
    const valid = {
      response_type: "code",
      client_id: clientId,
      redirect_uri: REDIRECT,
      code_challenge: pkce().challenge,
      code_challenge_method: "S256",
      state: "s",
    };
    const { response_type: _responseType, ...withoutResponseType } = valid;
    const { code_challenge: _challenge, ...withoutChallenge } = valid;
    for (const params of [
      withoutResponseType,
      { ...valid, response_type: "token" },
      withoutChallenge,
      { ...valid, code_challenge_method: "plain" },
      { ...valid, resource: "https://other.example.org/mcp" },
    ]) {
      const result = await authorize(params);
      expect(result.status).toBe(400);
      expect(result.location).toBeNull();
      expect(result.text).toContain("cannot connect");
      expect(result.text).not.toContain(REDIRECT);
    }
    // A valid request still goes to the consent screen.
    const started = await authorize(valid);
    expect(started.status).toBe(302);
    expect(started.location).toMatch(/^http:\/\/localhost:3000\/oauth\/consent\?request=/);
  });

  it("checks the requested resource before rotating a refresh token", async () => {
    const user = await createUser();
    const clientId = await registerPublic();
    const tokens = await connectAndExchange(user.id, clientId);
    const refresh = (...resources: string[]) => {
      const fields = new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: tokens.refresh_token,
        client_id: clientId,
      });
      for (const resource of resources) fields.append("resource", resource);
      return form("/oauth/token", fields);
    };

    const app = "http://localhost:3000/mcp";
    const wrongResource = await refresh("https://other.example.org/mcp", app);
    expect(wrongResource.status).toBe(400);
    expect(wrongResource.body).toMatchObject({ error: "invalid_target" });
    const valid = await refresh(app);
    expect(valid.status).toBe(200);
    expect(valid.body.refresh_token).not.toBe(tokens.refresh_token);
  });

  it("ends the connection when a replaced refresh token is used again", async () => {
    const ada = await createUser();
    const clientId = await registerPublic();
    const first = await connectAndExchange(ada.id, clientId);
    const second = await form("/oauth/token", {
      grant_type: "refresh_token",
      refresh_token: first.refresh_token,
      client_id: clientId,
    });
    expect(second.status).toBe(200);
    expect((await mcpCall(second.body.access_token)).status).toBe(200);

    // Another client cannot end someone else's connection with it.
    const otherClient = await registerPublic("Other client");
    const elsewhere = await form("/oauth/token", {
      grant_type: "refresh_token",
      refresh_token: first.refresh_token,
      client_id: otherClient,
    });
    expect(elsewhere.body).toMatchObject({ error: "invalid_grant" });
    expect((await mcpCall(second.body.access_token)).status).toBe(200);

    // The replaced token again: someone else may have it, so every token of the connection ends.
    const replayed = await form("/oauth/token", {
      grant_type: "refresh_token",
      refresh_token: first.refresh_token,
      client_id: clientId,
    });
    expect(replayed.status).toBe(400);
    expect(replayed.body).toMatchObject({ error: "invalid_grant" });
    expect((await mcpCall(second.body.access_token)).status).toBe(401);
    const afterReplay = await form("/oauth/token", {
      grant_type: "refresh_token",
      refresh_token: second.body.refresh_token,
      client_id: clientId,
    });
    expect(afterReplay.body).toMatchObject({ error: "invalid_grant" });

    // Connecting again works, and the old token cannot end the new connection.
    const again = await connectAndExchange(ada.id, clientId);
    expect((await mcpCall(again.access_token)).status).toBe(200);
    const replayedAgain = await form("/oauth/token", {
      grant_type: "refresh_token",
      refresh_token: first.refresh_token,
      client_id: clientId,
    });
    expect(replayedAgain.body).toMatchObject({ error: "invalid_grant" });
    expect((await mcpCall(again.access_token)).status).toBe(200);
  });

  it("removes clients that never got a grant after a few days", async () => {
    const ada = await createUser();
    const unused = await registerPublic("Unused");
    const connected = await registerPublic("Connected");
    const pending = await registerPublic("Pending");
    const recent = await registerPublic("Recent");
    await connectAndExchange(ada.id, connected);
    expect(
      (
        await authorize({
          response_type: "code",
          client_id: pending,
          redirect_uri: REDIRECT,
          code_challenge: pkce().challenge,
          code_challenge_method: "S256",
        })
      ).status,
    ).toBe(302);
    await getDb()
      .update(oauthClients)
      .set({ createdAt: new Date(Date.now() - 4 * 86_400_000) })
      .where(inArray(oauthClients.clientId, [unused, connected, pending]));

    await pruneExpired(getDb());

    const left = await getDb().select({ clientId: oauthClients.clientId }).from(oauthClients);
    expect(left.map((row) => row.clientId).sort()).toEqual([connected, pending, recent].sort());
  });

  it("limits requests per address", async () => {
    process.env.TRUST_PROXY = "1";
    resetConfigForTests();
    const from = (address: string) => ({ "x-forwarded-for": address });
    const metadata = { redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" };

    for (let index = 0; index < OAUTH_RATE_LIMITS.register.burst; index += 1) {
      expect((await register(metadata, from("203.0.113.7"))).status).toBe(201);
    }
    const refused = await register(metadata, from("203.0.113.7"));
    expect(refused.status).toBe(429);
    expect(refused.body).toMatchObject({ error: "temporarily_unavailable" });
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
    // Other addresses have their own limit; IPv6 addresses count by their /64 network.
    expect((await register(metadata, from("203.0.113.8"))).status).toBe(201);

    const params = { response_type: "code", client_id: "kn_client_unknown", redirect_uri: REDIRECT };
    for (let index = 0; index < OAUTH_RATE_LIMITS.authorize.burst; index += 1) {
      expect((await authorize(params, from("2001:db8:1:2::1"))).status).toBe(400);
    }
    const tooMany = await authorize(params, from("2001:db8:1:2::ffff"));
    expect(tooMany.status).toBe(429);
    expect(tooMany.location).toBeNull();
    expect(tooMany.text).toContain("Too many");
    expect((await authorize(params, from("2001:db8:1:3::1"))).status).toBe(400);

    const token = {
      grant_type: "refresh_token",
      refresh_token: "kn_rt_unknown",
      client_id: "kn_client_unknown",
    };
    for (let index = 0; index < OAUTH_RATE_LIMITS.token.burst; index += 1) {
      expect((await form("/oauth/token", token, from("198.51.100.1"))).status).toBe(401);
    }
    expect((await form("/oauth/token", token, from("198.51.100.1"))).status).toBe(429);

    const revoke = { token: "kn_rt_unknown", client_id: "kn_client_unknown" };
    for (let index = 0; index < OAUTH_RATE_LIMITS.revoke.burst; index += 1) {
      expect((await form("/oauth/revoke", revoke, from("198.51.100.2"))).status).toBe(401);
    }
    expect((await form("/oauth/revoke", revoke, from("198.51.100.2"))).status).toBe(429);
  });

  it("reads one metadata document per app at a time, and only a few at once", async () => {
    process.env.OAUTH_ALLOW_PRIVATE_CLIENT_URLS = "true";
    resetConfigForTests();
    const held: { url: string; response: http.ServerResponse }[] = [];
    const server = http.createServer((incoming, response) => {
      held.push({ url: incoming.url!, response });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const params = (path: string) => ({
      response_type: "code",
      client_id: `${base}${path}`,
      redirect_uri: REDIRECT,
      code_challenge: pkce().challenge,
      code_challenge_method: "S256",
    });
    try {
      const limit = DOCUMENT_MAX_CONCURRENT;
      const started = [authorize(params("/client-0.json"))];
      for (let index = 0; index < limit; index += 1) started.push(authorize(params(`/client-${index}.json`)));
      // The same document twice is read once.
      await vi.waitFor(() => expect(held).toHaveLength(limit));
      const refused = await authorize(params("/one-too-many.json"));
      expect(refused.status).toBe(503);
      expect(refused.location).toBeNull();
      expect(refused.text).toContain("Try again");

      for (const { url, response } of held) {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ client_id: `${base}${url}`, redirect_uris: [REDIRECT] }));
      }
      const results = await Promise.all(started);
      expect(results.map((result) => result.status)).toEqual(Array<number>(limit + 1).fill(302));
      expect(held).toHaveLength(limit);
    } finally {
      for (const { response } of held) if (!response.writableEnded) response.end();
      server.close();
    }
  });
});
