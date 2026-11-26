import { existsSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { asc, sql } from "drizzle-orm";
import { config } from "../config";
import { getDb } from "../db/client";
import { files } from "../db/schema";
import { createPage, createSpace, createUser, request, resetDatabase } from "../test/helpers";
import { pruneUnusedUploads } from "./storage";

vi.mock("../auth/resolve", () => import("../test/resolve-mock"));

describe("unused uploads", () => {
  beforeEach(resetDatabase);

  it("are removed after a day unless saved content ever mentioned them", async () => {
    const owner = await createUser();
    const space = await createSpace({ slug: "it", members: { [owner.id]: "owner" } });
    const page = await createPage(space, { title: "VPN", body: "Text.\n" });
    const upload = async (name: string) => {
      const form = new FormData();
      form.append("file", new File(["png"], name, { type: "image/png" }));
      const response = await request("POST", "/api/v1/spaces/it/files", { userId: owner.id, form });
      expect(response.status).toBe(201);
      return response.body as { url: string; markdown: string };
    };
    const inPage = await upload("page.png");
    const inDraft = await upload("draft.png");
    const inItem = await upload("item.png");
    const inChangeSet = await upload("change-set.png");
    const inComment = await upload("comment.png");
    const inDescription = await upload("description.png");
    const inTemplate = await upload("template.png");
    await upload("unused.png");

    await createPage(space, { title: "Uses image", body: `${inPage.markdown}\n` });
    const draft = await request("PUT", `/api/v1/pages/${page.id}/draft`, {
      userId: owner.id,
      body: { markdown: `---\ntitle: VPN\n---\n\n${inDraft.markdown}\n`, baseRevision: page.revision },
    });
    expect(draft.status).toBe(200);
    const changeSet = await request("POST", "/api/v1/change-sets", {
      userId: owner.id,
      body: { space: "it", title: "Images", description: `See ${inChangeSet.markdown}` },
    });
    expect(changeSet.status).toBe(201);
    const number = changeSet.body.number as number;
    const item = await request("PUT", `/api/v1/change-sets/${number}/pages`, {
      userId: owner.id,
      body: { path: "printers", markdown: `---\ntitle: Printers\n---\n\n${inItem.markdown}\n` },
    });
    expect(item.status).toBe(200);
    const comment = await request("POST", `/api/v1/change-sets/${number}/comments`, {
      userId: owner.id,
      body: { body: `Like this? ${inComment.markdown}` },
    });
    expect(comment.status).toBe(200);
    const settings = await request("PATCH", "/api/v1/spaces/it", {
      userId: owner.id,
      body: {
        description: `IT ${inDescription.markdown}`,
        pageTypes: [{ key: "how-to", label: "How-to", template: `${inTemplate.markdown}\n` }],
      },
    });
    expect(settings.status).toBe(200);

    await getDb()
      .update(files)
      .set({ createdAt: sql`now() - interval '2 days'` });
    const before = await getDb().select().from(files);
    const unused = before.find((row) => row.name === "unused.png")!;
    expect(await pruneUnusedUploads(getDb())).toBe(1);
    const kept = await getDb().select({ name: files.name }).from(files).orderBy(asc(files.name));
    expect(kept.map((row) => row.name)).toEqual([
      "change-set.png",
      "comment.png",
      "description.png",
      "draft.png",
      "item.png",
      "page.png",
      "template.png",
    ]);
    expect(existsSync(path.join(config().FILES_DIR, unused.storageKey))).toBe(false);
    const draftFile = before.find((row) => row.name === "draft.png")!;
    expect(existsSync(path.join(config().FILES_DIR, draftFile.storageKey))).toBe(true);
  });

  it("are found without reading pages, revisions or change sets", async () => {
    const space = await createSpace({ slug: "it" });
    // 300 pages with a revision each, 100 KB apiece, and 500 old uploads nothing mentions.
    await getDb().execute(sql`
      insert into pages (space_id, path, revision, title, markdown)
      select ${space.id}, 'page-' || n, 1, 'Page ' || n,
        (select string_agg(md5(n || '-' || g), ' ') from generate_series(1, 3000) g)
      from generate_series(1, 300) n`);
    await getDb().execute(sql`
      insert into page_revisions (page_id, number, kind, path, title, markdown, via)
      select id, 1, 'save', path, title, markdown, 'api' from pages`);
    await getDb().execute(sql`
      insert into files (space_id, name, content_type, size, storage_key, created_at)
      select ${space.id}, 'old.png', 'image/png', 3, substr(md5(n::text), 1, 2) || '/' || gen_random_uuid(),
        now() - interval '2 days'
      from generate_series(1, 500) n`);
    const start = performance.now();
    expect(await pruneUnusedUploads(getDb())).toBe(500);
    expect(performance.now() - start).toBeLessThan(2_000);
  });
});
