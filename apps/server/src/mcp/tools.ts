import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ChangeSet, ChangeSetPage, ChangeSetSummary } from "@handbook/shared/api/changes";
import type { Page, PageSummary, Revision, RevisionList } from "@handbook/shared/api/pages";
import type { SearchResponse } from "@handbook/shared/api/search";
import { HIGHLIGHT_END, HIGHLIGHT_START } from "@handbook/shared/api/search";
import type { Space, SpaceSummary } from "@handbook/shared/api/spaces";
import { BUILT_IN_PROPERTIES, BUILT_IN_KEYS } from "@handbook/shared/page";
import { diffTextLines } from "@handbook/shared/merge";
import { config } from "../config";
import { ApiCallError, type ApiClient } from "./client";

/**
 * The tools of the MCP server. Each is a thin translation to REST API calls
 * made as the caller (client.ts), so the API's rules apply unchanged: agents
 * read everything and write only into change sets. Results are JSON, as
 * text and as `structuredContent`; API errors become tool errors with the
 * API's message.
 */

type ToolResult = CallToolResult;

function ok(data: unknown): ToolResult {
  const structured =
    data && typeof data === "object" && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : { result: data ?? null };
  return { content: [{ type: "text", text: JSON.stringify(structured) }], structuredContent: structured };
}

function failure(error: ApiCallError): ToolResult {
  const fields = Object.entries(error.fields ?? {})
    .map(([key, message]) => `${key}: ${message}`)
    .join("; ");
  const text = `${error.message}${fields && fields !== error.message ? ` (${fields})` : ""} [${error.status} ${error.code}]`;
  return { isError: true, content: [{ type: "text", text }] };
}

/** A mistake in the tool's input, reported like an API error. */
class ToolInputError extends ApiCallError {
  constructor(message: string) {
    super(400, "invalid_input", message);
  }
}

async function run(body: () => Promise<unknown>): Promise<ToolResult> {
  try {
    return ok(await body());
  } catch (error) {
    if (error instanceof ApiCallError) return failure(error);
    throw error;
  }
}

const READ = { readOnlyHint: true, openWorldHint: false } as const;
const WRITE = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type PageRef = { id: string } | { space: string; path: string };

