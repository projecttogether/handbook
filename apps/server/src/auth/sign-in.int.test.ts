import { generateKeyPairSync, sign } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { resetConfigForTests } from "../config";
import { getDb } from "../db/client";
import { accounts, sessions, users } from "../db/schema";
import { createUser, resetDatabase, testApp } from "../test/helpers";
import { resetAuthForTests } from "./auth";
import { ensureEnvironmentAdmins } from "./bootstrap";
import { resolveSession } from "./resolve";
import { checkAccessAtSignIn } from "./sign-in";

const APP = "http://localhost:3000";
const ISSUER = process.env.OIDC_ISSUER!.replace(/\/+$/, "");
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });

/** What the fake provider answers next: the ID token's claims and the userinfo response. */
const provider = {
  nonce: undefined as string | undefined,
  claims: {} as Record<string, unknown>,
  userinfo: null as Record<string, unknown> | null,
};

function idToken(claims: Record<string, unknown>) {
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const input = `${encode({ alg: "RS256", typ: "JWT", kid: "test" })}.${encode({
    iss: ISSUER,
    aud: "handbook",
    iat: now,
    exp: now + 300,
    ...claims,
  })}`;
  return `${input}.${sign("sha256", Buffer.from(input), privateKey).toString("base64url")}`;
}

