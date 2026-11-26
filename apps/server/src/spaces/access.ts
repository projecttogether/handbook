import { and, eq } from "drizzle-orm";
import type { SpaceSchema } from "@handbook/shared/page";
import { spaceAbilities, spaceRoleSchema, type Abilities, type SpaceRole } from "@handbook/shared/roles";
import type { DbOrTx } from "../db/client";
import { spaceMembers, spaces } from "../db/schema";
import type { Principal } from "../auth/principal";
import { forbidden, notFound } from "../http/errors";

export type SpaceRow = typeof spaces.$inferSelect;

/** The properties and page types pages of a space are checked against. */
export function schemaOf(space: Pick<SpaceRow, "properties" | "pageTypes">): SpaceSchema {
  return { properties: space.properties, pageTypes: space.pageTypes };
}

/** A space by slug; 404 when unknown. Archived spaces are returned (read-only). */
export async function getSpace(db: DbOrTx, slug: string): Promise<SpaceRow> {
  const [space] = await db.select().from(spaces).where(eq(spaces.slug, slug));
  if (!space) throw notFound("No such space");
  return space;
}

export async function getSpaceById(db: DbOrTx, id: string): Promise<SpaceRow> {
  const [space] = await db.select().from(spaces).where(eq(spaces.id, id));
  if (!space) throw notFound("No such space");
  return space;
}

/** A stored membership role; null for anything that is not one (a reader). */
export function roleFrom(value: unknown): SpaceRole | null {
  return spaceRoleSchema.safeParse(value).data ?? null;
}

/** The principal's role in a space: owner, editor, or null (reader). */
export async function spaceRoleOf(
  db: DbOrTx,
  principal: Principal,
  spaceId: string,
): Promise<SpaceRole | null> {
  if (principal.kind !== "user") return null;
  const [row] = await db
    .select({ role: spaceMembers.role })
    .from(spaceMembers)
    .where(and(eq(spaceMembers.spaceId, spaceId), eq(spaceMembers.userId, principal.id)));
  return roleFrom(row?.role);
}

export function abilitiesOf(
  principal: Principal,
  role: SpaceRole | null,
  space: Pick<SpaceRow, "archivedAt">,
): Abilities {
  if (principal.kind === "service") {
    return spaceAbilities({ isAdmin: false, role: null, agent: true, readOnly: true });
  }
  return spaceAbilities({
    isAdmin: principal.isAdmin,
    role,
    agent: principal.agent,
    readOnly: false,
    archived: space.archivedAt !== null,
  });
}

export type SpaceContext = {
  space: SpaceRow;
  role: SpaceRole | null;
  abilities: Abilities;
  schema: SpaceSchema;
};

/** A space with what the principal may do in it. */
export async function spaceContext(
  db: DbOrTx,
  principal: Principal,
  space: SpaceRow | string,
): Promise<SpaceContext> {
  const row = typeof space === "string" ? await getSpace(db, space) : space;
  const role = await spaceRoleOf(db, principal, row.id);
  return { space: row, role, abilities: abilitiesOf(principal, role, row), schema: schemaOf(row) };
}

const ABILITY_MESSAGES: Record<keyof Abilities, string> = {
  editLive: "Only editors of this space can change pages directly. Suggest the change as a change set.",
  review: "Only editors of this space can do this",
  manage: "Only owners of this space can do this",
  manageOwners: "Only admins can choose owners",
  propose: "You cannot suggest changes here",
  seeDrafts: "Only editors of this space see drafts",
};

/** 403 unless the principal has this ability. Agents get a hint to use change sets. */
export function requireAbility(context: SpaceContext, ability: keyof Abilities) {
  if (context.abilities[ability]) return;
  if (context.space.archivedAt && ability !== "manage" && ability !== "manageOwners") {
    throw forbidden("This space is archived; it can only be read");
  }
  throw forbidden(ABILITY_MESSAGES[ability]);
}
