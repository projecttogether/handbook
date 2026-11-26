import { sql, type SQL } from "drizzle-orm";
import {
  HIGHLIGHT_END,
  HIGHLIGHT_START,
  type SearchQuery,
  type SearchResult,
} from "@handbook/shared/api/search";
import { normalizeTag } from "@handbook/shared/page";
import { pageUrl } from "@handbook/shared/paths";
import { config } from "../config";
import type { DbOrTx } from "../db/client";
import type { Principal } from "../auth/principal";
import { visibilityOf } from "../spaces/visibility";

/**
 * Full-text search over live pages (docs/architecture.md, "Search"). Ranks
 * each page by its title, search terms, tags and description plus its best
 * matching section; returns the best section per page with a snippet.
 * Titles also match with trigram similarity, for typos.
 */

function tsQuery(text: string): SQL {
  return sql.join(
    config().searchConfigs.map((language) => sql`websearch_to_tsquery(${language}::regconfig, ${text})`),
    sql` || `,
  );
}

/** The live pages (alias p) the viewer may see, and the query's filters. */
function filters(query: SearchQuery, visible: SQL): SQL {
  const parts: SQL[] = [visible];
  if (query.space) parts.push(sql`sp.slug = ${query.space}`);
  // @> (not = any) so the GIN index on tags can find the pages.
  if (query.tag) parts.push(sql`p.tags @> array[${normalizeTag(query.tag)}]::text[]`);
  if (query.type) parts.push(sql`p.type = ${query.type}`);
  return sql.join(parts, sql` and `);
}

type Row = {
  id: string;
  path: string;
  title: string;
  description: string | null;
  tags: string[];
  type: string | null;
  space_slug: string;
  space_name: string;
  anchor: string | null;
  heading_path: string[] | null;
  snippet: string | null;
  score: number;
};

const HEADLINE_OPTIONS = `StartSel=${HIGHLIGHT_START}, StopSel=${HIGHLIGHT_END}, MaxWords=35, MinWords=12, ShortWord=2, MaxFragments=1, FragmentDelimiter=" … "`;

function toResult(row: Row): SearchResult {
  const anchor = row.anchor ?? null;
  return {
    pageId: row.id,
    space: { slug: row.space_slug, name: row.space_name },
    path: row.path,
    title: row.title,
    description: row.description,
    headingPath: row.heading_path ?? [],
    anchor,
    url: `${config().APP_URL}${pageUrl(row.space_slug, row.path, anchor)}`,
    snippet: (row.snippet ?? "").trim(),
    tags: row.tags,
    type: row.type,
    score: Math.round(Number(row.score) * 1000) / 1000,
  };
}

/** Titles more similar to the query than this (pg_trgm) match as typos. */
const TITLE_SIMILARITY = 0.3;

export async function searchPages(
  db: DbOrTx,
  principal: Principal,
  query: SearchQuery,
): Promise<SearchResult[]> {
  const q = tsQuery(query.q);
  const visible = (await visibilityOf(db, principal)).livePages({
    spaceId: sql`p.space_id`,
    status: sql`p.status`,
    deletedAt: sql`p.deleted_at`,
    path: sql`p.path`,
  });
  const headlineLanguage = config().searchConfigs[0]!;
  // Only pages whose own search data or one of whose sections matches are
  // ranked; both come from the GIN indexes. `sections` keeps the best
  // matching section per page (rank, then position). The snippet is built
  // only for the pages returned.
  const ranked = await db.execute<Row>(sql`
    with q as (select ${q} as query),
    sections as (
      select distinct on (s.page_id) s.page_id, s.id, ts_rank(s.search_vector, q.query) as rank
      from page_sections s
      cross join q
      where s.search_vector @@ q.query
      order by s.page_id, rank desc, s.position
    ),
    matches as (
      select p.id from pages p cross join q where p.search_vector @@ q.query
      union
      select page_id from sections
    ),
    top as (
      select p.id, p.path, p.title, p.description, p.tags, p.type, sp.slug as space_slug, sp.name as space_name,
        best.id as section_id,
        (ts_rank(p.search_vector, q.query) * 2 + coalesce(best.rank, 0)) as score
      from matches m
      join pages p on p.id = m.id
      join spaces sp on sp.id = p.space_id
      cross join q
      left join sections best on best.page_id = p.id
      where ${filters(query, visible)}
      order by score desc, p.title
      limit ${query.limit}
    )
    select top.id, top.path, top.title, top.description, top.tags, top.type, top.space_slug, top.space_name,
      best.anchor, best.heading_path,
      ts_headline(${headlineLanguage}::regconfig,
        coalesce(best.content, nullif(top.description, ''),
          (select s.content from page_sections s where s.page_id = top.id order by s.position limit 1), ''),
        q.query, ${HEADLINE_OPTIONS}) as snippet,
      top.score
    from top
    cross join q
    left join page_sections best on best.id = top.section_id
    order by top.score desc, top.title
  `);
  const results = ranked.rows.map(toResult);
  if (results.length >= query.limit) return results;

  // Typos: titles similar to the query that full-text search missed. The %
  // operator (not similarity() alone) lets the trigram index find them; its
  // threshold is set for this transaction only.
  const seen = results.map((result) => result.pageId);
  const similar = await db.transaction(async (tx) => {
    await tx.execute(
      sql`select set_config('pg_trgm.similarity_threshold', ${String(TITLE_SIMILARITY)}, true)`,
    );
    return tx.execute<Row>(sql`
      select p.id, p.path, p.title, p.description, p.tags, p.type, sp.slug as space_slug, sp.name as space_name,
        null as anchor, null as heading_path,
        left(coalesce(nullif(p.description, ''), (select s.content from page_sections s where s.page_id = p.id order by s.position limit 1), ''), 240) as snippet,
        similarity(p.title, ${query.q}) * 0.5 as score
      from pages p
      join spaces sp on sp.id = p.space_id
      where ${filters(query, visible)}
        and p.title % ${query.q}
        ${
          seen.length > 0
            ? sql`and p.id not in (${sql.join(
                seen.map((id) => sql`${id}::uuid`),
                sql`, `,
              )})`
            : sql``
        }
      order by similarity(p.title, ${query.q}) desc, p.title
      limit ${query.limit - results.length}
    `);
  });
  return [...results, ...similar.rows.map(toResult)];
}
