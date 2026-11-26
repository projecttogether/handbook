import { and, asc, eq, ilike, isNull, notLike, or, sql } from "drizzle-orm";
import type { Person, PersonUpdate } from "@handbook/shared/api/users";
import {
  normalizeTag,
  readFrontmatterValues,
  splitFrontmatter,
  withFrontmatter,
} from "@handbook/shared/page";
import { spaceRoleSchema } from "@handbook/shared/roles";
import type { Db } from "../db/client";
import { pages, sessions, spaceMembers, spaces, users } from "../db/schema";
import type { UserPrincipal } from "../auth/principal";
import { revokeAgentAccess } from "../auth/credentials";
import { audit } from "../core/audit";
import { AppError, conflict, notFound, validationError } from "../http/errors";
import { getSpaceById } from "../spaces/access";
import { authorOf, lockPage, saveLivePage } from "../pages/core";
import { isRemoved, REMOVED_EMAIL_DOMAIN } from "./remove";

const iso = (value: Date | null) => (value ? value.toISOString() : null);

function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, "\\$&");
}

export async function listPeople(db: Db, q: string | undefined): Promise<Person[]> {
  const rows = await db
    .select()
    .from(users)
    .where(
      and(
        notLike(users.email, `%@${REMOVED_EMAIL_DOMAIN}`),
        q ? or(ilike(users.email, `%${escapeLike(q)}%`), ilike(users.name, `%${escapeLike(q)}%`)) : undefined,
      ),
    )
    .orderBy(asc(users.email))
    .limit(500);
  const memberships = await db
    .select({ userId: spaceMembers.userId, role: spaceMembers.role, slug: spaces.slug, name: spaces.name })
    .from(spaceMembers)
    .innerJoin(spaces, eq(spaces.id, spaceMembers.spaceId))
    .orderBy(asc(spaces.name));
  return rows.map((user) => ({
    id: user.id,
    email: user.email,
    name: user.name || user.email,
    isAdmin: user.isAdmin,
    adminSource: user.isAdmin ? (user.adminSource === "environment" ? "environment" : "app") : null,
    blocked: user.blockedAt !== null,
    spaces: memberships.flatMap((row) => {
      const role = spaceRoleSchema.safeParse(row.role);
      return row.userId === user.id && role.success
        ? [{ slug: row.slug, name: row.name, role: role.data }]
        : [];
    }),
    lastSignInAt: iso(user.lastSignInAt),
    createdAt: user.createdAt.toISOString(),
  }));
}

/**
 * Makes a person admin or not, blocks or unblocks them. People listed in
 * ADMIN_EMAILS stay admins; nobody changes their own admin rights or blocks
 * themselves. Blocking ends their sessions and revokes their personal
 * tokens and connected apps for good: unblocking does not bring them back.
 */
export async function updatePerson(
  db: Db,
  actor: UserPrincipal,
  userId: string,
  input: PersonUpdate,
): Promise<Person> {
  await db.transaction(async (tx) => {
    const [user] = await tx.select().from(users).where(eq(users.id, userId)).for("update");
    if (!user || isRemoved(user)) throw notFound("No such person");
    if (user.id === actor.id && (input.isAdmin === false || input.blocked === true)) {
      throw conflict("You cannot remove your own admin rights or block yourself", "self_change");
    }
    if (user.adminSource === "environment" && (input.isAdmin === false || input.blocked === true)) {
      throw conflict("This person is an admin through ADMIN_EMAILS; change it there", "environment_admin");
    }
    const changes: string[] = [];
    const set: Partial<typeof users.$inferInsert> = {};
    if (input.isAdmin !== undefined && input.isAdmin !== user.isAdmin) {
      set.isAdmin = input.isAdmin;
      set.adminSource = input.isAdmin ? "app" : null;
      changes.push(
        input.isAdmin ? `Made ${user.email} an admin` : `Removed the admin rights of ${user.email}`,
      );
    }
    if (input.blocked !== undefined && input.blocked !== (user.blockedAt !== null)) {
      set.blockedAt = input.blocked ? new Date() : null;
      changes.push(`${input.blocked ? "Blocked" : "Unblocked"} ${user.email}`);
      if (input.blocked) {
        await tx.delete(sessions).where(eq(sessions.userId, user.id));
        await revokeAgentAccess(tx, user.id);
      }
    }
    if (changes.length === 0) return;
    await tx
      .update(users)
      .set({ ...set, updatedAt: sql`now()` })
      .where(eq(users.id, user.id));
    await audit(tx, actor, {
      action: "person.updated",
      entityType: "user",
      entityId: user.id,
      summary: changes.join("; "),
    });
  });
  const [person] = (await listPeople(db, undefined)).filter((item) => item.id === userId);
  return person!;
}

/**
 * Renames a tag on every live page (an existing tag merges the two). Each
 * changed page gets a revision.
 */
export async function renameTag(db: Db, actor: UserPrincipal, input: { from: string; to: string }) {
  const from = normalizeTag(input.from);
  const to = normalizeTag(input.to);
  if (from === to) throw validationError({ to: "Choose a different name" }, "Choose a different name");
  const rows = await db
    .select({ id: pages.id })
    .from(pages)
    .where(and(isNull(pages.deletedAt), sql`${from} = any(${pages.tags})`));
  let changed = 0;
  let skipped = 0;
  for (const row of rows) {
    await db
      .transaction(async (tx) => {
        const page = await lockPage(tx, row.id);
        const space = await getSpaceById(tx, page.spaceId);
        const parts = splitFrontmatter(page.markdown);
        const read = parts ? readFrontmatterValues(parts.yaml) : null;
        if (!parts || !read || "error" in read) return;
        const tags = (Array.isArray(read.values.tags) ? read.values.tags : [read.values.tags])
          .filter((tag): tag is string => typeof tag === "string")
          .map((tag) => (normalizeTag(tag) === from ? to : tag));
        const markdown = withFrontmatter(page.markdown, { ...read.values, tags: [...new Set(tags)] });
        const result = await saveLivePage(tx, {
          space,
          page,
          markdown,
          baseRevision: page.revision,
          author: authorOf(actor, "api", { message: `Renamed the tag “${from}” to “${to}”` }),
        });
        if (result.changed) changed += 1;
      })
      .catch((error: unknown) => {
        // A page that no longer fits its space's properties keeps its tags.
        if (error instanceof AppError && error.status === 422) skipped += 1;
        else throw error;
      });
  }
  await audit(db, actor, {
    action: "tag.renamed",
    entityType: "tag",
    entityId: to,
    summary: `Renamed the tag “${from}” to “${to}” on ${changed} pages`,
  });
  return { changed, skipped };
}
