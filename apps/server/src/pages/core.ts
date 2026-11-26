import { and, asc, eq, inArray, isNull, like, max, or, sql, type SQL } from "drizzle-orm";
import {
  canonicalPageFile,
  frontmatterObject,
  splitFrontmatter,
  type ParsedPage,
} from "@handbook/shared/page";
import { lineStats, mergeText } from "@handbook/shared/merge";
import { isValidSlug, isWithin, joinPath, parentPath, pathProblem, slugify } from "@handbook/shared/paths";
import type { Via } from "@handbook/shared/roles";
import { config } from "../config";
import type { DbOrTx } from "../db/client";
import { pageLinks, pageRevisions, pageSections, pages, redirects, spaces, users } from "../db/schema";
import type { UserPrincipal } from "../auth/principal";
import { AppError, conflict, notFound, validationError } from "../http/errors";
import { markFilesUsed } from "../files/storage";
import { schemaOf, type SpaceRow } from "../spaces/access";
import { pageLinksOf, sectionsOf } from "./analyze";

/**
 * The one write path for pages. The web editor, the REST API, change set
 * merges, imports and restores all save through these functions, inside a
 * transaction: they check the file, merge with changes saved meanwhile,
 * store a revision, and update everything derived from the file (columns,
 * search sections, links). Callers check permissions first.
 */

export type PageRow = typeof pages.$inferSelect;

/** Who changes a page, and how; recorded on the revision. */
export type Author = {
  userId: string | null;
  via: Via;
  clientName: string | null;
  changeSetId?: string | null;
  message?: string | null;
};

export function authorOf(principal: UserPrincipal, via: Via, extra: Partial<Author> = {}): Author {
  return { userId: principal.id, via, clientName: principal.clientName, ...extra };
}

/** 409 `page_changed`: overlapping changes; `merged` holds conflict blocks to resolve. */
export class PageConflictError extends AppError {
  constructor(
    readonly current: {
      revision: number;
      markdown: string;
      updatedBy: { id: string | null; name: string; email: string | null } | null;
    },
    readonly merged: string,
    readonly conflicts: number,
  ) {
    super(
      409,
      "page_changed",
      "Someone else changed this page meanwhile, in the same places. Resolve the marked parts and save again.",
      undefined,
      { current, merged, conflicts },
    );
  }
}

/** Checks a file against the space and returns it in canonical form; 422 with field errors otherwise. */
export function canonicalize(markdown: string, space: SpaceRow): { markdown: string; page: ParsedPage } {
  const result = canonicalPageFile(markdown, schemaOf(space));
  if (!result.ok) {
    const message = result.errors.markdown ?? "Check the page's properties";
    throw validationError(result.errors, message);
  }
  return { markdown: result.markdown, page: result.page };
}

/**
 * The space a file is written to, read again and locked (shared) until the
 * transaction ends: files are checked against its properties and page types
 * as they are now, and owners cannot change those until the write is done
 * (`updateSpace` locks the space and checks the live pages).
 */
async function spaceForWrite(tx: DbOrTx, spaceId: string): Promise<SpaceRow> {
  const [space] = await tx.select().from(spaces).where(eq(spaces.id, spaceId)).for("share");
  if (!space) throw notFound("No such space");
  return space;
}

/** The body of a stored file, without checking it against the space (its schema may have changed). */
export function bodyOf(markdown: string): string {
  return splitFrontmatter(markdown)?.body ?? markdown;
}

/** A page by id, live or in the trash, locked for the transaction; null when unknown. */
export async function lockAnyPage(tx: DbOrTx, pageId: string): Promise<PageRow | null> {
  const [page] = await tx.select().from(pages).where(eq(pages.id, pageId)).for("update");
  return page ?? null;
}

/** A live (not deleted) page by id, locked for the transaction. */
export async function lockPage(
  tx: DbOrTx,
  pageId: string,
  options: { deleted?: boolean } = {},
): Promise<PageRow> {
  const page = await lockAnyPage(tx, pageId);
  if (!page || (page.deletedAt !== null) !== (options.deleted ?? false)) throw notFound("No such page");
  return page;
}

/** A live page of a space by path (not following redirects). */
export async function findLivePage(tx: DbOrTx, spaceId: string, path: string): Promise<PageRow | null> {
  const [page] = await tx
    .select()
    .from(pages)
    .where(and(eq(pages.spaceId, spaceId), eq(pages.path, path), isNull(pages.deletedAt)));
  return page ?? null;
}