/** "it/onboarding/laptop", "/s/it/onboarding/laptop(.md)", a page URL, or a page id. */
export function parseRef(value: string): PageRef {
  let text = value.trim();
  if (UUID.test(text)) return { id: text.toLowerCase() };
  try {
    if (/^https?:\/\//i.test(text)) text = new URL(text).pathname;
  } catch {
    // Not a URL; read it as a reference.
  }
  text = text.replace(/^\/+/, "").replace(/^s\//, "").replace(/\.md$/i, "").replace(/\/+$/, "");
  const slash = text.indexOf("/");
  if (slash <= 0 || slash === text.length - 1) {
    throw new ToolInputError(
      `Name a page as <space>/<path>, e.g. it/onboarding/laptop, or by id (got “${value}”)`,
    );
  }
  return { space: text.slice(0, slash), path: text.slice(slash + 1) };
}

const pageRef = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .describe("The page: <space>/<path> (e.g. it/onboarding/laptop) or its id");
const changeSetNumber = z.number().int().min(1).describe("The change set's number");

const url = (path: string) => `${config().APP_URL}${path}`;
const pageUrl = (space: string, path: string) => url(`/s/${space}/${path}`);
const changeSetUrl = (number: number) => url(`/changes/${number}`);

async function livePage(api: ApiClient, ref: PageRef): Promise<Page> {
  if ("id" in ref) return api.get<Page>(`/pages/${ref.id}`);
  return api.get<Page>(`/spaces/${encodeURIComponent(ref.space)}/pages/by-path`, { path: ref.path });
}

/** A page as a change set sees it, or null when the change set does not change it. */
async function inChangeSet(api: ApiClient, number: number, ref: PageRef): Promise<ChangeSetPage | null> {
  try {
    if ("id" in ref) return await api.get<ChangeSetPage>(`/change-sets/${number}/pages/${ref.id}`);
    return await api.get<ChangeSetPage>(`/change-sets/${number}/pages/by-path`, { path: ref.path });
  } catch (error) {
    if (error instanceof ApiCallError && error.status === 404 && error.code === "not_found") return null;
    throw error;
  }
}

/** The page id a reference names inside a change set: an item of the change set, else the live page. */
async function pageIdIn(api: ApiClient, changeSet: ChangeSet, ref: PageRef): Promise<string> {
  if ("id" in ref) return ref.id;
  if (ref.space !== changeSet.space.slug) {
    throw new ToolInputError(
      `Change set #${changeSet.number} belongs to the space “${changeSet.space.slug}”`,
    );
  }
  const item = await inChangeSet(api, changeSet.number, ref);
  if (item) return item.item.pageId;
  return (await livePage(api, ref)).id;
}

function itemResult(changeSet: ChangeSet, pageId: string | null) {
  const item = pageId ? changeSet.items.find((candidate) => candidate.pageId === pageId) : undefined;
  return {
    changeSet: changeSet.number,
    url: changeSetUrl(changeSet.number),
    status: changeSet.status,
    page: item
      ? {
          id: item.pageId,
          page: `${changeSet.space.slug}/${item.path}`,
          action: item.action,
          title: item.title,
          added: item.added,
          removed: item.removed,
        }
      : null,
    checks: changeSet.checks.filter((check) => !pageId || check.pageId === pageId || check.pageId === null),
  };
}

function plainSnippet(snippet: string) {
  return snippet.split(HIGHLIGHT_START).join("**").split(HIGHLIGHT_END).join("**");
}

/** A compact line diff: changed lines with two lines of context, "…" between hunks. */
export function compactDiff(before: string, after: string): string {
  const lines = diffTextLines(before, after);
  const keep = new Set<number>();
  lines.forEach((line, index) => {
    if (line.kind === "same") return;
    for (let near = Math.max(0, index - 2); near <= Math.min(lines.length - 1, index + 2); near += 1)
      keep.add(near);
  });
  const output: string[] = [];
  let last = -1;
  for (const index of [...keep].sort((a, b) => a - b)) {
    if (last !== -1 && index > last + 1) output.push("…");
    const line = lines[index]!;
    output.push(`${line.kind === "added" ? "+" : line.kind === "removed" ? "-" : " "} ${line.text}`);
    last = index;
  }
  return output.join("\n");
}

/** Registers the tools on a server for one MCP request. */
export function registerTools(server: McpServer, api: ApiClient) {
  server.registerTool(
    "search",
    {
      title: "Search the knowledge base",
      description:
        "Full-text search over every space: titles, search terms, tags and text, best matches first. " +
        "Returns per page its id (<space>/<path>), title, url and a snippet of the best matching section (matches in **bold**). " +
        "Read a whole page with fetch or read_page.",
      inputSchema: {
        query: z.string().trim().min(1).max(200).describe("Search words"),
        space: z.string().max(40).optional().describe("Only this space (its slug)"),
        tag: z.string().max(50).optional().describe("Only pages with this tag"),
        type: z.string().max(40).optional().describe("Only pages of this page type"),
        limit: z.number().int().min(1).max(50).optional().describe("Most results (default 10)"),
      },
      annotations: READ,
    },
    ({ query, space, tag, type, limit }) =>
      run(async () => {
        const response = await api.get<SearchResponse>("/search", {
          q: query,
          space,
          tag,
          type,
          limit: limit ?? 10,
        });
        return {
          results: response.results.map((result) => ({
            id: `${result.space.slug}/${result.path}`,
            title: result.title,
            url: result.url,
            text: plainSnippet(result.snippet),
            section: result.headingPath.join(" › ") || null,
            space: result.space.slug,
            pageId: result.pageId,
          })),
        };
      }),
  );

  server.registerTool(
    "fetch",
    {
      title: "Fetch a page",
      description:
        "Returns one live page as a Markdown file (frontmatter and body): id, title, text, url and metadata. " +
        "The id is <space>/<path> as search returns it, or a page id.",
      inputSchema: { id: pageRef },
      annotations: READ,
    },
    ({ id }) =>
      run(async () => {
        const page = await livePage(api, parseRef(id));
        return {
          id: `${page.space}/${page.path}`,
          title: page.title,
          text: page.markdown,
          url: pageUrl(page.space, page.path),
          metadata: {
            pageId: page.id,
            space: page.space,
            path: page.path,
            revision: page.revision,
            status: page.status,
            type: page.type,
            tags: page.tags,
            updatedAt: page.updatedAt,
          },
        };
      }),
  );

  server.registerTool(
    "list_spaces",
    {
      title: "List spaces",
      description:
        "Lists the spaces (knowledge bases): slug, name, description, number of pages, and your role there (owner, editor or none).",
      inputSchema: {},
      annotations: READ,
    },
    () =>
      run(async () => {
        const response = await api.get<{ items: SpaceSummary[] }>("/spaces");
        return {
          spaces: response.items.map((space) => ({
            space: space.slug,
            name: space.name,
            description: space.description,
            pages: space.pageCount,
            yourRole: space.myRole,
            url: url(`/s/${space.slug}`),
          })),
        };
      }),
  );

  server.registerTool(
    "list_pages",
    {
      title: "List the pages of a space",
      description:
        "Lists a space's pages as a tree (path order): <space>/<path>, title, description, type, status, tags, revision. " +
        "Filter by a path prefix, tag, page type or status.",
      inputSchema: {
        space: z.string().trim().min(1).max(40).describe("The space's slug"),
        under: z
          .string()
          .max(400)
          .optional()
          .describe("Only this page and its sub-pages (a path, e.g. onboarding)"),
        tag: z.string().max(50).optional(),
        type: z.string().max(40).optional(),
        status: z.enum(["draft", "active", "deprecated"]).optional(),
      },
      annotations: READ,
    },
    ({ space, under, tag, type, status }) =>
      run(async () => {
        const response = await api.get<{ items: PageSummary[] }>(`/spaces/${encodeURIComponent(space)}/tree`);
        const prefix = under?.replace(/^\/+|\/+$/g, "");
        const items = response.items
          .filter((page) => !prefix || page.path === prefix || page.path.startsWith(`${prefix}/`))
          .filter((page) => !tag || page.tags.includes(tag.toLowerCase()))
          .filter((page) => !type || page.type === type)
          .filter((page) => !status || page.status === status)
          .sort((a, b) => a.path.localeCompare(b.path));
        return {
          pages: items.slice(0, 1000).map((page) => ({
            page: `${page.space}/${page.path}`,
            id: page.id,
            title: page.title,
            description: page.description,
            type: page.type,
            status: page.status,
            tags: page.tags,
            revision: page.revision,
          })),
          total: items.length,
        };
      }),
  );

  server.registerTool(
    "get_space_schema",
    {
      title: "Get a space's properties and page types",
      description:
        "What page files of a space may contain: the built-in frontmatter properties, the space's custom properties (key, type, options, required), " +
        "and its page types (key, help: what the type is for, template: the body a new page starts with, required properties: custom or built-in keys). " +
        "Read this before creating pages or changing frontmatter: " +
        "unknown keys and invalid values are refused.",
      inputSchema: { space: z.string().trim().min(1).max(40).describe("The space's slug") },
      annotations: READ,
    },
    ({ space }) =>
      run(async () => {
        const detail = await api.get<Space>(`/spaces/${encodeURIComponent(space)}`);
        return {
          space: detail.slug,
          name: detail.name,
          description: detail.description,
          builtInProperties: BUILT_IN_KEYS.map((key) => ({ key, ...BUILT_IN_PROPERTIES[key] })),
          properties: detail.properties,
          pageTypes: detail.pageTypes,
          yourAbilities: detail.abilities,
          fileFormat:
            "---\ntitle: Laptop setup\ndescription: One sentence.\ntags:\n  - onboarding\n---\n\nThe body in Markdown (CommonMark with GitHub tables and callouts like > [!NOTE]). No HTML.\n",
        };
      }),
  );

  server.registerTool(
    "read_page",
    {
      title: "Read a page",
      description:
        "Returns a page's whole Markdown file and its revision. With change_set, returns the page as that change set proposes it " +
        "(or the live page when the change set does not change it). Copy old_text for edit_page from here exactly.",
      inputSchema: {
        page: pageRef,
        change_set: changeSetNumber.optional().describe("Read the page as this change set proposes it"),
      },
      annotations: READ,
    },
    ({ page, change_set }) =>
      run(async () => {
        const ref = parseRef(page);
        if (change_set !== undefined) {
          const view = await inChangeSet(api, change_set, ref);
          if (view) {
            const changeSet = await api.get<ChangeSet>(`/change-sets/${change_set}`);
            return {
              id: view.item.pageId,
              page: `${changeSet.space.slug}/${view.item.path}`,
              title: view.item.title,
              changeSet: change_set,
              action: view.item.action,
              baseRevision: view.item.baseRevision,
              liveRevision: view.item.liveRevision,
              conflict: view.item.conflict,
              markdown: view.proposed,
              note: view.proposed === null ? "This change set deletes the page." : undefined,
            };
          }
        }
        const live = await livePage(api, ref);
        return {
          id: live.id,
          page: `${live.space}/${live.path}`,
          title: live.title,
          url: pageUrl(live.space, live.path),
          revision: live.revision,
          status: live.status,
          ...(change_set !== undefined ? { changeSet: change_set, inChangeSet: false } : {}),
          editing: live.lock ? `${live.lock.user.name} is editing it in the web app` : null,
          markdown: live.markdown,
        };
      }),
  );

  server.registerTool(
    "page_history",
    {
      title: "Page history",
      description:
        "Lists a page's revisions, newest first: number, kind (save, move, delete, restore), who, how, change set, lines changed. `total` counts all; use `offset` for older ones.",
      inputSchema: {
        page: pageRef,
        limit: z.number().int().min(1).max(200).optional().describe("Most revisions (default 20)"),
        offset: z.number().int().min(0).optional().describe("Skips this many of the newest (default 0)"),
      },
      annotations: READ,
    },
    ({ page, limit, offset }) =>
      run(async () => {
        const live = await livePage(api, parseRef(page));
        const response = await api.get<RevisionList>(`/pages/${live.id}/revisions`, {
          limit: limit ?? 20,
          offset: offset ?? 0,
        });
        return {
          page: `${live.space}/${live.path}`,
          total: response.total,
          revisions: response.items.map((revision) => ({
            number: revision.number,
            kind: revision.kind,
            title: revision.title,
            path: revision.path,
            author: revision.author?.name ?? null,
            via: revision.via,
            client: revision.clientName,
            changeSet: revision.changeSet?.number ?? null,
            message: revision.message,
            added: revision.added,
            removed: revision.removed,
            createdAt: revision.createdAt,
          })),
        };
      }),
  );

  server.registerTool(
    "read_revision",
    {
      title: "Read an old revision",
      description: "Returns the whole Markdown file of one revision of a page.",
      inputSchema: { page: pageRef, revision: z.number().int().min(1).describe("The revision number") },
      annotations: READ,
    },
    ({ page, revision }) =>
      run(async () => {
        const live = await livePage(api, parseRef(page));
        const result = await api.get<Revision>(`/pages/${live.id}/revisions/${revision}`);
        return {
          page: `${live.space}/${live.path}`,
          number: result.number,
          kind: result.kind,
          path: result.path,
          author: result.author?.name ?? null,
          via: result.via,
          createdAt: result.createdAt,
          markdown: result.markdown,
        };
      }),
  );

  server.registerTool(
    "list_change_sets",
    {
      title: "List change sets",
      description:
        "Lists change sets (proposed changes): number, space, title, status, author, pages changed. Default: open and in review.",
      inputSchema: {
        space: z.string().max(40).optional(),
        status: z.enum(["active", "open", "in_review", "merged", "closed", "all"]).optional(),
        mine: z.boolean().optional().describe("Only change sets you started"),
      },
      annotations: READ,
    },
    ({ space, status, mine }) =>
      run(async () => {
        const response = await api.get<{ items: ChangeSetSummary[] }>("/change-sets", {
          space,
          status,
          mine,
        });
        return {
          changeSets: response.items.map((item) => ({
            number: item.number,
            space: item.space.slug,
            title: item.title,
            status: item.status,
            author: item.author?.name ?? null,
            client: item.clientName,
            pages: item.pages,
            updatedAt: item.updatedAt,
            url: changeSetUrl(item.number),
          })),
        };
      }),
  );

  server.registerTool(
    "start_change_set",
    {
      title: "Start a change set",
      description:
        "Starts a change set in a space: a set of page changes that people review and merge. Nothing changes live until then. " +
        "Then add changes with create_page, edit_page, write_page, move_page or delete_page, and finish with submit_change_set.",
      inputSchema: {
        space: z.string().trim().min(1).max(40).describe("The space's slug"),
        title: z
          .string()
          .trim()
          .min(1)
          .max(200)
          .describe("What the change does, e.g. 'Update the VPN setup for macOS 27'"),
        description: z
          .string()
          .max(10_000)
          .optional()
          .describe("Why, and what reviewers should check (Markdown)"),
      },
      annotations: WRITE,
    },
    ({ space, title, description }) =>
      run(async () => {
        const created = await api.post<ChangeSet>("/change-sets", {
          space,
          title,
          description: description ?? "",
        });
        return {
          changeSet: created.number,
          url: changeSetUrl(created.number),
          status: created.status,
          space: created.space.slug,
        };
      }),
  );

  server.registerTool(
    "get_change_set",
    {
      title: "Get a change set",
      description:
        "A change set's status, pages changed (with conflicts), checks (errors block merging), and timeline including reviewers' comments. " +
        "With include_diffs, also a line diff per page.",
      inputSchema: { change_set: changeSetNumber, include_diffs: z.boolean().optional() },
      annotations: READ,
    },
    ({ change_set, include_diffs }) =>
      run(async () => {
        const changeSet = await api.get<ChangeSet>(`/change-sets/${change_set}`);
        const pages = [];
        for (const item of changeSet.items) {
          let diff: string | undefined;
          if (include_diffs && pages.length < 30) {
            const view = await api.get<ChangeSetPage>(`/change-sets/${change_set}/pages/${item.pageId}`);
            diff = compactDiff(view.base ?? view.live ?? "", view.proposed ?? "");
          }
          pages.push({
            id: item.pageId,
            page: `${changeSet.space.slug}/${item.path}`,
            fromPath: item.fromPath,
            action: item.action,
            title: item.title,
            added: item.added,
            removed: item.removed,
            conflict: item.conflict,
            ...(diff !== undefined ? { diff } : {}),
          });
        }
        return {
          changeSet: changeSet.number,
          url: changeSetUrl(changeSet.number),
          space: changeSet.space.slug,
          title: changeSet.title,
          description: changeSet.description,
          status: changeSet.status,
          author: changeSet.author?.name ?? null,
          pages,
          checks: changeSet.checks,
          timeline: changeSet.events.slice(-30).map((event) => ({
            kind: event.kind,
            by: event.actor?.name ?? null,
            client: event.clientName,
            text: event.body,
            at: event.createdAt,
          })),
          youMay: changeSet.permissions,
        };
      }),
  );

  server.registerTool(
    "create_page",
    {
      title: "Create a page in a change set",
      description:
        "Adds a new page to a change set: page is <space>/<path> (the parent page must exist or be created in the same change set), " +
        "markdown the whole file with frontmatter (title required; see get_space_schema). Fails when the path is taken: use write_page or edit_page then.",
      inputSchema: {
        change_set: changeSetNumber,
        page: z
          .string()
          .trim()
          .min(3)
          .max(500)
          .describe("<space>/<path> of the new page, e.g. it/onboarding/vpn"),
        markdown: z.string().min(1).max(500_000).describe("The whole file: frontmatter and body"),
      },
      annotations: WRITE,
    },
    ({ change_set, page, markdown }) =>
      run(async () => {
        const ref = parseRef(page);
        if ("id" in ref) throw new ToolInputError("Name the new page as <space>/<path>");
        const changeSet = await api.get<ChangeSet>(`/change-sets/${change_set}`);
        if (ref.space !== changeSet.space.slug) {
          throw new ToolInputError(
            `Change set #${change_set} belongs to the space “${changeSet.space.slug}”`,
          );
        }
        if (await inChangeSet(api, change_set, ref)) {
          throw new ToolInputError(
            "This change set has a page at that path already; use write_page or edit_page",
          );
        }
        const exists = await livePage(api, ref).then(
          () => true,
          (error: unknown) => {
            if (error instanceof ApiCallError && error.status === 404) return false;
            throw error;
          },
        );
        if (exists) throw new ToolInputError("A page with that path exists; use write_page or edit_page");
        const result = await api.put<ChangeSet>(`/change-sets/${change_set}/pages`, {
          path: ref.path,
          markdown,
        });
        const item = result.items.find((candidate) => candidate.path === ref.path);
        return itemResult(result, item?.pageId ?? null);
      }),
  );

  server.registerTool(
    "edit_page",
    {
      title: "Edit a page in a change set",
      description:
        "Replaces exact text in a page, inside a change set (like editing a file): each old_text must occur exactly once in the current file " +
        "(read it with read_page and the change_set first), or set replace_all. Edits apply in order. Works on live pages and pages the change set adds.",
      inputSchema: {
        change_set: changeSetNumber,
        page: pageRef,
        edits: z
          .array(
            z.object({
              old_text: z.string().min(1).describe("Exact text to replace, including line breaks"),
              new_text: z.string().describe("The replacement"),
              replace_all: z.boolean().optional().describe("Replace every occurrence"),
            }),
          )
          .min(1)
          .max(100),
      },
      annotations: WRITE,
    },
    ({ change_set, page, edits }) =>
      run(async () => {
        const changeSet = await api.get<ChangeSet>(`/change-sets/${change_set}`);
        const pageId = await pageIdIn(api, changeSet, parseRef(page));
        const result = await api.post<ChangeSet>(`/change-sets/${change_set}/pages/${pageId}/edit`, {
          edits: edits.map((edit) => ({
            oldText: edit.old_text,
            newText: edit.new_text,
            replaceAll: edit.replace_all,
          })),
        });
        return itemResult(result, pageId);
      }),
  );

  server.registerTool(
    "write_page",
    {
      title: "Write a whole page in a change set",
      description:
        "Replaces a page's whole file inside a change set, or adds the page when nothing is at that path. Prefer edit_page for small changes. " +
        "Pass base_revision (the revision read_page returned) so that changes saved meanwhile are merged, not undone.",
      inputSchema: {
        change_set: changeSetNumber,
        page: pageRef,
        markdown: z.string().min(1).max(500_000).describe("The whole file: frontmatter and body"),
        base_revision: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe("The live revision the file was written from (from read_page)"),
      },
      annotations: WRITE,
    },
    ({ change_set, page, markdown, base_revision }) =>
      run(async () => {
        const changeSet = await api.get<ChangeSet>(`/change-sets/${change_set}`);
        const ref = parseRef(page);
        let pageId: string | null = null;
        try {
          pageId = await pageIdIn(api, changeSet, ref);
        } catch (error) {
          if (!(error instanceof ApiCallError && error.status === 404) || "id" in ref) throw error;
        }
        const result = await api.put<ChangeSet>(
          `/change-sets/${change_set}/pages`,
          pageId
            ? { pageId, markdown, baseRevision: base_revision }
            : { path: (ref as { path: string }).path, markdown, baseRevision: base_revision },
        );
        const target =
          pageId ?? result.items.find((item) => item.path === (ref as { path: string }).path)?.pageId ?? null;
        return itemResult(result, target);
      }),
  );

  server.registerTool(
    "move_page",
    {
      title: "Move or rename a page in a change set",
      description:
        "Gives a page a new path inside a change set; its sub-pages move along when merged, and old links keep working. The new parent must exist.",
      inputSchema: {
        change_set: changeSetNumber,
        page: pageRef,
        new_page: z.string().trim().min(3).max(500).describe("The new <space>/<path> (same space)"),
      },
      annotations: WRITE,
    },
    ({ change_set, page, new_page }) =>
      run(async () => {
        const changeSet = await api.get<ChangeSet>(`/change-sets/${change_set}`);
        const pageId = await pageIdIn(api, changeSet, parseRef(page));
        const target = parseRef(new_page);
        if ("id" in target || target.space !== changeSet.space.slug) {
          throw new ToolInputError(`Give the new path as ${changeSet.space.slug}/<path>`);
        }
        const result = await api.post<ChangeSet>(`/change-sets/${change_set}/pages/${pageId}/move`, {
          path: target.path,
        });
        return itemResult(result, pageId);
      }),
  );

  server.registerTool(
    "delete_page",
    {
      title: "Delete a page in a change set",
      description:
        "Proposes deleting a page (it goes to the trash when merged and can be restored). Pages with sub-pages cannot be deleted. " +
        "For a page the change set adds, this removes it from the change set.",
      inputSchema: { change_set: changeSetNumber, page: pageRef },
      annotations: WRITE,
    },
    ({ change_set, page }) =>
      run(async () => {
        const changeSet = await api.get<ChangeSet>(`/change-sets/${change_set}`);
        const pageId = await pageIdIn(api, changeSet, parseRef(page));
        const result = await api.post<ChangeSet>(`/change-sets/${change_set}/pages/${pageId}/delete`, {});
        return itemResult(result, pageId);
      }),
  );

  server.registerTool(
    "undo_page_change",
    {
      title: "Undo a page's change in a change set",
      description:
        "Takes one page's change out of a change set, so the change set leaves that page as it is live.",
      inputSchema: { change_set: changeSetNumber, page: pageRef },
      annotations: WRITE,
    },
    ({ change_set, page }) =>
      run(async () => {
        const changeSet = await api.get<ChangeSet>(`/change-sets/${change_set}`);
        const pageId = await pageIdIn(api, changeSet, parseRef(page));
        const result = await api.delete<ChangeSet>(`/change-sets/${change_set}/pages/${pageId}`);
        return itemResult(result, null);
      }),
  );

  server.registerTool(
    "comment_on_change_set",
    {
      title: "Comment on a change set",
      description: "Adds a comment to a change set's timeline, e.g. to answer a reviewer.",
      inputSchema: {
        change_set: changeSetNumber,
        text: z.string().trim().min(1).max(10_000).describe("The comment (Markdown)"),
      },
      annotations: WRITE,
    },
    ({ change_set, text }) =>
      run(async () => {
        const result = await api.post<ChangeSet>(`/change-sets/${change_set}/comments`, { body: text });
        return { changeSet: result.number, url: changeSetUrl(result.number), status: result.status };
      }),
  );

  server.registerTool(
    "submit_change_set",
    {
      title: "Ask for review",
      description:
        "Marks a change set as ready for review. Editors of the space then review, ask for changes or merge it; you cannot merge yourself. " +
        "Check get_change_set first: errors in checks block merging.",
      inputSchema: {
        change_set: changeSetNumber,
        note: z.string().max(10_000).optional().describe("A note for the reviewers"),
      },
      annotations: WRITE,
    },
    ({ change_set, note }) =>
      run(async () => {
        const result = await api.post<ChangeSet>(`/change-sets/${change_set}/submit`, note ? { note } : {});
        return {
          changeSet: result.number,
          url: changeSetUrl(result.number),
          status: result.status,
          checks: result.checks,
        };
      }),
  );
}
