import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { unzipSync } from "fflate";
import { spaceAbilities, type SpaceRole } from "@handbook/shared/roles";
import { getDb, type DbOrTx } from "../db/client";
import { changeSetItems, changeSets, pages, spaces } from "../db/schema";
import { issueCredential } from "../auth/credentials";
import type { Principal } from "../auth/principal";
import { deleteLivePage, lockPage, type PageRow } from "../pages/core";
import {
  createPage,
  createSpace,
  createToken,
  createUser,
  request,
  resetDatabase,
  testApp,
} from "../test/helpers";
import { spaceContext } from "./access";
import { listSpaces, spaceView } from "./service";
import { spaceVisibility, visibilityOf, type Visibility } from "./visibility";

vi.mock("../auth/resolve", () => import("../test/resolve-mock"));

const file = (title: string, body = "", extra = "") => `---\ntitle: ${title}\n${extra}---\n\n${body}`;

type SpaceRow = typeof spaces.$inferSelect;

function person(
  user: { id: string; email: string; name: string; isAdmin: boolean },
  agent = false,
): Principal {
  return {
    kind: "user",
    id: user.id,
    email: user.email,
    name: user.name,
    image: null,
    isAdmin: user.isAdmin,
    channel: agent ? "token" : "web",
    agent,
    clientName: agent ? "Test agent" : null,
    credentialId: null,
  };
}

const service: Principal = {
  kind: "service",
  credentialId: "00000000-0000-0000-0000-000000000000",
  name: "Bot",
};

/** The rule as `spaceAbilities` states it, from the roles this test gave out. */
function seesDraftsBySpaceAbilities(
  principal: Principal,
  role: SpaceRole | null,
  archived: boolean,
): boolean {
  if (principal.kind === "service") {
    return spaceAbilities({ isAdmin: false, role: null, agent: true, readOnly: true }).seeDrafts;
  }
  return spaceAbilities({
    isAdmin: principal.isAdmin,
    role,
    agent: principal.agent,
    readOnly: false,
    archived,
  }).seeDrafts;
}

async function trash(page: PageRow, space: SpaceRow) {
  await getDb().transaction(async (tx) => {
    const locked = await lockPage(tx, page.id);
    await deleteLivePage(tx, { space, page: locked, author: { userId: null, via: "api", clientName: null } });
  });
}

async function ids(db: DbOrTx, condition: ReturnType<Visibility["livePages"]>) {
  const rows = await db.select({ id: pages.id }).from(pages).where(condition);
  return new Set(rows.map((row) => row.id));
}

