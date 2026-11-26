import { and, eq, inArray, isNotNull, isNull, ne, or, sql, type Column, type SQL } from "drizzle-orm";
import { ancestorPaths } from "@handbook/shared/paths";
import type { DbOrTx } from "../db/client";
import { changeSets, pages, spaceMembers, spaces } from "../db/schema";
import type { Principal } from "../auth/principal";
import { notFound } from "../http/errors";
import { abilitiesOf, roleFrom, type SpaceContext } from "./access";

/**
 * What a principal may see of pages and change sets. Drafts, the pages below
 * them, the trash, and change sets that change a draft or a page below one
 * (live or in the trash) or put a page below a draft are only for those whose
 * abilities in the space include `seeDrafts` (`spaceAbilities`, the only
 * source of that rule); every other live page is for everyone signed in. A
 * draft thus hides its whole subtree until it is published. Lists, counts and
 * reads of pages and change sets filter through here.
 */
export type Visibility = {
  /** SQL condition: the page is live (not in the trash) and the viewer may see it. */
  livePages(columns?: PageColumns): SQL;
  /** SQL condition: the page is in the trash and the viewer sees the trash of its space. */
  trashedPages(columns?: PageColumns): SQL;
  /**
   * SQL condition on `change_sets`: it changes no draft and no page below a
   * live draft (live or in the trash) and puts no page below a live draft,
   * unless the viewer sees the drafts of the space.
   */
  changeSets(): SQL;
  /** The viewer may see this page (live or in the trash): its status and its ancestors decide. */
  canSeePage(db: DbOrTx, page: PageRef): Promise<boolean>;
  /** 404 for a page the viewer may not see. */
  assertPage(db: DbOrTx, page: PageRef): Promise<void>;
  /** The viewer would see a page at this path: no live draft it may not see is above it. */
  canSeePath(db: DbOrTx, spaceId: string, path: string): Promise<boolean>;
  /** The viewer may see the change set (`changeSets` for one). */
  canSeeChangeSet(db: DbOrTx, changeSet: { id: string; spaceId: string }): Promise<boolean>;
  /** The viewer sees the drafts of this space (and the pages below them). */
  seesDrafts(spaceId: string): boolean;
  /** The viewer sees the trash of this space (the same ability as drafts). */
  seesTrash(spaceId: string): boolean;
};

type PageRef = { spaceId: string; status: string; path: string };

/**
 * The columns `livePages` and `trashedPages` read; `pages` by default. Raw
 * SQL that names the table by an alias passes its own (`sql\`p.status\``).
 */
export type PageColumns = {
  spaceId: Column | SQL;
  status: Column | SQL;
  deletedAt: Column | SQL;
  path: Column | SQL;
};

// Written with the table name: these columns also appear inside the
// subquery of `draftAbove`, where a bare "path" would mean its own pages
// (and Drizzle leaves column names unqualified in select lists).
const PAGES: PageColumns = {
  spaceId: sql`"pages"."space_id"`,
  status: sql`"pages"."status"`,
  deletedAt: sql`"pages"."deleted_at"`,
  path: sql`"pages"."path"`,
};

const idList = (ids: string[]) =>
  sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  );

/**
 * SQL: a live draft of the space lies above the path (a page there is below
 * it), not counting drafts of the spaces in `except`. Live pages always have
 * live parents (pages/core.ts), so the drafts above a live page are its
 * draft ancestors.
 */
function draftAbove(spaceId: Column | SQL, path: Column | SQL, except: string[] = []): SQL {
  const seen = except.length > 0 ? sql` and draft_above.space_id not in (${idList(except)})` : sql``;
  return sql`exists (select 1 from pages draft_above where draft_above.space_id = ${spaceId}
    and draft_above.status = 'draft' and draft_above.deleted_at is null
    and starts_with(${path}, draft_above.path || '/')${seen})`;
}

/** Spaces whose drafts the viewer sees: all of them, or these. */
type DraftSpaces = "all" | ReadonlySet<string>;

