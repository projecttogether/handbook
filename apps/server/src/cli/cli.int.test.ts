import { spawn } from "node:child_process";
import path from "node:path";
import { asc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hashToken } from "../auth/credentials";
import { getDb } from "../db/client";
import { auditLog, credentials } from "../db/schema";
import { logger } from "../logger";
import { SERVER_ROOT } from "../paths";
import { createSpace, createToken, createUser, request, resetDatabase } from "../test/helpers";
import { runCli } from "./main";

vi.mock("../auth/resolve", () => import("../test/resolve-mock"));

const UNKNOWN_ID = "00000000-0000-4000-8000-000000000000";
/** A secret typed in the wrong place. */
const TYPED_SECRET = "kn_svc_typed-by-mistake-41c7";

/** The secrets of this test: no message, list or log line may hold one. */
let secrets: string[];
/** Everything the command printed except new tokens, and every log call. */
let printed: string[];

async function cli(...args: string[]) {
  let stdout = "";
  let stderr = "";
  const code = await runCli(args, {
    out: (text) => void (stdout += text),
    err: (text) => void (stderr += text),
  });
  printed.push(stderr);
  if (args[1] !== "create") printed.push(stdout);
  return { code, stdout, stderr };
}

/** A new token: stdout holds the token and nothing else. */
async function createServiceToken(...options: string[]) {
  const created = await cli("tokens", "create", "service", ...options);
  expect(created.code).toBe(0);
  expect(created.stdout).toMatch(/^kn_svc_[\w-]{43}\n$/);
  const secret = created.stdout.trim();
  secrets.push(secret);
  const id = /ID: ([0-9a-f-]{36})/.exec(created.stderr)![1]!;
  return { id, secret, stderr: created.stderr };
}

const storedTokens = () => getDb().select().from(credentials).orderBy(asc(credentials.createdAt));
const auditEntries = () => getDb().select().from(auditLog).orderBy(asc(auditLog.createdAt));

beforeEach(async () => {
  await resetDatabase();
  secrets = [TYPED_SECRET];
  printed = [];
  for (const level of ["trace", "debug", "info", "warn", "error", "fatal"] as const) {
    vi.spyOn(logger, level).mockImplementation((...args: unknown[]) => {
      printed.push(JSON.stringify(args));
    });
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const secret of secrets) for (const text of printed) expect(text).not.toContain(secret);
});