describe("page visibility", () => {
  beforeEach(resetDatabase);

  /**
   * Spaces: an active one, an archived one (same members) and another active
   * one. Each has an active, a deprecated and a draft page, two pages below
   * the draft and one below the active page, and a draft, an active page and
   * a page below the draft in the trash. Each has change sets that change a
   * draft, a page below it, add or move a page below it, and two that touch
   * only pages everyone sees.
   */
  async function world() {
    const admin = await createUser({ isAdmin: true });
    const owner = await createUser();
    const editor = await createUser();
    const otherEditor = await createUser();
    const reader = await createUser();
    const main = await createSpace({ slug: "main", members: { [owner.id]: "owner", [editor.id]: "editor" } });
    const archived = await createSpace({
      slug: "old",
      members: { [owner.id]: "owner", [editor.id]: "editor" },
    });
    const other = await createSpace({ slug: "other", members: { [otherEditor.id]: "editor" } });
    const roles = new Map<string, Map<string, SpaceRole>>([
      [
        owner.id,
        new Map([
          [main.id, "owner" as const],
          [archived.id, "owner" as const],
        ]),
      ],
      [
        editor.id,
        new Map([
          [main.id, "editor" as const],
          [archived.id, "editor" as const],
        ]),
      ],
      [otherEditor.id, new Map([[other.id, "editor" as const]])],
    ]);

    /** `belowDraft`: a draft is one of its ancestors. */
    type Fixture = { page: PageRow; space: SpaceRow; status: string; live: boolean; belowDraft: boolean };
    const fixtures: Fixture[] = [];
    /** `hidden`: only for those who see drafts. */
    const changeSetFixtures: { id: string; space: SpaceRow; title: string; hidden: boolean }[] = [];
    for (const space of [main, archived, other]) {
      const add = async (
        title: string,
        status: string,
        options: { parent?: PageRow; live?: boolean; belowDraft?: boolean } = {},
      ) => {
        const page = await createPage(space, {
          title,
          parentPath: options.parent?.path ?? null,
          markdown: file(title, "Text.\n", `status: ${status}\n`),
        });
        if (options.live === false) await trash(page, space);
        const fixture = {
          page,
          space,
          status,
          live: options.live ?? true,
          belowDraft: options.belowDraft ?? false,
        };
        fixtures.push(fixture);
        return page;
      };
      const active = await add("active page", "active");
      await add("deprecated page", "deprecated");
      const draft = await add("draft page", "draft");
      const below = await add("below draft", "active", { parent: draft, belowDraft: true });
      await add("further below draft", "deprecated", { parent: below, belowDraft: true });
      const belowActive = await add("below active", "active", { parent: active });
      await add("trashed active", "active", { live: false });
      await add("trashed draft", "draft", { live: false });
      await add("trashed below draft", "active", { parent: draft, live: false, belowDraft: true });

      const changeSet = async (title: string, hidden: boolean, item: { page?: PageRow; path: string }) => {
        const [row] = await getDb()
          .insert(changeSets)
          .values({ spaceId: space.id, title, authorId: reader.id, channel: "web" })
          .returning();
        await getDb()
          .insert(changeSetItems)
          .values({
            changeSetId: row!.id,
            pageId: item.page?.id ?? randomUUID(),
            action: item.page ? "update" : "create",
            path: item.path,
            baseRevision: item.page?.revision ?? null,
            markdown: item.page?.markdown ?? file("new page"),
          });
        changeSetFixtures.push({ id: row!.id, space, title, hidden });
      };
      await changeSet("Change the active page", false, { page: active, path: active.path });
      await changeSet("Add a page below the active page", false, { path: `${active.path}/new-page` });
      await changeSet("Change the draft", true, { page: draft, path: draft.path });
      await changeSet("Change a page below the draft", true, { page: below, path: below.path });
      await changeSet("Add a page below the draft", true, { path: `${below.path}/new-page` });
      await changeSet("Move a page below the draft", true, {
        page: belowActive,
        path: `${draft.path}/moved`,
      });
    }
    await getDb().update(spaces).set({ archivedAt: new Date() }).where(eq(spaces.id, archived.id));
    const spacesNow = await getDb().select().from(spaces);
    const fresh = (space: SpaceRow) => spacesNow.find((row) => row.id === space.id)!;

    const principals: [string, Principal][] = [
      ["admin", person(admin)],
      ["admin's agent", person(admin, true)],
      ["owner", person(owner)],
      ["editor", person(editor)],
      ["editor's agent", person(editor, true)],
      ["editor of another space", person(otherEditor)],
      ["reader", person(reader)],
      ["reader's agent", person(reader, true)],
      ["service token", service],
    ];
    const roleOf = (principal: Principal, space: SpaceRow) =>
      principal.kind === "user" ? (roles.get(principal.id)?.get(space.id) ?? null) : null;
    const seesDrafts = (principal: Principal, space: SpaceRow) =>
      seesDraftsBySpaceAbilities(principal, roleOf(principal, space), fresh(space).archivedAt !== null);
    /** The principal may see the page (by its status and ancestors), live or in the trash. */
    const mayRead = (principal: Principal, fixture: Fixture) =>
      (fixture.status !== "draft" && !fixture.belowDraft) || seesDrafts(principal, fixture.space);
    /** The principal sees the page among the live pages. */
    const seesPage = (principal: Principal, fixture: Fixture) => fixture.live && mayRead(principal, fixture);
    const seesChangeSet = (principal: Principal, changeSet: (typeof changeSetFixtures)[number]) =>
      !changeSet.hidden || seesDrafts(principal, changeSet.space);
    return {
      spaces: [main, archived, other].map(fresh),
      fixtures: fixtures.map((fixture) => ({ ...fixture, space: fresh(fixture.space) })),
      changeSetFixtures,
      principals,
      seesDrafts,
      mayRead,
      seesPage,
      seesChangeSet,
    };
  }

  it("matches spaceAbilities for every kind of principal, role and page status", async () => {
    const {
      spaces: allSpaces,
      fixtures,
      changeSetFixtures,
      principals,
      seesDrafts,
      mayRead,
      seesPage,
      seesChangeSet,
    } = await world();
    const db = getDb();
    for (const [name, principal] of principals) {
      const visible = (fixture: (typeof fixtures)[number]) => seesPage(principal, fixture);
      const expected = new Set(fixtures.filter(visible).map((fixture) => fixture.page.id));
      const everywhere = await visibilityOf(db, principal);

      // Lists across spaces, through the pages table and through an alias.
      expect(await ids(db, everywhere.livePages()), name).toEqual(expected);
      const aliased = await db.execute<{ id: string }>(
        sql`select p.id from pages p where ${everywhere.livePages({
          spaceId: sql`p.space_id`,
          status: sql`p.status`,
          deletedAt: sql`p.deleted_at`,
          path: sql`p.path`,
        })}`,
      );
      expect(new Set(aliased.rows.map((row) => row.id)), name).toEqual(expected);

      for (const space of allSpaces) {
        const sees = seesDrafts(principal, space);
        const inSpace = spaceVisibility(await spaceContext(db, principal, space));
        const expectedHere = new Set(
          fixtures
            .filter((fixture) => fixture.space.id === space.id && visible(fixture))
            .map((f) => f.page.id),
        );
        // Lists within one space.
        expect(await ids(db, and(eq(pages.spaceId, space.id), inSpace.livePages())!), name).toEqual(
          expectedHere,
        );
        // The trash of the space.
        const expectedTrash = new Set(
          fixtures
            .filter((fixture) => fixture.space.id === space.id && !fixture.live && sees)
            .map((fixture) => fixture.page.id),
        );
        for (const visibility of [everywhere, inSpace]) {
          expect(await ids(db, and(eq(pages.spaceId, space.id), visibility.trashedPages())!), name).toEqual(
            expectedTrash,
          );
        }
        for (const visibility of [everywhere, inSpace]) {
          expect(visibility.seesDrafts(space.id), `${name} in ${space.slug}`).toBe(sees);
          expect(visibility.seesTrash(space.id), `${name} in ${space.slug}`).toBe(sees);
        }
        // Single reads (live or in the trash: the status and the ancestors decide).
        for (const fixture of fixtures.filter((candidate) => candidate.space.id === space.id)) {
          const may = mayRead(principal, fixture);
          const what = `${name}: ${fixture.page.title}`;
          expect(await everywhere.canSeePage(db, fixture.page), what).toBe(may);
          expect(await inSpace.canSeePage(db, fixture.page), what).toBe(may);
          if (may) await expect(inSpace.assertPage(db, fixture.page), what).resolves.toBeUndefined();
          else await expect(inSpace.assertPage(db, fixture.page), what).rejects.toThrow("No such page");
          // A page below it (a change set adds or moves one there): live drafts hide it.
          const below = `${fixture.page.path}/new`;
          const draftAbove = (fixture.live && fixture.status === "draft") || fixture.belowDraft;
          expect(await everywhere.canSeePath(db, space.id, below), `${what}/new`).toBe(!draftAbove || sees);
          expect(await inSpace.canSeePath(db, space.id, below), `${what}/new`).toBe(!draftAbove || sees);
        }
        // One change set at a time.
        for (const changeSet of changeSetFixtures.filter((candidate) => candidate.space.id === space.id)) {
          const may = seesChangeSet(principal, changeSet);
          const row = { id: changeSet.id, spaceId: space.id };
          expect(await inSpace.canSeeChangeSet(db, row), `${name}: ${changeSet.title}`).toBe(may);
          expect(await everywhere.canSeeChangeSet(db, row), `${name}: ${changeSet.title}`).toBe(may);
        }
      }

      // Change set lists across spaces.
      const listed = await db.select({ id: changeSets.id }).from(changeSets).where(everywhere.changeSets());
      const expectedChangeSets = changeSetFixtures
        .filter((changeSet) => seesChangeSet(principal, changeSet))
        .map((changeSet) => changeSet.id);
      expect(new Set(listed.map((row) => row.id)), name).toEqual(new Set(expectedChangeSets));
    }
  });

  it("counts and dates spaces by the pages and change sets the viewer sees", async () => {
    const {
      spaces: allSpaces,
      fixtures,
      changeSetFixtures,
      principals,
      seesDrafts,
      seesPage,
      seesChangeSet,
    } = await world();
    const db = getDb();
    // Pages everyone sees changed long ago; the others (drafts, the trash)
    // recently, so counting one of them would show in the date.
    const hour = 3_600_000;
    const start = Date.parse("2026-01-01T00:00:00.000Z");
    const changedAt = new Map(
      fixtures.map((fixture, index) => [
        fixture.page.id,
        start + (seesPage(service, fixture) ? 0 : 1000 * hour) + index * hour,
      ]),
    );
    for (const [id, at] of changedAt) {
      await db
        .update(pages)
        .set({ updatedAt: new Date(at) })
        .where(eq(pages.id, id));
    }
    await db.update(spaces).set({ updatedAt: new Date(start - hour) });

    for (const [name, principal] of principals) {
      const expected = (space: SpaceRow) => {
        const here = fixtures.filter((fixture) => fixture.space.id === space.id);
        const live = here.filter((fixture) => seesPage(principal, fixture));
        // The trash is for those who see drafts (seesTrash).
        const trashed = here.filter((fixture) => !fixture.live && seesDrafts(principal, space));
        const times = [...live, ...trashed].map((fixture) => changedAt.get(fixture.page.id)!);
        return {
          pageCount: live.length,
          updatedAt: new Date(Math.max(start - hour, ...times)).toISOString(),
          openChangeSets: changeSetFixtures.filter(
            (changeSet) => changeSet.space.id === space.id && seesChangeSet(principal, changeSet),
          ).length,
        };
      };
      // GET /spaces
      const listed = await listSpaces(db, principal, "include");
      expect(listed.length, name).toBeGreaterThan(0);
      for (const summary of listed) {
        const space = allSpaces.find((candidate) => candidate.id === summary.id)!;
        const { pageCount, updatedAt } = expected(space);
        expect(
          { pageCount: summary.pageCount, updatedAt: summary.updatedAt },
          `${name}: ${space.slug}`,
        ).toEqual({
          pageCount,
          updatedAt,
        });
      }
      // GET /spaces/:space
      for (const space of allSpaces) {
        const view = await spaceView(db, principal, await spaceContext(db, principal, space));
        expect(
          { pageCount: view.pageCount, updatedAt: view.updatedAt, openChangeSets: view.openChangeSets },
          `${name}: ${space.slug}`,
        ).toEqual(expected(space));
      }
    }
  });

  it("asks the database nothing when the principal sees drafts everywhere or nowhere", async () => {
    const admin = await createUser({ isAdmin: true });
    const noDatabase = new Proxy({} as DbOrTx, {
      get() {
        throw new Error("no query expected");
      },
    });
    expect((await visibilityOf(noDatabase, person(admin))).seesDrafts("any space")).toBe(true);
    expect((await visibilityOf(noDatabase, person(admin, true))).seesDrafts("any space")).toBe(true);
    expect((await visibilityOf(noDatabase, service)).seesDrafts("any space")).toBe(false);
  });
});

