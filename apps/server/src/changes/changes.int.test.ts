import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq, isNull, sql } from "drizzle-orm";
import { getDb } from "../db/client";
import { changeSets, pageRevisions, pages } from "../db/schema";
import { issueCredential } from "../auth/credentials";
import { createPage, createSpace, createToken, createUser, request, resetDatabase } from "../test/helpers";
import { lockPage, saveLivePage } from "../pages/core";

vi.mock("../auth/resolve", () => import("../test/resolve-mock"));

const file = (title: string, body = "") => `---\ntitle: ${title}\n---\n\n${body}`;

async function setup() {
  const owner = await createUser({ name: "Olga Owner" });
  const editor = await createUser({ name: "Ed Editor" });
  const reader = await createUser({ name: "Rea Reader" });
  const space = await createSpace({ slug: "it", members: { [owner.id]: "owner", [editor.id]: "editor" } });
  const laptop = await createPage(space, { title: "Laptop", body: "one\n\ntwo\n\nthree\n" });
  return { owner, editor, reader, space, laptop };
}

async function liveSave(pageId: string, markdown: string, baseRevision: number) {
  return getDb().transaction(async (tx) => {
    const page = await lockPage(tx, pageId);
    const [space] = await tx.query.spaces.findMany({
      where: (table, { eq: equals }) => equals(table.id, page.spaceId),
    });
    return saveLivePage(tx, {
      space: space!,
      page,
      markdown,
      baseRevision,
      author: { userId: null, via: "web", clientName: null },
    });
  });
}

