import { and, eq, gt } from "drizzle-orm";
import type { Db } from "../db/client";
import { sessions, users } from "../db/schema";
import { auth } from "./auth";
import { resolveBearer } from "./credentials";
import type { Principal, UserPrincipal } from "./principal";

/** The signed-in person of a browser request (session cookie), or null. */
export async function resolveSession(db: Db, headers: Headers): Promise<UserPrincipal | null> {
  const session = await auth().api.getSession({ headers });
  if (!session) return null;
  // The cookie cache can outlive a revoked session by a minute; check the row.
  const [row] = await db
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      image: users.image,
      isAdmin: users.isAdmin,
      blockedAt: users.blockedAt,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.id, session.session.id), gt(sessions.expiresAt, new Date())));
  if (!row || row.blockedAt) return null;
  return {
    kind: "user",
    id: row.id,
    email: row.email,
    name: row.name,
    image: row.image,
    isAdmin: row.isAdmin,
    channel: "web",
    agent: false,
    clientName: null,
    credentialId: null,
  };
}

/** A bearer token from the Authorization header, if any. */
export function bearerToken(headers: Headers): string | null {
  const value = headers.get("authorization");
  const match = value ? /^Bearer\s+(\S+)\s*$/i.exec(value) : null;
  return match?.[1] ?? null;
}

/**
 * Who makes a request: a bearer token (agents, integrations) when the
 * request has one, else the session cookie. A request with an invalid
 * token is anonymous, even with a cookie.
 */
export async function resolvePrincipal(db: Db, headers: Headers): Promise<Principal | null> {
  const token = bearerToken(headers);
  if (token) return resolveBearer(db, token);
  return resolveSession(db, headers);
}