describe("read paths hide drafts from those who may not see them", () => {
  beforeEach(resetDatabase);

  async function setup() {
    const editor = await createUser({ name: "Eddie Editor" });
    const otherEditor = await createUser({ name: "Otto Other" });
    const reader = await createUser({ name: "Rita Reader" });
    const admin = await createUser({ name: "Ada Admin", isAdmin: true });
    const it = await createSpace({ slug: "it", name: "IT", members: { [editor.id]: "editor" } });
    const hr = await createSpace({ slug: "hr", name: "HR", members: { [otherEditor.id]: "editor" } });
    const laptop = await createPage(it, {
      title: "Laptop",
      markdown: file("Laptop", "Hello.\n", "tags: [hardware]\n"),
    });
    const plan = await createPage(it, {
      title: "Plan",
      markdown: file("Plan", "See [the laptop](laptop).\n", "status: draft\ntags: [hardware, secret]\n"),
    });
    const belowPlan = await createPage(it, {
      title: "Below plan",
      parentPath: "plan",
      markdown: file("Below plan", "Hidden with the draft above it.\n"),
    });
    await createPage(hr, {
      title: "Hiring",
      markdown: file("Hiring", "Needs [a laptop](/s/it/laptop).\n", "status: draft\ntags: [secret]\n"),
    });
    await createPage(hr, {
      title: "Holidays",
      markdown: file("Holidays", "Bring [a laptop](/s/it/laptop).\n", "tags: [time-off]\n"),
    });
    const { secret: serviceToken } = await issueCredential(getDb(), {
      kind: "service",
      name: "Bot",
      userId: null,
      expiresAt: null,
    });
    const editorAgent = await createToken(editor.id);
    return {
      editor,
      otherEditor,
      reader,
      admin,
      itSpace: it,
      laptop,
      plan,
      belowPlan,
      serviceToken,
      editorAgent,
    };
  }

  type Viewer = { userId?: string; token?: string };

  it("backlinks show only pages the viewer may see, across spaces", async () => {
    const { editor, otherEditor, reader, admin, laptop, serviceToken, editorAgent } = await setup();
    const backlinks = async (viewer: Viewer) => {
      const view = await request("GET", `/api/v1/pages/${laptop.id}`, viewer);
      return view.body.backlinks.map((link: { title: string }) => link.title).sort();
    };
    expect(await backlinks({ userId: reader.id })).toEqual(["Holidays"]);
    expect(await backlinks({ token: serviceToken })).toEqual(["Holidays"]);
    // Editors of the page's space do not see drafts of another space, and the reverse.
    expect(await backlinks({ userId: editor.id })).toEqual(["Holidays", "Plan"]);
    expect(await backlinks({ token: editorAgent })).toEqual(["Holidays", "Plan"]);
    expect(await backlinks({ userId: otherEditor.id })).toEqual(["Hiring", "Holidays"]);
    expect(await backlinks({ userId: admin.id })).toEqual(["Hiring", "Holidays", "Plan"]);
  });

  it("tags and tag pages count and list only visible pages", async () => {
    const { editor, otherEditor, reader, admin, serviceToken } = await setup();
    const tags = async (viewer: Viewer) => (await request("GET", "/api/v1/tags", viewer)).body.items;
    const tagged = async (tag: string, viewer: Viewer) =>
      (await request("GET", `/api/v1/tags/${tag}/pages`, viewer)).body.items
        .map((page: { title: string }) => page.title)
        .sort();
    const readerTags = [
      { tag: "hardware", count: 1 },
      { tag: "time-off", count: 1 },
    ];
    expect(await tags({ userId: reader.id })).toEqual(readerTags);
    expect(await tags({ token: serviceToken })).toEqual(readerTags);
    expect(await tags({ userId: editor.id })).toEqual([
      { tag: "hardware", count: 2 },
      { tag: "secret", count: 1 },
      { tag: "time-off", count: 1 },
    ]);
    expect(await tags({ userId: admin.id })).toEqual([
      { tag: "hardware", count: 2 },
      { tag: "secret", count: 2 },
      { tag: "time-off", count: 1 },
    ]);
    expect(await tagged("secret", { userId: reader.id })).toEqual([]);
    expect(await tagged("secret", { userId: editor.id })).toEqual(["Plan"]);
    expect(await tagged("secret", { userId: otherEditor.id })).toEqual(["Hiring"]);
    expect(await tagged("secret", { userId: admin.id })).toEqual(["Hiring", "Plan"]);
    expect(await tagged("hardware", { token: serviceToken })).toEqual(["Laptop"]);
  });

  it("exports drafts only to those who see them", async () => {
    const { editor, otherEditor, reader, admin, serviceToken, editorAgent } = await setup();
    const exported = async (viewer: Viewer) => {
      const headers: Record<string, string> = viewer.userId
        ? { "x-test-user": viewer.userId }
        : { authorization: `Bearer ${viewer.token}` };
      const response = await testApp().request("/api/v1/spaces/it/export", { headers });
      expect(response.status).toBe(200);
      return Object.keys(unzipSync(new Uint8Array(await response.arrayBuffer())))
        .filter((name) => name.endsWith(".md"))
        .sort();
    };
    const withoutDrafts = ["laptop.md"];
    const withDrafts = ["laptop.md", "plan.md", "plan/below-plan.md"];
    expect(await exported({ userId: reader.id })).toEqual(withoutDrafts);
    expect(await exported({ token: serviceToken })).toEqual(withoutDrafts);
    expect(await exported({ userId: otherEditor.id })).toEqual(withoutDrafts);
    expect(await exported({ userId: editor.id })).toEqual(withDrafts);
    expect(await exported({ token: editorAgent })).toEqual(withDrafts);
    expect(await exported({ userId: admin.id })).toEqual(withDrafts);
  });

  it("the space index lists drafts and the pages below them only to those who see drafts", async () => {
    const { editor, otherEditor, reader, admin, serviceToken } = await setup();
    const index = async (viewer: Viewer) => (await request("GET", "/s/it.md", viewer)).body as string;
    for (const viewer of [{ userId: reader.id }, { token: serviceToken }, { userId: otherEditor.id }]) {
      const text = await index(viewer);
      expect(text).toContain("- [Laptop](/s/it/laptop.md)");
      expect(text).not.toContain("[Plan]");
      expect(text).not.toContain("plan/");
    }
    for (const viewer of [{ userId: editor.id }, { userId: admin.id }]) {
      expect(await index(viewer)).toContain(
        "- [Plan](/s/it/plan.md)\n  - [Below plan](/s/it/plan/below-plan.md)",
      );
    }
  });

  it("children, the recent feed and the history of trashed pages follow the same rule", async () => {
    const { editor, otherEditor, reader, admin, laptop, plan } = await setup();
    await createPage((await getDb().select().from(spaces).where(eq(spaces.slug, "it")))[0]!, {
      title: "Draft child",
      parentPath: "laptop",
      markdown: file("Draft child", "", "status: draft\n"),
    });
    const children = async (userId: string) =>
      (await request("GET", `/api/v1/pages/${laptop.id}`, { userId })).body.children.map(
        (child: { title: string }) => child.title,
      );
    expect(await children(reader.id)).toEqual([]);
    expect(await children(otherEditor.id)).toEqual([]);
    expect(await children(editor.id)).toEqual(["Draft child"]);

    const recent = async (userId: string) =>
      (await request("GET", "/api/v1/recent?limit=50", { userId })).body.items
        .map((item: { page: { title: string } }) => item.page.title)
        .sort();
    expect(await recent(reader.id)).toEqual(["Holidays", "Laptop"]);
    expect(await recent(otherEditor.id)).toEqual(["Hiring", "Holidays", "Laptop"]);
    expect(await recent(editor.id)).toEqual(["Below plan", "Draft child", "Holidays", "Laptop", "Plan"]);
    expect(await recent(admin.id)).toEqual([
      "Below plan",
      "Draft child",
      "Hiring",
      "Holidays",
      "Laptop",
      "Plan",
    ]);

    // A page in the trash: its history only for the space's editors.
    const below = await request("GET", "/api/v1/spaces/it/pages/by-path?path=plan/below-plan", {
      userId: editor.id,
    });
    expect((await request("DELETE", `/api/v1/pages/${below.body.id}`, { userId: editor.id })).status).toBe(
      204,
    );
    expect(
      (await request("GET", `/api/v1/pages/${below.body.id}/revisions`, { userId: reader.id })).status,
    ).toBe(404);
    expect(
      (await request("GET", `/api/v1/pages/${below.body.id}/revisions`, { userId: editor.id })).status,
    ).toBe(200);
    // A draft: 404 for readers on every read.
    for (const path of [`/api/v1/pages/${plan.id}`, `/api/v1/pages/${plan.id}/revisions`, "/s/it/plan.md"]) {
      expect((await request("GET", path, { userId: reader.id })).status, path).toBe(404);
      expect((await request("GET", path, { userId: editor.id })).status, path).toBe(200);
    }
  });

  it("hides the pages below a draft with it until it is published", async () => {
    const {
      editor,
      otherEditor,
      reader,
      admin,
      itSpace,
      laptop,
      plan,
      belowPlan,
      serviceToken,
      editorAgent,
    } = await setup();
    const deeper = await createPage(itSpace, {
      title: "Deeper",
      parentPath: belowPlan.path,
      markdown: file("Deeper", "Quokka: ask for [a laptop](/s/it/laptop).\n", "tags: [quokkas]\n"),
    });
    const titles = (items: { title: string }[]) => items.map((item) => item.title).sort();
    /** What the viewer learns of the pages below the draft, on every path that lists or reads pages. */
    const look = async (viewer: Viewer) => ({
      tree: titles((await request("GET", "/api/v1/spaces/it/tree", viewer)).body.items),
      search: titles((await request("GET", "/api/v1/search?q=quokka", viewer)).body.results),
      tag: titles((await request("GET", "/api/v1/tags/quokkas/pages", viewer)).body.items),
      backlinks: titles((await request("GET", `/api/v1/pages/${laptop.id}`, viewer)).body.backlinks).filter(
        (title) => title === "Deeper",
      ),
      reads: await Promise.all(
        [
          `/api/v1/pages/${deeper.id}`,
          `/api/v1/pages/${deeper.id}/revisions`,
          `/api/v1/pages/${deeper.id}/revisions/1`,
          "/api/v1/spaces/it/pages/by-path?path=plan/below-plan/deeper",
          "/s/it/plan/below-plan/deeper.md",
        ].map(async (path) => (await request("GET", path, viewer)).status),
      ),
    });
    const hidden = { tree: ["Laptop"], search: [], tag: [], backlinks: [], reads: [404, 404, 404, 404, 404] };
    const shown = {
      tree: ["Below plan", "Deeper", "Laptop", "Plan"],
      search: ["Deeper"],
      tag: ["Deeper"],
      backlinks: ["Deeper"],
      reads: [200, 200, 200, 200, 200],
    };
    const readers: Viewer[] = [{ userId: reader.id }, { token: serviceToken }, { userId: otherEditor.id }];
    const editors: Viewer[] = [{ userId: editor.id }, { token: editorAgent }, { userId: admin.id }];
    for (const viewer of readers) expect(await look(viewer), JSON.stringify(viewer)).toEqual(hidden);
    for (const viewer of editors) expect(await look(viewer), JSON.stringify(viewer)).toEqual(shown);
    // Editors see the whole path in the breadcrumbs.
    const view = await request("GET", `/api/v1/pages/${deeper.id}`, { userId: editor.id });
    expect(view.body.breadcrumbs.map((crumb: { title: string }) => crumb.title)).toEqual([
      "Plan",
      "Below plan",
    ]);

    // Change sets that change a page below the draft, or add one there, are for editors only.
    const created = await request("POST", "/api/v1/change-sets", {
      userId: editor.id,
      body: { space: "it", title: "Plan the details" },
    });
    const number = created.body.number as number;
    const put = async (userId: string, body: object) =>
      request("PUT", `/api/v1/change-sets/${number}/pages`, { userId, body });
    expect((await put(editor.id, { path: "plan/below-plan/new", markdown: file("New") })).status).toBe(200);
    const visible = async (userId: string) => ({
      list: (await request("GET", "/api/v1/change-sets?status=all", { userId })).body.items.map(
        (item: { number: number }) => item.number,
      ),
      detail: (await request("GET", `/api/v1/change-sets/${number}`, { userId })).status,
    });
    expect(await visible(reader.id)).toEqual({ list: [], detail: 404 });
    expect(await visible(otherEditor.id)).toEqual({ list: [], detail: 404 });
    expect(await visible(editor.id)).toEqual({ list: [number], detail: 200 });

    // Readers cannot put pages there in their own change sets (the parent does not exist for them).
    const own = await request("POST", "/api/v1/change-sets", {
      userId: reader.id,
      body: { space: "it", title: "My idea" },
    });
    const mine = own.body.number as number;
    const readerPut = (body: object) =>
      request("PUT", `/api/v1/change-sets/${mine}/pages`, { userId: reader.id, body });
    const added = await readerPut({ path: "plan/below-plan/idea", markdown: file("Idea") });
    expect(added.status).toBe(422);
    expect(added.body.error.fields.path).toBe("The parent page “plan/below-plan” does not exist");
    // A taken path there answers like a free one.
    expect((await readerPut({ path: "plan/below-plan", markdown: file("Below plan") })).status).toBe(422);
    const moved = await readerPut({ pageId: laptop.id, path: "plan/laptop", markdown: laptop.markdown });
    expect(moved.status).toBe(422);
    const move = await request("POST", `/api/v1/change-sets/${mine}/pages/${laptop.id}/move`, {
      userId: reader.id,
      body: { path: "plan/laptop" },
    });
    expect(move.status).toBe(422);
    expect((await request("GET", `/api/v1/change-sets/${mine}`, { userId: reader.id })).body.items).toEqual(
      [],
    );

    // Published, the draft shows its pages to everyone again.
    const save = await request("PUT", `/api/v1/pages/${plan.id}`, {
      userId: editor.id,
      body: {
        markdown: plan.markdown.replace("status: draft", "status: active"),
        baseRevision: plan.revision,
      },
    });
    expect(save.status).toBe(200);
    for (const viewer of readers) expect(await look(viewer), JSON.stringify(viewer)).toEqual(shown);
    expect((await visible(reader.id)).detail).toBe(200);
  });
});