/** A live page by path, or the page an old path redirects to. */
export async function findPageByPathOrRedirect(
  tx: DbOrTx,
  spaceId: string,
  path: string,
): Promise<PageRow | null> {
  const page = await findLivePage(tx, spaceId, path);
  if (page) return page;
  const [redirect] = await tx
    .select({ page: pages })
    .from(redirects)
    .innerJoin(pages, eq(pages.id, redirects.pageId))
    .where(and(eq(redirects.spaceId, spaceId), eq(redirects.path, path), isNull(pages.deletedAt)));
  return redirect?.page ?? null;
}

export async function revisionMarkdown(tx: DbOrTx, pageId: string, number: number): Promise<string | null> {
  const [row] = await tx
    .select({ markdown: pageRevisions.markdown })
    .from(pageRevisions)
    .where(and(eq(pageRevisions.pageId, pageId), eq(pageRevisions.number, number)));
  return row?.markdown ?? null;
}

async function actorOf(tx: DbOrTx, userId: string | null) {
  if (!userId) return null;
  const [user] = await tx
    .select({ id: users.id, name: users.name, email: users.email })
    .from(users)
    .where(eq(users.id, userId));
  return user ? { id: user.id, name: user.name || user.email, email: user.email } : null;
}

function searchVectorOf(parts: { text: string; weight: "A" | "B" | "C" | "D" }[]): SQL {
  const vectors: SQL[] = [];
  for (const language of config().searchConfigs) {
    for (const part of parts) {
      vectors.push(sql`setweight(to_tsvector(${language}::regconfig, ${part.text}), ${part.weight})`);
    }
  }
  return sql.join(vectors, sql` || `);
}

/** The page-level search vector: title, search terms and tags, description. */
export function pageSearchVector(page: {
  title: string;
  searchTerms: string[];
  tags: string[];
  description: string | null;
}): SQL {
  return searchVectorOf([
    { text: page.title, weight: "A" },
    { text: [...page.searchTerms, ...page.tags].join(" ; "), weight: "B" },
    { text: page.description ?? "", weight: "C" },
  ]);
}

function derivedColumns(parsed: ParsedPage, space: SpaceRow) {
  const frontmatter = parsed.frontmatter;
  return {
    title: frontmatter.title,
    description: frontmatter.description,
    status: frontmatter.status,
    type: frontmatter.type,
    tags: frontmatter.tags,
    searchTerms: frontmatter.search_terms,
    properties: frontmatterObject(frontmatter, schemaOf(space)) as Record<string, never>,
  };
}

/** Rebuilds the search sections and outgoing links of a live page from its body. */
async function deriveFromBody(
  tx: DbOrTx,
  space: SpaceRow,
  page: { id: string; path: string; title: string },
  body: string,
) {
  await tx.delete(pageSections).where(eq(pageSections.pageId, page.id));
  const sections = sectionsOf(body);
  if (sections.length > 0) {
    await tx.insert(pageSections).values(
      sections.map((section) => ({
        pageId: page.id,
        position: section.position,
        anchor: section.anchor,
        headingPath: section.headingPath,
        content: section.content,
        searchVector: searchVectorOf([
          { text: section.headingPath.join(" "), weight: "A" },
          { text: section.content, weight: "D" },
        ]),
      })),
    );
  }

  await tx.delete(pageLinks).where(eq(pageLinks.fromPageId, page.id));
  const targets = pageLinksOf(body, { space: space.slug, path: page.path });
  if (targets.length > 0) {
    await tx
      .insert(pageLinks)
      .values(
        targets.map((target) => ({ fromPageId: page.id, toSpaceSlug: target.space, toPath: target.path })),
      );
    // Resolve to pages now: live paths first, then redirects of moved pages.
    await tx.execute(sql`
      update page_links l set to_page_id = coalesce(
        (select p.id from pages p join spaces s on s.id = p.space_id
          where s.slug = l.to_space_slug and p.path = l.to_path and p.deleted_at is null limit 1),
        (select r.page_id from redirects r join spaces s on s.id = r.space_id join pages p on p.id = r.page_id
          where s.slug = l.to_space_slug and r.path = l.to_path and p.deleted_at is null limit 1))
      where l.from_page_id = ${page.id}`);
  }
}

/** Links that pointed at a path nobody had now reach the page that took it. */
async function resolveIncomingLinks(tx: DbOrTx, space: SpaceRow, pageId: string, paths: string[]) {
  if (paths.length === 0) return;
  await tx
    .update(pageLinks)
    .set({ toPageId: pageId })
    .where(and(eq(pageLinks.toSpaceSlug, space.slug), inArray(pageLinks.toPath, paths)));
}

