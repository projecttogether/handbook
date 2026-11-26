import { and, asc, count, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import type {
  Space,
  SpaceCreate,
  SpaceMember,
  SpaceMemberPut,
  SpaceSummary,
  SpaceUpdate,
} from "@handbook/shared/api/spaces";
import { parsePageFile, spaceSchemaProblems, type SpaceSchema } from "@handbook/shared/page";
import { SPACE_TEMPLATES, starterPageFiles, templateSchema } from "@handbook/shared/space-templates";
import { spaceRoleSchema } from "@handbook/shared/roles";
import type { Db, DbOrTx } from "../db/client";
import { changeSets, pages, spaceMembers, spaces, users } from "../db/schema";
import type { Principal, UserPrincipal } from "../auth/principal";
import { audit } from "../core/audit";
import { conflict, forbidden, notFound, validationError } from "../http/errors";
import { markFilesUsed } from "../files/storage";
import { authorOf, createLivePage } from "../pages/core";
import { abilitiesOf, requireAbility, type SpaceContext, type SpaceRow } from "./access";
import { spaceVisibility, visibilityOf, type Visibility } from "./visibility";

const iso = (value: Date) => value.toISOString();

/** The columns of `pages p` for the visibility conditions. */
// The subqueries below write "spaces" out: Drizzle leaves column names
// unqualified in single-table selects, and inside them "id" would mean p.id.
const pageAlias = {
  spaceId: sql`p.space_id`,
  status: sql`p.status`,
  deletedAt: sql`p.deleted_at`,
  path: sql`p.path`,
};

/** The latest change of a space as the viewer sees it: itself, or a page it may see (live or in the trash). */
function lastChange(visibility: Visibility) {
  // greatest() skips the nulls of spaces without such pages.
  return sql<Date>`greatest("spaces"."updated_at",
    (select max(p.updated_at) from pages p where p.space_id = "spaces"."id" and ${visibility.livePages(pageAlias)}),
    (select max(p.updated_at) from pages p where p.space_id = "spaces"."id" and ${visibility.trashedPages(pageAlias)}))`;
}

/** The live pages of a space the viewer may see. */
function livePageCount(visibility: Visibility) {
  return sql<number>`(select count(*) from pages p where p.space_id = "spaces"."id" and ${visibility.livePages(pageAlias)})::int`;
}

export async function listSpaces(
  db: DbOrTx,
  principal: Principal,
  archived: "include" | "only" | "exclude",
): Promise<SpaceSummary[]> {
  const isAdmin = principal.kind === "user" && principal.isAdmin && !principal.agent;
  const filter =
    !isAdmin || archived === "exclude"
      ? isNull(spaces.archivedAt)
      : archived === "only"
        ? isNotNull(spaces.archivedAt)
        : sql`true`;
  const visibility = await visibilityOf(db, principal);
  const rows = await db
    .select({ space: spaces, pageCount: livePageCount(visibility), updatedAt: lastChange(visibility) })
    .from(spaces)
    .where(filter)
    .orderBy(asc(spaces.name));
  const roles = await membershipRoles(db, principal);
  return rows.map((row) => ({
    id: row.space.id,
    slug: row.space.slug,
    name: row.space.name,
    description: row.space.description,
    archived: row.space.archivedAt !== null,
    pageCount: row.pageCount,
    myRole: roles.get(row.space.id) ?? null,
    updatedAt: iso(new Date(row.updatedAt)),
  }));
}

async function membershipRoles(db: DbOrTx, principal: Principal) {
  const roles = new Map<string, "owner" | "editor">();
  if (principal.kind !== "user") return roles;
  const rows = await db.select().from(spaceMembers).where(eq(spaceMembers.userId, principal.id));
  for (const row of rows) {
    const role = spaceRoleSchema.safeParse(row.role);
    if (role.success) roles.set(row.spaceId, role.data);
  }
  return roles;
}

export async function spaceView(db: DbOrTx, principal: Principal, context: SpaceContext): Promise<Space> {
  const { space } = context;
  const visibility = spaceVisibility(context);
  const [counts] = await db
    .select({ pageCount: livePageCount(visibility), updatedAt: lastChange(visibility) })
    .from(spaces)
    .where(eq(spaces.id, space.id));
  const [open] = await db
    .select({ value: count() })
    .from(changeSets)
    .where(
      and(
        eq(changeSets.spaceId, space.id),
        inArray(changeSets.status, ["open", "in_review"]),
        visibility.changeSets(),
      ),
    );
  return {
    id: space.id,
    slug: space.slug,
    name: space.name,
    description: space.description,
    archived: space.archivedAt !== null,
    pageCount: counts?.pageCount ?? 0,
    myRole: context.role,
    updatedAt: iso(new Date(counts?.updatedAt ?? space.updatedAt)),
    properties: space.properties,
    pageTypes: space.pageTypes,
    abilities: abilitiesOf(principal, context.role, space),
    openChangeSets: open?.value ?? 0,
    createdAt: iso(space.createdAt),
  };
}

/** Creates a space with its template's properties, page types and starter pages. */
export async function createSpace(db: Db, actor: UserPrincipal, input: SpaceCreate): Promise<SpaceRow> {
  const [existing] = await db.select({ id: spaces.id }).from(spaces).where(eq(spaces.slug, input.slug));
  if (existing) throw conflict(`A space with the URL name “${input.slug}” exists already`, "slug_taken");
  const schema = templateSchema(input.template);
  return db.transaction(async (tx) => {
    const [space] = await tx
      .insert(spaces)
      .values({ slug: input.slug, name: input.name, description: input.description, ...schema })
      .returning();
    await markFilesUsed(tx, [input.description]);
    await audit(tx, actor, {
      action: "space.created",
      entityType: "space",
      entityId: space!.id,
      summary: `Created the space ${input.name} (${input.slug}) from the ${SPACE_TEMPLATES[input.template].label} template`,
    });
    for (const starter of starterPageFiles(input.template)) {
      await createLivePage(tx, {
        space: space!,
        parentPath: null,
        slug: starter.slug,
        markdown: starter.markdown,
        author: authorOf(actor, "web"),
      });
    }
    return space!;
  });
}

/** Live pages that do not fit a schema (titles, at most 10). */
async function pagesNotFitting(db: DbOrTx, spaceId: string, schema: SpaceSchema): Promise<string[]> {
  const rows = await db
    .select({ title: pages.title, markdown: pages.markdown })
    .from(pages)
    .where(and(eq(pages.spaceId, spaceId), isNull(pages.deletedAt)))
    .orderBy(asc(pages.path));
  const failing: string[] = [];
  for (const row of rows) {
    if (!parsePageFile(row.markdown, schema).ok) failing.push(row.title);
    if (failing.length >= 10) break;
  }
  return failing;
}

export async function updateSpace(db: Db, actor: UserPrincipal, context: SpaceContext, input: SpaceUpdate) {
  requireAbility(context, "manage");
  return db.transaction(async (tx) => {
    // Locked: page writes check files against the space under a shared lock
    // (pages/core.ts), so none is half done while the live pages are checked.
    const [space] = await tx.select().from(spaces).where(eq(spaces.id, context.space.id)).for("update");
    if (!space) throw notFound("No such space");
    const schema: SpaceSchema = {
      properties: input.properties ?? space.properties,
      pageTypes: input.pageTypes ?? space.pageTypes,
    };
    const problems = spaceSchemaProblems(schema);
    if (Object.keys(problems).length > 0) throw validationError(problems);
    if (input.properties !== undefined || input.pageTypes !== undefined) {
      const failing = await pagesNotFitting(tx, space.id, schema);
      if (failing.length > 0) {
        const message = `These pages do not fit the new properties or page types: ${failing.join(", ")}. Change them first.`;
        throw validationError({ properties: message }, message);
      }
    }
    const [updated] = await tx
      .update(spaces)
      .set({
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.properties !== undefined ? { properties: input.properties } : {}),
        ...(input.pageTypes !== undefined ? { pageTypes: input.pageTypes } : {}),
        updatedAt: sql`now()`,
      })
      .where(eq(spaces.id, space.id))
      .returning();
    await markFilesUsed(tx, [
      input.description,
      ...(input.pageTypes ?? []).map((pageType) => pageType.template),
    ]);
    const changed = Object.keys(input).filter((key) => input[key as keyof SpaceUpdate] !== undefined);
    await audit(tx, actor, {
      action: "space.updated",
      entityType: "space",
      entityId: space.id,
      summary: `Changed ${changed.join(", ") || "nothing"} of the space ${space.name}`,
    });
    return updated!;
  });
}

