import { beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { HIGHLIGHT_END, HIGHLIGHT_START, searchQuerySchema } from "@handbook/shared/api/search";
import { getDb } from "../db/client";
import { issueCredential } from "../auth/credentials";
import { searchPages } from "../search/query";
import { getSpace } from "../spaces/access";
import { createPage, createSpace, createUser, request, resetDatabase } from "../test/helpers";
import { resolveSession } from "../test/resolve-mock";

vi.mock("../auth/resolve", () => import("../test/resolve-mock"));

const file = (title: string, body: string, extra = "") => `---\ntitle: ${title}\n${extra}---\n\n${body}`;

describe("search API", () => {
  beforeEach(resetDatabase);

  async function setup() {
    const editor = await createUser();
    const reader = await createUser();
    const it = await createSpace({ slug: "it", name: "IT", members: { [editor.id]: "editor" } });
    const hr = await createSpace({ slug: "hr", name: "People" });
    await createPage(it, {
      title: "Laptop setup",
      markdown: file(
        "Laptop setup",
        "Intro.\n\n## Disk encryption\n\nTurn on FileVault before you store anything.\n\n## Printers\n\nAdd the office printer.\n",
        "tags:\n  - hardware\nsearch_terms:\n  - Rechner einrichten\n",
      ),
    });
    await createPage(it, {
      title: "VPN",
      markdown: file("VPN", "Der Zugang zum Netzwerk von unterwegs.\n", "type: \n"),
    });
    await createPage(hr, {
      title: "Holidays",
      markdown: file("Holidays", "Ask your lead.\n", "tags: [time-off]\n"),
    });
    await createPage(it, {
      title: "Draft budget",
      markdown: file("Draft budget", "Laptops for everyone.\n", "status: draft\n"),
    });
    return { editor, reader };
  }

  it("finds the best section with a highlighted snippet and the page URL", async () => {
    const { reader } = await setup();
    const result = await request("GET", "/api/v1/search?q=FileVault", { userId: reader.id });
    expect(result.status).toBe(200);
    const [first] = result.body.results;
    expect(first).toMatchObject({
      title: "Laptop setup",
      space: { slug: "it", name: "IT" },
      headingPath: ["Disk encryption"],
      anchor: "disk-encryption",
      url: "http://localhost:3000/s/it/laptop-setup#disk-encryption",
    });
    expect(first.snippet).toContain(`${HIGHLIGHT_START}FileVault${HIGHLIGHT_END}`);
  });

  it("matches word forms in English and German, search terms, and typos in titles", async () => {
    const { reader } = await setup();
    const plural = await request("GET", "/api/v1/search?q=laptops", { userId: reader.id });
    expect(plural.body.results.map((result: { title: string }) => result.title)).toEqual(["Laptop setup"]);
    const german = await request("GET", "/api/v1/search?q=Netzwerks", { userId: reader.id });
    expect(german.body.results[0]?.title).toBe("VPN");
    const terms = await request("GET", "/api/v1/search?q=Rechner", { userId: reader.id });
    expect(terms.body.results[0]?.title).toBe("Laptop setup");
    const typo = await request("GET", "/api/v1/search?q=Holidyas", { userId: reader.id });
    expect(typo.body.results[0]?.title).toBe("Holidays");
  });

  it("finds typos with the trigram threshold of the search, not the server's", async () => {
    const { reader } = await setup();
    const principal = (await resolveSession(getDb(), new Headers({ "x-test-user": reader.id })))!;
    const results = await getDb().transaction(async (tx) => {
      // A stricter threshold for the session: the search sets its own.
      await tx.execute(sql`set local pg_trgm.similarity_threshold = 0.9`);
      return searchPages(tx, principal, searchQuerySchema.parse({ q: "Holidyas" }));
    });
    expect(results.map((result) => result.title)).toEqual(["Holidays"]);
    expect(results[0]).toMatchObject({ anchor: null, snippet: "Ask your lead." });
  });

  it("ranks pages by their own fields and their best section", async () => {
    const { reader } = await setup();
    const it = await getSpace(getDb(), "it");
    await createPage(it, {
      title: "Printers",
      markdown: file(
        "Printers",
        "Intro.\n\n## Paper\n\nLoad paper.\n\n## Office printer\n\nThe office printer is on floor 2.\n",
      ),
    });
    const result = await request("GET", "/api/v1/search?q=printer", { userId: reader.id });
    expect(
      result.body.results.map((item: { title: string; anchor: string | null }) => [item.title, item.anchor]),
    ).toEqual([
      ["Printers", "office-printer"],
      ["Laptop setup", "printers"],
    ]);
  });

  it("filters by space and tag, and shows drafts only to editors", async () => {
    const { reader, editor } = await setup();
    const inHr = await request("GET", "/api/v1/search?q=lead&space=hr", { userId: reader.id });
    expect(inHr.body.results).toHaveLength(1);
    const notInIt = await request("GET", "/api/v1/search?q=lead&space=it", { userId: reader.id });
    expect(notInIt.body.results).toHaveLength(0);
    const tagged = await request("GET", "/api/v1/search?q=laptop&tag=Hardware", { userId: reader.id });
    expect(tagged.body.results).toHaveLength(1);
    const forReader = await request("GET", "/api/v1/search?q=budget", { userId: reader.id });
    expect(forReader.body.results).toHaveLength(0);
    const forEditor = await request("GET", "/api/v1/search?q=budget", { userId: editor.id });
    expect(forEditor.body.results[0]?.title).toBe("Draft budget");
    const { secret } = await issueCredential(getDb(), {
      kind: "service",
      name: "Bot",
      userId: null,
      expiresAt: null,
    });
    const service = await request("GET", "/api/v1/search?q=budget", { token: secret });
    expect(service.body.results).toHaveLength(0);
    expect((await request("GET", "/api/v1/search?q=", { userId: reader.id })).status).toBe(422);
  });

  it("lists the pages of a tag with a percent sign", async () => {
    const { reader } = await setup();
    await createPage(await getSpace(getDb(), "it"), {
      title: "Remote work",
      markdown: file("Remote work", "Yes.\n", "tags: ['100%']\n"),
    });
    const tagged = await request("GET", `/api/v1/tags/${encodeURIComponent("100%")}/pages`, {
      userId: reader.id,
    });
    expect(tagged.status).toBe(200);
    expect(tagged.body.items.map((item: { title: string }) => item.title)).toEqual(["Remote work"]);
  });

  it("lists tags, pages of a tag and recent changes", async () => {
    const { reader, editor } = await setup();
    const tags = await request("GET", "/api/v1/tags", { userId: reader.id });
    expect(tags.body.items).toEqual([
      { tag: "hardware", count: 1 },
      { tag: "time-off", count: 1 },
    ]);
    const tagged = await request("GET", "/api/v1/tags/hardware/pages", { userId: reader.id });
    expect(tagged.body.items.map((page: { title: string }) => page.title)).toEqual(["Laptop setup"]);
    const recent = await request("GET", "/api/v1/recent?space=it", { userId: reader.id });
    expect(recent.body.items.map((item: { page: { title: string } }) => item.page.title).sort()).toEqual([
      "Laptop setup",
      "VPN",
    ]);
    const editorRecent = await request("GET", "/api/v1/recent", { userId: editor.id });
    expect(editorRecent.body.items).toHaveLength(4);
    expect(editorRecent.body.items[0].revision.number).toBe(1);
  });

  it("never shows drafts of a space to editors of another space", async () => {
    const { editor } = await setup();
    const hrEditor = await createUser();
    const it = await createSpace({ slug: "finance", members: { [editor.id]: "editor" } });
    await createSpace({ slug: "legal", members: { [hrEditor.id]: "editor" } });
    await createPage(it, {
      title: "Secret plan",
      markdown: file("Secret plan", "Not yet.\n", "status: draft\ntags: [secret-plan]\n"),
    });
    const tags = await request("GET", "/api/v1/tags", { userId: hrEditor.id });
    expect(tags.body.items.map((item: { tag: string }) => item.tag)).not.toContain("secret-plan");
    const tagged = await request("GET", "/api/v1/tags/secret-plan/pages", { userId: hrEditor.id });
    expect(tagged.body.items).toEqual([]);
    const own = await request("GET", "/api/v1/tags/secret-plan/pages", { userId: editor.id });
    expect(own.body.items).toHaveLength(1);
  });
});
