import { and, asc, eq, inArray, isNull, max } from "drizzle-orm";
import { lastSegment, parentPath } from "@handbook/shared/paths";
import type { Db, DbOrTx } from "../db/client";
import { changeSetItems, changeSets, pageRevisions, pages } from "../db/schema";
import type { UserPrincipal } from "../auth/principal";
import { AppError } from "../http/errors";
import { logger } from "../logger";
import {
  createLivePage,
  deleteLivePage,
  findLivePage,
  lockAnyPage,
  lockPage,
  moveLivePage,
  PageConflictError,
  restoreDeletedPage,
  saveLivePage,
  type Author,
} from "../pages/core";
import {
  ACTIVE_STATUSES,
  addEvent,
  itemsOf,
  loadChangeSet,
  requireAccess,
  titleOf,
  type ChangeSetAccess,
} from "./model";
import { computeChecks, itemStates, type ItemState } from "./view";

/**
 * Merging a change set into the live pages, and reverting a merged one.
 * Both run in one transaction through the page core, so a failure leaves
 * every page as it was.
 */

export type MergeConflict = { pageId: string; path: string; reason: string };

export class MergeConflictsError extends AppError {
  constructor(conflicts: MergeConflict[]) {
    super(
      409,
      "merge_conflicts",
      "Some pages changed meanwhile in the same places. Update them from the live pages, resolve the marked parts, and merge again.",
      undefined,
      { conflicts },
    );
  }
}

const depth = (path: string) => path.split("/").length;

/**
 * The order of a merge: new pages, changes and moves by the depth of where
 * they end up (parents first, so a page created below a moved page finds it;
 * at one depth moves first, freeing their old paths), then deletions
 * (children first).
 */
function mergeOrder(states: ItemState[]): ItemState[] {
  const rank = (state: ItemState) => (state.item.action === "update" ? 0 : 1);
  const writes = states
    .filter((state) => state.item.action !== "delete")
    .sort((a, b) => depth(a.targetPath) - depth(b.targetPath) || rank(a) - rank(b));
  const deletes = states
    .filter((state) => state.item.action === "delete")
    .sort((a, b) => depth(b.item.path) - depth(a.item.path));
  return [...writes, ...deletes];
}

/** Applies a change set's items to the live pages. Throws MergeConflictsError on overlapping changes. */
/**
 * True when an item can be applied now: a deletion once its page has no live
 * sub-pages; a new or moved page once its path is free (another item may
 * still have to move or delete the page there) and its parent path holds the
 * page that stays there after the merge (`finalOwners`), not one that is
 * about to move away.
 */
async function ready(
  tx: DbOrTx,
  spaceId: string,
  state: ItemState,
  finalOwners: Map<string, string>,
): Promise<boolean> {
  const { item, targetPath } = state;
  if (item.action === "delete") {
    const [child] = await tx
      .select({ id: pages.id })
      .from(pages)
      .where(and(eq(pages.parentId, item.pageId), isNull(pages.deletedAt)))
      .limit(1);
    return !child;
  }
  if (item.action === "update") {
    const [page] = await tx.select({ path: pages.path }).from(pages).where(eq(pages.id, item.pageId));
    if (!page || page.path === targetPath) return true;
  }
  const parent = parentPath(targetPath);
  if (parent) {
    const parentPage = await findLivePage(tx, spaceId, parent);
    if (!parentPage || parentPage.id !== finalOwners.get(parent)) return false;
  }
  const occupant = await findLivePage(tx, spaceId, targetPath);
  return !occupant || occupant.id === item.pageId;
}

/**
 * Applies a change set's items to the live pages, each once it is ready, in
 * passes (`mergeOrder` within a pass). Throws MergeConflictsError on
 * overlapping changes.
 */
async function applyItems(tx: DbOrTx, access: ChangeSetAccess, states: ItemState[]) {
  const space = access.context.space;
  const conflicts: MergeConflict[] = [];
  // Which page has each path after the merge: untouched live pages, then the items.
  const touched = new Set(states.map((state) => state.item.pageId));
  const finalOwners = new Map<string, string>();
  const livePages = await tx
    .select({ id: pages.id, path: pages.path })
    .from(pages)
    .where(and(eq(pages.spaceId, space.id), isNull(pages.deletedAt)));
  for (const page of livePages) if (!touched.has(page.id)) finalOwners.set(page.path, page.id);
  for (const state of states) {
    if (state.item.action !== "delete") finalOwners.set(state.targetPath, state.item.pageId);
  }
  let pending = mergeOrder(states);
  while (pending.length > 0) {
    const waiting: ItemState[] = [];
    for (const state of pending) {
      if (await ready(tx, space.id, state, finalOwners)) await applyItem(tx, access, state, conflicts);
      else waiting.push(state);
    }
    if (waiting.length === pending.length) {
      // Nothing moved on: an overlap above, or the page core names the problem.
      if (conflicts.length > 0) break;
      for (const state of waiting) await applyItem(tx, access, state, conflicts);
      break;
    }
    pending = waiting;
  }
  if (conflicts.length > 0) throw new MergeConflictsError(conflicts);
}