export async function setArchived(db: Db, actor: UserPrincipal, space: SpaceRow, archived: boolean) {
  return db.transaction(async (tx) => {
    const [updated] = await tx
      .update(spaces)
      .set({ archivedAt: archived ? sql`now()` : null, updatedAt: sql`now()` })
      .where(eq(spaces.id, space.id))
      .returning();
    await audit(tx, actor, {
      action: archived ? "space.archived" : "space.unarchived",
      entityType: "space",
      entityId: space.id,
      summary: `${archived ? "Archived" : "Restored"} the space ${space.name}`,
    });
    return updated!;
  });
}

export async function listMembers(db: DbOrTx, spaceId: string): Promise<SpaceMember[]> {
  const rows = await db
    .select({ member: spaceMembers, user: users })
    .from(spaceMembers)
    .innerJoin(users, eq(users.id, spaceMembers.userId))
    .where(eq(spaceMembers.spaceId, spaceId))
    .orderBy(asc(spaceMembers.role), asc(users.email));
  return rows.flatMap((row) => {
    const role = spaceRoleSchema.safeParse(row.member.role);
    if (!role.success) return [];
    return [
      {
        userId: row.user.id,
        email: row.user.email,
        name: row.user.name || row.user.email,
        role: role.data,
        signedIn: row.user.lastSignInAt !== null,
      },
    ];
  });
}