function visibility(draftSpaces: DraftSpaces): Visibility {
  const ids = draftSpaces === "all" ? [] : [...draftSpaces];
  const seesDrafts = (spaceId: string) => draftSpaces === "all" || draftSpaces.has(spaceId);
  const canSeePath = async (db: DbOrTx, spaceId: string, path: string) => {
    if (seesDrafts(spaceId)) return true;
    const above = ancestorPaths(path);
    if (above.length === 0) return true;
    const [draft] = await db
      .select({ id: pages.id })
      .from(pages)
      .where(
        and(
          eq(pages.spaceId, spaceId),
          inArray(pages.path, above),
          eq(pages.status, "draft"),
          isNull(pages.deletedAt),
        ),
      )
      .limit(1);
    return !draft;
  };
  const canSeePage = async (db: DbOrTx, page: PageRef) =>
    (page.status !== "draft" || seesDrafts(page.spaceId)) && (await canSeePath(db, page.spaceId, page.path));
  const changeSetCondition = () => {
    if (draftSpaces === "all") return sql`true`;
    // "change_sets" written out: inside the subquery an unqualified id would mean i.id or p.id.
    const space = sql`"change_sets"."space_id"`;
    // The page an item changes (none for new pages), and the path it puts a page at.
    const hidesNothing = sql`not exists (select 1 from change_set_items i left join pages p on p.id = i.page_id
      where i.change_set_id = "change_sets"."id"
        and (p.status = 'draft' or ${draftAbove(sql`p.space_id`, sql`p.path`)} or ${draftAbove(space, sql`i.path`)}))`;
    if (ids.length === 0) return hidesNothing;
    return sql`(${hidesNothing} or ${space} in (${idList(ids)}))`;
  };
  return {
    livePages(columns = PAGES) {
      const live = isNull(columns.deletedAt);
      if (draftSpaces === "all") return live;
      const notDraft = ne(sql`${columns.status}`, "draft");
      return and(
        live,
        ids.length > 0 ? or(notDraft, inArray(sql`${columns.spaceId}`, ids)) : notDraft,
        // A top-level "not exists": PostgreSQL makes it an anti-join.
        sql`not ${draftAbove(columns.spaceId, columns.path, ids)}`,
      )!;
    },
    trashedPages(columns = PAGES) {
      const trashed = isNotNull(columns.deletedAt);
      if (draftSpaces === "all") return trashed;
      return ids.length > 0 ? and(trashed, inArray(sql`${columns.spaceId}`, ids))! : sql`false`;
    },
    changeSets: changeSetCondition,
    canSeePage,
    async assertPage(db, page) {
      if (!(await canSeePage(db, page))) throw notFound("No such page");
    },
    canSeePath,
    async canSeeChangeSet(db, changeSet) {
      if (seesDrafts(changeSet.spaceId)) return true;
      const [row] = await db
        .select({ id: changeSets.id })
        .from(changeSets)
        .where(and(eq(changeSets.id, changeSet.id), changeSetCondition()));
      return Boolean(row);
    },
    seesDrafts,
    seesTrash: seesDrafts,
  };
}

/**
 * What the principal may see in every space, loaded once per request. With
 * the same abilities everywhere (admins: all drafts; service tokens: none)
 * it needs no query; otherwise it reads the principal's memberships and
 * asks `abilitiesOf` about each.
 */
export async function visibilityOf(db: DbOrTx, principal: Principal): Promise<Visibility> {
  // Without a role, seeing drafts does not depend on the space
  // (visibility.int.test.ts checks this in active and archived spaces).
  if (abilitiesOf(principal, null, { archivedAt: null }).seeDrafts) return visibility("all");
  // Service tokens have no role in any space (spaceRoleOf).
  if (principal.kind !== "user") return visibility(new Set());
  const rows = await db
    .select({ id: spaces.id, archivedAt: spaces.archivedAt, role: spaceMembers.role })
    .from(spaceMembers)
    .innerJoin(spaces, eq(spaces.id, spaceMembers.spaceId))
    .where(eq(spaceMembers.userId, principal.id));
  const seen = rows.filter((row) => abilitiesOf(principal, roleFrom(row.role), row).seeDrafts);
  return visibility(new Set(seen.map((row) => row.id)));
}

/**
 * What the principal may see in one space, from the abilities of its
 * context (no query). Outside that space it shows no drafts.
 */
export function spaceVisibility(context: SpaceContext): Visibility {
  return visibility(new Set(context.abilities.seeDrafts ? [context.space.id] : []));
}
