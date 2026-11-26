import { createHash, randomBytes } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { OauthRequest } from "@handbook/shared/api/tokens";
import { config } from "../config";
import type { Db, DbOrTx } from "../db/client";
import { credentials, oauthClients, oauthGrants, oauthRequests, users } from "../db/schema";
import { agentAccess, hashToken, issueCredential } from "../auth/credentials";
import type { UserPrincipal } from "../auth/principal";
import { conflict, notFound } from "../http/errors";
import { logger } from "../logger";
import {
  clientForAuthorization,
  matchesRedirectUri,
  OAuthError,
  redirectTarget,
  type ClientRow,
} from "./clients";

/**
 * The authorization code flow with PKCE for connected apps:
 * /oauth/authorize → consent in the web app → code → /oauth/token.
 */

export const SCOPE = "handbook";
const REQUEST_MINUTES = 10;
const CODE_SECONDS = 60;
const VERIFIER = /^[A-Za-z0-9\-._~]{43,128}$/;
const CHALLENGE = /^[A-Za-z0-9\-_]{43,128}$/;

/** True when `resource` names this app's MCP endpoint (a trailing slash does not matter). */
export function isOurResource(resource: string): boolean {
  const normalize = (value: string) => value.replace(/\/+$/, "");
  return (
    normalize(resource) === normalize(config().mcpUrl) || normalize(resource) === normalize(config().APP_URL)
  );
}

/** An error the authorization endpoint shows itself, because redirecting would not be safe. */
export class AuthorizePageError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 503 = 400,
  ) {
    super(message);
    this.name = "AuthorizePageError";
  }
}

/** A redirect back to the client with an error (RFC 6749 4.1.2.1, with RFC 9207 `iss`); only after the person decided. */
export function errorRedirect(
  redirectUri: string,
  error: string,
  description: string,
  state: string | undefined,
) {
  const url = new URL(redirectUri);
  url.searchParams.set("error", error);
  url.searchParams.set("error_description", description);
  if (state) url.searchParams.set("state", state);
  url.searchParams.set("iss", config().APP_URL);
  return url.toString();
}

/**
 * Checks an authorization request and returns the consent screen's address.
 * Throws AuthorizePageError for every problem: anyone can register a client
 * with any redirect URI, so before the person has decided, errors are shown
 * here and never sent to the app (RFC 9700 4.11.2, no open redirect).
 */
export async function startAuthorization(
  db: Db,
  query: Record<string, string>,
  resources: string[],
): Promise<string> {
  const clientId = query.client_id;
  if (!clientId) throw new AuthorizePageError("The app did not say who it is (client_id is missing).");
  let client: ClientRow | null;
  try {
    client = await clientForAuthorization(db, clientId);
  } catch (error) {
    if (error instanceof OAuthError)
      throw new AuthorizePageError(error.description, error.status === 503 ? 503 : 400);
    throw error;
  }
  if (!client)
    throw new AuthorizePageError("This app is not registered here. Connect it again from the app.");
  let redirectUri = query.redirect_uri;
  if (!redirectUri) {
    if (client.redirectUris.length !== 1)
      throw new AuthorizePageError("The app did not send its redirect_uri.");
    redirectUri = client.redirectUris[0]!;
  } else if (!matchesRedirectUri(client.redirectUris, redirectUri)) {
    throw new AuthorizePageError("The app's redirect address is not one it registered.");
  }
  const state = query.state && query.state.length <= 1000 ? query.state : undefined;
  if (query.response_type !== "code") {
    throw new AuthorizePageError(
      "The app asked for a kind of sign-in that is not supported (response_type).",
    );
  }
  if (
    !query.code_challenge ||
    query.code_challenge_method !== "S256" ||
    !CHALLENGE.test(query.code_challenge)
  ) {
    throw new AuthorizePageError("The app did not protect its sign-in with PKCE (code_challenge, S256).");
  }
  if (resources.some((resource) => resource && !isOurResource(resource))) {
    throw new AuthorizePageError("The app asked for access to another server (resource).");
  }
  const [row] = await db
    .insert(oauthRequests)
    .values({
      clientId: client.id,
      redirectUri,
      state: state ?? null,
      codeChallenge: query.code_challenge,
      scope: SCOPE,
      resource: query.resource ?? null,
      expiresAt: new Date(Date.now() + REQUEST_MINUTES * 60_000),
    })
    .returning({ id: oauthRequests.id });
  return `${config().APP_URL}/oauth/consent?request=${row!.id}`;
}

/** A pending request for the consent screen; the first person to open it is the only one who may decide. */
async function pendingRequest(db: DbOrTx, principal: UserPrincipal, id: string) {
  const [row] = await db
    .select({ request: oauthRequests, client: oauthClients })
    .from(oauthRequests)
    .innerJoin(oauthClients, eq(oauthClients.id, oauthRequests.clientId))
    .where(eq(oauthRequests.id, id))
    .for("update", { of: oauthRequests });
  const expired = "This sign-in request expired or does not exist. Start connecting again in the app.";
  if (!row || row.request.expiresAt < new Date()) throw notFound(expired);
  if (row.request.userId && row.request.userId !== principal.id) throw notFound(expired);
  if (row.request.codeHash) throw conflict("This sign-in request was answered already", "request_decided");
  if (!row.request.userId) {
    await db.update(oauthRequests).set({ userId: principal.id }).where(eq(oauthRequests.id, id));
  }
  return row;
}

