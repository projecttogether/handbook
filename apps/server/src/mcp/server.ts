import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { config } from "../config";
import type { ApiClient } from "./client";
import { registerTools } from "./tools";

const INSTRUCTIONS = `This server is an organization's knowledge base: spaces (one per team or topic) of pages. Each page is a Markdown file with YAML frontmatter (title, description, tags and the space's own properties) and has a path, e.g. it/onboarding/laptop (<space>/<path>).

Reading: use search to find pages, fetch or read_page to read one, list_spaces and list_pages to browse, page_history and read_revision for older versions. You may read everything.

Changing: you never change live pages directly. Work in a change set, which people review and merge:
1. start_change_set in the page's space (one change set per space).
2. Change pages with edit_page (exact text replacements; read the page with read_page and change_set first and copy old_text exactly), write_page (a whole file), create_page, move_page or delete_page. get_space_schema lists the allowed frontmatter.
3. Check get_change_set (errors in checks block merging), then submit_change_set.
Reviewers may ask for changes in the timeline (get_change_set): fix them in the same change set and submit again. When a page changed meanwhile, read it again; a person resolves real conflicts.

Write plain Markdown (CommonMark, GitHub tables, callouts like > [!NOTE]); no HTML. Never put personal data into pages.`;

/** A new MCP server with the knowledge base tools, acting through `api`. One per request (stateless). */
export function createMcpServer(api: ApiClient): McpServer {
  const server = new McpServer(
    { name: "handbook", title: config().APP_NAME, version: "1.0.0" },
    { instructions: INSTRUCTIONS, capabilities: { tools: {} } },
  );
  registerTools(server, api);
  return server;
}