/** The revision that last took a page out of the trash. */
async function restoredAt(tx: DbOrTx, pageId: string): Promise<number | null> {
  const [row] = await tx
    .select({ number: max(pageRevisions.number) })
    .from(pageRevisions)
    .where(and(eq(pageRevisions.pageId, pageId), eq(pageRevisions.kind, "restore")));
  return row?.number ?? null;
}

async function applyItem(tx: DbOrTx, access: ChangeSetAccess, state: ItemState, conflicts: MergeConflict[]) {
  const space = access.context.space;
  const { item, targetPath } = state;
  const author: Author = {
    userId: item.updatedById,
    via: "merge",
    clientName: access.changeSet.clientName,
    changeSetId: access.changeSet.id,
    message: access.changeSet.title,
  };
  try {
    if (item.action === "create") {
      const existing = await lockAnyPage(tx, item.pageId);
      if (existing) {
        // Reverting a deletion: a page in the trash comes back, then gets the
        // file. One restored live meanwhile keeps the changes saved since.
        let page = existing;
        const baseRevision = page.deletedAt === null ? await restoredAt(tx, page.id) : null;
        if (page.deletedAt !== null)
          page = await restoreDeletedPage(tx, { space, page, author, checkFile: false });
        if (page.path !== item.path)
          page = await moveLivePage(tx, { space, page, newPath: item.path, author });
        await saveLivePage(tx, {
          space,
          page,
          markdown: item.markdown!,
          baseRevision: baseRevision ?? page.revision,
          author,
        });
      } else {
        await createLivePage(tx, {
          space,
          parentPath: parentPath(item.path),
          slug: lastSegment(item.path),
          markdown: item.markdown!,
          author,
          pageId: item.pageId,
        });
      }
    } else if (item.action === "update") {
      let page = await lockPage(tx, item.pageId);
      const saved = await saveLivePage(tx, {
        space,
        page,
        markdown: item.markdown!,
        baseRevision: item.baseRevision ?? page.revision,
        author,
      });
      page = saved.page;
      // Only a move this change set asked for; a move saved live meanwhile stays.
      if (page.path !== targetPath) await moveLivePage(tx, { space, page, newPath: targetPath, author });
    } else {
      const page = await lockAnyPage(tx, item.pageId);
      // In the trash already (deleted live meanwhile): nothing left to do.
      if (!page || page.deletedAt !== null) return;
      if (item.baseRevision !== null && page.revision !== item.baseRevision) {
        const [base] = await tx
          .select({ markdown: pageRevisions.markdown })
          .from(pageRevisions)
          .where(and(eq(pageRevisions.pageId, page.id), eq(pageRevisions.number, item.baseRevision)));
        if (base && base.markdown !== page.markdown) {
          conflicts.push({
            pageId: item.pageId,
            path: item.path,
            reason: "The page changed after it was deleted here",
          });
          return;
        }
      }
      await deleteLivePage(tx, { space, page, author });
    }
  } catch (error) {
    if (error instanceof PageConflictError) {
      conflicts.push({
        pageId: item.pageId,
        path: item.path,
        reason: "The page changed meanwhile in the same places",
      });
      return;
    }
    throw error;
  }
}

async function mergeInTransaction(tx: DbOrTx, principal: UserPrincipal, access: ChangeSetAccess) {
  const items = await itemsOf(tx, access.changeSet.id);
  if (items.length === 0) throw new AppError(409, "empty_change_set", "This change set changes no pages");
  const states = await itemStates(tx, items);
  const conflicting = states.filter((state) => state.conflict || state.moveConflict);
  if (conflicting.length > 0) {
    throw new MergeConflictsError(
      conflicting.map((state) => ({
        pageId: state.item.pageId,
        path: state.targetPath,
        reason: state.moveConflict
          ? "The page was moved meanwhile to another place"
          : "The page changed meanwhile in the same places",
      })),
    );
  }
  const errors = (await computeChecks(tx, access.context.space, states)).filter(
    (check) => check.level === "error",
  );
  if (errors.length > 0) {
    throw new AppError(422, "checks_failed", `Fix this before merging: ${errors[0]!.message}`, undefined, {
      checks: errors,
    });
  }
  await applyItems(tx, access, states);
  await tx
    .update(changeSets)
    .set({ status: "merged", mergedAt: new Date(), mergedById: principal.id, updatedAt: new Date() })
    .where(eq(changeSets.id, access.changeSet.id));
  await addEvent(tx, access.changeSet, principal, { kind: "merged" });
  if (access.changeSet.revertOfId) {
    await tx
      .update(changeSets)
      .set({ revertedById: access.changeSet.id, updatedAt: new Date() })
      .where(eq(changeSets.id, access.changeSet.revertOfId));
    const [original] = await tx
      .select()
      .from(changeSets)
      .where(eq(changeSets.id, access.changeSet.revertOfId));
    if (original) {
      await addEvent(tx, original, principal, {
        kind: "reverted",
        body: `Reverted by change set #${access.changeSet.number}`,
      });
    }
  }
}

