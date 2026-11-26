import { beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { getDb } from "../db/client";
import { files } from "../db/schema";
import { issueCredential } from "../auth/credentials";
import { pruneUnusedUploads } from "../files/storage";
import {
  createPage,
  createSpace,
  createToken,
  createUser,
  request,
  resetDatabase,
  testApp,
} from "../test/helpers";

vi.mock("../auth/resolve", () => import("../test/resolve-mock"));

describe("Markdown files, llms.txt and uploads", () => {
  beforeEach(resetDatabase);

  it("serves pages as Markdown to people and tokens, follows moves, hides drafts", async () => {
    const editor = await createUser();
    const reader = await createUser();
    const space = await createSpace({ slug: "it", name: "IT", members: { [editor.id]: "editor" } });
    space.description = "";
    await createPage(space, { title: "Laptop", body: "Hello.\n" });
    await createPage(space, { title: "Setup", parentPath: "laptop" });
    await createPage(space, { title: "Plan", markdown: "---\ntitle: Plan\nstatus: draft\n---\n" });
    const { secret: service } = await issueCredential(getDb(), {
      kind: "service",
      name: "Bot",
      userId: null,
      expiresAt: null,
    });

    const anonymous = await testApp().request("/s/it/laptop.md");
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get("www-authenticate")).toContain("Bearer");

    const page = await request("GET", "/s/it/laptop.md", { token: service });
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(page.body).toBe("---\ntitle: Laptop\n---\n\nHello.\n");
    expect((await request("GET", "/s/it/plan.md", { userId: reader.id })).status).toBe(404);
    expect((await request("GET", "/s/it/plan.md", { userId: editor.id })).status).toBe(200);

    await request(
      "POST",
      `/api/v1/pages/${(await request("GET", "/api/v1/spaces/it/pages/by-path?path=laptop", { userId: editor.id })).body.id}/move`,
      {
        userId: editor.id,
        body: { parentPath: null, slug: "notebook" },
      },
    );
    const moved = await testApp().request("/s/it/laptop/setup.md", { headers: { "x-test-user": reader.id } });
    expect(moved.status).toBe(301);
    expect(moved.headers.get("cache-control")).toBe("no-store");
    expect(moved.headers.get("location")).toBe("/s/it/notebook/setup.md");

    const index = await request("GET", "/s/it.md", { userId: reader.id });
    expect(index.body).toContain("# IT");
    expect(index.body).toContain("- [Laptop](/s/it/notebook.md)\n  - [Setup](/s/it/notebook/setup.md)");
    expect(index.body).not.toContain("Plan");

    const agent = await createToken(reader.id);
    const llms = await request("GET", "/llms.txt", { token: agent });
    expect(llms.status).toBe(200);
    expect(llms.body).toContain("http://localhost:3000/mcp");
    expect(llms.body).toContain("[IT](http://localhost:3000/s/it.md)");

    // Paths without .md are the web app's.
    const html = await testApp().request("/s/it/notebook", {
      headers: { accept: "text/html", "x-test-user": reader.id },
    });
    expect([200, 503]).toContain(html.status);
    expect(html.headers.get("content-type")).toContain("text/");
  });

  it("stores uploads and serves images inline and other files as downloads", async () => {
    const reader = await createUser();
    await createSpace({ slug: "it" });
    const agent = await createToken(reader.id);
    const image = new FormData();
    image.append(
      "file",
      new File([new Uint8Array([137, 80, 78, 71])], "screen shot.png", { type: "image/png" }),
    );
    const uploaded = await request("POST", "/api/v1/spaces/it/files", { token: agent, form: image });
    expect(uploaded.status).toBe(201);
    expect(uploaded.body).toMatchObject({
      name: "screen shot.png",
      contentType: "image/png",
      size: 4,
      url: `/files/${uploaded.body.id}/screen%20shot.png`,
      markdown: `![screen shot.png](/files/${uploaded.body.id}/screen%20shot.png)`,
    });
    const shown = await testApp().request(uploaded.body.url, { headers: { "x-test-user": reader.id } });
    expect(shown.status).toBe(200);
    expect(shown.headers.get("content-type")).toBe("image/png");
    expect(shown.headers.get("content-disposition")).toContain("inline");
    expect(shown.headers.get("content-security-policy")).toBe("sandbox; default-src 'none'");
    expect(shown.headers.get("x-content-type-options")).toBe("nosniff");
    expect(new Uint8Array(await shown.arrayBuffer())).toEqual(new Uint8Array([137, 80, 78, 71]));

    const svg = new FormData();
    svg.append("file", new File(["<svg onload='alert(1)'/>"], "logo.svg", { type: "image/svg+xml" }));
    const svgUpload = await request("POST", "/api/v1/spaces/it/files", { userId: reader.id, form: svg });
    const download = await testApp().request(svgUpload.body.url, { headers: { "x-test-user": reader.id } });
    expect(download.headers.get("content-type")).toBe("application/octet-stream");
    expect(download.headers.get("content-disposition")).toContain("attachment");
    expect((await testApp().request(svgUpload.body.url)).status).toBe(401);

    const empty = new FormData();
    empty.append("file", new File([], "empty.txt"));
    expect(
      (await request("POST", "/api/v1/spaces/it/files", { userId: reader.id, form: empty })).status,
    ).toBe(400);
    const { secret: service } = await issueCredential(getDb(), {
      kind: "service",
      name: "Bot",
      userId: null,
      expiresAt: null,
    });
    expect((await request("POST", "/api/v1/spaces/it/files", { token: service, form: image })).status).toBe(
      403,
    );

    // Unused uploads older than a day are removed; used ones stay.
    const space = await createSpace({ slug: "hr" });
    await createPage(space, { title: "Uses image", body: `${uploaded.body.markdown}\n` });
    await getDb()
      .update(files)
      .set({ createdAt: sql`now() - interval '2 days'` });
    expect(await pruneUnusedUploads(getDb())).toBe(1);
    expect((await getDb().select().from(files)).map((row) => row.name)).toEqual(["screen shot.png"]);
  });
});
