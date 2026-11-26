import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetConfigForTests } from "../config";
import { createToken, createUser, request, resetDatabase } from "../test/helpers";

vi.mock("../auth/resolve", () => import("../test/resolve-mock"));

beforeEach(async () => {
  await resetDatabase();
});

afterEach(() => {
  delete process.env.APP_VERSION;
  resetConfigForTests();
});

describe("GET /api/v1/about", () => {
  it("shows admins the version that runs", async () => {
    const admin = await createUser({ isAdmin: true });
    process.env.APP_VERSION = "0123456789ab";
    resetConfigForTests();
    const response = await request("GET", "/api/v1/about", { userId: admin.id });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ version: "0123456789ab" });
  });

  it("has no version for a build from source", async () => {
    const admin = await createUser({ isAdmin: true });
    const response = await request("GET", "/api/v1/about", { userId: admin.id });
    expect(response.body).toEqual({ version: null });
  });

  it("is for admins in the web app only", async () => {
    const admin = await createUser({ isAdmin: true });
    const person = await createUser();
    expect((await request("GET", "/api/v1/about", { userId: person.id })).status).toBe(403);
    expect((await request("GET", "/api/v1/about", { token: await createToken(admin.id) })).status).toBe(403);
    expect((await request("GET", "/api/v1/about")).status).toBe(401);
  });
});