async function insertRevision(
  tx: DbOrTx,
  input: {
    page: { id: string; path: string; title: string };
    number: number;
    kind: "save" | "move" | "delete" | "restore";
    markdown: string;
    previous: string | null;
    author: Author;
  },
) {
  const stats =
    input.kind === "save" ? lineStats(input.previous ?? "", input.markdown) : { added: 0, removed: 0 };
  await tx.insert(pageRevisions).values({
    pageId: input.page.id,
    number: input.number,
    kind: input.kind,
    path: input.page.path,
    title: input.page.title,
    markdown: input.markdown,
    authorId: input.author.userId,
    via: input.author.via,
    clientName: input.author.clientName,
    changeSetId: input.author.changeSetId ?? null,
    message: input.author.message ?? null,
    added: stats.added,
    removed: stats.removed,
  });
  await markFilesUsed(tx, [input.markdown]);
}

export type SaveResult = { page: PageRow; changed: boolean; merged: boolean };

/**
 * Saves a new version of a live page. When the page changed since
 * `baseRevision`, both changes are merged; overlapping changes throw
 * `PageConflictError`. Saving the same file again changes nothing.
 * `page` must come from `lockPage` in the same transaction.
 */
export async function saveLivePage(
  tx: DbOrTx,
  input: { space: SpaceRow; page: PageRow; markdown: string; baseRevision: number; author: Author },
): Promise<SaveResult> {
  const { page, author } = input;
  const space = await spaceForWrite(tx, input.space.id);
  if (input.baseRevision > page.revision)
    throw conflict("This revision does not exist yet", "invalid_revision");
  let file = canonicalize(input.markdown, space);
  let merged = false;
  if (input.baseRevision !== page.revision) {
    const base = await revisionMarkdown(tx, page.id, input.baseRevision);
    if (base === null) throw conflict("The base revision does not exist", "invalid_revision");
    const result = mergeText(base, file.markdown, page.markdown);
    if (!result.clean) {
      throw new PageConflictError(
        { revision: page.revision, markdown: page.markdown, updatedBy: await actorOf(tx, page.updatedById) },
        result.text,
        result.conflicts,
      );
    }
    file = canonicalize(result.text, space);
    merged = true;
  }
  if (file.markdown === page.markdown) return { page, changed: false, merged };

  const number = page.revision + 1;
  const columns = derivedColumns(file.page, space);
  const [updated] = await tx
    .update(pages)
    .set({
      ...columns,
      revision: number,
      markdown: file.markdown,
      searchVector: pageSearchVector(columns),
      updatedById: author.userId,
      updatedAt: sql`now()`,
    })
    .where(eq(pages.id, page.id))
    .returning();
  await insertRevision(tx, {
    page: { id: page.id, path: page.path, title: columns.title },
    number,
    kind: "save",
    markdown: file.markdown,
    previous: page.markdown,
    author,
  });
  await deriveFromBody(tx, space, { id: page.id, path: page.path, title: columns.title }, file.page.body);
  return { page: updated!, changed: true, merged };
}

async function nextPosition(tx: DbOrTx, spaceId: string, parentId: string | null): Promise<number> {
  const [row] = await tx
    .select({ value: max(pages.position) })
    .from(pages)
    .where(
      and(
        eq(pages.spaceId, spaceId),
        parentId ? eq(pages.parentId, parentId) : isNull(pages.parentId),
        isNull(pages.deletedAt),
      ),
    );
  return (row?.value ?? -1) + 1;
}

/**
 * The live parent page of a path; 422 when it does not exist. The parent and
 * its ancestors stay locked (shared, top down) until the transaction ends:
 * none of them can move or go to the trash meanwhile. Moves and deletions
 * lock their page first, so they wait for this transaction and then see the
 * page put below it, or this one waits for them and finds no parent.
 */
async function parentOf(tx: DbOrTx, space: SpaceRow, path: string): Promise<PageRow | null> {
  const parent = parentPath(path);
  if (!parent) return null;
  const segments = parent.split("/");
  const ancestors = segments.map((_, index) => segments.slice(0, index + 1).join("/"));
  const rows = await tx
    .select()
    .from(pages)
    .where(and(eq(pages.spaceId, space.id), inArray(pages.path, ancestors), isNull(pages.deletedAt)))
    .orderBy(asc(pages.path))
    .for("share");
  const page = rows.find((row) => row.path === parent);
  if (!page)
    throw validationError(
      { path: `The parent page “${parent}” does not exist` },
      `The parent page “${parent}” does not exist`,
    );
  return page;
}

function checkPath(path: string) {
  const problem = pathProblem(path);
  if (problem) throw validationError({ path: problem }, problem);
}

