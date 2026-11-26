import { and, desc, eq, sql } from "drizzle-orm";
import { config } from "../config";
import { getDb } from "../db/client";
import { accounts, users } from "../db/schema";
import { logger } from "../logger";
import { isEnvironmentAdmin } from "./bootstrap";

/** The claims of a JWT, without checking its signature (the sign-in already verified the ID token). */
export function jwtClaims(token: string | null | undefined): Record<string, unknown> | null {
  const payload = token?.split(".")[1];
  if (!payload) return null;
  try {
    const claims: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return typeof claims === "object" && claims !== null ? (claims as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** A claim by name; a dotted name reads a nested claim, e.g. `realm_access.roles`. */
export function readClaim(claims: Record<string, unknown> | null, name: string): unknown {
  if (!claims) return undefined;
  if (name in claims) return claims[name];
  let value: unknown = claims;
  for (const part of name.split(".")) {
    if (typeof value !== "object" || value === null) return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

/** Group names from a claim value: a list, or one comma-separated string. */
export function claimGroups(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  if (typeof value === "string") {
    return value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

const trimSlashes = (group: string) => group.replace(/^\/+|\/+$/g, "");

/**
 * True when one of `groups` is one of `allowed`, or below it: Keycloak
 * group paths count their subgroups (`/staff` admits `/staff/it`).
 * Leading slashes do not matter.
 */
export function inAllowedGroup(groups: string[], allowed: string[]): boolean {
  const wanted = allowed.map(trimSlashes);
  return groups
    .map(trimSlashes)
    .some((group) => wanted.some((item) => group === item || group.startsWith(`${item}/`)));
}

let userInfoEndpoint: string | null | undefined;

/** The userinfo answer for `subject`; an answer about anyone else is an error. */
async function userInfoClaims(accessToken: string, subject: string): Promise<Record<string, unknown> | null> {
  if (userInfoEndpoint === undefined) {
    const discovery = await fetch(
      `${config().OIDC_ISSUER.replace(/\/+$/, "")}/.well-known/openid-configuration`,
      {
        signal: AbortSignal.timeout(10_000),
      },
    );
    const body = (await discovery.json().catch(() => null)) as { userinfo_endpoint?: unknown } | null;
    userInfoEndpoint = typeof body?.userinfo_endpoint === "string" ? body.userinfo_endpoint : null;
  }
  if (!userInfoEndpoint) return null;
  const response = await fetch(userInfoEndpoint, {
    headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`The provider's userinfo endpoint answered HTTP ${response.status}`);
  const claims = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  // OpenID Connect Core 5.3.2: the answer must be about the person who signed in.
  if (claims?.sub !== subject) throw new Error("The provider's userinfo answer is about another subject");
  return claims;
}

/** The groups of the sign-in: the claim in the ID token, else in the userinfo response. */
async function signInGroups(account: {
  accountId: string;
  idToken: string | null;
  accessToken: string | null;
}): Promise<string[]> {
  const claim = config().OIDC_GROUPS_CLAIM;
  const idClaims = jwtClaims(account.idToken);
  const fromIdToken = readClaim(idClaims, claim);
  if (fromIdToken !== undefined) return claimGroups(fromIdToken);
  if (!account.accessToken) return [];
  const subject = typeof idClaims?.sub === "string" ? idClaims.sub : account.accountId;
  return claimGroups(readClaim(await userInfoClaims(account.accessToken, subject), claim));
}

/**
 * Asked by Better Auth before it creates, links or signs in a person from
 * the provider's answer: the provider must vouch for the email address
 * (`email_verified`). People exist by email before their first sign-in
 * (ADMIN_EMAILS, named editors, former colleagues), and an address someone
 * merely typed in at the provider must not reach them.
 * OIDC_REQUIRE_EMAIL_VERIFIED=false turns this off for providers that do
 * not send the claim.
 */
export function checkProviderUserInfo(user: {
  id?: unknown;
  emailVerified?: unknown;
}): { error: string; errorDescription: string } | undefined {
  if (!config().OIDC_REQUIRE_EMAIL_VERIFIED || user.emailVerified === true) return undefined;
  logger.info(
    { userId: typeof user.id === "string" ? user.id : undefined },
    "sign-in refused: email address not verified by the provider",
  );
  return {
    error: "email_not_verified",
    errorDescription: "The provider has not verified this email address",
  };
}

/**
 * Decides at every sign-in whether a person may use the app: not blocked,
 * an allowed email domain (ALLOWED_EMAIL_DOMAINS) and in an allowed group
 * (ACCESS_GROUPS). Admins from ADMIN_EMAILS always may. Returns false to
 * refuse the session. The provider's tokens are needed only for this
 * check: afterwards none are kept.
 */
export async function checkAccessAtSignIn(userId: string): Promise<boolean> {
  try {
    return await mayUseApp(userId);
  } finally {
    await getDb()
      .update(accounts)
      .set({ accessToken: null, refreshToken: null, idToken: null })
      .where(eq(accounts.userId, userId))
      .catch((error: unknown) =>
        logger.warn({ err: error, userId }, "could not remove the provider's tokens"),
      );
  }
}

async function mayUseApp(userId: string): Promise<boolean> {
  const db = getDb();
  const [user] = await db.select().from(users).where(eq(users.id, userId));
  if (!user) return false;
  if (isEnvironmentAdmin(user.email)) {
    await db
      .update(users)
      .set({ isAdmin: true, adminSource: "environment", blockedAt: null, updatedAt: sql`now()` })
      .where(eq(users.id, userId));
    return true;
  }
  if (user.blockedAt) {
    logger.info({ userId }, "sign-in refused: blocked");
    return false;
  }
  const domains = config().allowedEmailDomains;
  const domain = user.email.slice(user.email.lastIndexOf("@") + 1).toLowerCase();
  if (domains.length > 0 && !domains.includes(domain)) {
    logger.info({ userId }, "sign-in refused: email domain not allowed");
    return false;
  }
  const groups = config().accessGroups;
  if (groups.length > 0) {
    const [account] = await db
      .select({ accountId: accounts.accountId, idToken: accounts.idToken, accessToken: accounts.accessToken })
      .from(accounts)
      .where(and(eq(accounts.userId, userId), eq(accounts.providerId, "oidc")))
      .orderBy(desc(accounts.updatedAt))
      .limit(1);
    if (!account) return false;
    try {
      if (!inAllowedGroup(await signInGroups(account), groups)) {
        logger.info({ userId }, "sign-in refused: not in ACCESS_GROUPS");
        return false;
      }
    } catch (error) {
      logger.warn({ err: error, userId }, "sign-in refused: could not read the groups");
      return false;
    }
  }
  return true;
}