/** A JWT the way the provider's tokens look in `accounts` (the signature is not checked there). */
const storedToken = (claims: Record<string, unknown>) =>
  `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** An OpenID Connect provider behind `fetch`: discovery, keys, token and userinfo endpoints. */
const realFetch = globalThis.fetch;
async function fakeFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (!url.startsWith(`${ISSUER}/`)) return realFetch(input, init);
  const path = url.slice(ISSUER.length).split("?")[0];
  if (path === "/.well-known/openid-configuration") {
    return json({
      issuer: ISSUER,
      authorization_endpoint: `${ISSUER}/auth`,
      token_endpoint: `${ISSUER}/token`,
      userinfo_endpoint: `${ISSUER}/userinfo`,
      jwks_uri: `${ISSUER}/certs`,
      id_token_signing_alg_values_supported: ["RS256"],
    });
  }
  if (path === "/certs") {
    return json({
      keys: [{ ...publicKey.export({ format: "jwk" }), kid: "test", alg: "RS256", use: "sig" }],
    });
  }
  if (path === "/token") {
    return json({
      access_token: "provider-access-token",
      token_type: "Bearer",
      expires_in: 300,
      refresh_token: "provider-refresh-token",
      id_token: idToken({ ...provider.claims, nonce: provider.nonce }),
    });
  }
  if (path === "/userinfo") return provider.userinfo ? json(provider.userinfo) : json({}, 401);
  return json({}, 404);
}

const cookiesOf = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((value) => value.split(";")[0]!)
    .join("; ");

/** Signs in as the web app does: start, the provider's answer, the callback. */
async function signIn(claims: Record<string, unknown>) {
  const started = await testApp().request("/api/auth/sign-in/social", {
    method: "POST",
    headers: { origin: APP, "content-type": "application/json" },
    body: JSON.stringify({ provider: "oidc", callbackURL: "/", errorCallbackURL: "/sign-in" }),
  });
  expect(started.status).toBe(200);
  const authorization = new URL(((await started.json()) as { url: string }).url);
  provider.nonce = authorization.searchParams.get("nonce") ?? undefined;
  provider.claims = claims;
  const state = encodeURIComponent(authorization.searchParams.get("state")!);
  const callback = await testApp().request(`/api/auth/callback/oidc?code=code&state=${state}`, {
    headers: { cookie: cookiesOf(started) },
  });
  expect(callback.status).toBe(302);
  const location = new URL(callback.headers.get("location")!, APP);
  const session = callback.headers
    .getSetCookie()
    .find((value) => value.startsWith("handbook.session_token="))
    ?.split(";")[0];
  return { path: location.pathname, error: location.searchParams.get("error"), cookie: session ?? null };
}

function setEnv(values: Record<string, string>) {
  Object.assign(process.env, values);
  resetConfigForTests();
  resetAuthForTests();
}

const ENV_KEYS = ["OIDC_REQUIRE_EMAIL_VERIFIED", "ALLOWED_EMAIL_DOMAINS", "ACCESS_GROUPS"];

beforeAll(() => {
  vi.stubGlobal("fetch", fakeFetch);
  resetAuthForTests();
});
afterAll(() => {
  vi.unstubAllGlobals();
  resetAuthForTests();
});
beforeEach(resetDatabase);
afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
  resetConfigForTests();
  resetAuthForTests();
});

describe("sign-in through the provider", () => {
  it("refuses addresses the provider has not verified, and links people named in advance once it has", async () => {
    await ensureEnvironmentAdmins(getDb());
    const [root] = await getDb().select().from(users).where(eq(users.email, "root@example.org"));

    // Someone who can type any address at the provider, e.g. an admin's:
    // the authentication library links only verified addresses.
    const forged = await signIn({ sub: "mallory", email: "root@example.org", email_verified: false });
    expect(forged).toMatchObject({ path: "/sign-in", error: "account_not_linked", cookie: null });
    // No claim counts as not verified; nobody new is created.
    expect((await signIn({ sub: "nina", email: "nina@example.org" })).error).toBe("email_not_verified");
    expect(await getDb().select().from(accounts)).toHaveLength(0);
    expect(await getDb().select().from(sessions)).toHaveLength(0);
    expect((await getDb().select().from(users)).map((user) => user.email)).toEqual(["root@example.org"]);

    // The admin's own first sign-in links the provider's account to the entry.
    const real = await signIn({ sub: "root", email: "root@example.org", email_verified: true, name: "Root" });
    expect(real).toMatchObject({ path: "/", error: null, cookie: expect.any(String) });
    expect(await getDb().select().from(accounts)).toEqual([
      // The provider's tokens are not kept after the sign-in check.
      expect.objectContaining({
        userId: root!.id,
        accountId: "root",
        accessToken: null,
        refreshToken: null,
        idToken: null,
      }),
    ]);
    expect(await getDb().select().from(sessions).where(eq(sessions.userId, root!.id))).toHaveLength(1);
    const [after] = await getDb().select().from(users).where(eq(users.id, root!.id));
    expect(after).toMatchObject({ name: "Root", isAdmin: true });
    expect(after!.lastSignInAt).not.toBeNull();

    expect((await signIn({ sub: "mallory", email: "root@example.org", email_verified: false })).error).toBe(
      "account_not_linked",
    );
    expect(await getDb().select().from(accounts)).toHaveLength(1);
    // A linked account whose address the provider no longer vouches for.
    expect((await signIn({ sub: "root", email: "root@example.org", email_verified: false })).error).toBe(
      "email_not_verified",
    );
    expect(await getDb().select().from(sessions)).toHaveLength(1);
  });

  it("trusts the provider's addresses when OIDC_REQUIRE_EMAIL_VERIFIED is off", async () => {
    setEnv({ OIDC_REQUIRE_EMAIL_VERIFIED: "false" });
    const eddie = await createUser({ email: "eddie@example.org", lastSignInAt: null });
    expect(await signIn({ sub: "eddie", email: "eddie@example.org" })).toMatchObject({
      path: "/",
      error: null,
    });
    expect(await getDb().select().from(accounts)).toEqual([expect.objectContaining({ userId: eddie.id })]);
  });

  it("ends sessions SESSION_DAYS after sign-in, however much they are used", async () => {
    const { cookie } = await signIn({ sub: "rita", email: "rita@example.org", email_verified: true });
    const headers = new Headers({ cookie: cookie! });
    const [session] = await getDb().select().from(sessions);
    const day = 86_400_000;
    // Signed in three days ago: the session still ends seven days after that.
    const expiresAt = new Date(Date.now() + 4 * day);
    await getDb()
      .update(sessions)
      .set({
        createdAt: new Date(Date.now() - 3 * day),
        updatedAt: new Date(Date.now() - 3 * day),
        expiresAt,
      })
      .where(eq(sessions.id, session!.id));
    expect(await resolveSession(getDb(), headers)).toMatchObject({ email: "rita@example.org" });
    const [used] = await getDb().select().from(sessions);
    expect(used!.expiresAt.getTime()).toBe(expiresAt.getTime());

    await getDb()
      .update(sessions)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(sessions.id, session!.id));
    expect(await resolveSession(getDb(), headers)).toBeNull();
  });
});

describe("routes of the authentication library", () => {
  it("serves only what the web app uses, and no sign-in with an ID token", async () => {
    const { cookie } = await signIn({
      sub: "rita",
      email: "rita@example.org",
      email_verified: true,
      name: "Rita",
    });
    const headers = { origin: APP, "content-type": "application/json", cookie: cookie! };

    const renamed = await testApp().request("/api/auth/update-user", {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Ada Lovelace", image: "https://evil.example.net/a.png" }),
    });
    expect(renamed.status).toBe(404);
    expect((await getDb().select().from(users))[0]).toMatchObject({ name: "Rita", image: null });
    for (const path of ["/api/auth/get-session", "/api/auth/list-accounts", "/api/auth/list-sessions"]) {
      expect((await testApp().request(path, { headers })).status).toBe(404);
    }

    const token = idToken({ sub: "rita", email: "rita@example.org", email_verified: true });
    const withIdToken = await testApp().request("/api/auth/sign-in/social", {
      method: "POST",
      headers: { origin: APP, "content-type": "application/json" },
      body: JSON.stringify({ provider: "oidc", idToken: { token } }),
    });
    expect(withIdToken.status).toBe(400);
    expect(await withIdToken.json()).toMatchObject({ code: "id_token_sign_in" });
    expect(await getDb().select().from(sessions)).toHaveLength(1);

    const signedOut = await testApp().request("/api/auth/sign-out", { method: "POST", headers, body: "{}" });
    expect(signedOut.status).toBe(200);
    expect(await getDb().select().from(sessions)).toHaveLength(0);
  });
});

describe("checkAccessAtSignIn", () => {
  async function withAccount(
    email: string,
    tokens: { sub: string; idClaims?: Record<string, unknown>; accessToken?: string },
  ) {
    const user = await createUser({ email });
    await getDb()
      .insert(accounts)
      .values({
        userId: user.id,
        providerId: "oidc",
        accountId: tokens.sub,
        idToken: storedToken({ sub: tokens.sub, ...tokens.idClaims }),
        accessToken: tokens.accessToken ?? null,
        refreshToken: "provider-refresh-token",
      });
    return user;
  }

  it("refuses blocked people and other domains; admins from ADMIN_EMAILS always may", async () => {
    setEnv({ ALLOWED_EMAIL_DOMAINS: "example.org" });
    expect(await checkAccessAtSignIn((await createUser({ email: "ok@example.org" })).id)).toBe(true);
    expect(await checkAccessAtSignIn((await createUser({ email: "x@example.net" })).id)).toBe(false);
    // The domain is what follows the last "@".
    expect(await checkAccessAtSignIn((await createUser({ email: "x@example.org@example.net" })).id)).toBe(
      false,
    );
    const blocked = await createUser({ email: "blocked@example.org" });
    await getDb().update(users).set({ blockedAt: new Date() }).where(eq(users.id, blocked.id));
    expect(await checkAccessAtSignIn(blocked.id)).toBe(false);

    const root = await createUser({ email: "root@example.org" });
    await getDb().update(users).set({ blockedAt: new Date() }).where(eq(users.id, root.id));
    expect(await checkAccessAtSignIn(root.id)).toBe(true);
    const [after] = await getDb().select().from(users).where(eq(users.id, root.id));
    expect(after).toMatchObject({ isAdmin: true, adminSource: "environment", blockedAt: null });
  });

  it("reads ACCESS_GROUPS from the ID token, else from the userinfo answer about the same person", async () => {
    setEnv({ ACCESS_GROUPS: "/staff" });
    const inToken = await withAccount("a@example.org", { sub: "a", idClaims: { groups: ["/staff/it"] } });
    expect(await checkAccessAtSignIn(inToken.id)).toBe(true);
    const guest = await withAccount("g@example.org", { sub: "g", idClaims: { groups: ["/guests"] } });
    expect(await checkAccessAtSignIn(guest.id)).toBe(false);

    const fromUserinfo = await withAccount("b@example.org", { sub: "b", accessToken: "at-b" });
    provider.userinfo = { sub: "b", groups: ["/staff"] };
    expect(await checkAccessAtSignIn(fromUserinfo.id)).toBe(true);
    // An answer about someone else does not count.
    const other = await withAccount("c@example.org", { sub: "c", accessToken: "at-c" });
    provider.userinfo = { sub: "b", groups: ["/staff"] };
    expect(await checkAccessAtSignIn(other.id)).toBe(false);
    expect(await checkAccessAtSignIn((await createUser({ email: "none@example.org" })).id)).toBe(false);

    // None of the provider's tokens are kept.
    const kept = await getDb().select().from(accounts);
    expect(kept).toHaveLength(4);
    for (const account of kept) {
      expect(account).toMatchObject({ accessToken: null, refreshToken: null, idToken: null });
    }
  });
});