/**
 * Creates a live page. Without a slug, it comes from the title. A path that
 * redirected to a moved page now belongs to the new page.
 */
export async function createLivePage(
  tx: DbOrTx,
  input: {
    space: SpaceRow;
    parentPath: string | null;
    slug?: string | null;
    markdown: string;
    author: Author;
    /** For pages created by a change set merge: the id the change set used. */
    pageId?: string;
    position?: number;
  },
): Promise<PageRow> {
  const { author } = input;
  const space = await spaceForWrite(tx, input.space.id);
  const file = canonicalize(input.markdown, space);
  const slug = input.slug?.trim() ? input.slug.trim() : slugify(file.page.frontmatter.title);
  if (!isValidSlug(slug)) {
    throw validationError(
      { slug: "Use lowercase letters, digits and dashes" },
      "Use lowercase letters, digits and dashes",
    );
  }
  const path = joinPath(input.parentPath, slug);
  checkPath(path);
  const parent = await parentOf(tx, space, path);
  if (await findLivePage(tx, space.id, path))
    throw conflict(`A page with the path “${path}” exists already`, "path_taken");

  const columns = derivedColumns(file.page, space);
  const [created] = await tx
    .insert(pages)
    .values({
      ...(input.pageId ? { id: input.pageId } : {}),
      spaceId: space.id,
      parentId: parent?.id ?? null,
      path,
      position: input.position ?? (await nextPosition(tx, space.id, parent?.id ?? null)),
      revision: 1,
      ...columns,
      markdown: file.markdown,
      searchVector: pageSearchVector(columns),
      createdById: author.userId,
      updatedById: author.userId,
    })
    .returning();
  const page = created!;
  await insertRevision(tx, { page, number: 1, kind: "save", markdown: file.markdown, previous: "", author });
  await tx.delete(redirects).where(and(eq(redirects.spaceId, space.id), eq(redirects.path, path)));
  await deriveFromBody(tx, space, page, file.page.body);
  await resolveIncomingLinks(tx, space, page.id, [path]);
  return page;
}

/**
 * Moves (or renames) a live page with its sub-pages. Old paths redirect to
 * the moved pages; each moved page gets a "move" revision.
 */
export async function moveLivePage(
  tx: DbOrTx,
  input: { space: SpaceRow; page: PageRow; newPath: string; position?: number; author: Author },
): Promise<PageRow> {
  const { space, page, author } = input;
  const newPath = input.newPath;
  checkPath(newPath);
  if (isWithin(newPath, page.path) && newPath !== page.path) {
    throw validationError({ path: "A page cannot move below itself" }, "A page cannot move below itself");
  }
  const parent = await parentOf(tx, space, newPath);
  if (newPath !== page.path && (await findLivePage(tx, space.id, newPath))) {
    throw conflict(`A page with the path “${newPath}” exists already`, "path_taken");
  }
  const parentId = parent?.id ?? null;
  const parentChanged = parentId !== page.parentId;
  const position =
    input.position ?? (parentChanged ? await nextPosition(tx, space.id, parentId) : page.position);

  if (input.position !== undefined || parentChanged) {
    // Make room among the new siblings.
    await tx
      .update(pages)
      .set({ position: sql`${pages.position} + 1` })
      .where(
        and(
          eq(pages.spaceId, space.id),
          parentId ? eq(pages.parentId, parentId) : isNull(pages.parentId),
          isNull(pages.deletedAt),
          sql`${pages.position} >= ${position}`,
          sql`${pages.id} <> ${page.id}`,
        ),
      );
  }
  if (newPath === page.path) {
    const [updated] = await tx.update(pages).set({ position }).where(eq(pages.id, page.id)).returning();
    return updated!;
  }

  const moved = await tx
    .select()
    .from(pages)
    .where(
      and(
        eq(pages.spaceId, space.id),
        isNull(pages.deletedAt),
        or(eq(pages.id, page.id), like(pages.path, `${page.path.replace(/[\\%_]/g, "\\$&")}/%`)),
      ),
    )
    .orderBy(asc(pages.path))
    .for("update");
  const oldPath = page.path;
  for (const item of moved) {
    const path = item.id === page.id ? newPath : `${newPath}${item.path.slice(oldPath.length)}`;
    checkPath(path);
    const [updated] = await tx
      .update(pages)
      .set({
        path,
        ...(item.id === page.id ? { parentId, position } : {}),
        revision: item.revision + 1,
        updatedById: author.userId,
        updatedAt: sql`now()`,
      })
      .where(eq(pages.id, item.id))
      .returning();
    await insertRevision(tx, {
      page: { id: item.id, path, title: item.title },
      number: item.revision + 1,
      kind: "move",
      markdown: item.markdown,
      previous: item.markdown,
      author,
    });
    await tx
      .insert(redirects)
      .values({ spaceId: space.id, path: item.path, pageId: item.id })
      .onConflictDoUpdate({
        target: [redirects.spaceId, redirects.path],
        set: { pageId: item.id, createdAt: sql`now()` },
      });
    await tx.delete(redirects).where(and(eq(redirects.spaceId, space.id), eq(redirects.path, path)));
    // Relative links in the moved page now start from its new place.
    await deriveFromBody(tx, space, { id: item.id, path, title: item.title }, bodyOf(item.markdown));
    await resolveIncomingLinks(tx, space, item.id, [path]);
    if (item.id === page.id) Object.assign(page, updated);
  }
  return page;
}

