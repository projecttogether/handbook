import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resetConfigForTests } from "../config";
import { compression } from "./compression";
import type { AppEnv } from "./env";
import { webApp } from "./static";

const text = "Every page of the handbook. ".repeat(200);
const gzip = { "accept-encoding": "gzip, deflate, br, zstd" };

describe("compression", () => {
  const app = new Hono();
  app.use("*", compression());
  app.get("/api/v1/pages", (c) => c.json({ text }));
  app.get("/s/it.md", (c) => c.text(text));
  app.get("/files/:id/:name", (c) => c.text(text));
  app.post("/mcp", (c) => c.body(`data: ${text}\n\n`, 200, { "content-type": "text/event-stream" }));
  app.get("/events", (c) => c.body(`data: ${text}\n\n`, 200, { "content-type": "text/event-stream" }));
  app.get("/zip", (c) => c.body(new Uint8Array(4096), 200, { "content-type": "application/zip" }));

  it("gzips JSON and text for clients that accept it", async () => {
    for (const url of ["/api/v1/pages", "/s/it.md"]) {
      const response = await app.request(url, { headers: gzip });
      expect(response.headers.get("content-encoding")).toBe("gzip");
      expect(response.headers.get("vary")).toBe("Accept-Encoding");
      expect(gunzipSync(Buffer.from(await response.arrayBuffer())).toString()).toContain(text);
    }
    const plain = await app.request("/api/v1/pages");
    expect(plain.headers.get("content-encoding")).toBeNull();
    expect(await plain.json()).toEqual({ text });
  });

  it("leaves MCP, uploaded files, event streams and binary data alone", async () => {
    for (const [method, url] of [
      ["POST", "/mcp"],
      ["GET", "/files/1/notes.txt"],
      ["GET", "/events"],
      ["GET", "/zip"],
    ] as const) {
      const response = await app.request(url, { method, headers: gzip });
      expect(response.headers.get("content-encoding"), url).toBeNull();
    }
  });
});

describe("web app assets", () => {
  let root: string;
  let app: Hono<AppEnv>;

  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "handbook-web-"));
    await mkdir(path.join(root, "assets"));
    await writeFile(path.join(root, "assets/index-abc.js"), "plain");
    await writeFile(path.join(root, "assets/index-abc.js.br"), "brotli");
    await writeFile(path.join(root, "assets/index-abc.js.gz"), "gzip");
    process.env.WEB_DIST_DIR = root;
    resetConfigForTests();
    app = webApp();
  });

  afterAll(async () => {
    delete process.env.WEB_DIST_DIR;
    resetConfigForTests();
    await rm(root, { recursive: true, force: true });
  });

  it("serves the compressed copies from the build", async () => {
    const brotli = await app.request("/assets/index-abc.js", { headers: gzip });
    expect(brotli.headers.get("content-encoding")).toBe("br");
    expect(brotli.headers.get("content-type")).toMatch(/^text\/javascript/);
    expect(brotli.headers.get("vary")).toBe("Accept-Encoding");
    expect(await brotli.text()).toBe("brotli");

    const gzipOnly = await app.request("/assets/index-abc.js", { headers: { "accept-encoding": "gzip" } });
    expect(gzipOnly.headers.get("content-encoding")).toBe("gzip");
    expect(await gzipOnly.text()).toBe("gzip");

    const plain = await app.request("/assets/index-abc.js");
    expect(plain.headers.get("content-encoding")).toBeNull();
    expect(await plain.text()).toBe("plain");
  });
});
