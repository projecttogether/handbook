import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq, gt, isNull, lt, or, sql } from "drizzle-orm";
import type { Token } from "@handbook/shared/api/tokens";
import { config } from "../config";
import type { DbOrTx } from "../db/client";
import { credentials, oauthClients, oauthGrants, users } from "../db/schema";
import { AppError } from "../http/errors";
import type { Principal } from "./principal";

/**
 * Credentials of agents and integrations. Only SHA-256 hashes are stored;
 * the token itself is shown once. Prefixes tell the kinds apart:
 *   kn_pat_  personal access token (acts as its owner, as an agent)
 *   kn_svc_  service token (reads only)
 *   kn_at_   access token of a connected app (OAuth)
 *   kn_rt_   refresh token of a connected app (OAuth)
 */
export const CREDENTIAL_PREFIXES = {
  personal: "kn_pat_",
  service: "kn_svc_",
  oauth_access: "kn_at_",
  oauth_refresh: "kn_rt_",
} as const;
export type CredentialKind = keyof typeof CREDENTIAL_PREFIXES;

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Constant-time comparison of two hex hashes. */
export function sameHash(a: string, b: string): boolean {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}

export function newSecret(kind: CredentialKind): string {
  return `${CREDENTIAL_PREFIXES[kind]}${randomBytes(32).toString("base64url")}`;
}

/** The first characters shown in lists, e.g. "kn_pat_Ab3d…". */
export function displayPrefix(secret: string): string {
  return `${secret.slice(0, secret.indexOf("_", 3) + 5)}…`;
}

/** Stores a new credential and returns its secret (shown once). */
export async function issueCredential(
  db: DbOrTx,
  input: {
    kind: CredentialKind;
    name: string;
    userId: string | null;
    grantId?: string | null;
    createdById?: string | null;
    createdByOperator?: boolean;
    expiresAt: Date | null;
  },
): Promise<{ id: string; secret: string }> {
  const secret = newSecret(input.kind);
  const [row] = await db
    .insert(credentials)
    .values({
      kind: input.kind,
      name: input.name,
      tokenHash: hashToken(secret),
      prefix: displayPrefix(secret),
      userId: input.userId,
      grantId: input.grantId ?? null,
      createdById: input.createdById ?? null,
      createdByOperator: input.createdByOperator ?? false,
      expiresAt: input.expiresAt,
    })
    .returning({ id: credentials.id });
  return { id: row!.id, secret };
}

const iso = (value: Date | null) => (value ? value.toISOString() : null);

/** A credential as its lists show it, without its secret. */
export function tokenView(row: typeof credentials.$inferSelect): Token {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: iso(row.lastUsedAt),
    expiresAt: iso(row.expiresAt),
  };
}

/** When a token that lives for `days` ends; null: never. */
export function expiryIn(days: number | null): Date | null {
  return days === null ? null : new Date(Date.now() + days * 86_400_000);
}

const LAST_USED_RESOLUTION_MS = 60_000;

/**
 * Whether a person's agents (personal tokens, connected apps) may act for
 * them: not when the person is blocked, nor when they have not signed in
 * through the provider for AGENT_SIGN_IN_DAYS. So agents stop some days
 * after the provider stops letting the person in. Every place that accepts
 * an agent's credential asks this.
 */
export function agentAccess(
  person: { blockedAt: Date | null; lastSignInAt: Date | null },
  now = new Date(),
): "allowed" | "blocked" | "sign_in_needed" {
  if (person.blockedAt) return "blocked";
  const days = config().AGENT_SIGN_IN_DAYS;
  if (days === 0) return "allowed";
  if (!person.lastSignInAt || now.getTime() - person.lastSignInAt.getTime() > days * 86_400_000) {
    return "sign_in_needed";
  }
  return "allowed";
}