export async function describeRequest(db: Db, principal: UserPrincipal, id: string): Promise<OauthRequest> {
  return db.transaction(async (tx) => {
    const { request, client } = await pendingRequest(tx, principal, id);
    const document = client.registration === "metadata_document";
    return {
      id: request.id,
      clientName: client.name,
      clientHost: document ? new URL(client.clientId).host : null,
      redirectHost: redirectTarget(request.redirectUri),
      registration: document ? "metadata_document" : "dynamic",
      expiresAt: request.expiresAt.toISOString(),
    };
  });
}

/** Approves or denies a request; returns where the browser goes next. */
export async function decideRequest(
  db: Db,
  principal: UserPrincipal,
  id: string,
  approve: boolean,
): Promise<string> {
  return db.transaction(async (tx) => {
    const { request, client } = await pendingRequest(tx, principal, id);
    const state = request.state ?? undefined;
    if (!approve) {
      await tx.delete(oauthRequests).where(eq(oauthRequests.id, id));
      return errorRedirect(request.redirectUri, "access_denied", "The person did not allow access", state);
    }
    const [existing] = await tx
      .select()
      .from(oauthGrants)
      .where(
        and(
          eq(oauthGrants.userId, principal.id),
          eq(oauthGrants.clientId, client.id),
          isNull(oauthGrants.revokedAt),
        ),
      );
    const grantId = existing
      ? existing.id
      : (
          await tx
            .insert(oauthGrants)
            .values({ clientId: client.id, userId: principal.id, redirectUri: request.redirectUri })
            .returning({ id: oauthGrants.id })
        )[0]!.id;
    if (existing)
      await tx
        .update(oauthGrants)
        .set({ redirectUri: request.redirectUri })
        .where(eq(oauthGrants.id, grantId));
    const code = randomBytes(32).toString("base64url");
    await tx
      .update(oauthRequests)
      .set({ codeHash: hashToken(code), grantId, expiresAt: new Date(Date.now() + CODE_SECONDS * 1000) })
      .where(eq(oauthRequests.id, id));
    logger.info({ grantId, clientId: client.id }, "connected app approved");
    const url = new URL(request.redirectUri);
    url.searchParams.set("code", code);
    if (state) url.searchParams.set("state", state);
    url.searchParams.set("iss", config().APP_URL);
    return url.toString();
  });
}

export type TokenResponse = {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  scope: string;
};

async function issueTokens(
  tx: DbOrTx,
  grant: { id: string; userId: string },
  clientName: string,
): Promise<TokenResponse> {
  const minutes = config().OAUTH_ACCESS_TOKEN_MINUTES;
  const access = await issueCredential(tx, {
    kind: "oauth_access",
    name: clientName,
    userId: grant.userId,
    grantId: grant.id,
    expiresAt: new Date(Date.now() + minutes * 60_000),
  });
  const refresh = await issueCredential(tx, {
    kind: "oauth_refresh",
    name: clientName,
    userId: grant.userId,
    grantId: grant.id,
    expiresAt: new Date(Date.now() + config().OAUTH_REFRESH_TOKEN_DAYS * 86_400_000),
  });
  return {
    access_token: access.secret,
    token_type: "Bearer",
    expires_in: minutes * 60,
    refresh_token: refresh.secret,
    scope: SCOPE,
  };
}

/** Revokes every token of a grant (and optionally the grant itself). */
export async function revokeGrantTokens(tx: DbOrTx, grantId: string, options: { grant: boolean }) {
  await tx
    .update(credentials)
    .set({ revokedAt: sql`now()` })
    .where(and(eq(credentials.grantId, grantId), isNull(credentials.revokedAt)));
  if (options.grant) {
    await tx
      .update(oauthGrants)
      .set({ revokedAt: sql`now()` })
      .where(eq(oauthGrants.id, grantId));
  }
}

async function activeGrant(tx: DbOrTx, grantId: string | null, clientId: string) {
  if (!grantId) return null;
  const [row] = await tx
    .select({ grant: oauthGrants, blockedAt: users.blockedAt, lastSignInAt: users.lastSignInAt })
    .from(oauthGrants)
    .innerJoin(users, eq(users.id, oauthGrants.userId))
    .where(
      and(eq(oauthGrants.id, grantId), eq(oauthGrants.clientId, clientId), isNull(oauthGrants.revokedAt)),
    );
  if (!row || agentAccess(row) !== "allowed") return null;
  return row.grant;
}