/** Merges a change set (editors, not agents). */
export async function mergeChangeSet(db: Db, principal: UserPrincipal, number: number) {
  await db.transaction(async (tx) => {
    const access = await loadChangeSet(tx, principal, number, { forUpdate: true });
    requireAccess(access, "merge");
    await mergeInTransaction(tx, principal, access);
  });
  logger.info({ changeSet: number }, "change set merged");
}

/**
 * Reverts a merged change set: a new change set restores every page it
 * touched to the revision before the merge (combined with later changes),
 * deletes pages it created or took out of the trash, and restores pages it
 * deleted. It is merged at once when that is clean; else it stays open for a
 * person to resolve, and reverting again answers with that change set. One
 * transaction: any other failure leaves no revert behind.
 */
export async function revertChangeSet(
  db: Db,
  principal: UserPrincipal,
  number: number,
): Promise<{ number: number; merged: boolean }> {
  return db.transaction(async (tx) => {
    const access = await loadChangeSet(tx, principal, number, { forUpdate: true });
    requireAccess(access, "revert");
    const original = access.changeSet;
    const [pending] = await tx
      .select({ number: changeSets.number })
      .from(changeSets)
      .where(and(eq(changeSets.revertOfId, original.id), inArray(changeSets.status, ACTIVE_STATUSES)));
    if (pending) return { number: pending.number, merged: false };
    const revisions = await tx
      .select()
      .from(pageRevisions)
      .where(eq(pageRevisions.changeSetId, original.id))
      .orderBy(asc(pageRevisions.number));
    const byPage = new Map<string, (typeof revisions)[number][]>();
    for (const revision of revisions) {
      byPage.set(revision.pageId, [...(byPage.get(revision.pageId) ?? []), revision]);
    }
    const current = new Map(
      byPage.size > 0
        ? (
            await tx
              .select()
              .from(pages)
              .where(inArray(pages.id, [...byPage.keys()]))
          ).map((page) => [page.id, page])
        : [],
    );
    const items: (typeof changeSetItems.$inferInsert)[] = [];
    const [revert] = await tx
      .insert(changeSets)
      .values({
        spaceId: original.spaceId,
        title: `Revert “${original.title}”`,
        description: `Reverts change set #${original.number}.`,
        authorId: principal.id,
        channel: principal.channel,
        clientName: principal.clientName,
        revertOfId: original.id,
      })
      .returning();
    for (const [pageId, pageRevisionsOfSet] of byPage) {
      const page = current.get(pageId);
      if (!page) continue;
      const first = pageRevisionsOfSet[0]!;
      const last = pageRevisionsOfSet.at(-1)!;
      const base = { changeSetId: revert!.id, pageId, updatedById: principal.id };
      const [before] =
        first.number === 1
          ? []
          : await tx
              .select()
              .from(pageRevisions)
              .where(and(eq(pageRevisions.pageId, pageId), eq(pageRevisions.number, first.number - 1)));
      if (first.number === 1 || before?.kind === "delete") {
        // Created by the change set, or taken out of the trash: delete it (if it
        // still exists). Edits made since then make the deletion a conflict.
        if (page.deletedAt === null) {
          items.push({
            ...base,
            action: "delete",
            baseRevision: last.number,
            path: page.path,
            markdown: null,
          });
        }
        continue;
      }
      if (!before) continue;
      if (last.kind === "delete") {
        // Deleted by the change set: bring it back as it was.
        if (page.deletedAt !== null) {
          items.push({
            ...base,
            action: "create",
            baseRevision: null,
            path: before.path,
            markdown: before.markdown,
          });
        }
        continue;
      }
      if (page.deletedAt !== null) continue;
      // Changed or moved: back to the file and path before, combined with later changes.
      items.push({
        ...base,
        action: "update",
        baseRevision: last.number,
        path: before.path,
        markdown: before.markdown,
      });
    }
    if (items.length > 0) await tx.insert(changeSetItems).values(items);
    await addEvent(tx, revert!, principal, { kind: "created" });
    for (const item of items) {
      const title = titleOf(item.markdown) ?? current.get(item.pageId)?.title ?? item.path;
      await addEvent(tx, revert!, principal, {
        kind: "edited",
        body:
          item.action === "delete"
            ? `Deleted “${title}”`
            : item.action === "create"
              ? `Restored “${title}”`
              : `Changed “${title}” back`,
        page: { id: item.pageId, path: item.path, title },
      });
    }

    try {
      // In a savepoint: conflicts undo only the merge, and the revert stays open.
      await tx.transaction(async (merge) => {
        const revertAccess = await loadChangeSet(merge, principal, revert!.number, { forUpdate: true });
        requireAccess(revertAccess, "merge");
        await mergeInTransaction(merge, principal, revertAccess);
      });
      return { number: revert!.number, merged: true };
    } catch (error) {
      if (error instanceof AppError && (error.status === 409 || error.status === 422)) {
        logger.info({ changeSet: revert!.number }, "revert needs a person to resolve conflicts");
        return { number: revert!.number, merged: false };
      }
      throw error;
    }
  });
}
