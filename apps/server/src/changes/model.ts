import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { readFrontmatterValues, splitFrontmatter } from "@handbook/shared/page";
import type { ChangeSetEventKind, ChangeSetStatus } from "@handbook/shared/api/changes";
import type { DbOrTx } from "../db/client";
import { changeSetEvents, changeSetItems, changeSets, pageRevisions, pages, users } from "../db/schema";
import type { Principal, UserPrincipal } from "../auth/principal";
import { forbidden, notFound } from "../http/errors";
import { markFilesUsed } from "../files/storage";
import { getSpaceById, spaceContext, type SpaceContext } from "../spaces/access";
import { spaceVisibility } from "../spaces/visibility";
import type { PageRow } from "../pages/core";

/**
 * Shared pieces of the change set service: loading a change set with what
 * the principal may do with it, the effective view of pages inside it, and
 * the timeline.
 */

export type ChangeSetRow = typeof changeSets.$inferSelect;
export type ItemRow = typeof changeSetItems.$inferSelect;
export type ItemAction = "create" | "update" | "delete";

export const ACTIVE_STATUSES: ChangeSetStatus[] = ["open", "in_review"];

export type ChangeSetAccess = {
  changeSet: ChangeSetRow;
  context: SpaceContext;
  /** The principal as a person (null for service tokens). */
  user: UserPrincipal | null;
  isAuthor: boolean;
  /** Change pages, title and description. */
  edit: boolean;
  submit: boolean;
  review: boolean;
  merge: boolean;
  close: boolean;
  reopen: boolean;
  revert: boolean;
  comment: boolean;
};

export function accessOf(
  principal: Principal,
  changeSet: ChangeSetRow,
  context: SpaceContext,
): ChangeSetAccess {
  const user = principal.kind === "user" ? principal : null;
  const isAuthor = user !== null && changeSet.authorId === user.id;
  const active = ACTIVE_STATUSES.includes(changeSet.status as ChangeSetStatus);
  const archived = context.space.archivedAt !== null;
  const review = context.abilities.review;
  const edit = user !== null && active && !archived && (isAuthor || review);
  return {
    changeSet,
    context,
    user,
    isAuthor,
    edit,
    submit: edit && changeSet.status === "open",
    review: review && changeSet.status === "in_review",
    merge: review && active,
    close: user !== null && active && !archived && (isAuthor || review),
    reopen: user !== null && changeSet.status === "closed" && !archived && (isAuthor || review),
    revert: review && changeSet.status === "merged" && changeSet.revertedById === null,
    comment: user !== null && !archived,
  };
}

/** A change set by number with the principal's access; 404 when unknown, 403 for service tokens. */
export async function loadChangeSet(
  db: DbOrTx,
  principal: Principal,
  number: number,
  options: { forUpdate?: boolean } = {},
): Promise<ChangeSetAccess> {
  if (principal.kind !== "user") throw forbidden("Service tokens cannot use change sets");
  const query = db.select().from(changeSets).where(eq(changeSets.number, number));
  const [changeSet] = options.forUpdate ? await query.for("update") : await query;
  if (!changeSet) throw notFound("No such change set");
  const space = await getSpaceById(db, changeSet.spaceId);
  const context = await spaceContext(db, principal, space);
  // Drafts and the pages below them are only for the space's editors: so are change sets that change them.
  if (!(await spaceVisibility(context).canSeeChangeSet(db, changeSet))) {
    throw notFound("No such change set");
  }
  return accessOf(principal, changeSet, context);
}

/** A live page the principal may not see (for readers a draft or a page below one) counts as missing. */
export async function visibleLive(
  db: DbOrTx,
  access: ChangeSetAccess,
  live: PageRow | null,
): Promise<PageRow | null> {
  return live && !(await spaceVisibility(access.context).canSeePage(db, live)) ? null : live;
}

export function requireAccess(
  access: ChangeSetAccess,
  what: Exclude<keyof ChangeSetAccess, "changeSet" | "context" | "user" | "isAuthor">,
) {
  if (access[what]) return;
  // Archived spaces are read-only: no changes, comments or status changes.
  if (access.context.space.archivedAt) throw forbidden("This space is archived; it can only be read");
  const status = access.changeSet.status;
  if (what === "edit" || what === "submit" || what === "close") {
    if (!ACTIVE_STATUSES.includes(status as ChangeSetStatus)) {
      throw forbidden(status === "merged" ? "This change set is merged" : "This change set is closed");
    }
    throw forbidden("Only its author and editors of this space can change this change set");
  }
  if (what === "reopen") throw forbidden("Only its author and editors of this space can reopen it");
  if (what === "revert") {
    if (status !== "merged") throw forbidden("Only merged change sets can be reverted");
    if (access.changeSet.revertedById) throw forbidden("This change set was reverted already");
  }
  if (access.user?.agent) throw forbidden("Agents cannot do this; a person reviews and merges change sets");
  if (what === "review" && status !== "in_review") throw forbidden("This change set is not in review");
  throw forbidden("Only editors of this space can do this");
}

/** The title in a page file's frontmatter, if readable. */
export function titleOf(markdown: string | null | undefined): string | null {
  if (!markdown) return null;
  const parts = splitFrontmatter(markdown);
  if (!parts) return null;
  const read = readFrontmatterValues(parts.yaml);
  if ("error" in read) return null;
  const title = read.values.title;
  return typeof title === "string" && title.trim() ? title.trim() : null;
}

