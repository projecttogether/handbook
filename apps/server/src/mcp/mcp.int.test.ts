import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "../db/client";
import { pages } from "../db/schema";
import { issueCredential } from "../auth/credentials";
import { createPage, createSpace, createToken, createUser, request, resetDatabase } from "../test/helpers";

vi.mock("../auth/resolve", () => import("../test/resolve-mock"));

const MCP_HEADERS = { accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" };
let sequence = 0;

async function rpc(token: string | undefined, method: string, params: Record<string, unknown> = {}) {
  return request("POST", "/mcp", {
    token,
    body: { jsonrpc: "2.0", id: ++sequence, method, params },
    headers: MCP_HEADERS,
  });
}

type ToolResult = {
  isError?: boolean;
  content: { type: string; text: string }[];
  structuredContent?: Record<string, unknown>;
};

async function call(token: string, name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  const response = await rpc(token, "tools/call", { name, arguments: args });
  expect(response.status).toBe(200);
  expect(response.body.error).toBeUndefined();
  return response.body.result as ToolResult;
}

/** The structured result of a successful tool call. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests read results loosely
async function data(token: string, name: string, args: Record<string, unknown> = {}): Promise<any> {
  const result = await call(token, name, args);
  expect(result.isError, result.content[0]?.text).toBeFalsy();
  expect(JSON.parse(result.content[0]!.text)).toEqual(result.structuredContent);
  return result.structuredContent;
}

async function setup() {
  const editor = await createUser({ name: "Ed Editor" });
  const reader = await createUser({ name: "Rea Reader" });
  const space = await createSpace({ slug: "it", name: "IT", members: { [editor.id]: "editor" } });
  const laptop = await createPage(space, {
    title: "Laptop",
    body: "Install the VPN client.\n\n## Wifi\n\nConnect to the office wifi.\n",
  });
  return { editor, reader, space, laptop, token: await createToken(reader.id, "Claude") };
}

describe("MCP server", () => {
  beforeEach(resetDatabase);

  it("asks for sign-in with the resource metadata, and is stateless", async () => {
    const missing = await rpc(undefined, "initialize");
    expect(missing.status).toBe(401);
    expect(missing.headers.get("www-authenticate")).toBe(
      'Bearer resource_metadata="http://localhost:3000/.well-known/oauth-protected-resource/mcp"',
    );
    expect(missing.headers.get("access-control-allow-origin")).toBe("*");
    expect((await rpc("kn_pat_not-a-real-token", "initialize")).status).toBe(401);
    // Bearer tokens only: a signed-in browser's session does not count.
    const { reader } = await setup();
    const withSession = await request("POST", "/mcp", {
      userId: reader.id,
      body: { jsonrpc: "2.0", id: ++sequence, method: "tools/list", params: {} },
      headers: MCP_HEADERS,
    });
    expect(withSession.status).toBe(401);
    expect(withSession.headers.get("www-authenticate")).toBe(missing.headers.get("www-authenticate"));
    expect((await request("GET", "/mcp", { headers: MCP_HEADERS })).status).toBe(405);
  });

  it("initializes and lists the tools with annotations", async () => {
    const { token } = await setup();
    const init = await rpc(token, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    });
    expect(init.status).toBe(200);
    expect(init.body.result.serverInfo.name).toBe("handbook");
    expect(init.body.result.instructions).toContain("change set");
    const list = await rpc(token, "tools/list");
    const tools = list.body.result.tools as { name: string; annotations?: { readOnlyHint?: boolean } }[];
    const names = tools.map((tool) => tool.name).sort();
    expect(names).toEqual(
      [
        "comment_on_change_set",
        "create_page",
        "delete_page",
        "edit_page",
        "fetch",
        "get_change_set",
        "get_space_schema",
        "list_change_sets",
        "list_pages",
        "list_spaces",
        "move_page",
        "page_history",
        "read_page",
        "read_revision",
        "search",
        "start_change_set",
        "submit_change_set",
        "undo_page_change",
        "write_page",
      ].sort(),
    );
    const readOnly = tools
      .filter((tool) => tool.annotations?.readOnlyHint)
      .map((tool) => tool.name)
      .sort();
    expect(readOnly).toEqual(
      [
        "fetch",
        "get_change_set",
        "get_space_schema",
        "list_change_sets",
        "list_pages",
        "list_spaces",
        "page_history",
        "read_page",
        "read_revision",
        "search",
      ].sort(),
    );
  });

  it("proposes changes in a change set that a person merges", async () => {
    const { editor, laptop, token } = await setup();
    const started = await data(token, "start_change_set", { space: "it", title: "Better laptop page" });
    const number = started.changeSet as number;
    expect(started.url).toBe(`http://localhost:3000/changes/${number}`);

    const created = await data(token, "create_page", {
      change_set: number,
      page: "it/laptop/vpn",
      markdown: "---\ntitle: VPN\n---\n\nUse the VPN client.\n",
    });
    expect(created.page).toMatchObject({ page: "it/laptop/vpn", action: "create", title: "VPN" });
    const duplicate = await call(token, "create_page", {
      change_set: number,
      page: "it/laptop",
      markdown: "---\ntitle: X\n---\n",
    });
    expect(duplicate.isError).toBe(true);

    const read = await data(token, "read_page", { page: "it/laptop", change_set: number });
    expect(read).toMatchObject({ inChangeSet: false, revision: 1 });
    const edited = await data(token, "edit_page", {
      change_set: number,
      page: "it/laptop",
      edits: [{ old_text: "Connect to the office wifi.", new_text: "Connect to the office wifi (WPA3)." }],
    });
    expect(edited.page).toMatchObject({ action: "update", added: 1, removed: 1 });
    const proposed = await data(token, "read_page", { page: "it/laptop", change_set: number });
    expect(proposed.markdown).toContain("WPA3");
    const failing = await call(token, "edit_page", {
      change_set: number,
      page: "it/laptop",
      edits: [{ old_text: "not in the page", new_text: "x" }],
    });
    expect(failing.isError).toBe(true);
    expect(failing.content[0]!.text).toContain("not found");

    const detail = await data(token, "get_change_set", { change_set: number, include_diffs: true });
    expect(detail.pages).toHaveLength(2);
    expect(detail.pages.find((page: { action: string }) => page.action === "update").diff).toContain(
      "+ Connect to the office wifi (WPA3).",
    );

    const submitted = await data(token, "submit_change_set", { change_set: number, note: "Ready" });
    expect(submitted.status).toBe("in_review");
    expect((await request("POST", `/api/v1/change-sets/${number}/merge`, { token })).status).toBe(403);

    // Live stays as it is until a person merges.
    expect((await getDb().select().from(pages).where(eq(pages.id, laptop.id)))[0]?.markdown).not.toContain(
      "WPA3",
    );
    expect((await request("POST", `/api/v1/change-sets/${number}/merge`, { userId: editor.id })).status).toBe(
      200,
    );
    const live = await data(token, "read_page", { page: "it/laptop" });
    expect(live.markdown).toContain("WPA3");
    expect(live.revision).toBe(2);
  });

  it("reads spaces, pages, search results and history", async () => {
    const { token, laptop } = await setup();
    const spaces = await data(token, "list_spaces");
    expect(spaces.spaces).toEqual([
      expect.objectContaining({ space: "it", name: "IT", url: "http://localhost:3000/s/it" }),
    ]);
    const list = await data(token, "list_pages", { space: "it" });
    expect(list.pages).toEqual([expect.objectContaining({ page: "it/laptop", title: "Laptop" })]);
    const schema = await data(token, "get_space_schema", { space: "it" });
    expect(schema.builtInProperties.map((property: { key: string }) => property.key)).toContain("title");
    const fetched = await data(token, "fetch", { id: "it/laptop" });
    expect(fetched).toMatchObject({
      id: "it/laptop",
      title: "Laptop",
      url: "http://localhost:3000/s/it/laptop",
    });
    expect(fetched.text).toContain("## Wifi");
    const byId = await data(token, "read_page", { page: laptop.id });
    expect(byId.page).toBe("it/laptop");
    const found = await data(token, "search", { query: "wifi" });
    expect(found.results[0]).toMatchObject({ id: "it/laptop", title: "Laptop" });
    const history = await data(token, "page_history", { page: "it/laptop" });
    expect(history.revisions[0]).toMatchObject({ number: 1, kind: "save" });
    expect(history.total).toBe(1);
    const revision = await data(token, "read_revision", { page: "it/laptop", revision: 1 });
    expect(revision.markdown).toContain("title: Laptop");
    const missing = await call(token, "fetch", { id: "it/nothing" });
    expect(missing.isError).toBe(true);
  });

  it("pages a long history", async () => {
    const { editor, laptop, token } = await setup();
    for (let base = 1; base <= 4; base++) {
      const saved = await request("PUT", `/api/v1/pages/${laptop.id}`, {
        userId: editor.id,
        body: { markdown: `---\ntitle: Laptop\n---\n\nVersion ${base + 1}.\n`, baseRevision: base },
      });
      expect(saved.status).toBe(200);
    }
    const newest = await data(token, "page_history", { page: "it/laptop", limit: 2 });
    expect(newest.total).toBe(5);
    expect(newest.revisions.map((revision: { number: number }) => revision.number)).toEqual([5, 4]);
    const older = await data(token, "page_history", { page: "it/laptop", limit: 2, offset: 3 });
    expect(older.revisions.map((revision: { number: number }) => revision.number)).toEqual([2, 1]);
  });

  it("lets service tokens read but not write", async () => {
    await setup();
    const { secret } = await issueCredential(getDb(), {
      kind: "service",
      name: "Support bot",
      userId: null,
      expiresAt: null,
    });
    expect((await data(secret, "fetch", { id: "it/laptop" })).title).toBe("Laptop");
    const refused = await call(secret, "start_change_set", { space: "it", title: "No" });
    expect(refused.isError).toBe(true);
    expect(refused.content[0]!.text).toContain("403");
  });
});
