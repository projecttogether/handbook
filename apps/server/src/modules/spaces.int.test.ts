import { beforeEach, describe, expect, it, vi } from "vitest";
import { rm } from "node:fs/promises";
import path from "node:path";
import { strFromU8, strToU8, unzipSync } from "fflate";
import { eq } from "drizzle-orm";
import { config } from "../config";
import { getDb } from "../db/client";
import { auditLog, spaces, users } from "../db/schema";
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

describe("spaces API", () => {
  beforeEach(resetDatabase);

  it("creates spaces (admins), lists them with roles and hides archived ones", async () => {
    const admin = await createUser({ isAdmin: true });
    const reader = await createUser();
    expect(
      (await request("POST", "/api/v1/spaces", { userId: reader.id, body: { slug: "it", name: "IT" } }))
        .status,
    ).toBe(403);
    const agent = await createToken(admin.id);
    expect(
      (await request("POST", "/api/v1/spaces", { token: agent, body: { slug: "it", name: "IT" } })).status,
    ).toBe(403);
    const created = await request("POST", "/api/v1/spaces", {
      userId: admin.id,
      body: { slug: "it", name: "IT", description: "Devices and accounts" },
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      slug: "it",
      pageCount: 0,
      openChangeSets: 0,
      abilities: { manage: true },
      properties: [],
    });
    // Without a template: the default page types, no pages.
    expect(created.body.pageTypes.map((pageType: { key: string }) => pageType.key)).toEqual([
      "overview",
      "how-to",
      "policy",
      "reference",
    ]);
    expect(
      (await request("POST", "/api/v1/spaces", { userId: admin.id, body: { slug: "it", name: "Again" } }))
        .status,
    ).toBe(409);
    expect(
      (await request("POST", "/api/v1/spaces", { userId: admin.id, body: { slug: "Not valid", name: "X" } }))
        .status,
    ).toBe(422);

    const list = await request("GET", "/api/v1/spaces", { userId: reader.id });
    expect(list.body.items).toMatchObject([{ slug: "it", myRole: null, archived: false }]);
    await request("POST", "/api/v1/spaces/it/archive", { userId: admin.id });
    expect((await request("GET", "/api/v1/spaces", { userId: reader.id })).body.items).toHaveLength(0);
    const withArchived = await request("GET", "/api/v1/spaces?archived=include", { userId: admin.id });
    expect(withArchived.body.items[0].archived).toBe(true);
    const archived = await request("GET", "/api/v1/spaces/it", { userId: admin.id });
    expect(archived.body.abilities.editLive).toBe(false);
    await request("POST", "/api/v1/spaces/it/unarchive", { userId: admin.id });
    const [row] = await getDb().select().from(spaces).where(eq(spaces.slug, "it"));
    await createPage(row!, { title: "Laptop" });
    await createPage(row!, { title: "VPN" });
    const counted = await request("GET", "/api/v1/spaces", { userId: reader.id });
    expect(counted.body.items[0].pageCount).toBe(2);
    expect((await request("GET", "/api/v1/spaces/it", { userId: reader.id })).body.pageCount).toBe(2);
    const actions = await getDb().select({ action: auditLog.action }).from(auditLog);
    expect(actions.map((row) => row.action)).toEqual(["space.created", "space.archived", "space.unarchived"]);
  });

  it("creates a space from a template with its page types, properties and starter pages", async () => {
    const admin = await createUser({ isAdmin: true });
    expect(
      (
        await request("POST", "/api/v1/spaces", {
          userId: admin.id,
          body: { slug: "it", name: "IT", template: "intranet" },
        })
      ).status,
    ).toBe(422);
    const created = await request("POST", "/api/v1/spaces", {
      userId: admin.id,
      body: { slug: "it", name: "IT", template: "it" },
    });
    expect(created.status).toBe(201);
    expect(created.body.pageTypes.map((pageType: { key: string }) => pageType.key)).toEqual([
      "overview",
      "how-to",
      "policy",
      "reference",
      "tool",
      "troubleshooting",
    ]);
    expect(created.body.properties.map((property: { key: string }) => property.key)).toEqual([
      "systems",
      "audience",
    ]);
    expect(created.body.pageCount).toBe(6);

    const tree = await request("GET", "/api/v1/spaces/it/tree", { userId: admin.id });
    expect(tree.body.items.map((page: { path: string }) => page.path)).toEqual([
      "software",
      "how-to-guides",
      "onboarding-and-offboarding",
      "help",
      "policies",
      "it-team",
    ]);
    const file = await request("GET", "/s/it/software.md", { userId: admin.id });
    expect(file.body).toContain(
      "title: Software\ndescription: The apps and systems we use.\ntype: overview\n",
    );

    // A policy needs an owner and a review date.
    const policy = await request("POST", "/api/v1/spaces/it/pages", {
      userId: admin.id,
      body: {
        parentPath: "policies",
        markdown: "---\ntitle: Passwords\ntype: policy\n---\n\nUse a password manager.\n",
      },
    });
    expect(policy.status).toBe(422);
    expect(policy.body.error.fields).toMatchObject({
      "properties.owner": "Pages of type “Policy” need “Owner”",
      "properties.reviewed": "Pages of type “Policy” need “Last reviewed”",
    });
  });

  it("lets owners choose editors and only admins choose owners", async () => {
    const admin = await createUser({ isAdmin: true });
    const owner = await createUser();
    const editor = await createUser();
    const space = await createSpace({ slug: "it", members: { [owner.id]: "owner", [editor.id]: "editor" } });
    const add = await request("PUT", "/api/v1/spaces/it/members", {
      userId: owner.id,
      body: { email: "New.Person@Example.org", role: "editor" },
    });
    expect(add.status).toBe(200);
    expect(add.body.items).toContainEqual(
      expect.objectContaining({ email: "new.person@example.org", role: "editor", signedIn: false }),
    );
    const [created] = await getDb().select().from(users).where(eq(users.email, "new.person@example.org"));
    expect(created).toBeDefined();
    expect(
      (
        await request("PUT", "/api/v1/spaces/it/members", {
          userId: owner.id,
          body: { email: "x@example.org", role: "owner" },
        })
      ).status,
    ).toBe(403);
    expect(
      (await request("DELETE", `/api/v1/spaces/it/members/${owner.id}`, { userId: owner.id })).status,
    ).toBe(403);
    expect(
      (
        await request("PUT", "/api/v1/spaces/it/members", {
          userId: editor.id,
          body: { email: "y@example.org", role: "editor" },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await request("PUT", "/api/v1/spaces/it/members", {
          userId: admin.id,
          body: { email: "x@example.org", role: "owner" },
        })
      ).status,
    ).toBe(200);
    const removed = await request("DELETE", `/api/v1/spaces/it/members/${created!.id}`, { userId: owner.id });
    expect(removed.body.items.map((member: { email: string }) => member.email)).not.toContain(
      "new.person@example.org",
    );
    const me = await request("GET", "/api/v1/me", { userId: editor.id });
    expect(me.body.spaces).toEqual([{ slug: space.slug, role: "editor" }]);
  });

  it("changes properties only when every page still fits", async () => {
    const owner = await createUser();
    const space = await createSpace({ slug: "it", members: { [owner.id]: "owner" } });
    const properties = [
      { key: "team", label: "Team", type: "select", options: ["it", "hr"], required: false, help: "" },
    ];
    const set = await request("PATCH", "/api/v1/spaces/it", {
      userId: owner.id,
      body: { properties, pageTypes: [{ key: "workflow", label: "Workflow", requiredProperties: ["team"] }] },
    });
    expect(set.status).toBe(200);
    expect(set.body.pageTypes[0]).toMatchObject({ key: "workflow", template: "" });
    await createPage(
      { ...space, properties: set.body.properties, pageTypes: set.body.pageTypes },
      { title: "Backup", markdown: "---\ntitle: Backup\nteam: hr\n---\n" },
    );
    const narrower = await request("PATCH", "/api/v1/spaces/it", {
      userId: owner.id,
      body: { properties: [{ ...properties[0], options: ["it"] }] },
    });
    expect(narrower.status).toBe(422);
    expect(narrower.body.error.message).toContain("Backup");
    const broken = await request("PATCH", "/api/v1/spaces/it", {
      userId: owner.id,
      body: {
        properties: [],
        pageTypes: [{ key: "workflow", label: "Workflow", requiredProperties: ["team"] }],
      },
    });
    expect(broken.status).toBe(422);
    const renamed = await request("PATCH", "/api/v1/spaces/it", { userId: owner.id, body: { name: "Tech" } });
    expect(renamed.body.name).toBe("Tech");
  });

  it("exports the space with the uploads its pages use", async () => {
    const editor = await createUser();
    const space = await createSpace({ slug: "it", members: { [editor.id]: "editor" } });
    const upload = async (name: string, type: string, content: Uint8Array) => {
      const form = new FormData();
      form.append("file", new File([content.slice()], name, { type }));
      const response = await request("POST", "/api/v1/spaces/it/files", { userId: editor.id, form });
      expect(response.status).toBe(201);
      return response.body as { id: string; url: string; markdown: string };
    };
    // Bytes that do not survive a text round trip, and a name with a space.
    const pngBytes = Uint8Array.from({ length: 300_000 }, (_, index) => (index * 7919) % 256);
    const image = await upload("vpn screen.png", "image/png", pngBytes);
    const pdf = await upload("guide.pdf", "application/pdf", strToU8("%PDF-1.7 guide"));
    await upload("unused.png", "image/png", strToU8("not used"));
    await createPage(space, { title: "Existing", body: "Old text.\n" });
    await createPage(space, { title: "VPN", slug: "vpn", body: `${image.markdown}\n\n${pdf.markdown}\n` });
    await createPage(space, {
      title: "Draft",
      slug: "draft",
      markdown: `---\ntitle: Draft\nstatus: draft\n---\n\n${pdf.markdown}\n`,
    });

    const reader = await createUser();
    const response = await testApp().request("/api/v1/spaces/it/export", {
      headers: { "x-test-user": reader.id },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/zip");
    const exported = unzipSync(new Uint8Array(await response.arrayBuffer()));
    expect(Object.keys(exported).sort()).toEqual(
      [
        "_space.yaml",
        "existing.md",
        `files/${image.id}/vpn screen.png`,
        `files/${pdf.id}/guide.pdf`,
        "vpn.md",
      ].sort(),
    );
    expect(strFromU8(exported["existing.md"]!)).toBe("---\ntitle: Existing\n---\n\nOld text.\n");
    // Pages link to /files/<id>/<name>: from the zip's folder, the file is there.
    expect(strFromU8(exported["vpn.md"]!)).toContain(`(/files/${image.id}/vpn%20screen.png)`);
    expect(exported[`files/${image.id}/vpn screen.png`]).toEqual(pngBytes);
    expect(strFromU8(exported[`files/${pdf.id}/guide.pdf`]!)).toBe("%PDF-1.7 guide");
    expect(strFromU8(exported["_space.yaml"]!)).toContain("pageTypes:");

    // Editors get drafts, and uploads only drafts use.
    const asEditor = await testApp().request("/api/v1/spaces/it/export", {
      headers: { "x-test-user": editor.id },
    });
    const withDrafts = unzipSync(new Uint8Array(await asEditor.arrayBuffer()));
    expect(Object.keys(withDrafts)).toContain("draft.md");

    // An upload missing on disk is left out; the rest still exports.
    await rm(path.join(config().FILES_DIR, image.id.slice(0, 2), image.id), { force: true });
    const again = await testApp().request("/api/v1/spaces/it/export", {
      headers: { "x-test-user": reader.id },
    });
    const partial = unzipSync(new Uint8Array(await again.arrayBuffer()));
    expect(Object.keys(partial).sort()).toEqual([
      "_space.yaml",
      "existing.md",
      `files/${pdf.id}/guide.pdf`,
      "vpn.md",
    ]);
  });
});
