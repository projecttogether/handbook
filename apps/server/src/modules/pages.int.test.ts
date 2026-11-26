import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { newPageFile } from "@handbook/shared/page";
import { getDb } from "../db/client";
import { changeSetItems, changeSets, editLocks, pageRevisions } from "../db/schema";
import { issueCredential } from "../auth/credentials";
import { createPage, createSpace, createToken, createUser, request, resetDatabase } from "../test/helpers";

vi.mock("../auth/resolve", () => import("../test/resolve-mock"));

const file = (title: string, body = "", extra = "") => `---\ntitle: ${title}\n${extra}---\n\n${body}`;

async function setup() {
  const owner = await createUser({ name: "Olga Owner" });
  const editor = await createUser({ name: "Eddie Editor" });
  const reader = await createUser({ name: "Rita Reader" });
  const admin = await createUser({ name: "Ada Admin", isAdmin: true });
  const space = await createSpace({
    slug: "it",
    name: "IT",
    members: { [owner.id]: "owner", [editor.id]: "editor" },
  });
  const page = await createPage(space, { title: "Laptop", body: "one\n\ntwo\n\nthree\n" });
  return { owner, editor, reader, admin, space, page };
}

describe("pages API", () => {
  beforeEach(resetDatabase);

  it("lets everyone read and only editors write live (access matrix)", async () => {
    const { owner, editor, reader, admin, space, page } = await setup();
    const agent = await createToken(editor.id, "Claude Code");
    const { secret: service } = await issueCredential(getDb(), {
      kind: "service",
      name: "Support bot",
      userId: null,
      expiresAt: null,
    });
    for (const who of [{ userId: reader.id }, { token: agent }, { token: service }, { userId: owner.id }]) {
      const read = await request("GET", `/api/v1/pages/${page.id}`, who);
      expect(read.status).toBe(200);
      expect(read.body.title).toBe("Laptop");
    }
    const save = (who: { userId?: string; token?: string }, text: string) =>
      request("PUT", `/api/v1/pages/${page.id}`, {
        ...who,
        body: { markdown: file("Laptop", text), baseRevision: 1 },
      });
    expect((await save({ userId: reader.id }, "x")).status).toBe(403);
    const byAgent = await save({ token: agent }, "x");
    expect(byAgent.status).toBe(403);
    expect(byAgent.body.error.message).toContain("change set");
    expect((await save({ token: service }, "x")).status).toBe(403);
    expect((await save({ userId: editor.id }, "by editor")).status).toBe(200);
    const created = await request("POST", `/api/v1/spaces/${space.slug}/pages`, {
      userId: admin.id,
      body: { parentPath: "laptop", markdown: file("Setup") },
    });
    expect(created.status).toBe(201);
    expect(created.body.path).toBe("laptop/setup");
    expect(created.body.breadcrumbs.map((crumb: { title: string }) => crumb.title)).toEqual(["Laptop"]);
    const reread = await request("GET", `/api/v1/pages/${page.id}`, { userId: reader.id });
    expect(reread.body.children.map((child: { path: string }) => child.path)).toEqual(["laptop/setup"]);
    expect(reread.body.updatedBy.name).toBe("Eddie Editor");
    expect(reread.body.abilities.editLive).toBe(false);
  });

  it("hides drafts from readers", async () => {
    const { editor, reader, space } = await setup();
    const draft = await createPage(space, {
      title: "Secret plan",
      markdown: file("Secret plan", "", "status: draft\n"),
    });
    expect((await request("GET", `/api/v1/pages/${draft.id}`, { userId: reader.id })).status).toBe(404);
    expect((await request("GET", `/api/v1/pages/${draft.id}`, { userId: editor.id })).status).toBe(200);
    const tree = await request("GET", `/api/v1/spaces/${space.slug}/tree`, { userId: reader.id });
    expect(tree.body.items.map((item: { title: string }) => item.title)).toEqual(["Laptop"]);
    const editorTree = await request("GET", `/api/v1/spaces/${space.slug}/tree`, { userId: editor.id });
    expect(editorTree.body.items).toHaveLength(2);
  });

  it("hides an active page below a draft from readers, with its ancestors", async () => {
    const { editor, reader, space } = await setup();
    const parent = await createPage(space, {
      title: "Draft parent",
      markdown: file("Draft parent", "", "status: draft\n"),
    });
    const child = await request("POST", "/api/v1/spaces/it/pages", {
      userId: editor.id,
      body: { parentPath: parent.path, markdown: file("Active child") },
    });
    expect(child.status).toBe(201);
    expect(child.body.breadcrumbs).toMatchObject([{ id: parent.id }]);
    const view = await request("GET", `/api/v1/pages/${child.body.id}`, { userId: reader.id });
    expect(view.status).toBe(404);
  });

  it("merges or answers 409 page_changed with the current file and conflict blocks", async () => {
    const { editor, owner, page } = await setup();
    const base = page.markdown;
    const first = await request("PUT", `/api/v1/pages/${page.id}`, {
      userId: editor.id,
      body: { markdown: base.replace("one", "ONE"), baseRevision: 1 },
    });
    expect(first.body.revision).toBe(2);
    const merged = await request("PUT", `/api/v1/pages/${page.id}`, {
      userId: owner.id,
      body: { markdown: base.replace("three", "THREE"), baseRevision: 1 },
    });
    expect(merged.status).toBe(200);
    expect(merged.body.markdown).toContain("ONE");
    expect(merged.body.markdown).toContain("THREE");
    const conflict = await request("PUT", `/api/v1/pages/${page.id}`, {
      userId: owner.id,
      body: { markdown: base.replace("one", "uno"), baseRevision: 1 },
    });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe("page_changed");
    expect(conflict.body.current.revision).toBe(3);
    expect(conflict.body.current.updatedBy.name).toBe("Olga Owner");
    expect(conflict.body.merged).toContain("<<<<<<< yours\nuno\n=======\nONE\n>>>>>>> current");
    expect(conflict.body.conflicts).toBe(1);
    const invalid = await request("PUT", `/api/v1/pages/${page.id}`, {
      userId: owner.id,
      body: { markdown: "---\ncolor: red\n---\n", baseRevision: 3 },
    });
    expect(invalid.status).toBe(422);
    expect(invalid.body.error.fields["properties.color"]).toContain("Unknown property");
  });

  it("locks the editor: 423, takeover, lock_lost, release on save", async () => {
    const { editor, owner, reader, page } = await setup();
    const mine = await request("POST", `/api/v1/pages/${page.id}/lock`, { userId: editor.id });
    expect(mine.status).toBe(200);
    expect(mine.body).toMatchObject({ renewSeconds: 30, expireSeconds: 120, idleSeconds: 1800 });
    expect((await request("POST", `/api/v1/pages/${page.id}/lock`, { userId: reader.id })).status).toBe(403);

    const blocked = await request("POST", `/api/v1/pages/${page.id}/lock`, { userId: owner.id });
    expect(blocked.status).toBe(423);
    expect(blocked.body.error.code).toBe("page_locked");
    expect(blocked.body.lock.user.name).toBe("Eddie Editor");
    expect(blocked.body.lock.mine).toBe(false);
    const view = await request("GET", `/api/v1/pages/${page.id}`, { userId: owner.id });
    expect(view.body.lock.user.name).toBe("Eddie Editor");

    // A save without the lock token is refused while the lock holds.
    const refused = await request("PUT", `/api/v1/pages/${page.id}`, {
      userId: owner.id,
      body: { markdown: file("Laptop", "owner"), baseRevision: 1 },
    });
    expect(refused.status).toBe(423);

    const renewed = await request("POST", `/api/v1/pages/${page.id}/lock/renew`, {
      userId: editor.id,
      body: { token: mine.body.token, active: true },
    });
    expect(renewed.status).toBe(200);

    const taken = await request("POST", `/api/v1/pages/${page.id}/lock/takeover`, { userId: owner.id });
    expect(taken.status).toBe(200);
    const lost = await request("POST", `/api/v1/pages/${page.id}/lock/renew`, {
      userId: editor.id,
      body: { token: mine.body.token, active: true },
    });
    expect(lost.status).toBe(409);
    expect(lost.body.error.code).toBe("lock_lost");
    expect(lost.body.takenOverBy.name).toBe("Olga Owner");

    const saved = await request("PUT", `/api/v1/pages/${page.id}`, {
      userId: owner.id,
      body: { markdown: file("Laptop", "owner"), baseRevision: 1, lockToken: taken.body.token },
    });
    expect(saved.status).toBe(200);
    expect(saved.body.lock).toBeNull();
    expect(await getDb().select().from(editLocks)).toHaveLength(0);
  });

  it("ends locks after inactivity and takes them again when the person types", async () => {
    const { editor, owner, page } = await setup();
    const lock = await request("POST", `/api/v1/pages/${page.id}/lock`, { userId: editor.id });
    await getDb()
      .update(editLocks)
      .set({ renewedAt: sql`now() - interval '5 minutes'` });
    expect((await request("POST", `/api/v1/pages/${page.id}/lock`, { userId: owner.id })).status).toBe(200);
    await getDb()
      .update(editLocks)
      .set({ activityAt: sql`now() - interval '31 minutes'` });
    const idle = await request("POST", `/api/v1/pages/${page.id}/lock/renew`, {
      userId: editor.id,
      body: { token: lock.body.token, active: false },
    });
    expect(idle.status).toBe(409);
    expect(idle.body.takenOverBy).toBeNull();
    const again = await request("POST", `/api/v1/pages/${page.id}/lock/renew`, {
      userId: editor.id,
      body: { token: lock.body.token, active: true },
    });
    expect(again.status).toBe(200);
    await request("DELETE", `/api/v1/pages/${page.id}/lock?token=${lock.body.token}`, { userId: editor.id });
    expect(await getDb().select().from(editLocks)).toHaveLength(0);
  });

  it("keeps drafts per person and removes them after saving", async () => {
    const { editor, page } = await setup();
    expect((await request("GET", `/api/v1/pages/${page.id}/draft`, { userId: editor.id })).status).toBe(404);
    const put = await request("PUT", `/api/v1/pages/${page.id}/draft`, {
      userId: editor.id,
      body: { markdown: file("Laptop", "half done"), baseRevision: 1 },
    });
    expect(put.status).toBe(200);
    const view = await request("GET", `/api/v1/pages/${page.id}`, { userId: editor.id });
    expect(view.body.draft.baseRevision).toBe(1);
    const draft = await request("GET", `/api/v1/pages/${page.id}/draft`, { userId: editor.id });
    expect(draft.body.markdown).toContain("half done");
    await request("PUT", `/api/v1/pages/${page.id}`, {
      userId: editor.id,
      body: { markdown: file("Laptop", "done"), baseRevision: 1 },
    });
    expect((await request("GET", `/api/v1/pages/${page.id}/draft`, { userId: editor.id })).status).toBe(404);
    const agent = await createToken(editor.id);
    expect((await request("GET", `/api/v1/pages/${page.id}/draft`, { token: agent })).status).toBe(403);
  });

  it("moves pages, follows old paths, trashes and restores", async () => {
    const { editor, reader, space, page } = await setup();
    await createPage(space, { title: "Hardware" });
    const child = await createPage(space, { title: "Setup", parentPath: "laptop" });
    const moved = await request("POST", `/api/v1/pages/${page.id}/move`, {
      userId: editor.id,
      body: { parentPath: "hardware", slug: "notebook" },
    });
    expect(moved.status).toBe(200);
    expect(moved.body.path).toBe("hardware/notebook");
    const old = await request("GET", `/api/v1/spaces/it/pages/by-path?path=laptop/setup`, {
      userId: reader.id,
    });
    expect(old.body.id).toBe(child.id);
    expect(old.body.path).toBe("hardware/notebook/setup");

    expect((await request("DELETE", `/api/v1/pages/${page.id}`, { userId: editor.id })).status).toBe(409);
    expect((await request("DELETE", `/api/v1/pages/${child.id}`, { userId: editor.id })).status).toBe(204);
    expect((await request("GET", `/api/v1/pages/${child.id}`, { userId: reader.id })).status).toBe(404);
    const trash = await request("GET", `/api/v1/spaces/it/trash`, { userId: editor.id });
    expect(trash.body.items.map((item: { title: string }) => item.title)).toEqual(["Setup"]);
    expect(trash.body.items[0].deletedBy.name).toBe("Eddie Editor");
    expect(Date.parse(trash.body.items[0].deletedAt)).toBeGreaterThan(Date.now() - 60_000);
    expect((await request("GET", `/api/v1/spaces/it/trash`, { userId: reader.id })).status).toBe(403);
    const restored = await request("POST", `/api/v1/pages/${child.id}/restore`, { userId: editor.id });
    expect(restored.status).toBe(200);
    expect(restored.body.path).toBe("hardware/notebook/setup");
  });

  it("lists revisions, shows one with the previous file, and restores it", async () => {
    const { editor, reader, page } = await setup();
    await request("PUT", `/api/v1/pages/${page.id}`, {
      userId: editor.id,
      body: { markdown: file("Laptop", "changed"), baseRevision: 1, message: "Shorter" },
    });
    const list = await request("GET", `/api/v1/pages/${page.id}/revisions`, { userId: reader.id });
    expect(list.body.items.map((item: { number: number; via: string }) => [item.number, item.via])).toEqual([
      [2, "web"],
      [1, "api"],
    ]);
    expect(list.body.total).toBe(2);
    expect(list.body.items[0]).toMatchObject({
      message: "Shorter",
      author: { name: "Eddie Editor" },
      added: 1,
    });
    const second = await request("GET", `/api/v1/pages/${page.id}/revisions/2`, { userId: reader.id });
    expect(second.body.previousMarkdown).toContain("three");
    expect((await request("GET", `/api/v1/pages/${page.id}/revisions/9`, { userId: reader.id })).status).toBe(
      404,
    );
    const restored = await request("POST", `/api/v1/pages/${page.id}/revisions/1/restore`, {
      userId: editor.id,
      body: { baseRevision: 2 },
    });
    expect(restored.status).toBe(200);
    expect(restored.body.revision).toBe(3);
    expect(restored.body.body).toContain("three");
  });

  it("pages the revision list, newest first, without the files", async () => {
    const { editor, reader, page } = await setup();
    for (let base = 1; base <= 4; base++) {
      const saved = await request("PUT", `/api/v1/pages/${page.id}`, {
        userId: editor.id,
        body: { markdown: file("Laptop", `version ${base + 1}`), baseRevision: base },
      });
      expect(saved.status).toBe(200);
    }
    const list = (query: string) =>
      request("GET", `/api/v1/pages/${page.id}/revisions${query}`, { userId: reader.id });
    const numbers = (response: { body: { items: { number: number }[] } }) =>
      response.body.items.map((item) => item.number);

    const all = await list("");
    expect(numbers(all)).toEqual([5, 4, 3, 2, 1]);
    expect(all.body.total).toBe(5);
    expect(all.body.items[0]).not.toHaveProperty("markdown");
    const first = await list("?limit=2");
    expect(numbers(first)).toEqual([5, 4]);
    expect(first.body.total).toBe(5);
    expect(numbers(await list("?limit=2&offset=2"))).toEqual([3, 2]);
    expect(numbers(await list("?limit=2&offset=4"))).toEqual([1]);
    expect(numbers(await list("?offset=9"))).toEqual([]);
    expect((await list("?limit=0")).status).toBe(422);
    expect((await list("?limit=201")).status).toBe(422);
    expect((await list("?offset=-1")).status).toBe(422);

    const third = await request("GET", `/api/v1/pages/${page.id}/revisions/3`, { userId: reader.id });
    expect(third.body.markdown).toContain("version 3");
    expect(third.body.previousMarkdown).toContain("version 2");
    const firstRevision = await request("GET", `/api/v1/pages/${page.id}/revisions/1`, { userId: reader.id });
    expect(firstRevision.body.markdown).toContain("three");
    expect(firstRevision.body.previousMarkdown).toBeNull();
  });

  it("lists open change sets that touch a page", async () => {
    const { editor, space, page } = await setup();
    const [changeSet] = await getDb()
      .insert(changeSets)
      .values({ spaceId: space.id, title: "Fix typos", authorId: editor.id, channel: "web" })
      .returning();
    await getDb()
      .insert(changeSetItems)
      .values({
        changeSetId: changeSet!.id,
        pageId: page.id,
        action: "update",
        baseRevision: 1,
        path: page.path,
        markdown: newPageFile({ title: "Laptop", body: "fixed" }, { properties: [], pageTypes: [] }),
      });
    const view = await request("GET", `/api/v1/pages/${page.id}`, { userId: editor.id });
    expect(view.body.changeSets).toEqual([{ number: changeSet!.number, title: "Fix typos", status: "open" }]);
    await getDb().update(changeSets).set({ status: "merged" }).where(eq(changeSets.id, changeSet!.id));
    const after = await request("GET", `/api/v1/pages/${page.id}`, { userId: editor.id });
    expect(after.body.changeSets).toEqual([]);
  });

  it("uses change set visibility for summaries on an active page", async () => {
    const { editor, reader, space, page } = await setup();
    const draft = await createPage(space, {
      title: "Draft plan",
      markdown: file("Draft plan", "", "status: draft\n"),
    });
    const [changeSet] = await getDb()
      .insert(changeSets)
      .values({ spaceId: space.id, title: "Update both pages", authorId: editor.id, channel: "web" })
      .returning();
    await getDb()
      .insert(changeSetItems)
      .values(
        [page, draft].map((item) => ({
          changeSetId: changeSet!.id,
          pageId: item.id,
          action: "update",
          baseRevision: item.revision,
          path: item.path,
          markdown: item.markdown,
        })),
      );
    const editorView = await request("GET", `/api/v1/pages/${page.id}`, { userId: editor.id });
    expect(editorView.body.changeSets).toMatchObject([{ number: changeSet!.number }]);
    const readerView = await request("GET", `/api/v1/pages/${page.id}`, { userId: reader.id });
    expect(readerView.body.changeSets).toEqual([]);

    // Revisions name their change set only for those who may see it.
    await getDb()
      .update(pageRevisions)
      .set({ changeSetId: changeSet!.id })
      .where(eq(pageRevisions.pageId, page.id));
    const changeSetOf = async (userId: string) => {
      const list = await request("GET", `/api/v1/pages/${page.id}/revisions`, { userId });
      const one = await request("GET", `/api/v1/pages/${page.id}/revisions/1`, { userId });
      const recent = await request("GET", `/api/v1/recent`, { userId });
      const recentItem = recent.body.items.find((item: { page: { id: string } }) => item.page.id === page.id);
      return [list.body.items[0].changeSet, one.body.changeSet, recentItem.revision.changeSet];
    };
    const named = { number: changeSet!.number, title: "Update both pages" };
    expect(await changeSetOf(editor.id)).toEqual([named, named, named]);
    expect(await changeSetOf(reader.id)).toEqual([null, null, null]);
  });

  it("finds backlinks from live pages", async () => {
    const { reader, space, page } = await setup();
    await createPage(space, { title: "VPN", body: "See [the laptop](laptop)." });
    const view = await request("GET", `/api/v1/pages/${page.id}`, { userId: reader.id });
    expect(view.body.backlinks.map((link: { title: string }) => link.title)).toEqual(["VPN"]);
  });
});