describe("cli tokens create service", () => {
  it("issues a token that only reads, as the operator", async () => {
    await createSpace({ slug: "it" });
    const { id, secret, stderr } = await createServiceToken("--name", "Connector");
    const [stored] = await storedTokens();
    expect(stored).toMatchObject({
      id,
      kind: "service",
      name: "Connector",
      tokenHash: hashToken(secret),
      userId: null,
      createdById: null,
    });
    expect(JSON.stringify(stored)).not.toContain(secret);
    // The page's default: 90 days.
    const days = (stored!.expiresAt!.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(89.9);
    expect(days).toBeLessThanOrEqual(90);
    expect(stderr).toBe(`Created. ID: ${id}, expires: ${stored!.expiresAt!.toISOString().slice(0, 10)}\n`);
    expect(await auditEntries()).toMatchObject([
      {
        actorUserId: null,
        actorEmail: "operator",
        action: "service_token.create",
        entityType: "service_token",
        entityId: id,
        summary: "Created the service token “Connector” (cli tokens create service)",
      },
    ]);

    expect((await request("GET", "/api/v1/spaces", { token: secret })).status).toBe(200);
    expect(
      (await request("POST", "/api/v1/change-sets", { token: secret, body: { space: "it", title: "x" } }))
        .status,
    ).toBe(403);
    expect((await request("GET", "/api/v1/admin/service-tokens", { token: secret })).status).toBe(403);
    expect(
      (await request("POST", "/api/v1/admin/service-tokens", { token: secret, body: { name: "Bot" } }))
        .status,
    ).toBe(403);
  });

  it("takes an expiry in days or never", async () => {
    await createServiceToken("--name", "Month", "--expires-in-days", "30");
    const never = await createServiceToken("--name=Never", "--expires-in-days=never");
    expect(never.stderr).toContain("expires: never\n");
    const [month, forever] = await storedTokens();
    expect(Math.round((month!.expiresAt!.getTime() - Date.now()) / 86_400_000)).toBe(30);
    expect(forever).toMatchObject({ name: "Never", expiresAt: null });
  });

  it("refuses what the page refuses, with its messages", async () => {
    const admin = await createUser({ isAdmin: true });
    for (const [args, body] of [
      [["--name", "  "], { name: "  " }],
      [["--name", "x".repeat(81)], { name: "x".repeat(81) }],
      [["--name", "Bot", "--expires-in-days", "0"], { name: "Bot", expiresInDays: 0 }],
      [["--name", "Bot", "--expires-in-days", "3651"], { name: "Bot", expiresInDays: 3651 }],
    ] as const) {
      const page = await request("POST", "/api/v1/admin/service-tokens", { userId: admin.id, body });
      expect(page.status).toBe(422);
      const [field, message] = Object.entries(page.body.error.fields as Record<string, string>)[0]!;
      expect(await cli("tokens", "create", "service", ...args)).toEqual({
        code: 1,
        stdout: "",
        stderr: `${page.body.error.message}\n  ${field}: ${message}\n`,
      });
    }
    expect(await storedTokens()).toEqual([]);
    expect(await auditEntries()).toEqual([]);
  });
});

describe("cli tokens list", () => {
  it("lists the tokens as the page does, without their secrets", async () => {
    expect(await cli("tokens", "list")).toEqual({ code: 0, stdout: "No service tokens.\n", stderr: "" });
    const admin = await createUser({ isAdmin: true, email: "ada@example.org" });
    const page = await request("POST", "/api/v1/admin/service-tokens", {
      userId: admin.id,
      body: { name: "Support\nbot", expiresInDays: null },
    });
    expect(page.status).toBe(201);
    secrets.push(page.body.secret as string);
    const token = await createServiceToken("--name", "Connector");
    await getDb()
      .update(credentials)
      .set({ createdAt: new Date("2026-01-02T00:00:00Z") });
    await getDb()
      .update(credentials)
      .set({
        createdAt: new Date("2026-01-03T00:00:00Z"),
        expiresAt: new Date("2026-04-03T00:00:00Z"),
      })
      .where(eq(credentials.id, token.id));
    // Other kinds of credentials are no service tokens.
    secrets.push(await createToken(admin.id));

    const [first, second] = (await cli("tokens", "list")).stdout.trimEnd().split("\n");
    expect(first).toBe(
      `service ${token.id}  expired  "Connector"; ${token.secret.slice(0, 11)}…; created 2026-01-03 by Operator; last used never; expires 2026-04-03`,
    );
    expect(second).toBe(
      `service ${page.body.id}  active   "Support\\nbot"; ${page.body.prefix}; created 2026-01-02 by ada@example.org; last used never; expires never`,
    );
    const answer = await request("GET", "/api/v1/admin/service-tokens", { userId: admin.id });
    expect(answer.body.items).toMatchObject([{ createdBy: "Operator" }, { createdBy: "ada@example.org" }]);
    expect(JSON.parse((await cli("tokens", "list", "--json")).stdout)).toEqual(answer.body.items);
  });
});

describe("cli tokens revoke", () => {
  it("ends a service token for good, as the operator", async () => {
    const { id, secret } = await createServiceToken("--name", "Connector");
    expect(await cli("tokens", "revoke", id)).toEqual({ code: 0, stdout: "", stderr: "Revoked.\n" });
    expect((await request("GET", "/api/v1/spaces", { token: secret })).status).toBe(401);
    expect((await auditEntries())[1]).toMatchObject({
      actorUserId: null,
      actorEmail: "operator",
      action: "service_token.revoke",
      entityId: id,
      summary: "Revoked the service token “Connector” (cli tokens revoke)",
    });
    expect((await cli("tokens", "list")).stdout).toBe("No service tokens.\n");
    expect(await cli("tokens", "revoke", id)).toEqual({
      code: 1,
      stdout: "",
      stderr: "No such service token\n",
    });
  });

  it("does not touch other credentials", async () => {
    const ada = await createUser();
    secrets.push(await createToken(ada.id));
    const [personal] = await storedTokens();
    for (const id of [personal!.id, UNKNOWN_ID]) {
      expect(await cli("tokens", "revoke", id)).toEqual({
        code: 1,
        stdout: "",
        stderr: "No such service token\n",
      });
    }
    expect((await storedTokens())[0]!.revokedAt).toBeNull();
    expect(await auditEntries()).toEqual([]);
  });
});

describe("a wrong command", () => {
  it.each([
    [[]],
    [["settings", "list"]],
    [[TYPED_SECRET]],
    [["help", TYPED_SECRET]],
    [["tokens"]],
    [["tokens", TYPED_SECRET]],
    [["tokens", "create"]],
    [["tokens", "create", TYPED_SECRET, "--name", "Bot"]],
    [["tokens", "create", "service"]],
    [["tokens", "create", "service", "--name"]],
    [["tokens", "create", "service", "Bot"]],
    [["tokens", "create", "service", "--name", "Bot", TYPED_SECRET]],
    [["tokens", "create", "service", "--name", "Bot", `--token=${TYPED_SECRET}`]],
    [["tokens", "create", "service", "--name", "Bot", "--expires-in-days", TYPED_SECRET]],
    [["tokens", "list", TYPED_SECRET]],
    [["tokens", "list", `--json=${TYPED_SECRET}`]],
    [["tokens", "revoke"]],
    [["tokens", "revoke", TYPED_SECRET]],
    [["tokens", "revoke", UNKNOWN_ID, TYPED_SECRET]],
  ])("%j answers 2, changes nothing and repeats no argument", async (args) => {
    const answer = await cli(...args);
    expect(answer).toMatchObject({ code: 2, stdout: "" });
    expect(answer.stderr).toContain("cli help");
    expect(await storedTokens()).toEqual([]);
    expect(await auditEntries()).toEqual([]);
  });

  it("help lists the commands", async () => {
    expect((await cli("help")).stdout).toContain("cli tokens create service --name <name>");
  });
});

describe("the admin page", () => {
  it("still records the admin who creates and revokes a token", async () => {
    const admin = await createUser({ isAdmin: true, email: "ada@example.org" });
    const created = await request("POST", "/api/v1/admin/service-tokens", {
      userId: admin.id,
      body: { name: "Support bot", expiresInDays: null },
    });
    expect(created.body.createdBy).toBe("ada@example.org");
    await request("DELETE", `/api/v1/admin/service-tokens/${created.body.id}`, { userId: admin.id });
    expect(await auditEntries()).toMatchObject([
      {
        actorUserId: admin.id,
        actorEmail: "ada@example.org",
        summary: "Created the service token “Support bot”",
      },
      {
        actorUserId: admin.id,
        actorEmail: "ada@example.org",
        summary: "Revoked the service token “Support bot”",
      },
    ]);
  });
});

/** Runs the command in a process of its own, as the image does. */
function runProcess(args: string[], env: Record<string, string> = {}) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", path.join(SERVER_ROOT, "src/cli.ts"), ...args],
      { cwd: SERVER_ROOT, env: { ...process.env, LOG_LEVEL: "trace", ...env }, timeout: 20_000 },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

describe("the cli process", () => {
  it("prints only the token on stdout and exits", async () => {
    // It logs nothing, so a level that the app refuses does not matter.
    const created = await runProcess(["tokens", "create", "service", "--name", "Connector"], {
      LOG_LEVEL: "loud",
    });
    expect(created.code).toBe(0);
    expect(created.stdout).toMatch(/^kn_svc_[\w-]{43}\n$/);
    expect(created.stderr).toMatch(/^Created\. ID: [0-9a-f-]{36}, expires: \d{4}-\d{2}-\d{2}\n$/);
    expect((await storedTokens())[0]!.tokenHash).toBe(hashToken(created.stdout.trim()));
  });

  it("prints no error text when the database refuses the connection", async () => {
    // The whole output: no log line, no address, no password.
    expect(
      await runProcess(["tokens", "list"], {
        DATABASE_URL: "postgres://handbook:db-password-8c1d@127.0.0.1:1/handbook",
      }),
    ).toEqual({ code: 1, stdout: "", stderr: "Something went wrong. Try again. (ECONNREFUSED)\n" });
  });

  it("names invalid variables without their values", async () => {
    expect(await runProcess(["tokens", "list"], { ADMIN_EMAILS: `ada@example.org,${TYPED_SECRET}` })).toEqual(
      { code: 1, stdout: "", stderr: "Missing or invalid variables: ADMIN_EMAILS\n" },
    );
  });
});