describe("change sets", () => {
  beforeEach(resetDatabase);

  it("collects changes invisibly, and an editor merges them", async () => {
    const { editor, reader, laptop } = await setup();
    const created = await request("POST", "/api/v1/change-sets", {
      userId: reader.id,
      body: { space: "it", title: "Laptop fixes", description: "Two fixes" },
    });
    expect(created.status).toBe(201);
    const number = created.body.number as number;
    expect(created.body.permissions).toMatchObject({ edit: true, submit: true, merge: false });

    // Update the live page, add a sub-page, and move the page.
    const updated = await request("PUT", `/api/v1/change-sets/${number}/pages`, {
      userId: reader.id,
      body: { path: "laptop", markdown: laptop.markdown.replace("two", "TWO") },
    });
    expect(updated.status).toBe(200);
    expect(updated.body.items).toMatchObject([
      { action: "update", path: "laptop", baseRevision: 1, added: 1, removed: 1 },
    ]);
    const added = await request("PUT", `/api/v1/change-sets/${number}/pages`, {
      userId: reader.id,
      body: { path: "laptop/vpn", markdown: file("VPN", "See [laptop](../laptop).") },
    });
    const vpn = added.body.items.find((item: { path: string }) => item.path === "laptop/vpn");
    expect(vpn).toMatchObject({ action: "create", title: "VPN" });
    const edited = await request("POST", `/api/v1/change-sets/${number}/pages/${vpn.pageId}/edit`, {
      userId: reader.id,
      body: { edits: [{ oldText: "See", newText: "Read" }] },
    });
    expect(edited.status).toBe(200);
    const page = await request("GET", `/api/v1/change-sets/${number}/pages/by-path?path=laptop/vpn`, {
      userId: reader.id,
    });
    expect(page.body.proposed).toContain("Read [laptop]");

    // Readers do not see it live.
    const [live] = await getDb().select().from(pages).where(eq(pages.id, laptop.id));
    expect(live?.markdown).not.toContain("TWO");

    expect((await request("POST", `/api/v1/change-sets/${number}/merge`, { userId: reader.id })).status).toBe(
      403,
    );
    const submitted = await request("POST", `/api/v1/change-sets/${number}/submit`, {
      userId: reader.id,
      body: { note: "Please check" },
    });
    expect(submitted.body.status).toBe("in_review");
    const merged = await request("POST", `/api/v1/change-sets/${number}/merge`, { userId: editor.id });
    expect(merged.status).toBe(200);
    expect(merged.body).toMatchObject({ status: "merged", mergedBy: { id: editor.id } });
    expect(merged.body.events.map((event: { kind: string }) => event.kind)).toEqual([
      "created",
      "edited",
      "edited",
      "edited",
      "submitted",
      "merged",
    ]);

    const [after] = await getDb().select().from(pages).where(eq(pages.id, laptop.id));
    expect(after?.markdown).toContain("TWO");
    const revisions = await getDb().select().from(pageRevisions).where(eq(pageRevisions.pageId, laptop.id));
    expect(revisions.at(-1)).toMatchObject({ via: "merge", authorId: reader.id });
    const [child] = await getDb().select().from(pages).where(eq(pages.id, vpn.pageId));
    expect(child?.path).toBe("laptop/vpn");
  });

  it("merges changes saved meanwhile, blocks overlaps, and rebases", async () => {
    const { editor, laptop } = await setup();
    const number = (
      await request("POST", "/api/v1/change-sets", {
        userId: editor.id,
        body: { space: "it", title: "Edit" },
      })
    ).body.number;
    await request("PUT", `/api/v1/change-sets/${number}/pages`, {
      userId: editor.id,
      body: { pageId: laptop.id, markdown: laptop.markdown.replace("one", "ONE") },
    });
    // Live change elsewhere: merges cleanly.
    await liveSave(laptop.id, laptop.markdown.replace("three", "THREE"), 1);
    let detail = await request("GET", `/api/v1/change-sets/${number}`, { userId: editor.id });
    expect(detail.body.items[0]).toMatchObject({ conflict: false, baseRevision: 1, liveRevision: 2 });

    // Live change in the same place: conflict blocks the merge.
    const current = (await getDb().select().from(pages).where(eq(pages.id, laptop.id)))[0]!;
    await liveSave(laptop.id, current.markdown.replace("one", "uno"), 2);
    detail = await request("GET", `/api/v1/change-sets/${number}`, { userId: editor.id });
    expect(detail.body.items[0].conflict).toBe(true);
    expect(detail.body.checks[0]).toMatchObject({ level: "error" });
    const blocked = await request("POST", `/api/v1/change-sets/${number}/merge`, { userId: editor.id });
    expect(blocked.status).toBe(409);
    expect(blocked.body).toMatchObject({
      error: { code: "merge_conflicts" },
      conflicts: [{ pageId: laptop.id }],
    });

    const rebased = await request("POST", `/api/v1/change-sets/${number}/pages/${laptop.id}/rebase`, {
      userId: editor.id,
    });
    expect(
      rebased.body.checks.some((check: { message: string }) => check.message.includes("conflict blocks")),
    ).toBe(true);
    const view = await request("GET", `/api/v1/change-sets/${number}/pages/${laptop.id}`, {
      userId: editor.id,
    });
    expect(view.body.proposed).toContain("<<<<<<< yours\nONE\n=======\nuno\n>>>>>>> current");
    const resolved = view.body.proposed.replace("<<<<<<< yours\nONE\n=======\nuno\n>>>>>>> current", "Uno");
    await request("PUT", `/api/v1/change-sets/${number}/pages`, {
      userId: editor.id,
      body: { pageId: laptop.id, markdown: resolved },
    });
    const merged = await request("POST", `/api/v1/change-sets/${number}/merge`, { userId: editor.id });
    expect(merged.status).toBe(200);
    const [after] = await getDb().select().from(pages).where(eq(pages.id, laptop.id));
    expect(after?.markdown).toContain("Uno");
    expect(after?.markdown).toContain("THREE");
  });

  it("reverts created, changed, moved and deleted pages", async () => {
    const { editor, space, laptop } = await setup();
    const old = await createPage(space, { title: "Old" });
    const number = (
      await request("POST", "/api/v1/change-sets", {
        userId: editor.id,
        body: { space: "it", title: "Big change" },
      })
    ).body.number;
    await request("PUT", `/api/v1/change-sets/${number}/pages`, {
      userId: editor.id,
      body: { path: "new-page", markdown: file("New") },
    });
    await request("PUT", `/api/v1/change-sets/${number}/pages`, {
      userId: editor.id,
      body: { pageId: laptop.id, path: "notebook", markdown: laptop.markdown.replace("one", "1") },
    });
    await request("POST", `/api/v1/change-sets/${number}/pages/${old.id}/delete`, { userId: editor.id });
    expect((await request("POST", `/api/v1/change-sets/${number}/merge`, { userId: editor.id })).status).toBe(
      200,
    );
    const [moved] = await getDb().select().from(pages).where(eq(pages.id, laptop.id));
    expect(moved?.path).toBe("notebook");

    const reverted = await request("POST", `/api/v1/change-sets/${number}/revert`, { userId: editor.id });
    expect(reverted.body).toMatchObject({ merged: true });
    const [back] = await getDb().select().from(pages).where(eq(pages.id, laptop.id));
    expect(back).toMatchObject({ path: "laptop", markdown: laptop.markdown });
    const [restored] = await getDb().select().from(pages).where(eq(pages.id, old.id));
    expect(restored?.deletedAt).toBeNull();
    const created = await getDb().select().from(pages).where(eq(pages.path, "new-page"));
    expect(created[0]?.deletedAt).not.toBeNull();
    const original = await request("GET", `/api/v1/change-sets/${number}`, { userId: editor.id });
    expect(original.body).toMatchObject({ revertedBy: reverted.body.number, permissions: { revert: false } });
    expect(
      (await request("GET", `/api/v1/change-sets/${reverted.body.number}`, { userId: editor.id })).body
        .revertOf,
    ).toBe(number);
  });

  it("limits agents, readers and service tokens", async () => {
    const { editor, reader, laptop } = await setup();
    const agent = await createToken(editor.id, "Claude");
    // Agents cannot edit live, but propose and submit.
    const live = await request("PUT", `/api/v1/pages/${laptop.id}`, {
      token: agent,
      body: { markdown: laptop.markdown, baseRevision: 1 },
    });
    expect([403, 404]).toContain(live.status);
    const created = await request("POST", "/api/v1/change-sets", {
      token: agent,
      body: { space: "it", title: "Agent work" },
    });
    expect(created.status).toBe(201);
    expect(created.body.clientName).toBe("Claude");
    const number = created.body.number;
    await request("PUT", `/api/v1/change-sets/${number}/pages`, {
      token: agent,
      body: { path: "laptop", markdown: laptop.markdown.replace("two", "zwei") },
    });
    expect(
      (await request("POST", `/api/v1/change-sets/${number}/submit`, { token: agent, body: {} })).status,
    ).toBe(200);
    const denied = await request("POST", `/api/v1/change-sets/${number}/merge`, { token: agent });
    expect(denied.status).toBe(403);
    expect(denied.body.error.message).toContain("Agents");
    expect(
      (
        await request("POST", `/api/v1/change-sets/${number}/request-changes`, {
          token: agent,
          body: { body: "no" },
        })
      ).status,
    ).toBe(403);

    // A reader may comment, but not change someone else's change set.
    expect(
      (
        await request("POST", `/api/v1/change-sets/${number}/comments`, {
          userId: reader.id,
          body: { body: "Nice" },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await request("PUT", `/api/v1/change-sets/${number}/pages`, {
          userId: reader.id,
          body: { path: "x", markdown: file("X") },
        })
      ).status,
    ).toBe(403);
    expect((await request("POST", `/api/v1/change-sets/${number}/close`, { userId: reader.id })).status).toBe(
      403,
    );

    // The editor requests changes, the agent fixes, the editor merges.
    const requested = await request("POST", `/api/v1/change-sets/${number}/request-changes`, {
      userId: editor.id,
      body: { body: "Use English" },
    });
    expect(requested.body.status).toBe("open");
    await request("PUT", `/api/v1/change-sets/${number}/pages`, {
      token: agent,
      body: { path: "laptop", markdown: laptop.markdown.replace("two", "2") },
    });
    expect((await request("POST", `/api/v1/change-sets/${number}/merge`, { userId: editor.id })).status).toBe(
      200,
    );
    const [after] = await getDb().select().from(pages).where(eq(pages.id, laptop.id));
    expect(after?.markdown).toContain("\n2\n");
    const [revision] = await getDb()
      .select()
      .from(pageRevisions)
      .where(eq(pageRevisions.pageId, laptop.id))
      .orderBy(pageRevisions.number)
      .then((rows) => rows.slice(-1));
    expect(revision).toMatchObject({ via: "merge", clientName: "Claude", authorId: editor.id });

    // Service tokens cannot use change sets.
    const { secret } = await issueCredential(getDb(), {
      kind: "service",
      name: "Bot",
      userId: null,
      expiresAt: null,
    });
    expect((await request("GET", "/api/v1/change-sets", { token: secret })).status).toBe(403);
  });

  it("checks files, paths and links, closes and reopens", async () => {
    const { editor, laptop } = await setup();
    const number = (
      await request("POST", "/api/v1/change-sets", {
        userId: editor.id,
        body: { space: "it", title: "Checks" },
      })
    ).body.number;
    const invalid = await request("PUT", `/api/v1/change-sets/${number}/pages`, {
      userId: editor.id,
      body: { path: "bad", markdown: "---\ntitle: Bad\ncolor: red\n---\n" },
    });
    expect(invalid.status).toBe(422);
    expect(
      (
        await request("PUT", `/api/v1/change-sets/${number}/pages`, {
          userId: editor.id,
          body: { path: "laptop/x", markdown: file("X") },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await request("PUT", `/api/v1/change-sets/${number}/pages`, {
          userId: editor.id,
          body: { path: "orphan/child", markdown: file("Child", "[gone](nowhere)") },
        })
      ).status,
    ).toBe(200);
    const taken = await request("POST", `/api/v1/change-sets/${number}/pages/${laptop.id}/move`, {
      userId: editor.id,
      body: { path: "laptop/x" },
    });
    expect(taken.status).toBe(409);
    const detail = await request("GET", `/api/v1/change-sets/${number}`, { userId: editor.id });
    expect(detail.body.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ level: "error", message: expect.stringContaining("“orphan”") }),
        expect.objectContaining({ level: "warning", message: expect.stringContaining("nowhere") }),
      ]),
    );
    const blocked = await request("POST", `/api/v1/change-sets/${number}/merge`, { userId: editor.id });
    expect(blocked.status).toBe(422);
    // Deleting a page with a new sub-page in the change set: the sub-page counts.
    await request("POST", `/api/v1/change-sets/${number}/pages/${laptop.id}/delete`, { userId: editor.id });
    expect(
      (await request("GET", `/api/v1/change-sets/${number}`, { userId: editor.id })).body.checks.length,
    ).toBeGreaterThan(0);

    expect(
      (await request("POST", `/api/v1/change-sets/${number}/close`, { userId: editor.id })).body.status,
    ).toBe("closed");
    expect(
      (
        await request("PUT", `/api/v1/change-sets/${number}/pages`, {
          userId: editor.id,
          body: { path: "y", markdown: file("Y") },
        })
      ).status,
    ).toBe(403);
    expect(
      (await request("POST", `/api/v1/change-sets/${number}/reopen`, { userId: editor.id })).body.status,
    ).toBe("open");
    const list = await request("GET", "/api/v1/change-sets?space=it&mine=true", { userId: editor.id });
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0]).toMatchObject({ number, pages: 3 });
  });

  it("keeps drafts and change sets that change them away from readers", async () => {
    const { editor, reader, space } = await setup();
    const draft = await createPage(space, {
      title: "Plan",
      markdown: "---\ntitle: Plan\nstatus: draft\n---\n\nSecret.\n",
    });
    const mine = await request("POST", "/api/v1/change-sets", {
      userId: editor.id,
      body: { space: "it", title: "Plan" },
    });
    const number = mine.body.number as number;
    await request("PUT", `/api/v1/change-sets/${number}/pages`, {
      userId: editor.id,
      body: { pageId: draft.id, markdown: "---\ntitle: Plan\nstatus: draft\n---\n\nStill secret.\n" },
    });
    expect((await request("GET", `/api/v1/change-sets/${number}`, { userId: reader.id })).status).toBe(404);
    expect(
      (await request("GET", `/api/v1/change-sets/${number}/pages/${draft.id}`, { userId: reader.id })).status,
    ).toBe(404);
    expect(
      (await request("GET", "/api/v1/change-sets?status=all", { userId: reader.id })).body.items,
    ).toEqual([]);
    expect((await request("GET", `/api/v1/change-sets/${number}`, { userId: editor.id })).status).toBe(200);

    const own = await request("POST", "/api/v1/change-sets", {
      userId: reader.id,
      body: { space: "it", title: "Mine" },
    });
    const ownNumber = own.body.number as number;
    for (const body of [
      { path: "plan", markdown: "---\ntitle: Plan\n---\n\nMine.\n" },
      { pageId: draft.id, markdown: "---\ntitle: Plan\n---\n\nMine.\n" },
    ]) {
      const put = await request("PUT", `/api/v1/change-sets/${ownNumber}/pages`, { userId: reader.id, body });
      expect(put.status).toBe(404);
    }
  });

  it("merges a suggestion from the revision it was written from, keeping live changes and moves", async () => {
    const { editor, reader, space, laptop } = await setup();
    const v1 = laptop.markdown;
    // The reader opens revision 1; an editor saves revision 2 meanwhile.
    await liveSave(laptop.id, v1.replace("three", "THREE"), 1);
    const suggestion = await request("POST", "/api/v1/change-sets", {
      userId: reader.id,
      body: { space: "it", title: "One" },
    });
    const number = suggestion.body.number as number;
    const put = await request("PUT", `/api/v1/change-sets/${number}/pages`, {
      userId: reader.id,
      body: { pageId: laptop.id, markdown: v1.replace("one", "ONE"), baseRevision: 1 },
    });
    expect(put.status).toBe(200);
    // The page moves live after the suggestion was made.
    await createPage(space, { title: "Devices" });
    await getDb().transaction(async (tx) => {
      const { moveLivePage } = await import("../pages/core");
      const page = await lockPage(tx, laptop.id);
      await moveLivePage(tx, {
        space,
        page,
        newPath: "devices/laptop",
        author: { userId: null, via: "web", clientName: null },
      });
    });
    const view = await request("GET", `/api/v1/change-sets/${number}`, { userId: editor.id });
    expect(view.body.items[0]).toMatchObject({ path: "devices/laptop", fromPath: null, conflict: false });
    const merged = await request("POST", `/api/v1/change-sets/${number}/merge`, { userId: editor.id });
    expect(merged.status).toBe(200);
    const [page] = await getDb().select().from(pages).where(eq(pages.id, laptop.id));
    expect(page?.path).toBe("devices/laptop");
    expect(page?.markdown).toContain("ONE");
    expect(page?.markdown).toContain("THREE");
  });

  it("creates pages below a page the same change set moves", async () => {
    const { editor, space } = await setup();
    const guide = await createPage(space, { title: "Guide" });
    const created = await request("POST", "/api/v1/change-sets", {
      userId: editor.id,
      body: { space: "it", title: "Restructure" },
    });
    const number = created.body.number as number;
    await request("POST", `/api/v1/change-sets/${number}/pages/${guide.id}/move`, {
      userId: editor.id,
      body: { path: "handbook" },
    });
    const child = await request("PUT", `/api/v1/change-sets/${number}/pages`, {
      userId: editor.id,
      body: { path: "handbook/start", markdown: "---\ntitle: Start\n---\n" },
    });
    expect(child.status).toBe(200);
    expect(child.body.checks.filter((check: { level: string }) => check.level === "error")).toEqual([]);
    const merged = await request("POST", `/api/v1/change-sets/${number}/merge`, { userId: editor.id });
    expect(merged.status).toBe(200);
    const paths = (await getDb().select({ path: pages.path }).from(pages)).map((row) => row.path).sort();
    expect(paths).toEqual(["handbook", "handbook/start", "laptop"]);
  });

  it("keeps change sets of deleted drafts away from readers", async () => {
    const { editor, reader, space } = await setup();
    const draft = await createPage(space, {
      title: "Plan",
      markdown: "---\ntitle: Plan\nstatus: draft\n---\n\nSecret.\n",
    });
    const created = await request("POST", "/api/v1/change-sets", {
      userId: editor.id,
      body: { space: "it", title: "Plan" },
    });
    const number = created.body.number as number;
    await request("POST", `/api/v1/change-sets/${number}/pages/${draft.id}/edit`, {
      userId: editor.id,
      body: { edits: [{ oldText: "Secret.", newText: "Very secret." }] },
    });
    await request("DELETE", `/api/v1/pages/${draft.id}`, { userId: editor.id });
    expect((await request("GET", `/api/v1/change-sets/${number}`, { userId: reader.id })).status).toBe(404);
    expect(
      (await request("GET", `/api/v1/change-sets/${number}/pages/${draft.id}`, { userId: reader.id })).status,
    ).toBe(404);
    expect(
      (await request("GET", "/api/v1/change-sets?status=all", { userId: reader.id })).body.items,
    ).toEqual([]);
  });

  it("merges a replacement page at the path a moved page leaves", async () => {
    const { editor, space, laptop } = await setup();
    await createPage(space, { title: "Archive" });
    const created = await request("POST", "/api/v1/change-sets", {
      userId: editor.id,
      body: { space: "it", title: "Replace" },
    });
    const number = created.body.number as number;
    await request("POST", `/api/v1/change-sets/${number}/pages/${laptop.id}/move`, {
      userId: editor.id,
      body: { path: "archive/laptop" },
    });
    const replacement = await request("PUT", `/api/v1/change-sets/${number}/pages`, {
      userId: editor.id,
      body: { path: "laptop", markdown: "---\ntitle: Laptop\n---\n\nThe new way.\n" },
    });
    expect(replacement.status).toBe(200);
    const merged = await request("POST", `/api/v1/change-sets/${number}/merge`, { userId: editor.id });
    expect(merged.status).toBe(200);
    const rows = await getDb().select({ id: pages.id, path: pages.path }).from(pages);
    expect(rows.find((row) => row.id === laptop.id)?.path).toBe("archive/laptop");
    expect(rows.map((row) => row.path).sort()).toEqual(["archive", "archive/laptop", "laptop"]);
  });

  it("finds an item by the path its page was moved to live", async () => {
    const { editor, space, laptop } = await setup();
    const created = await request("POST", "/api/v1/change-sets", {
      userId: editor.id,
      body: { space: "it", title: "Edit" },
    });
    const number = created.body.number as number;
    await request("PUT", `/api/v1/change-sets/${number}/pages`, {
      userId: editor.id,
      body: { pageId: laptop.id, markdown: laptop.markdown.replace("one", "ONE") },
    });
    await getDb().transaction(async (tx) => {
      const { moveLivePage } = await import("../pages/core");
      const page = await lockPage(tx, laptop.id);
      await moveLivePage(tx, {
        space,
        page,
        newPath: "notebook",
        author: { userId: null, via: "web", clientName: null },
      });
    });
    // Someone creates a new page at the old path.
    await createPage(space, { title: "Laptop", slug: "laptop" });
    const read = await request("GET", `/api/v1/change-sets/${number}/pages/by-path?path=notebook`, {
      userId: editor.id,
    });
    expect(read.status).toBe(200);
    expect(read.body.item.pageId).toBe(laptop.id);
    const write = await request("PUT", `/api/v1/change-sets/${number}/pages`, {
      userId: editor.id,
      body: { path: "notebook", markdown: laptop.markdown.replace("one", "ONE!") },
    });
    expect(write.status).toBe(200);
    expect(write.body.items).toHaveLength(1);
    const again = await request("PUT", `/api/v1/change-sets/${number}/pages`, {
      userId: editor.id,
      body: { pageId: laptop.id, markdown: laptop.markdown.replace("one", "ONE!!") },
    });
    expect(again.status).toBe(200);
    expect(again.body.items[0]).toMatchObject({ path: "notebook", fromPath: null });
  });

  it("creates a sub-page under the page that keeps its parent's path", async () => {
    const { editor, space, laptop } = await setup();
    await createPage(space, { title: "Archive" });
    const old = await createPage(space, { title: "Old laptop", parentPath: "archive", slug: "laptop" });
    const created = await request("POST", "/api/v1/change-sets", {
      userId: editor.id,
      body: { space: "it", title: "Restructure" },
    });
    const number = created.body.number as number;
    const call = (method: string, path: string, body?: unknown) =>
      request(method, `/api/v1/change-sets/${number}${path}`, { userId: editor.id, body });
    await call("POST", `/pages/${old.id}/delete`);
    await call("POST", `/pages/${laptop.id}/move`, { path: "archive/laptop" });
    await call("PUT", "/pages", { path: "laptop", markdown: "---\ntitle: Laptop\n---\n\nThe new way.\n" });
    const start = await call("PUT", "/pages", { path: "laptop/start", markdown: "---\ntitle: Start\n---\n" });
    expect(start.status).toBe(200);
    const merged = await call("POST", "/merge");
    expect(merged.status).toBe(200);
    const rows = await getDb().select().from(pages).where(isNull(pages.deletedAt));
    const byPath = new Map(rows.map((row) => [row.path, row]));
    expect(byPath.get("archive/laptop")?.id).toBe(laptop.id);
    expect(byPath.get("laptop")?.id).not.toBe(laptop.id);
    expect(byPath.get("laptop/start")?.parentId).toBe(byPath.get("laptop")?.id);
    expect(byPath.has("archive/laptop/start")).toBe(false);
  });

  it("merges a deletion of a page that was put in the trash meanwhile", async () => {
    const { editor, reader, space, laptop } = await setup();
    const old = await createPage(space, { title: "Old" });
    const number = (
      await request("POST", "/api/v1/change-sets", {
        userId: reader.id,
        body: { space: "it", title: "Tidy" },
      })
    ).body.number as number;
    await request("POST", `/api/v1/change-sets/${number}/pages/${old.id}/delete`, { userId: reader.id });
    await request("PUT", `/api/v1/change-sets/${number}/pages`, {
      userId: reader.id,
      body: { pageId: laptop.id, markdown: laptop.markdown.replace("one", "ONE") },
    });
    expect((await request("DELETE", `/api/v1/pages/${old.id}`, { userId: editor.id })).status).toBe(204);
    const detail = await request("GET", `/api/v1/change-sets/${number}`, { userId: editor.id });
    expect(detail.body.checks.filter((check: { level: string }) => check.level === "error")).toEqual([]);

    const merged = await request("POST", `/api/v1/change-sets/${number}/merge`, { userId: editor.id });
    expect(merged.status).toBe(200);
    expect(merged.body.status).toBe("merged");
    const [trashed] = await getDb().select().from(pages).where(eq(pages.id, old.id));
    expect(trashed).toMatchObject({ revision: 2 });
    expect(trashed?.deletedAt).not.toBeNull();
    const [after] = await getDb().select().from(pages).where(eq(pages.id, laptop.id));
    expect(after?.markdown).toContain("ONE");
  });

  it("merges a revert that restores a page someone restored live meanwhile", async () => {
    const { editor, space, laptop } = await setup();
    const old = await createPage(space, { title: "Old", body: "first\n\nsecond\n" });
    const number = (
      await request("POST", "/api/v1/change-sets", {
        userId: editor.id,
        body: { space: "it", title: "Tidy" },
      })
    ).body.number as number;
    await request("POST", `/api/v1/change-sets/${number}/pages/${old.id}/delete`, { userId: editor.id });
    await request("PUT", `/api/v1/change-sets/${number}/pages`, {
      userId: editor.id,
      body: { pageId: laptop.id, markdown: laptop.markdown.replace("one", "ONE") },
    });
    expect((await request("POST", `/api/v1/change-sets/${number}/merge`, { userId: editor.id })).status).toBe(
      200,
    );
    // An overlapping live change keeps the revert open.
    const changed = (await getDb().select().from(pages).where(eq(pages.id, laptop.id)))[0]!;
    await liveSave(laptop.id, changed.markdown.replace("ONE", "uno"), changed.revision);
    const revert = await request("POST", `/api/v1/change-sets/${number}/revert`, { userId: editor.id });
    expect(revert.body).toMatchObject({ merged: false });
    const revertNumber = revert.body.number as number;

    // Meanwhile an editor restores the page and changes it live.
    expect((await request("POST", `/api/v1/pages/${old.id}/restore`, { userId: editor.id })).status).toBe(
      200,
    );
    const restored = (await getDb().select().from(pages).where(eq(pages.id, old.id)))[0]!;
    await liveSave(old.id, restored.markdown.replace("second", "SECOND"), restored.revision);

    await request("DELETE", `/api/v1/change-sets/${revertNumber}/pages/${laptop.id}`, { userId: editor.id });
    const merged = await request("POST", `/api/v1/change-sets/${revertNumber}/merge`, { userId: editor.id });
    expect(merged.status).toBe(200);
    const [page] = await getDb().select().from(pages).where(eq(pages.id, old.id));
    expect(page?.deletedAt).toBeNull();
    expect(page?.markdown).toContain("SECOND");
  });

  it("reverts a revert that restored a deleted page", async () => {
    const { editor, space } = await setup();
    const old = await createPage(space, { title: "Old" });
    const number = (
      await request("POST", "/api/v1/change-sets", {
        userId: editor.id,
        body: { space: "it", title: "Tidy" },
      })
    ).body.number as number;
    await request("POST", `/api/v1/change-sets/${number}/pages/${old.id}/delete`, { userId: editor.id });
    await request("POST", `/api/v1/change-sets/${number}/merge`, { userId: editor.id });
    const first = await request("POST", `/api/v1/change-sets/${number}/revert`, { userId: editor.id });
    expect(first.body).toMatchObject({ merged: true });
    expect((await getDb().select().from(pages).where(eq(pages.id, old.id)))[0]?.deletedAt).toBeNull();

    const second = await request("POST", `/api/v1/change-sets/${first.body.number}/revert`, {
      userId: editor.id,
    });
    expect(second.body).toMatchObject({ merged: true });
    expect((await getDb().select().from(pages).where(eq(pages.id, old.id)))[0]?.deletedAt).not.toBeNull();
  });

  it("keeps a page that was edited after a change set restored it when that change set is reverted", async () => {
    const { editor, space } = await setup();
    const old = await createPage(space, { title: "Old" });
    const number = (
      await request("POST", "/api/v1/change-sets", {
        userId: editor.id,
        body: { space: "it", title: "Tidy" },
      })
    ).body.number as number;
    await request("POST", `/api/v1/change-sets/${number}/pages/${old.id}/delete`, { userId: editor.id });
    await request("POST", `/api/v1/change-sets/${number}/merge`, { userId: editor.id });
    const restore = await request("POST", `/api/v1/change-sets/${number}/revert`, { userId: editor.id });
    expect(restore.body).toMatchObject({ merged: true });
    const restored = (await getDb().select().from(pages).where(eq(pages.id, old.id)))[0]!;
    await liveSave(old.id, `${restored.markdown}\nAdded after the restore.\n`, restored.revision);

    const undo = await request("POST", `/api/v1/change-sets/${restore.body.number}/revert`, {
      userId: editor.id,
    });
    expect(undo.body).toMatchObject({ merged: false });
    const live = (await getDb().select().from(pages).where(eq(pages.id, old.id)))[0]!;
    expect(live.deletedAt).toBeNull();
    expect(live.markdown).toContain("Added after the restore.");
  });

  it("leaves no revert behind when merging it fails, and keeps one open revert", async () => {
    const { editor, laptop } = await setup();
    const number = (
      await request("POST", "/api/v1/change-sets", {
        userId: editor.id,
        body: { space: "it", title: "Edit" },
      })
    ).body.number as number;
    await request("PUT", `/api/v1/change-sets/${number}/pages`, {
      userId: editor.id,
      body: { pageId: laptop.id, markdown: laptop.markdown.replace("one", "ONE") },
    });
    await request("POST", `/api/v1/change-sets/${number}/merge`, { userId: editor.id });
    const reverts = async () =>
      (await getDb().select().from(changeSets)).filter((row) => row.revertOfId !== null).length;

    // A failure inside the merge (here: the database refuses page updates) undoes the whole revert.
    await getDb().execute(
      sql`create function test_refuse() returns trigger language plpgsql as $$ begin raise exception 'refused'; end $$`,
    );
    await getDb().execute(
      sql`create trigger test_refuse before update on pages for each row execute function test_refuse()`,
    );
    try {
      const failed = await request("POST", `/api/v1/change-sets/${number}/revert`, { userId: editor.id });
      expect(failed.status).toBe(500);
    } finally {
      await getDb().execute(sql`drop trigger test_refuse on pages`);
      await getDb().execute(sql`drop function test_refuse`);
    }
    expect(await reverts()).toBe(0);

    // A revert with conflicts stays open; reverting again answers with it.
    const changed = (await getDb().select().from(pages).where(eq(pages.id, laptop.id)))[0]!;
    await liveSave(laptop.id, changed.markdown.replace("ONE", "uno"), changed.revision);
    const open = await request("POST", `/api/v1/change-sets/${number}/revert`, { userId: editor.id });
    expect(open.body).toMatchObject({ merged: false });
    const again = await request("POST", `/api/v1/change-sets/${number}/revert`, { userId: editor.id });
    expect(again.body).toEqual({ number: open.body.number, merged: false });
    expect(await reverts()).toBe(1);
  });

  it("refuses every change in archived spaces", async () => {
    const { editor, reader, laptop } = await setup();
    const admin = await createUser({ isAdmin: true });
    const create = async (userId: string, title: string) =>
      (await request("POST", "/api/v1/change-sets", { userId, body: { space: "it", title } })).body
        .number as number;
    const open = await create(reader.id, "Open");
    await request("PUT", `/api/v1/change-sets/${open}/pages`, {
      userId: reader.id,
      body: { pageId: laptop.id, markdown: laptop.markdown.replace("one", "ONE") },
    });
    const merged = await create(editor.id, "Merged");
    await request("PUT", `/api/v1/change-sets/${merged}/pages`, {
      userId: editor.id,
      body: { path: "vpn", markdown: file("VPN") },
    });
    await request("POST", `/api/v1/change-sets/${merged}/merge`, { userId: editor.id });
    const closed = await create(reader.id, "Closed");
    await request("POST", `/api/v1/change-sets/${closed}/close`, { userId: reader.id });
    expect((await request("POST", "/api/v1/spaces/it/archive", { userId: admin.id })).status).toBe(200);

    const attempts: [string, string, string, unknown?][] = [
      ["POST", "/change-sets", reader.id, { space: "it", title: "New" }],
      ["PATCH", `/change-sets/${open}`, reader.id, { title: "Renamed" }],
      ["PUT", `/change-sets/${open}/pages`, reader.id, { path: "x", markdown: file("X") }],
      ["POST", `/change-sets/${open}/pages/${laptop.id}/delete`, reader.id],
      ["DELETE", `/change-sets/${open}/pages/${laptop.id}`, reader.id],
      ["POST", `/change-sets/${open}/comments`, reader.id, { body: "Hello" }],
      ["POST", `/change-sets/${merged}/comments`, reader.id, { body: "Hello" }],
      ["POST", `/change-sets/${closed}/comments`, reader.id, { body: "Hello" }],
      ["POST", `/change-sets/${open}/submit`, reader.id, {}],
      ["POST", `/change-sets/${open}/close`, reader.id],
      ["POST", `/change-sets/${open}/close`, editor.id],
      ["POST", `/change-sets/${open}/merge`, editor.id],
      ["POST", `/change-sets/${open}/request-changes`, editor.id, { body: "No" }],
      ["POST", `/change-sets/${closed}/reopen`, reader.id],
      ["POST", `/change-sets/${merged}/revert`, editor.id],
      ["PUT", `/pages/${laptop.id}`, editor.id, { markdown: laptop.markdown, baseRevision: 1 }],
      ["POST", "/spaces/it/pages", editor.id, { markdown: file("New") }],
      ["POST", `/pages/${laptop.id}/move`, editor.id, { parentPath: null, slug: "notebook" }],
      ["DELETE", `/pages/${laptop.id}`, editor.id],
      ["POST", `/pages/${laptop.id}/lock`, editor.id],
      ["PUT", `/pages/${laptop.id}/draft`, editor.id, { markdown: laptop.markdown, baseRevision: 1 }],
    ];
    for (const [method, path, userId, body] of attempts) {
      const response = await request(method, `/api/v1${path}`, { userId, body });
      expect({ method, path, status: response.status, message: response.body.error?.message }).toEqual({
        method,
        path,
        status: 403,
        message: "This space is archived; it can only be read",
      });
    }
    const detail = await request("GET", `/api/v1/change-sets/${open}`, { userId: reader.id });
    expect(detail.status).toBe(200);
    expect(Object.values(detail.body.permissions).some(Boolean)).toBe(false);
    const [page] = await getDb().select().from(pages).where(eq(pages.id, laptop.id));
    expect(page).toMatchObject({ revision: 1, path: "laptop", deletedAt: null });
  });
});
