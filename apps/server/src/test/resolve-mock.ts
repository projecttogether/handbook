import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { users } from "../db/schema";
import { resolveBearer } from "../auth/credentials";
import type { Principal, UserPrincipal } from "../auth/principal";

/**
 * Sign-in is the OIDC provider's job; API tests act as a person in the web
 * app through the x-test-user header. Bearer tokens work as in production.
 * Use with `vi.mock("../auth/resolve", () => import("../test/resolve-mock"))`.
 */
export function bearerToken(headers: Headers): string | null {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(headers.get("authorization") ?? "");
  return match?.[1] ?? null;
}

export async function resolveSession(db: Db, headers: Headers): Promise<UserPrincipal | null> {
  const id = headers.get("x-test-user");
  if (!id) return null;
  const [user] = await db.select().from(users).where(eq(users.id, id));
  if (!user || user.blockedAt) return null;
  return {
    kind: "user",
    id: user.id,
    email: user.email,
    name: user.name,
    image: null,
    isAdmin: user.isAdmin,
    channel: "web",
    agent: false,
    clientName: null,
    credentialId: null,
  };
}

export async function resolvePrincipal(db: Db, headers: Headers): Promise<Principal | null> {
  const token = bearerToken(headers);
  if (token) return resolveBearer(db, token);
  return resolveSession(db, headers);
}
