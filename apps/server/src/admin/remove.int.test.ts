import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { REMOVED_PERSON_NAME } from "@handbook/shared/api/users";
import { getDb } from "../db/client";
import {
  accounts,
  auditLog,
  credentials,
  drafts,
  editLocks,
  oauthClients,
  oauthGrants,
  oauthRequests,
  sessions,
  spaceMembers,
  users,
} from "../db/schema";
import { auth } from "../auth/auth";
import { issueCredential } from "../auth/credentials";
import { createPage, createSpace, createToken, createUser, request, resetDatabase } from "../test/helpers";

vi.mock("../auth/resolve", () => import("../test/resolve-mock"));

const RITA = "rita@example.org";

/** Everything a person leaves behind: sign-ins, tokens, a connected app, drafts, a lock, roles, history. */
async function setup() {
  const admin = await createUser({ isAdmin: true, email: "ada@example.org" });
  const rita = await createUser({ email: RITA, name: "Rita Reader" });
  const space = await createSpace({ slug: "it", name: "IT", members: { [rita.id]: "editor" } });
  const page = await createPage(space, { title: "Laptop", authorId: rita.id });
  const db = getDb();
  await db.insert(sessions).values({ userId: rita.id, token: "t", expiresAt: new Date(Date.now() + 60_000) });
  await db.insert(accounts).values({ userId: rita.id, providerId: "oidc", accountId: "kc-rita" });
  const token = await createToken(rita.id);
  const [client] = await db
    .insert(oauthClients)
    .values({
      clientId: "app",
      registration: "dynamic",
      name: "Agent",
      redirectUris: ["https://example.org/cb"],
    })
    .returning();
  const [grant] = await db
    .insert(oauthGrants)
    .values({ clientId: client!.id, userId: rita.id, redirectUri: "https://example.org/cb" })
    .returning();
  const app = await issueCredential(db, {
    kind: "oauth_access",
    name: "Agent",
    userId: rita.id,
    grantId: grant!.id,
    expiresAt: null,
  });
  await db.insert(oauthRequests).values({
    clientId: client!.id,
    redirectUri: "https://example.org/cb",
    codeChallenge: "challenge",
    userId: rita.id,
    expiresAt: new Date(Date.now() + 60_000),
  });

  expect((await request("POST", `/api/v1/pages/${page.id}/lock`, { userId: rita.id })).status).toBe(200);
  const draft = await request("PUT", `/api/v1/pages/${page.id}/draft`, {
    userId: rita.id,
    body: { markdown: "---\ntitle: Laptop\n---\n\nNew text\n", baseRevision: 1 },
  });
  expect(draft.status).toBe(200);
  const changeSet = await request("POST", "/api/v1/change-sets", {
    userId: rita.id,
    body: { space: "it", title: "Better laptop page" },
  });
  expect(changeSet.status).toBe(201);
  const number = changeSet.body.number as number;
  const comment = await request("POST", `/api/v1/change-sets/${number}/comments`, {
    userId: rita.id,
    body: { body: "Please have a look" },
  });
  expect(comment.status).toBeLessThan(300);

  // An admin's change about Rita, and one by Rita.
  await request("PATCH", `/api/v1/admin/people/${rita.id}`, { userId: admin.id, body: { isAdmin: true } });
  const created = await request("POST", "/api/v1/spaces", {
    userId: rita.id,
    body: { slug: "hr", name: "HR", description: "" },
  });
  expect(created.status).toBe(201);
  return { admin, rita, page, number, token, appToken: app.secret };
}