/**
 * Adds a person by email (also before their first sign-in) or changes their
 * role. Owners choose editors; only admins add, change or remove owners.
 */
export async function putMember(db: Db, actor: UserPrincipal, context: SpaceContext, input: SpaceMemberPut) {
  requireAbility(context, "manage");
  const { space } = context;
  const email = input.email.toLowerCase();
  return db.transaction(async (tx) => {
    await tx.insert(users).values({ email, name: "" }).onConflictDoNothing({ target: users.email });
    const [user] = await tx.select().from(users).where(eq(users.email, email));
    const [current] = await tx
      .select()
      .from(spaceMembers)
      .where(and(eq(spaceMembers.spaceId, space.id), eq(spaceMembers.userId, user!.id)));
    if ((input.role === "owner" || current?.role === "owner") && !context.abilities.manageOwners) {
      throw forbidden("Only admins can choose owners");
    }
    await tx
      .insert(spaceMembers)
      .values({ spaceId: space.id, userId: user!.id, role: input.role })
      .onConflictDoUpdate({ target: [spaceMembers.spaceId, spaceMembers.userId], set: { role: input.role } });
    await audit(tx, actor, {
      action: "space.member_set",
      entityType: "space",
      entityId: space.id,
      summary: `Made ${email} ${input.role} of the space ${space.name}`,
    });
  });
}

export async function removeMember(db: Db, actor: UserPrincipal, context: SpaceContext, userId: string) {
  requireAbility(context, "manage");
  const { space } = context;
  await db.transaction(async (tx) => {
    const [current] = await tx
      .select({ member: spaceMembers, email: users.email })
      .from(spaceMembers)
      .innerJoin(users, eq(users.id, spaceMembers.userId))
      .where(and(eq(spaceMembers.spaceId, space.id), eq(spaceMembers.userId, userId)));
    if (!current) throw notFound("This person is not an owner or editor of the space");
    if (current.member.role === "owner" && !context.abilities.manageOwners) {
      throw forbidden("Only admins can choose owners");
    }
    await tx
      .delete(spaceMembers)
      .where(and(eq(spaceMembers.spaceId, space.id), eq(spaceMembers.userId, userId)));
    await audit(tx, actor, {
      action: "space.member_removed",
      entityType: "space",
      entityId: space.id,
      summary: `Removed ${current.email} from the space ${space.name}`,
    });
  });
}