/** grant_type=authorization_code: one use, PKCE checked, the same redirect URI. */
export async function exchangeCode(
  db: Db,
  client: ClientRow,
  body: Record<string, string>,
): Promise<TokenResponse> {
  const { code, code_verifier: verifier, redirect_uri: redirectUri } = body;
  if (!code || !verifier) throw new OAuthError(400, "invalid_request", "Send code and code_verifier");
  if (!VERIFIER.test(verifier)) throw new OAuthError(400, "invalid_grant", "Invalid code_verifier");
  const invalid = new OAuthError(400, "invalid_grant", "The code is invalid, expired or used");
  const result = await db.transaction(async (tx) => {
    const [request] = await tx
      .select()
      .from(oauthRequests)
      .where(eq(oauthRequests.codeHash, hashToken(code)))
      .for("update");
    if (!request || request.clientId !== client.id) throw invalid;
    if (redirectUri && redirectUri !== request.redirectUri) {
      throw new OAuthError(400, "invalid_grant", "redirect_uri does not match the authorization request");
    }
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    if (challenge !== request.codeChallenge)
      throw new OAuthError(400, "invalid_grant", "code_verifier does not match");
    // Only a request that proves possession of the verifier can trigger replay revocation.
    if (request.codeUsedAt) return { reusedGrantId: request.grantId };
    if (request.expiresAt < new Date()) throw invalid;
    await tx.update(oauthRequests).set({ codeUsedAt: new Date() }).where(eq(oauthRequests.id, request.id));
    const grant = await activeGrant(tx, request.grantId, client.id);
    if (!grant) throw invalid;
    return { tokens: await issueTokens(tx, grant, client.name) };
  });
  if (result.tokens) return result.tokens;
  // A code used twice may have been stolen: end everything it gave.
  if (result.reusedGrantId) {
    const grantId = result.reusedGrantId;
    await db.transaction((tx) => revokeGrantTokens(tx, grantId, { grant: false }));
    logger.warn({ grantId }, "authorization code reused; its tokens were revoked");
  }
  throw invalid;
}

/**
 * grant_type=refresh_token: rotating; the old refresh token stops working.
 * An old one used again ends every token of its grant (RFC 9700 4.14.2).
 */
export async function refreshTokens(
  db: Db,
  client: ClientRow,
  body: Record<string, string>,
): Promise<TokenResponse> {
  const token = body.refresh_token;
  if (!token) throw new OAuthError(400, "invalid_request", "Send refresh_token");
  const invalid = new OAuthError(400, "invalid_grant", "The refresh token is invalid, expired or used");
  const result = await db.transaction(async (tx) => {
    const [row] = await tx
      .select({
        credential: credentials,
        grantClientId: oauthGrants.clientId,
        grantRevokedAt: oauthGrants.revokedAt,
      })
      .from(credentials)
      .innerJoin(oauthGrants, eq(oauthGrants.id, credentials.grantId))
      .where(and(eq(credentials.tokenHash, hashToken(token)), eq(credentials.kind, "oauth_refresh")))
      .for("update", { of: credentials });
    if (!row || row.grantClientId !== client.id) throw invalid;
    if (row.credential.revokedAt) {
      // Nothing is left to end once the person disconnected the app.
      if (row.grantRevokedAt) throw invalid;
      return { reusedGrantId: row.credential.grantId };
    }
    if (!row.credential.expiresAt || row.credential.expiresAt <= new Date()) throw invalid;
    const grant = await activeGrant(tx, row.credential.grantId, client.id);
    if (!grant) throw invalid;
    await tx.update(credentials).set({ revokedAt: new Date() }).where(eq(credentials.id, row.credential.id));
    return { tokens: await issueTokens(tx, grant, client.name) };
  });
  if (result.tokens) return result.tokens;
  // A refresh token used after it was replaced may have been stolen: end the
  // connection, so connecting again starts a new one the old token cannot reach.
  if (result.reusedGrantId) {
    const grantId = result.reusedGrantId;
    await db.transaction((tx) => revokeGrantTokens(tx, grantId, { grant: true }));
    logger.warn({ grantId }, "refresh token reused; the grant's tokens were revoked");
  }
  throw invalid;
}

/** RFC 7009: revoking a refresh token ends the whole connection; an access token only itself. */
export async function revokeToken(db: Db, client: ClientRow, token: string | undefined) {
  if (!token) return;
  await db.transaction(async (tx) => {
    const [row] = await tx
      .select({ credential: credentials, grantClientId: oauthGrants.clientId })
      .from(credentials)
      .innerJoin(oauthGrants, eq(oauthGrants.id, credentials.grantId))
      .where(eq(credentials.tokenHash, hashToken(token)));
    if (!row || row.grantClientId !== client.id) return;
    if (row.credential.kind === "oauth_refresh") {
      await revokeGrantTokens(tx, row.credential.grantId!, { grant: true });
    } else {
      await tx
        .update(credentials)
        .set({ revokedAt: sql`now()` })
        .where(eq(credentials.id, row.credential.id));
    }
  });
}
