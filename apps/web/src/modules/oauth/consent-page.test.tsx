import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OauthRequest } from "@handbook/shared/api/tokens";
import { renderWithProviders } from "@/test-utils";
import { ConsentPage } from "./consent-page";

const REQUEST_ID = "0b5a3e5e-3c1f-4d8e-9f3a-444444444444";

const request: OauthRequest = {
  id: REQUEST_ID,
  clientName: "Claude",
  clientHost: "claude.ai",
  redirectHost: "claude.ai",
  registration: "metadata_document",
  expiresAt: "2026-11-17T10:10:00.000Z",
};

/** The value next to a label in the facts list ("Identified by", "Returns to"). */
function fact(label: string) {
  const term = screen.getByText(label, { selector: "dt" });
  return within(term.parentElement!).getByRole("definition");
}

type Reply = { status?: number; body?: unknown };

function routeFetch(routes: Record<string, Reply>) {
  const mock = vi.fn(async (url: string, init?: RequestInit) => {
    const reply = routes[`${init?.method ?? "GET"} ${url.split("?")[0]}`] ?? {
      status: 500,
      body: { error: { code: "internal_error", message: "No reply" } },
    };
    return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), {
      status: reply.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

afterEach(() => vi.unstubAllGlobals());

describe("consent page", () => {
  it("approves and returns to the app with its redirect", async () => {
    const redirectUrl = "https://claude.ai/api/mcp/auth_callback?code=abc&state=xyz";
    const fetch = routeFetch({
      "GET /api/v1/auth-config": { body: { appName: "Handbook", providerName: "Keycloak" } },
      [`GET /api/v1/oauth/requests/${REQUEST_ID}`]: { body: request },
      [`POST /api/v1/oauth/requests/${REQUEST_ID}/approve`]: { body: { redirectUrl } },
    });
    const onRedirect = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(<ConsentPage requestId={REQUEST_ID} onRedirect={onRedirect} />);

    expect(await screen.findByRole("heading", { name: "Connect Claude?" })).toBeInTheDocument();
    expect(fact("Identified by")).toHaveTextContent("claude.ai");
    expect(fact("Returns to")).toHaveTextContent("claude.ai");
    expect(screen.getByText(/description published at claude.ai/)).toBeInTheDocument();
    expect(screen.queryByText("Not verified")).not.toBeInTheDocument();
    expect(screen.getByText(/cannot publish or merge/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Connect" }));

    await vi.waitFor(() => expect(onRedirect).toHaveBeenCalledWith(redirectUrl));
    expect(fetch).toHaveBeenCalledWith(
      `/api/v1/oauth/requests/${REQUEST_ID}/approve`,
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("marks an app that registered itself as not verified, and shows where it returns to", async () => {
    // A self-chosen name and website must not look trustworthy.
    routeFetch({
      [`GET /api/v1/oauth/requests/${REQUEST_ID}`]: {
        body: {
          ...request,
          clientHost: null,
          redirectHost: "claude.example.org",
          registration: "dynamic",
          clientUri: "https://claude.ai",
        },
      },
    });
    renderWithProviders(<ConsentPage requestId={REQUEST_ID} onRedirect={vi.fn()} />);

    expect(await screen.findByRole("heading", { name: "Connect Claude?" })).toBeInTheDocument();
    expect(fact("Identified by")).toHaveTextContent("Not verified");
    expect(fact("Returns to")).toHaveTextContent("claude.example.org");
    expect(screen.getByText(/registered itself and chose its own name/)).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.queryByText(/claude\.ai/)).not.toBeInTheDocument();
  });

  it("denies", async () => {
    const redirectUrl = "https://claude.ai/api/mcp/auth_callback?error=access_denied&state=xyz";
    routeFetch({
      [`GET /api/v1/oauth/requests/${REQUEST_ID}`]: { body: request },
      [`POST /api/v1/oauth/requests/${REQUEST_ID}/deny`]: { body: { redirectUrl } },
    });
    const onRedirect = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(<ConsentPage requestId={REQUEST_ID} onRedirect={onRedirect} />);
    await user.click(await screen.findByRole("button", { name: "Cancel" }));
    await vi.waitFor(() => expect(onRedirect).toHaveBeenCalledWith(redirectUrl));
  });

  it("explains an expired request", async () => {
    routeFetch({
      [`GET /api/v1/oauth/requests/${REQUEST_ID}`]: {
        status: 404,
        body: { error: { code: "not_found", message: "Not found" } },
      },
    });
    renderWithProviders(<ConsentPage requestId={REQUEST_ID} onRedirect={vi.fn()} />);
    expect(await screen.findByText("This sign-in request is no longer valid")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Connect" })).not.toBeInTheDocument();
  });
});
