import { beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { getDb, type Tx } from "../db/client";
import { pageLinks, pageSections, pages, spaces } from "../db/schema";
import type { UserPrincipal } from "../auth/principal";
import { spaceContext } from "../spaces/access";
import { updateSpace } from "../spaces/service";
import { reindexIfLanguagesChanged } from "../search/reindex";
import { createPage, createSpace, createUser, resetDatabase } from "../test/helpers";
import { blockedOrDone, heldTransaction, settle } from "../test/concurrency";
import {
  createLivePage,
  deleteLivePage,
  lockPage,
  moveLivePage,
  restoreDeletedPage,
  saveLivePage,
} from "./core";

/**
 * Writes that race each other, in a fixed order: the first transaction
 * holds its locks until the second one waits for them (or finished, when
 * nothing stopped it), then commits.
 */

const author = { userId: null, via: "web" as const, clientName: null };
const file = (title: string) => `---\ntitle: ${title}\n---\n`;

type Space = Awaited<ReturnType<typeof createSpace>>;

const create = (tx: Tx, space: Space, parentPath: string, slug: string) =>
  createLivePage(tx, { space, parentPath, slug, markdown: file(slug), author });

async function move(tx: Tx, space: Space, pageId: string, newPath: string) {
  const page = await lockPage(tx, pageId);
  return moveLivePage(tx, { space, page, newPath, author });
}

async function trash(tx: Tx, space: Space, pageId: string) {
  const page = await lockPage(tx, pageId);
  await deleteLivePage(tx, { space, page, author });
}

async function restore(tx: Tx, space: Space, pageId: string) {
  const page = await lockPage(tx, pageId, { deleted: true });
  return restoreDeletedPage(tx, { space, page, author });
}

/** Runs `first` and holds it open while `second` starts; then commits `first`. */
async function race<A, B>(first: (tx: Tx) => Promise<A>, second: (tx: Tx) => Promise<B>) {
  const held = heldTransaction(first);
  await held.ready;
  const next = settle(getDb().transaction(second));
  const waited = await blockedOrDone(next);
  await held.commit();
  expect(waited).toBe("blocked");
  return next;
}

async function pageAt(id: string) {
  const [row] = await getDb().select().from(pages).where(eq(pages.id, id));
  return row!;
}

describe("page core races", () => {
  beforeEach(resetDatabase);

  it("moves a sub-page created while its parent moves along with it", async () => {
    const space = await createSpace();
    const a = await createPage(space, { title: "A", slug: "a" });
    const held = heldTransaction((tx) => create(tx, space, "a", "new"));
    await held.ready;
    const moving = settle(getDb().transaction((tx) => move(tx, space, a.id, "z")));
    const waited = await blockedOrDone(moving);
    const created = await held.commit();
    expect(waited).toBe("blocked");
    expect((await moving).ok).toBe(true);
    expect(await pageAt(created.id)).toMatchObject({ path: "z/new", parentId: a.id });
  });

  it("moves a page created two levels below a page that moves", async () => {
    const space = await createSpace();
    const a = await createPage(space, { title: "A", slug: "a" });
    await createPage(space, { title: "B", parentPath: "a", slug: "b" });
    const held = heldTransaction((tx) => create(tx, space, "a/b", "new"));
    await held.ready;
    const moving = settle(getDb().transaction((tx) => move(tx, space, a.id, "z")));
    const waited = await blockedOrDone(moving);
    const created = await held.commit();
    expect(waited).toBe("blocked");
    expect((await moving).ok).toBe(true);
    expect((await pageAt(created.id)).path).toBe("z/b/new");
  });

  it("refuses a sub-page below a page that moved meanwhile", async () => {
    const space = await createSpace();
    const a = await createPage(space, { title: "A", slug: "a" });
    const result = await race(
      (tx) => move(tx, space, a.id, "z"),
      (tx) => create(tx, space, "a", "new"),
    );
    expect(result).toMatchObject({ ok: false, error: { status: 422 } });
    expect((await getDb().select().from(pages)).map((row) => row.path)).toEqual(["z"]);
  });

  it("refuses to delete a page that got a sub-page meanwhile", async () => {
    const space = await createSpace();
    const a = await createPage(space, { title: "A", slug: "a" });
    const result = await race(
      (tx) => create(tx, space, "a", "new"),
      (tx) => trash(tx, space, a.id),
    );
    expect(result).toMatchObject({ ok: false, error: { code: "has_children" } });
    expect((await pageAt(a.id)).deletedAt).toBeNull();
  });

  it("refuses to move a page below a page deleted meanwhile", async () => {
    const space = await createSpace();
    const a = await createPage(space, { title: "A", slug: "a" });
    const x = await createPage(space, { title: "X", slug: "x" });
    const result = await race(
      (tx) => trash(tx, space, a.id),
      (tx) => move(tx, space, x.id, "a/x"),
    );
    expect(result).toMatchObject({ ok: false, error: { status: 422 } });
    expect((await pageAt(x.id)).path).toBe("x");
  });

  it("refuses to restore a page below a page that moved meanwhile", async () => {
    const space = await createSpace();
    const a = await createPage(space, { title: "A", slug: "a" });
    const child = await createPage(space, { title: "C", parentPath: "a", slug: "c" });
    await getDb().transaction((tx) => trash(tx, space, child.id));
    const result = await race(
      (tx) => move(tx, space, a.id, "z"),
      (tx) => restore(tx, space, child.id),
    );
    expect(result).toMatchObject({ ok: false, error: { status: 422 } });
    expect((await pageAt(child.id)).deletedAt).not.toBeNull();
  });

  describe("with a property that goes away", () => {
    const team = {
      key: "team",
      label: "Team",
      type: "select" as const,
      options: ["it"],
      required: false,
      help: "",
    };
    const withTeam = "---\ntitle: Doc\nteam: it\n---\n";

    async function setup() {
      const user = await createUser();
      const space = await createSpace({ properties: [team], members: { [user.id]: "owner" } });
      const page = await createPage(space, { title: "Doc" });
      const owner: UserPrincipal = {
        kind: "user",
        id: user.id,
        email: user.email,
        name: user.name,
        image: null,
        isAdmin: false,
        channel: "web",
        agent: false,
        clientName: null,
        credentialId: null,
      };
      return { space, page, owner };
    }

    const save = async (tx: Tx, space: Space, pageId: string) =>
      saveLivePage(tx, {
        space,
        page: await lockPage(tx, pageId),
        markdown: withTeam,
        baseRevision: 1,
        author,
      });

    it("refuses the change while a save that uses it is not done", async () => {
      const { space, page, owner } = await setup();
      const held = heldTransaction((tx) => save(tx, space, page.id));
      await held.ready;
      const context = await spaceContext(getDb(), owner, space);
      const updating = settle(updateSpace(getDb(), owner, context, { properties: [] }));
      const waited = await blockedOrDone(updating);
      await held.commit();
      expect(waited).toBe("blocked");
      expect(await updating).toMatchObject({ ok: false, error: { status: 422 } });
      const [after] = await getDb().select().from(spaces).where(eq(spaces.id, space.id));
      expect(after?.properties).toEqual([team]);
    });

    it("checks a save against the properties as they are when it is done", async () => {
      const { space, page } = await setup();
      // `space` is the row as a request read it before the change.
      const result = await race(
        (tx) => tx.update(spaces).set({ properties: [] }).where(eq(spaces.id, space.id)),
        (tx) => save(tx, space, page.id),
      );
      expect(result).toMatchObject({ ok: false, error: { status: 422 } });
      expect((await pageAt(page.id)).revision).toBe(1);
    });

    it("keeps a page in the trash that no longer fits the space", async () => {
      const { space, page } = await setup();
      await getDb().transaction((tx) => save(tx, space, page.id));
      await getDb().transaction((tx) => trash(tx, space, page.id));
      // The property went away while the page was in the trash (only live pages are checked then).
      await getDb().update(spaces).set({ properties: [] }).where(eq(spaces.id, space.id));
      const result = await settle(getDb().transaction((tx) => restore(tx, space, page.id)));
      expect(result).toMatchObject({ ok: false, error: { status: 422 } });
      expect((await pageAt(page.id)).deletedAt).not.toBeNull();
    });
  });

  it("rebuilds the search data of a page saved meanwhile from its new file", async () => {
    const space = await createSpace({ slug: "it" });
    const page = await createPage(space, { title: "Doc", body: "## Old heading\n\nOld text.\n" });
    const held = heldTransaction(async (tx) =>
      saveLivePage(tx, {
        space,
        page: await lockPage(tx, page.id),
        markdown: "---\ntitle: Handbook\n---\n\n## New heading\n\nSee [VPN](vpn).\n",
        baseRevision: 1,
        author,
      }),
    );
    await held.ready;
    // The search languages changed: the worker rebuilds every page.
    const rebuild = settle(reindexIfLanguagesChanged(getDb()));
    const waited = await blockedOrDone(rebuild);
    await held.commit();
    expect(waited).toBe("blocked");
    expect(await rebuild).toMatchObject({ ok: true });

    const sections = await getDb().select().from(pageSections).where(eq(pageSections.pageId, page.id));
    expect(sections.map((section) => section.headingPath)).toEqual([["New heading"]]);
    const links = await getDb().select().from(pageLinks).where(eq(pageLinks.fromPageId, page.id));
    expect(links.map((link) => link.toPath)).toEqual(["vpn"]);
    const [found] = await getDb()
      .select({ id: pages.id })
      .from(pages)
      .where(sql`${pages.searchVector} @@ to_tsquery('simple', 'handbook')`);
    expect(found?.id).toBe(page.id);
  });
});
