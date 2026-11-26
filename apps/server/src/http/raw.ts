import { Readable } from "node:stream";
import { Hono, type Context } from "hono";
import { and, asc, eq, isNull } from "drizzle-orm";
import { isValidPath, isValidSpaceSlug, pageMarkdownUrl } from "@handbook/shared/paths";
import { config } from "../config";
import { getDb } from "../db/client";
import { files, pages, spaces } from "../db/schema";
import { readStoredFile, isInlineImage } from "../files/storage";
import { getSpace, spaceContext } from "../spaces/access";
import { spaceVisibility } from "../spaces/visibility";
import { findPageByPathOrRedirect } from "../pages/core";
import type { Principal } from "../auth/principal";
import type { AppEnv } from "./env";

/**
 * Routes outside /api/v1 that agents and the browser read directly:
 * uploaded files (/files/:id/:name), pages as Markdown files
 * (/s/:space/<path>.md), space indexes (/s/:space.md) and /llms.txt.
 * Anything else falls through to the web app.
 */

function unauthorized(c: Context<AppEnv>) {
  return c.text("Sign in, or send a token: Authorization: Bearer <token>\n", 401, {
    "WWW-Authenticate": 'Bearer realm="handbook"',
  });
}

function markdown(c: Context<AppEnv>, text: string) {
  return c.body(text, 200, {
    "content-type": "text/markdown; charset=utf-8",
    "cache-control": "private, no-cache",
    "x-content-type-options": "nosniff",
  });
}

const notFoundText = (c: Context<AppEnv>) => c.text("Not found\n", 404);

function decodePath(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

/** The space index: every visible live page as a nested list of links to its Markdown file. */
async function spaceIndex(principal: Principal, slug: string): Promise<string | null> {
  const [space] = await getDb().select().from(spaces).where(eq(spaces.slug, slug));
  if (!space) return null;
  const context = await spaceContext(getDb(), principal, space);
  const rows = await getDb()
    .select({
      id: pages.id,
      parentId: pages.parentId,
      path: pages.path,
      title: pages.title,
      description: pages.description,
    })
    .from(pages)
    .where(and(eq(pages.spaceId, space.id), spaceVisibility(context).livePages()))
    .orderBy(asc(pages.position), asc(pages.title));
  const byParent = new Map<string | null, typeof rows>();
  for (const row of rows) byParent.set(row.parentId, [...(byParent.get(row.parentId) ?? []), row]);
  const lines: string[] = [`# ${space.name}`, ""];
  if (space.description) lines.push(space.description, "");
  lines.push(
    `Pages of this space. Each link is the page's Markdown file; add it to ${config().APP_URL}.`,
    "",
  );
  const walk = (parentId: string | null, depth: number) => {
    for (const row of byParent.get(parentId) ?? []) {
      const description = row.description ? `: ${row.description}` : "";
      lines.push(
        `${"  ".repeat(depth)}- [${row.title}](${pageMarkdownUrl(space.slug, row.path)})${description}`,
      );
      walk(row.id, depth + 1);
    }
  };
  // A draft hides the pages below it: every listed page's parent is listed.
  walk(null, 0);
  return `${lines.join("\n")}\n`;
}

async function llmsText(): Promise<string> {
  const settings = config();
  const rows = await getDb().select().from(spaces).where(isNull(spaces.archivedAt)).orderBy(asc(spaces.name));
  const lines = [
    `# ${settings.APP_NAME}`,
    "",
    "> The knowledge base of this organization: spaces of Markdown pages.",
    "",
    "## For agents",
    "",
    `- MCP server: ${settings.mcpUrl} (sign in with OAuth, or send a personal token as \`Authorization: Bearer\`). Agents read every space and propose changes as change sets that editors review.`,
    `- Every page as a Markdown file: ${settings.APP_URL}/s/<space>/<path>.md`,
    `- Search: ${settings.APP_URL}/api/v1/search?q=<words>`,
    "",
    "## Spaces",
    "",
    ...rows.map(
      (space) =>
        `- [${space.name}](${settings.APP_URL}/s/${space.slug}.md)${space.description ? `: ${space.description}` : ""}`,
    ),
  ];
  return `${lines.join("\n")}\n`;
}

export function rawRoutes() {
  const app = new Hono<AppEnv>();

  app.get("/files/:id/:name", async (c) => {
    const principal = c.get("principal");
    if (!principal) return unauthorized(c);
    const id = c.req.param("id");
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return notFoundText(c);
    const [row] = await getDb().select().from(files).where(eq(files.id, id.toLowerCase()));
    if (!row) return notFoundText(c);
    const inline = isInlineImage(row.contentType);
    const encoded = encodeURIComponent(row.name);
    const ascii = row.name.replace(/[^\x20-\x7e]|["\\]/g, "_");
    c.header("content-type", inline ? row.contentType : "application/octet-stream");
    c.header("content-length", String(row.size));
    c.header(
      "content-disposition",
      `${inline ? "inline" : "attachment"}; filename="${ascii}"; filename*=UTF-8''${encoded}`,
    );
    c.header("x-content-type-options", "nosniff");
    c.header("content-security-policy", "sandbox; default-src 'none'");
    c.header("cache-control", "private, max-age=31536000, immutable");
    return c.body(Readable.toWeb(readStoredFile(row)) as ReadableStream);
  });

  app.get("/llms.txt", async (c) => {
    const principal = c.get("principal");
    if (!principal) return unauthorized(c);
    return c.body(await llmsText(), 200, {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
    });
  });

  app.get("/s/*", async (c, next) => {
    const raw = c.req.path.slice("/s/".length);
    if (!raw.endsWith(".md")) return next();
    const principal = c.get("principal");
    if (!principal) return unauthorized(c);
    const decoded = decodePath(raw.slice(0, -".md".length));
    if (!decoded) return notFoundText(c);
    const slash = decoded.indexOf("/");
    if (slash === -1) {
      if (!isValidSpaceSlug(decoded)) return notFoundText(c);
      const index = await spaceIndex(principal, decoded);
      return index === null ? notFoundText(c) : markdown(c, index);
    }
    const slug = decoded.slice(0, slash);
    const path = decoded.slice(slash + 1).replace(/\/index$/, "");
    if (!isValidSpaceSlug(slug) || !isValidPath(path)) return notFoundText(c);
    const space = await getSpace(getDb(), slug).catch(() => null);
    if (!space) return notFoundText(c);
    const context = await spaceContext(getDb(), principal, space);
    const page = await findPageByPathOrRedirect(getDb(), space.id, path);
    if (!page || !(await spaceVisibility(context).canSeePage(getDb(), page))) return notFoundText(c);
    if (page.path !== path) {
      // The destination is only visible while this principal has access.
      c.header("cache-control", "no-store");
      return c.redirect(pageMarkdownUrl(slug, page.path), 301);
    }
    return markdown(c, page.markdown);
  });

  return app;
}