export async function itemsOf(db: DbOrTx, changeSetId: string): Promise<ItemRow[]> {
  return db
    .select()
    .from(changeSetItems)
    .where(eq(changeSetItems.changeSetId, changeSetId))
    .orderBy(asc(changeSetItems.path));
}

/** The pages (live or deleted) that items refer to, by id. */
export async function pagesOf(db: DbOrTx, ids: string[]): Promise<Map<string, PageRow>> {
  if (ids.length === 0) return new Map();
  const rows = await db.select().from(pages).where(inArray(pages.id, ids));
  return new Map(rows.map((row) => [row.id, row]));
}

/** A live page of the space by id; null when unknown or deleted. */
export async function livePageById(db: DbOrTx, spaceId: string, pageId: string): Promise<PageRow | null> {
  const [page] = await db
    .select()
    .from(pages)
    .where(and(eq(pages.id, pageId), eq(pages.spaceId, spaceId), isNull(pages.deletedAt)));
  return page ?? null;
}

/**
 * The page a path names inside a change set: an item with that path (or a
 * delete item of the live page there), else the live page at the path,
 * unless the change set moved it away.
 */
export async function resolveInChangeSet(
  db: DbOrTx,
  changeSet: ChangeSetRow,
  path: string,
): Promise<{ item: ItemRow | null; live: PageRow | null }> {
  const items = await itemsOf(db, changeSet.id);
  const paths = await effectivePaths(db, items);
  const item = items.find((candidate) => paths.get(candidate.pageId) === path);
  if (item) {
    const live = item.action === "create" ? null : await livePageById(db, changeSet.spaceId, item.pageId);
    return { item, live };
  }
  const [live] = await db
    .select()
    .from(pages)
    .where(and(eq(pages.spaceId, changeSet.spaceId), eq(pages.path, path), isNull(pages.deletedAt)));
  if (!live) return { item: null, live: null };
  // A live page with an item elsewhere was moved away by this change set.
  if (items.some((candidate) => candidate.pageId === live.id)) return { item: null, live: null };
  return { item: null, live };
}

export async function addEvent(
  db: DbOrTx,
  changeSet: ChangeSetRow,
  principal: UserPrincipal,
  event: {
    kind: ChangeSetEventKind;
    body?: string | null;
    page?: { id: string; path: string; title: string } | null;
  },
) {
  await db.insert(changeSetEvents).values({
    changeSetId: changeSet.id,
    kind: event.kind,
    actorId: principal.id,
    clientName: principal.clientName,
    body: event.body ?? null,
    pageId: event.page?.id ?? null,
    pagePath: event.page?.path ?? null,
    pageTitle: event.page?.title ?? null,
  });
  await markFilesUsed(db, [event.body]);
}

export type ActorRow = { id: string; name: string; email: string };

export async function actorsOf(
  db: DbOrTx,
  ids: (string | null | undefined)[],
): Promise<Map<string, ActorRow>> {
  const wanted = [...new Set(ids.filter((id): id is string => typeof id === "string"))];
  if (wanted.length === 0) return new Map();
  const rows = await db
    .select({ id: users.id, name: users.name, email: users.email })
    .from(users)
    .where(inArray(users.id, wanted));
  return new Map(rows.map((row) => [row.id, row]));
}

export function actorOf(actors: Map<string, ActorRow>, id: string | null | undefined) {
  if (!id) return null;
  const row = actors.get(id);
  return row ? { id: row.id, name: row.name || row.email, email: row.email } : null;
}

/** The path a page had at a revision; null when the revision does not exist. */
export async function revisionPath(db: DbOrTx, pageId: string, number: number): Promise<string | null> {
  const [row] = await db
    .select({ path: pageRevisions.path })
    .from(pageRevisions)
    .where(and(eq(pageRevisions.pageId, pageId), eq(pageRevisions.number, number)));
  return row?.path ?? null;
}

/**
 * Where an item puts its page. An update item moves the page only when its
 * path differs from the page's path at the base revision; otherwise the page
 * keeps its live path, so a move saved live meanwhile stays.
 */
export function targetPathOf(item: ItemRow, basePath: string | null, livePath: string | null): string {
  if (item.action !== "update" || basePath === null || livePath === null) return item.path;
  return item.path === basePath ? livePath : item.path;
}

/** The change set moves the page, and it was moved live meanwhile to another place. */
export function moveConflictOf(item: ItemRow, basePath: string | null, livePath: string | null): boolean {
  return (
    item.action === "update" &&
    basePath !== null &&
    livePath !== null &&
    item.path !== basePath &&
    livePath !== basePath &&
    livePath !== item.path
  );
}

/**
 * Each item's effective path (`targetPathOf`), by page id: where its page
 * ends up, following moves saved live meanwhile. Use it wherever items are
 * found or compared by path.
 */
export async function effectivePaths(db: DbOrTx, items: ItemRow[]): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const updates = items.filter((item) => item.action === "update" && item.baseRevision !== null);
  const pagesById = await pagesOf(
    db,
    updates.map((item) => item.pageId),
  );
  for (const item of items) {
    const page = pagesById.get(item.pageId);
    if (item.action !== "update" || item.baseRevision === null || !page || page.deletedAt !== null) {
      result.set(item.pageId, item.path);
      continue;
    }
    const basePath = await revisionPath(db, item.pageId, item.baseRevision);
    result.set(item.pageId, targetPathOf(item, basePath, page.path));
  }
  return result;
}