describe("removing a person", () => {
  beforeEach(resetDatabase);

  it("keeps their history under a placeholder and deletes everything else", async () => {
    const { admin, rita, page, number, token, appToken } = await setup();

    const removed = await request("DELETE", `/api/v1/admin/people/${rita.id}`, { userId: admin.id });
    expect(removed.status).toBe(204);

    const [row] = await getDb().select().from(users).where(eq(users.id, rita.id));
    expect(row).toMatchObject({
      email: `removed-${rita.id}@removed.invalid`,
      name: REMOVED_PERSON_NAME,
      isAdmin: false,
      adminSource: null,
      lastSignInAt: null,
    });
    expect(row!.blockedAt).not.toBeNull();
    for (const [table, column] of [
      [sessions, sessions.userId],
      [accounts, accounts.userId],
      [credentials, credentials.userId],
      [oauthGrants, oauthGrants.userId],
      [oauthRequests, oauthRequests.userId],
      [drafts, drafts.userId],
      [editLocks, editLocks.userId],
      [spaceMembers, spaceMembers.userId],
    ] as const) {
      expect(await getDb().select().from(table).where(eq(column, rita.id))).toHaveLength(0);
    }
    expect((await request("GET", "/api/v1/me", { token })).status).toBe(401);
    expect((await request("GET", "/api/v1/me", { token: appToken })).status).toBe(401);

    // Revisions, change sets and comments stay, under the placeholder.
    const history = await request("GET", `/api/v1/pages/${page.id}/revisions`, { userId: admin.id });
    expect(history.body.items[0].author).toEqual({
      id: rita.id,
      name: REMOVED_PERSON_NAME,
      email: `removed-${rita.id}@removed.invalid`,
    });
    const changeSet = await request("GET", `/api/v1/change-sets/${number}`, { userId: admin.id });
    expect(changeSet.body.author.name).toBe(REMOVED_PERSON_NAME);
    expect(changeSet.body.events).toContainEqual(
      expect.objectContaining({
        kind: "comment",
        body: "Please have a look",
        actor: expect.objectContaining({ name: REMOVED_PERSON_NAME }),
      }),
    );

    // The audit log keeps no trace of the email, and records the removal without it.
    const entries = await getDb().select().from(auditLog);
    expect(JSON.stringify(entries)).not.toContain(RITA);
    expect(JSON.stringify(entries)).not.toContain("Rita Reader");
    const audit = await request("GET", "/api/v1/admin/audit", { userId: admin.id });
    expect(
      audit.body.items.map((item: { actorEmail: string; action: string; summary: string }) => [
        item.actorEmail,
        item.action,
        item.summary,
      ]),
    ).toEqual([
      ["ada@example.org", "person.removed", "Removed a person"],
      [REMOVED_PERSON_NAME, "space.created", "Created the space HR (hr) from the Blank template"],
      ["ada@example.org", "person.updated", "Made a removed person an admin"],
    ]);

    // Removed people are gone from the list and cannot be changed or removed again.
    const people = await request("GET", "/api/v1/admin/people", { userId: admin.id });
    expect(people.body.items.map((item: { id: string }) => item.id)).toEqual([admin.id]);
    expect((await request("GET", "/api/v1/admin/people?q=removed", { userId: admin.id })).body.items).toEqual(
      [],
    );
    expect(
      (
        await request("PATCH", `/api/v1/admin/people/${rita.id}`, {
          userId: admin.id,
          body: { blocked: false },
        })
      ).status,
    ).toBe(404);
    expect((await request("DELETE", `/api/v1/admin/people/${rita.id}`, { userId: admin.id })).status).toBe(
      404,
    );
  });

  it("lets the person sign in again as a new, empty person", async () => {
    const { admin, rita } = await setup();
    const adapter = (await auth().$context).internalAdapter;
    expect(await adapter.findAccountOwnerByKey({ providerId: "oidc", accountId: "kc-rita" })).not.toBeNull();
    await request("DELETE", `/api/v1/admin/people/${rita.id}`, { userId: admin.id });

    // What the sign-in looks up: the provider's account, then the email.
    expect(await adapter.findAccountOwnerByKey({ providerId: "oidc", accountId: "kc-rita" })).toBeNull();
    expect(await adapter.findUserByEmail(RITA)).toBeNull();
    const { user } = await adapter.createOAuthUser(
      { email: RITA, name: "Rita Reader", emailVerified: true },
      { providerId: "oidc", accountId: "kc-rita" },
    );
    expect(user.id).not.toBe(rita.id);
    const people = await request("GET", "/api/v1/admin/people?q=rita", { userId: admin.id });
    expect(people.body.items).toEqual([
      expect.objectContaining({ id: user.id, email: RITA, isAdmin: false, blocked: false, spaces: [] }),
    ]);
  });

  it("only admins in the web app remove, never themselves or ADMIN_EMAILS", async () => {
    const admin = await createUser({ isAdmin: true, email: "ada@example.org" });
    const rita = await createUser({ email: RITA });
    const root = await createUser({ email: "root@example.org" });
    await getDb()
      .update(users)
      .set({ isAdmin: true, adminSource: "environment" })
      .where(eq(users.id, root.id));
    const agent = await createToken(admin.id);

    const remove = (id: string, options: { userId?: string; token?: string }) =>
      request("DELETE", `/api/v1/admin/people/${id}`, options);
    expect((await remove(admin.id, { userId: rita.id })).status).toBe(403);
    expect((await remove(rita.id, { token: agent })).status).toBe(403);
    const self = await remove(admin.id, { userId: admin.id });
    expect(self.status).toBe(409);
    expect(self.body.error.code).toBe("self_change");
    const environment = await remove(root.id, { userId: admin.id });
    expect(environment.status).toBe(409);
    expect(environment.body.error.code).toBe("environment_admin");
    expect((await remove("0b5a3e5e-3c1f-4d8e-9f3a-000000000000", { userId: admin.id })).status).toBe(404);
    const [row] = await getDb().select().from(users).where(eq(users.id, rita.id));
    expect(row!.email).toBe(RITA);
  });
});
