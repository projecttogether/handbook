import { and, desc, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import type {
  ChangeSet,
  ChangeSetItem,
  ChangeSetPage,
  ChangeSetSummary,
  Check,
} from "@handbook/shared/api/changes";
import { canonicalPageFile } from "@handbook/shared/page";
import { hasConflictMarkers, lineStats, mergeText } from "@handbook/shared/merge";
import { parentPath, pathProblem } from "@handbook/shared/paths";
import type { DbOrTx } from "../db/client";
import { changeSetEvents, changeSets, pages, redirects, spaces } from "../db/schema";
import type { UserPrincipal } from "../auth/principal";
import { schemaOf, type SpaceRow } from "../spaces/access";
import { visibilityOf } from "../spaces/visibility";
import { bodyOf, revisionMarkdown, type PageRow } from "../pages/core";
import { pageLinksOf } from "../pages/analyze";
import {
  actorOf,
  actorsOf,
  itemsOf,
  moveConflictOf,
  pagesOf,
  revisionPath,
  targetPathOf,
  titleOf,
  type ChangeSetAccess,
  type ChangeSetRow,
  type ItemRow,
} from "./model";

const iso = (value: Date | null | undefined) => (value ? value.toISOString() : null);

/** What the checks and the item list need to know about each item. */
export type ItemState = {
  item: ItemRow;
  /** The page as it is now (live or in the trash); null for new pages. */
  page: PageRow | null;
  /** The file at base_revision; null for new pages. */
  base: string | null;
  /** The live file now; null when the page does not exist or is in the trash. */
  live: string | null;
  liveRevision: number | null;
  title: string;
  conflict: boolean;
  /** Where the page ends up after the merge (`targetPathOf`). */
  targetPath: string;
  /** The change set moves the page, and it was moved live meanwhile elsewhere. */
  moveConflict: boolean;
};

export async function itemStates(db: DbOrTx, items: ItemRow[]): Promise<ItemState[]> {
  const byId = await pagesOf(
    db,
    items.map((item) => item.pageId),
  );
  const states: ItemState[] = [];
  for (const item of items) {
    const page = byId.get(item.pageId) ?? null;
    const livePage = page && page.deletedAt === null ? page : null;
    const base =
      item.baseRevision !== null && page ? await revisionMarkdown(db, page.id, item.baseRevision) : null;
    const live = livePage?.markdown ?? null;
    const basePath =
      item.baseRevision !== null && page ? await revisionPath(db, page.id, item.baseRevision) : null;
    const livePath = livePage?.path ?? null;
    let conflict = false;
    if (
      item.action !== "create" &&
      livePage &&
      item.baseRevision !== null &&
      livePage.revision !== item.baseRevision
    ) {
      if (item.action === "delete") conflict = base !== null && base !== live;
      else if (base !== null && item.markdown !== null) {
        conflict = !mergeText(base, item.markdown, live ?? "").clean;
      }
    }
    states.push({
      item,
      page,
      base,
      live,
      liveRevision: livePage?.revision ?? null,
      title: titleOf(item.markdown) ?? page?.title ?? item.path,
      conflict,
      targetPath: targetPathOf(item, basePath, livePath),
      moveConflict: moveConflictOf(item, basePath, livePath),
    });
  }
  return states;
}

/**
 * The checks of a change set against the space as it is now. Errors block
 * merging; warnings do not.
 */
export async function computeChecks(db: DbOrTx, space: SpaceRow, states: ItemState[]): Promise<Check[]> {
  const checks: Check[] = [];
  const error = (state: ItemState | null, message: string) =>
    checks.push({
      level: "error",
      pageId: state?.item.pageId ?? null,
      path: state?.targetPath ?? null,
      message,
    });
  const warning = (state: ItemState, message: string) =>
    checks.push({ level: "warning", pageId: state.item.pageId, path: state.targetPath, message });

  const livePages = await db
    .select({ id: pages.id, path: pages.path, parentId: pages.parentId })
    .from(pages)
    .where(and(eq(pages.spaceId, space.id), isNull(pages.deletedAt)));
  const touched = new Set(states.map((state) => state.item.pageId));
  const deleted = new Set(
    states.filter((state) => state.item.action === "delete").map((state) => state.item.pageId),
  );

  // Paths after the merge: untouched live pages, then the items.
  const finalPaths = new Map<string, string>();
  for (const page of livePages) if (!touched.has(page.id)) finalPaths.set(page.path, page.id);
  for (const state of states) {
    if (state.item.action === "delete") continue;
    const other = finalPaths.get(state.targetPath);
    if (other && other !== state.item.pageId) {
      error(state, `Two pages would have the path “${state.targetPath}”`);
    }
    finalPaths.set(state.targetPath, state.item.pageId);
  }

  const schema = schemaOf(space);
  for (const state of states) {
    const { item } = state;
    const name = `“${state.title}”`;
    if (item.action !== "create" && (!state.page || state.page.deletedAt !== null)) {
      if (!(item.action === "delete" && state.page?.deletedAt)) error(state, `${name} was deleted meanwhile`);
      continue;
    }
    if (state.conflict) {
      error(
        state,
        item.action === "delete"
          ? `${name} changed after this change set deleted it. Update it from the live page or undo the deletion.`
          : `${name} changed meanwhile in the same places. Update it from the live page and resolve the marked parts.`,
      );
    }
    if (state.moveConflict) {
      error(
        state,
        `${name} was moved meanwhile to “${state.page?.path ?? ""}”. Move it again here, or undo the move.`,
      );
    }
    if (item.action === "delete") {
      const children = livePages.filter((page) => page.parentId === item.pageId && !deleted.has(page.id));
      if (children.some((child) => !touched.has(child.id))) error(state, `${name} still has sub-pages`);
      continue;
    }
    const markdown = item.markdown ?? "";
    if (hasConflictMarkers(markdown)) {
      error(state, `${name} has conflict blocks to resolve (<<<<<<< yours … >>>>>>> current)`);
    } else {
      const parsed = canonicalPageFile(markdown, schema);
      if (!parsed.ok) {
        const first = Object.entries(parsed.errors)[0];
        error(state, `${name}: ${first ? first[1] : "the file is not valid"}`);
      }
    }
    const problem = pathProblem(state.targetPath);
    if (problem) error(state, `${name}: ${problem}`);
    const parent = parentPath(state.targetPath);
    if (parent && !finalPaths.has(parent))
      error(state, `The parent page “${parent}” of ${name} would not exist`);

    for (const target of pageLinksOf(bodyOf(markdown), { space: space.slug, path: state.targetPath })) {
      if (target.space === space.slug) {
        if (finalPaths.has(target.path) || (await redirectExists(db, space.id, target.path))) continue;
      } else if (await liveInOtherSpace(db, target.space, target.path)) continue;
      warning(
        state,
        `${name} links to “${target.space === space.slug ? target.path : `/s/${target.space}/${target.path}`}”, which would not exist`,
      );
    }
  }
  return checks;
}

async function redirectExists(db: DbOrTx, spaceId: string, path: string) {
  const [row] = await db
    .select({ pageId: redirects.pageId })
    .from(redirects)
    .innerJoin(pages, eq(pages.id, redirects.pageId))
    .where(and(eq(redirects.spaceId, spaceId), eq(redirects.path, path), isNull(pages.deletedAt)));
  return Boolean(row);
}

async function liveInOtherSpace(db: DbOrTx, spaceSlug: string, path: string) {
  const [row] = await db
    .select({ id: pages.id })
    .from(pages)
    .innerJoin(spaces, eq(spaces.id, pages.spaceId))
    .where(and(eq(spaces.slug, spaceSlug), eq(pages.path, path), isNull(pages.deletedAt)));
  return Boolean(row);
}

export function itemView(state: ItemState, actors: Awaited<ReturnType<typeof actorsOf>>): ChangeSetItem {
  const { item, page } = state;
  const before = item.action === "create" ? "" : (state.base ?? state.live ?? "");
  const after = item.action === "delete" ? "" : (item.markdown ?? "");
  const stats = lineStats(before, after);
  const livePath = page && page.deletedAt === null ? page.path : null;
  return {
    pageId: item.pageId,
    action: item.action as ChangeSetItem["action"],
    path: state.targetPath,
    fromPath: item.action === "update" && livePath && livePath !== state.targetPath ? livePath : null,
    title: state.title,
    baseRevision: item.baseRevision,
    liveRevision: state.liveRevision,
    added: stats.added,
    removed: stats.removed,
    conflict: state.conflict || state.moveConflict,
    updatedAt: item.updatedAt.toISOString(),
    updatedBy: actorOf(actors, item.updatedById),
  };
}

function summaryView(
  row: ChangeSetRow,
  space: { slug: string; name: string },
  pagesCount: number,
  actors: Awaited<ReturnType<typeof actorsOf>>,
): ChangeSetSummary {
  return {
    id: row.id,
    number: row.number,
    space,
    title: row.title,
    status: row.status as ChangeSetSummary["status"],
    author: actorOf(actors, row.authorId),
    clientName: row.clientName,
    pages: pagesCount,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    mergedAt: iso(row.mergedAt),
  };
}

export async function listChangeSets(
  db: DbOrTx,
  principal: UserPrincipal,
  query: { space?: string; status: string; mine: boolean; limit: number },
): Promise<ChangeSetSummary[]> {
  const filters: SQL[] = [];
  if (query.space) filters.push(eq(spaces.slug, query.space));
  if (query.status === "active") filters.push(inArray(changeSets.status, ["open", "in_review"]));
  else if (query.status !== "all") filters.push(eq(changeSets.status, query.status));
  if (query.mine) filters.push(eq(changeSets.authorId, principal.id));
  filters.push((await visibilityOf(db, principal)).changeSets());
  const rows = await db
    .select({
      changeSet: changeSets,
      space: { slug: spaces.slug, name: spaces.name },
      // Table names written out: Drizzle leaves columns unqualified in select lists.
      pages: sql<number>`(select count(*) from change_set_items i where i.change_set_id = "change_sets"."id")`,
    })
    .from(changeSets)
    .innerJoin(spaces, eq(spaces.id, changeSets.spaceId))
    .where(filters.length > 0 ? and(...filters) : undefined)
    .orderBy(desc(changeSets.updatedAt))
    .limit(query.limit);
  const actors = await actorsOf(
    db,
    rows.map((row) => row.changeSet.authorId),
  );
  return rows.map((row) => summaryView(row.changeSet, row.space, Number(row.pages), actors));
}

export async function changeSetDetail(db: DbOrTx, access: ChangeSetAccess): Promise<ChangeSet> {
  const { changeSet, context } = access;
  const items = await itemsOf(db, changeSet.id);
  const states = await itemStates(db, items);
  const checks = ACTIVE.has(changeSet.status) ? await computeChecks(db, context.space, states) : [];
  const events = await db
    .select()
    .from(changeSetEvents)
    .where(eq(changeSetEvents.changeSetId, changeSet.id))
    .orderBy(changeSetEvents.createdAt);
  const actors = await actorsOf(db, [
    changeSet.authorId,
    changeSet.mergedById,
    ...items.map((item) => item.updatedById),
    ...events.map((event) => event.actorId),
  ]);
  const related = [changeSet.revertOfId, changeSet.revertedById].filter((id): id is string => id !== null);
  const numbers = new Map(
    related.length > 0
      ? (
          await db
            .select({ id: changeSets.id, number: changeSets.number })
            .from(changeSets)
            .where(inArray(changeSets.id, related))
        ).map((row) => [row.id, row.number])
      : [],
  );
  return {
    ...summaryView(changeSet, { slug: context.space.slug, name: context.space.name }, items.length, actors),
    description: changeSet.description,
    items: states.map((state) => itemView(state, actors)),
    checks,
    events: events.map((event) => ({
      id: event.id,
      kind: event.kind as ChangeSet["events"][number]["kind"],
      actor: actorOf(actors, event.actorId),
      clientName: event.clientName,
      body: event.body,
      page:
        event.pageId && event.pagePath
          ? { id: event.pageId, path: event.pagePath, title: event.pageTitle ?? event.pagePath }
          : null,
      createdAt: event.createdAt.toISOString(),
    })),
    mergedBy: actorOf(actors, changeSet.mergedById),
    revertOf: changeSet.revertOfId ? (numbers.get(changeSet.revertOfId) ?? null) : null,
    revertedBy: changeSet.revertedById ? (numbers.get(changeSet.revertedById) ?? null) : null,
    permissions: {
      edit: access.edit,
      submit: access.submit,
      review: access.review,
      merge: access.merge,
      close: access.close,
      reopen: access.reopen,
      revert: access.revert,
      comment: access.comment,
    },
  };
}

const ACTIVE = new Set(["open", "in_review"]);

/** One page as the change set sees it. */
export async function changeSetPageView(db: DbOrTx, item: ItemRow): Promise<ChangeSetPage> {
  const [state] = await itemStates(db, [item]);
  const actors = await actorsOf(db, [item.updatedById]);
  return {
    item: itemView(state!, actors),
    base: state!.base,
    live: state!.live,
    proposed: item.action === "delete" ? null : item.markdown,
  };
}
