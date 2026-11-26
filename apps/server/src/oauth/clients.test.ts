import { describe, expect, it } from "vitest";
import { redirectTarget, redirectUriProblem } from "./clients";

describe("redirectUriProblem", () => {
  it("allows https, http on loopback and native apps' own schemes", () => {
    expect(redirectUriProblem("https://claude.ai/api/mcp/auth_callback")).toBeNull();
    expect(redirectUriProblem("http://localhost:8787/callback")).toBeNull();
    expect(redirectUriProblem("http://127.0.0.1/callback")).toBeNull();
    expect(redirectUriProblem("cursor://anysphere.cursor-mcp/oauth/callback")).toBeNull();
    expect(redirectUriProblem("com.example.app:/oauth")).toBeNull();
  });

  it("refuses http elsewhere, fragments and schemes that run in the browser", () => {
    expect(redirectUriProblem("http://client.example.org/callback")).not.toBeNull();
    expect(redirectUriProblem("https://client.example.org/callback#x")).not.toBeNull();
    expect(redirectUriProblem("javascript:alert(1)")).not.toBeNull();
    expect(redirectUriProblem("data:text/html,hi")).not.toBeNull();
    expect(redirectUriProblem("not a url")).not.toBeNull();
  });
});

describe("redirectTarget", () => {
  it("shows the host of https URIs and the scheme of everything else", () => {
    expect(redirectTarget("https://claude.ai/api/mcp/auth_callback")).toBe("claude.ai");
    expect(redirectTarget("http://127.0.0.1:8787/callback")).toBe("http://127.0.0.1:8787");
    // Another scheme cannot pass for a website.
    expect(redirectTarget("evil://claude.ai/callback")).toBe("evil://claude.ai");
    expect(redirectTarget("com.example.app:/oauth")).toBe("com.example.app:");
  });
});