/** The 401 for an agent whose person has to sign in again. */
export function signInNeeded() {
  const { APP_NAME, AGENT_SIGN_IN_DAYS } = config();
  return new AppError(
    401,
    "sign_in_needed",
    `Sign in to ${APP_NAME} again: agents work for ${AGENT_SIGN_IN_DAYS} days after your last sign-in.`,
  );
}

/** Ends all of a person's personal tokens and connected apps for good (blocking). */
export async function revokeAgentAccess(tx: DbOrTx, userId: string) {
  await tx
    .update(credentials)
    .set({ revokedAt: sql`now()` })
    .where(and(eq(credentials.userId, userId), isNull(credentials.revokedAt)));
  await tx
    .update(oauthGrants)
    .set({ revokedAt: sql`now()` })
    .where(and(eq(oauthGrants.userId, userId), isNull(oauthGrants.revokedAt)));
}

/**
 * The principal of a bearer token (`Authorization: Bearer <token>`), or null
 * when it is unknown, expired, revoked, or its person is blocked. Throws
 * `signInNeeded()` when its person has to sign in again (`agentAccess`).
 * Refresh tokens are not accepted here.
 */
export async function resolveBearer(db: DbOrTx, token: string): Promise<Principal | null> {
  const kind = (Object.keys(CREDENTIAL_PREFIXES) as CredentialKind[]).find((candidate) =>
    token.startsWith(CREDENTIAL_PREFIXES[candidate]),
  );
  if (!kind || kind === "oauth_refresh" || token.length > 200) return null;
  const now = new Date();
  const [row] = await db
    .select({
      id: credentials.id,
      kind: credentials.kind,
      name: credentials.name,
      lastUsedAt: credentials.lastUsedAt,
      grantId: credentials.grantId,
      user: {
        id: users.id,
        email: users.email,
        name: users.name,
        image: users.image,
        isAdmin: users.isAdmin,
        blockedAt: users.blockedAt,
        lastSignInAt: users.lastSignInAt,
      },
      clientName: oauthClients.name,
      grantRevokedAt: oauthGrants.revokedAt,
    })
    .from(credentials)
    .leftJoin(users, eq(users.id, credentials.userId))
    .leftJoin(oauthGrants, eq(oauthGrants.id, credentials.grantId))
    .leftJoin(oauthClients, eq(oauthClients.id, oauthGrants.clientId))
    .where(
      and(
        eq(credentials.tokenHash, hashToken(token)),
        eq(credentials.kind, kind),
        isNull(credentials.revokedAt),
        or(isNull(credentials.expiresAt), gt(credentials.expiresAt, now)),
      ),
    );
  if (!row) return null;
  if (!row.lastUsedAt || now.getTime() - row.lastUsedAt.getTime() > LAST_USED_RESOLUTION_MS) {
    await db.update(credentials).set({ lastUsedAt: now }).where(eq(credentials.id, row.id));
    if (row.grantId)
      await db.update(oauthGrants).set({ lastUsedAt: now }).where(eq(oauthGrants.id, row.grantId));
  }
  if (row.kind === "service") return { kind: "service", credentialId: row.id, name: row.name };
  if (!row.user) return null;
  if (row.kind === "oauth_access" && (!row.grantId || row.grantRevokedAt)) return null;
  const access = agentAccess(row.user, now);
  if (access === "blocked") return null;
  if (access === "sign_in_needed") throw signInNeeded();
  return {
    kind: "user",
    id: row.user.id,
    email: row.user.email,
    name: row.user.name,
    image: row.user.image,
    isAdmin: row.user.isAdmin,
    channel: row.kind === "oauth_access" ? "oauth" : "token",
    agent: true,
    clientName: row.kind === "oauth_access" ? (row.clientName ?? "Connected app") : row.name,
    credentialId: row.id,
  };
}

/** Removes credentials that expired more than a week ago. */
export async function pruneExpiredCredentials(db: DbOrTx) {
  await db
    .delete(credentials)
    .where(
      and(lt(credentials.expiresAt, sql`now() - interval '7 days'`), sql`${credentials.kind} like 'oauth_%'`),
    );
}