/**
 * Moves a page to the trash. Pages with live sub-pages cannot be deleted.
 * Drafts stay, for when the page is restored.
 */
export async function deleteLivePage(tx: DbOrTx, input: { space: SpaceRow; page: PageRow; author: Author }) {
  const { page, author } = input;
  const [child] = await tx
    .select({ id: pages.id })
    .from(pages)
    .where(and(eq(pages.parentId, page.id), isNull(pages.deletedAt)))
    .limit(1);
  if (child) throw conflict("Move or delete its sub-pages first", "has_children");
  const number = page.revision + 1;
  await tx
    .update(pages)
    .set({ deletedAt: sql`now()`, deletedById: author.userId, revision: number, updatedAt: sql`now()` })
    .where(eq(pages.id, page.id));
  await insertRevision(tx, {
    page,
    number,
    kind: "delete",
    markdown: page.markdown,
    previous: page.markdown,
    author,
  });
  await tx.delete(pageSections).where(eq(pageSections.pageId, page.id));
  await tx.delete(pageLinks).where(eq(pageLinks.fromPageId, page.id));
  await tx.update(pageLinks).set({ toPageId: null }).where(eq(pageLinks.toPageId, page.id));
}

/** Takes a page out of the trash, at its old path (which must be free, below a live parent). */
export async function restoreDeletedPage(
  tx: DbOrTx,
  input: {
    space: SpaceRow;
    page: PageRow;
    author: Author;
    /** False when the caller saves a checked file right after (a merge brings the page back). */
    checkFile?: boolean;
  },
): Promise<PageRow> {
  const { space, page, author } = input;
  // Its file must fit the space as it is now: properties may have changed while it was in the trash.
  const current = await spaceForWrite(tx, space.id);
  if (input.checkFile !== false && !canonicalPageFile(page.markdown, schemaOf(current)).ok) {
    throw validationError({}, "The page no longer fits the space's properties and page types.");
  }
  if (await findLivePage(tx, space.id, page.path)) {
    throw conflict(`Another page has the path “${page.path}” now. Move it first.`, "path_taken");
  }
  const parent = await parentOf(tx, space, page.path);
  const number = page.revision + 1;
  const [restored] = await tx
    .update(pages)
    .set({
      deletedAt: null,
      deletedById: null,
      parentId: parent?.id ?? null,
      revision: number,
      updatedById: author.userId,
      updatedAt: sql`now()`,
    })
    .where(eq(pages.id, page.id))
    .returning();
  await insertRevision(tx, {
    page,
    number,
    kind: "restore",
    markdown: page.markdown,
    previous: page.markdown,
    author,
  });
  await tx.delete(redirects).where(and(eq(redirects.spaceId, space.id), eq(redirects.path, page.path)));
  await deriveFromBody(tx, space, page, bodyOf(page.markdown));
  // Links to its path and to its old paths (which still redirect to it) reach it again.
  const oldPaths = await tx
    .select({ path: redirects.path })
    .from(redirects)
    .where(and(eq(redirects.spaceId, space.id), eq(redirects.pageId, page.id)));
  await resolveIncomingLinks(tx, space, page.id, [page.path, ...oldPaths.map((row) => row.path)]);
  return restored!;
}

/**
 * Rebuilds the search data of a live page from its file (after
 * SEARCH_LANGUAGES changed). It locks and reads the page itself, so a save
 * meanwhile is never undone; a page in the trash has nothing to rebuild.
 */
export async function reindexPage(tx: DbOrTx, space: SpaceRow, pageId: string) {
  const page = await lockAnyPage(tx, pageId);
  if (!page || page.deletedAt !== null) return;
  await tx
    .update(pages)
    .set({ searchVector: pageSearchVector(page) })
    .where(eq(pages.id, page.id));
  await deriveFromBody(tx, space, page, bodyOf(page.markdown));
}
