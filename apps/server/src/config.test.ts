import { afterEach, describe, expect, it } from "vitest";
import { config, resetConfigForTests } from "./config";

const original = { ...process.env };

function configWith(values: Record<string, string>) {
  Object.assign(process.env, values);
  resetConfigForTests();
  return () => config();
}

describe("config", () => {
  afterEach(() => {
    process.env = { ...original };
    resetConfigForTests();
  });

  it("refuses the example AUTH_SECRET when the app is in use (https or production)", () => {
    const example = "development-secret-development-secret";
    expect(configWith({ AUTH_SECRET: example, NODE_ENV: "development" })).not.toThrow();
    // A copied .env.example: NODE_ENV=development, but a public https address.
    expect(
      configWith({ AUTH_SECRET: example, NODE_ENV: "development", APP_URL: "https://handbook.example.org" }),
    ).toThrow(/AUTH_SECRET: Replace the example value/);
    expect(
      configWith({ AUTH_SECRET: example, NODE_ENV: "production", APP_URL: "http://localhost:3000" }),
    ).toThrow(/AUTH_SECRET/);
    expect(configWith({ AUTH_SECRET: "change-me-to-a-long-random-value" })).toThrow(/AUTH_SECRET/);
    expect(configWith({ AUTH_SECRET: "a-real-secret-a-real-secret-a-real-secret" })).not.toThrow();
  });

  it("allows private client URLs only in development", () => {
    expect(configWith({ OAUTH_ALLOW_PRIVATE_CLIENT_URLS: "true" })).not.toThrow();
    expect(
      configWith({
        OAUTH_ALLOW_PRIVATE_CLIENT_URLS: "true",
        NODE_ENV: "development",
        APP_URL: "https://handbook.example.org",
      }),
    ).toThrow(/OAUTH_ALLOW_PRIVATE_CLIENT_URLS/);
  });

  it("has no version in a build from source", () => {
    delete process.env.APP_VERSION;
    expect(configWith({})().APP_VERSION).toBeUndefined();
    expect(configWith({ APP_VERSION: "" })().APP_VERSION).toBeUndefined();
  });

  it("reads the version the Deploy workflow builds in", () => {
    expect(configWith({ APP_VERSION: "0123456789ab" })().APP_VERSION).toBe("0123456789ab");
  });

  it("reads the session and agent limits", () => {
    const defaults = configWith({})();
    expect(defaults).toMatchObject({
      SESSION_DAYS: 7,
      AGENT_SIGN_IN_DAYS: 30,
      OIDC_REQUIRE_EMAIL_VERIFIED: true,
    });
    expect(configWith({ SESSION_DAYS: "14", AGENT_SIGN_IN_DAYS: "7" })).toThrow(
      /AGENT_SIGN_IN_DAYS: Use 0 or at least SESSION_DAYS/,
    );
    expect(configWith({ SESSION_DAYS: "14", AGENT_SIGN_IN_DAYS: "0" })).not.toThrow();
    expect(configWith({ OIDC_REQUIRE_EMAIL_VERIFIED: "false" })().OIDC_REQUIRE_EMAIL_VERIFIED).toBe(false);
  });
});
