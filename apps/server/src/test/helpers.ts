import { sql } from "drizzle-orm";
import { newPageFile } from "@handbook/shared/page";
import type { SpaceRole } from "@handbook/shared/roles";
import { getDb } from "../db/client";
import { spaceMembers, spaces, users } from "../db/schema";
import { createApp } from "../http/app";
import { issueCredential } from "../auth/credentials";
import { createLivePage } from "../pages/core";

/** Empties every table between tests. */
export async function resetDatabase() {
  await getDb().execute(sql`
    truncate table change_set_events, change_set_items, change_sets, drafts, edit_locks, files, redirects,
      page_links, page_sections, page_revisions, pages, space_members, spaces, oauth_requests, oauth_grants,
      oauth_clients, credentials, audit_log, settings, sessions, accounts, verifications, auth_rate_limits, users
      restart identity cascade
  `);
}

/** A person who signed in just now (`lastSignInAt`), unless told otherwise. */
export async function createUser(
  options: { email?: string; name?: string; isAdmin?: boolean; lastSignInAt?: Date | null } = {},
) {
  const email = options.email ?? `person-${Math.random().toString(36).slice(2, 8)}@example.org`;
  const [user] = await getDb()
    .insert(users)
    .values({
      email,
      name: options.name ?? email.split("@")[0]!,
      isAdmin: options.isAdmin ?? false,
      adminSource: options.isAdmin ? "app" : null,
      lastSignInAt: options.lastSignInAt === undefined ? new Date() : options.lastSignInAt,
    })
    .returning();
  return user!;
}

/** A space with optional members: `{ [userId]: "owner" | "editor" }`. */
export async function createSpace(
  options: {
    slug?: string;
    name?: string;
    members?: Record<string, SpaceRole>;
    properties?: (typeof spaces.$inferInsert)["properties"];
    pageTypes?: (typeof spaces.$inferInsert)["pageTypes"];
  } = {},
) {
  const slug = options.slug ?? `space-${Math.random().toString(36).slice(2, 8)}`;
  const [space] = await getDb()
    .insert(spaces)
    .values({
      slug,
      name: options.name ?? slug,
      properties: options.properties ?? [],
      pageTypes: options.pageTypes ?? [],
    })
    .returning();
  for (const [userId, role] of Object.entries(options.members ?? {})) {
    await getDb().insert(spaceMembers).values({ spaceId: space!.id, userId, role });
  }
  return space!;
}

/** A live page through the page core, as if an editor created it. */
export async function createPage(
  space: typeof spaces.$inferSelect,
  options: {
    title: string;
    body?: string;
    parentPath?: string | null;
    slug?: string;
    markdown?: string;
    authorId?: string;
  },
) {
  return getDb().transaction((tx) =>
    createLivePage(tx, {
      space,
      parentPath: options.parentPath ?? null,
      slug: options.slug,
      markdown:
        options.markdown ??
        newPageFile(
          { title: options.title, body: options.body ?? "" },
          { properties: space.properties, pageTypes: space.pageTypes },
        ),
      author: { userId: options.authorId ?? null, via: "api", clientName: null },
    }),
  );
}

/** A personal access token (agent) of a person; returns the secret. */
export async function createToken(userId: string, name = "Test agent") {
  const { secret } = await issueCredential(getDb(), {
    kind: "personal",
    name,
    userId,
    createdById: userId,
    expiresAt: null,
  });
  return secret;
}

let app: ReturnType<typeof createApp> | undefined;

export function testApp() {
  app ??= createApp();
  return app;
}

/**
 * A request to the app as `userId` in the web app (the test resolver in API
 * tests reads the x-test-user header), or with a bearer `token`. JSON bodies
 * are sent with the app's origin.
 */
export async function request(
  method: string,
  path: string,
  options: {
    userId?: string;
    token?: string;
    body?: unknown;
    form?: FormData;
    headers?: Record<string, string>;
  } = {},
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test responses are read loosely
): Promise<{ status: number; body: any; headers: Headers }> {
  const headers: Record<string, string> = {
    origin: "http://localhost:3000",
    accept: "application/json",
    ...options.headers,
  };
  if (options.userId) headers["x-test-user"] = options.userId;
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  if (options.body !== undefined) headers["content-type"] = "application/json";
  const response = await testApp().request(path, {
    method,
    headers,
    body: options.form ?? (options.body === undefined ? undefined : JSON.stringify(options.body)),
  });
  const type = response.headers.get("content-type") ?? "";
  const text = await response.text();
  return {
    status: response.status,
    body: text && type.includes("json") ? JSON.parse(text) : text,
    headers: response.headers,
  };
}
