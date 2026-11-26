import { and, desc, eq, isNull } from "drizzle-orm";
import type { ServiceToken, TokenCreate, TokenCreated } from "@handbook/shared/api/tokens";
import type { Db } from "../db/client";
import { credentials, users } from "../db/schema";
import { audit } from "../core/audit";
import { notFound } from "../http/errors";
import { expiryIn, issueCredential, tokenView } from "./credentials";
import { isOperator, type Actor } from "./principal";

/*
 * Read-only service tokens for integrations. The admin page
 * (modules/tokens.ts) and the operator command (cli/tokens.ts) call these.
 */

/** Who created a token that was made with the operator command. */
const OPERATOR_LABEL = "Operator";

/** The service tokens that are not revoked, newest first. */
export async function listServiceTokens(db: Db): Promise<ServiceToken[]> {
  const rows = await db
    .select({ credential: credentials, createdBy: users.email })
    .from(credentials)
    .leftJoin(users, eq(users.id, credentials.createdById))
    .where(and(eq(credentials.kind, "service"), isNull(credentials.revokedAt)))
    .orderBy(desc(credentials.createdAt));
  return rows.map((row) => ({
    ...tokenView(row.credential),
    createdBy: row.credential.createdByOperator ? OPERATOR_LABEL : row.createdBy,
  }));
}

/** A new token; `secret` is shown once and never stored. */
export async function createServiceToken(
  db: Db,
  actor: Actor,
  input: TokenCreate,
): Promise<ServiceToken & TokenCreated> {
  const user = isOperator(actor) ? null : actor;
  const created = await db.transaction(async (tx) => {
    const issued = await issueCredential(tx, {
      kind: "service",
      name: input.name,
      userId: null,
      createdById: user?.id ?? null,
      createdByOperator: isOperator(actor),
      expiresAt: expiryIn(input.expiresInDays),
    });
    await audit(tx, actor, {
      action: "service_token.create",
      entityType: "service_token",
      entityId: issued.id,
      summary: `Created the service token “${input.name}”`,
    });
    return issued;
  });
  const [row] = await db.select().from(credentials).where(eq(credentials.id, created.id));
  return { ...tokenView(row!), createdBy: user?.email ?? OPERATOR_LABEL, secret: created.secret };
}

/** Ends a token for good; answers its name. */
export async function revokeServiceToken(db: Db, actor: Actor, id: string): Promise<string> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(credentials)
      .set({ revokedAt: new Date() })
      .where(and(eq(credentials.id, id), eq(credentials.kind, "service"), isNull(credentials.revokedAt)))
      .returning({ id: credentials.id, name: credentials.name });
    if (!row) throw notFound("No such service token");
    await audit(tx, actor, {
      action: "service_token.revoke",
      entityType: "service_token",
      entityId: row.id,
      summary: `Revoked the service token “${row.name}”`,
    });
    return row.name;
  });
}
