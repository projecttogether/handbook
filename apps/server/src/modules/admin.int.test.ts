import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "../db/client";
import { pages, sessions, users } from "../db/schema";
import { createPage, createSpace, createToken, createUser, request, resetDatabase } from "../test/helpers";

vi.mock("../auth/resolve", () => import("../test/resolve-mock"));

describe("admin API", () => {
  beforeEach(resetDatabase);

  it("lists people, makes admins, blocks people and protects itself and ADMIN_EMAILS", async () => {
    const admin = await createUser({ isAdmin: true, email: "ada@example.org" });
    const person = await createUser({ email: "rita@example.org" });
    const root = await createUser({ email: "root@example.org" });
    await getDb()
      .update(users)
      .set({ isAdmin: true, adminSource: "environment" })
      .where(eq(users.id, root.id));
    await createSpace({ slug: "it", name: "IT", members: { [person.id]: "editor" } });
    await getDb()
      .insert(sessions)
      .values({ userId: person.id, token: "t", expiresAt: new Date(Date.now() + 60_000) });

    expect((await request("GET", "/api/v1/admin/people", { userId: person.id })).status).toBe(403);
    const agent = await createToken(admin.id);
    expect((await request("GET", "/api/v1/admin/people", { token: agent })).status).toBe(403);
    const list = await request("GET", "/api/v1/admin/people?q=rita", { userId: admin.id });
    expect(list.body.items).toEqual([
      expect.objectContaining({
        email: "rita@example.org",
        isAdmin: false,
        spaces: [{ slug: "it", name: "IT", role: "editor" }],
      }),
    ]);

    const made = await request("PATCH", `/api/v1/admin/people/${person.id}`, {
      userId: admin.id,
      body: { isAdmin: true },
    });
    expect(made.body).toMatchObject({ isAdmin: true, adminSource: "app" });
    const blocked = await request("PATCH", `/api/v1/admin/people/${person.id}`, {
      userId: admin.id,
      body: { isAdmin: false, blocked: true },
    });
    expect(blocked.body).toMatchObject({ isAdmin: false, blocked: true });
    expect(await getDb().select().from(sessions).where(eq(sessions.userId, person.id))).toHaveLength(0);
    expect((await request("GET", "/api/v1/me", { userId: person.id })).status).toBe(401);

    expect(
      (
        await request("PATCH", `/api/v1/admin/people/${admin.id}`, {
          userId: admin.id,
          body: { blocked: true },
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await request("PATCH", `/api/v1/admin/people/${root.id}`, {
          userId: admin.id,
          body: { isAdmin: false },
        })
      ).status,
    ).toBe(409);

    const audit = await request("GET", "/api/v1/admin/audit", { userId: admin.id });
    expect(audit.body.total).toBe(2);
    expect(audit.body.items.map((item: { summary: string }) => item.summary)).toEqual([
      "Removed the admin rights of rita@example.org; Blocked rita@example.org",
      "Made rita@example.org an admin",
    ]);
  });

  it("renames and merges tags on every page", async () => {
    const admin = await createUser({ isAdmin: true });
    const space = await createSpace({ slug: "it" });
    const one = await createPage(space, {
      title: "One",
      markdown: "---\ntitle: One\ntags: [laptop, mac]\n---\n",
    });
    const two = await createPage(space, {
      title: "Two",
      markdown: "---\ntitle: Two\ntags: [notebook]\n---\n",
    });
    const renamed = await request("POST", "/api/v1/admin/tags/rename", {
      userId: admin.id,
      body: { from: "Laptop", to: "notebook" },
    });
    expect(renamed.body).toEqual({ changed: 1, skipped: 0 });
    const [first] = await getDb().select().from(pages).where(eq(pages.id, one.id));
    expect(first!.tags).toEqual(["notebook", "mac"]);
    expect(first!.revision).toBe(2);
    const [second] = await getDb().select().from(pages).where(eq(pages.id, two.id));
    expect(second!.revision).toBe(1);
    const tags = await request("GET", "/api/v1/tags", { userId: admin.id });
    expect(tags.body.items).toEqual([
      { tag: "mac", count: 1 },
      { tag: "notebook", count: 2 },
    ]);
  });
});
