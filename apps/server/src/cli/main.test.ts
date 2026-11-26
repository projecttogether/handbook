import { afterEach, describe, expect, it, vi } from "vitest";
import { DrizzleQueryError } from "drizzle-orm";
import pg from "pg";
import * as serviceTokens from "../auth/service-tokens";
import { runCli } from "./main";

vi.mock("../auth/service-tokens");

const SECRET = "kn_svc_query-parameter-3e8a";

async function list() {
  let stdout = "";
  let stderr = "";
  const code = await runCli(["tokens", "list"], {
    out: (text) => void (stdout += text),
    err: (text) => void (stderr += text),
  });
  return { code, stdout, stderr };
}

const failsWith = (error: unknown) => vi.mocked(serviceTokens.listServiceTokens).mockRejectedValue(error);

afterEach(() => vi.resetAllMocks());

describe("an error that is no refusal", () => {
  it("prints the page's generic message with its code, never its text", async () => {
    const cause = Object.assign(new pg.DatabaseError(`value "${SECRET}" is too long`, 0, "error"), {
      code: "22001",
    });
    failsWith(new DrizzleQueryError("update credentials set name = $1", [SECRET], cause));
    expect(await list()).toEqual({
      code: 1,
      stdout: "",
      stderr: "Something went wrong. Try again. (22001)\n",
    });

    failsWith(Object.assign(new Error(`connect ECONNREFUSED ${SECRET}`), { code: "ECONNREFUSED" }));
    expect((await list()).stderr).toBe("Something went wrong. Try again. (ECONNREFUSED)\n");

    failsWith(new TypeError(`Invalid value "${SECRET}"`));
    expect((await list()).stderr).toBe("Something went wrong. Try again.\n");

    failsWith(Object.assign(new Error("odd code"), { code: `with ${SECRET}` }));
    expect((await list()).stderr).toBe("Something went wrong. Try again.\n");
  });
});
