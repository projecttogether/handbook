import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TokenCreated } from "@handbook/shared/api/tokens";
import { renderWithProviders } from "@/test-utils";
import { SettingsPage } from "./settings-page";

type Reply = { status?: number; body?: unknown };

function routeFetch(routes: Record<string, Reply | (() => Reply)>) {
  const mock = vi.fn(async (url: string, init?: RequestInit) => {
    const entry = routes[`${init?.method ?? "GET"} ${url.split("?")[0]}`];
    const reply = (typeof entry === "function" ? entry() : entry) ?? {
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

const created: TokenCreated = {
  id: "0b5a3e5e-3c1f-4d8e-9f3a-333333333333",
  name: "Claude Code",
  prefix: "kn_pat_AbCd…",
  createdAt: "2026-11-17T10:00:00.000Z",
  lastUsedAt: null,
  expiresAt: "2027-02-15T10:00:00.000Z",
  secret: "kn_pat_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdef",
};

describe("settings page", () => {
  it("shows the MCP address and a new token's secret once, hidden", async () => {
    let tokens: unknown[] = [];
    const fetch = routeFetch({
      "GET /api/v1/connect-info": {
        body: { appUrl: "https://handbook.example.org", mcpUrl: "https://handbook.example.org/mcp" },
      },
      "GET /api/v1/connected-apps": { body: { items: [] } },
      "GET /api/v1/tokens": () => ({ body: { items: tokens } }),
      "POST /api/v1/tokens": () => {
        const { secret: _secret, ...token } = created;
        tokens = [token];
        return { body: created };
      },
    });
    const user = userEvent.setup();
    renderWithProviders(<SettingsPage />);

    expect(await screen.findByText("https://handbook.example.org/mcp")).toBeInTheDocument();
    expect(await screen.findByText("No personal tokens.")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "New token" }));
    await user.type(screen.getByLabelText("Name"), "Claude Code");
    await user.click(screen.getByRole("button", { name: "Create token" }));

    // Hidden until shown; the copy button copies it without showing it.
    const dialog = await screen.findByRole("dialog");
    const secret = within(dialog).getByLabelText("Token");
    expect(secret).toHaveValue(created.secret);
    expect(secret).toHaveAttribute("type", "password");
    expect(within(dialog).getByText(/You won't see it again/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Copy" }));
    expect(await navigator.clipboard.readText()).toBe(created.secret);
    expect(secret).toHaveAttribute("type", "password");
    await user.click(within(dialog).getByRole("button", { name: "Show" }));
    expect(secret).toHaveAttribute("type", "text");
    expect(within(dialog).getByRole("button", { name: "Hide" })).toBeInTheDocument();
    const post = fetch.mock.calls.find(([, init]) => init?.method === "POST");
    expect(JSON.parse(String(post?.[1]?.body))).toEqual({ name: "Claude Code", expiresInDays: 90 });

    await user.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByDisplayValue(created.secret)).not.toBeInTheDocument());
    expect(await screen.findByText("kn_pat_AbCd…")).toBeInTheDocument();
    expect(screen.queryByText(created.secret)).not.toBeInTheDocument();
  });

  const me = {
    id: "0b5a3e5e-3c1f-4d8e-9f3a-444444444444",
    email: "ada@example.org",
    name: "Ada",
    image: null,
    isAdmin: false,
    spaces: [],
  };
  const lists = {
    "GET /api/v1/connect-info": {
      body: { appUrl: "https://handbook.example.org", mcpUrl: "https://handbook.example.org/mcp" },
    },
    "GET /api/v1/connected-apps": { body: { items: [] } },
    "GET /api/v1/tokens": { body: { items: [] } },
  };

  it("shows admins the version that runs, linked to its commit", async () => {
    const fetch = routeFetch({
      ...lists,
      "GET /api/v1/me": { body: { ...me, isAdmin: true } },
      "GET /api/v1/about": { body: { version: "0123456789ab" } },
    });
    renderWithProviders(<SettingsPage />);

    const link = await screen.findByRole("link", { name: "Version 0123456789ab" });
    expect(link).toHaveAttribute("href", "https://github.com/projecttogether/handbook/commit/0123456789ab");
    expect(fetch.mock.calls.some(([url]) => url === "/api/v1/about")).toBe(true);
  });

  it("asks for no version for other people", async () => {
    const fetch = routeFetch({ ...lists, "GET /api/v1/me": { body: me } });
    renderWithProviders(<SettingsPage />);

    expect(await screen.findByText(/open-source knowledge base/)).toBeInTheDocument();
    await waitFor(() => expect(fetch.mock.calls.some(([url]) => url === "/api/v1/me")).toBe(true));
    expect(screen.queryByText(/^Version/)).not.toBeInTheDocument();
    expect(fetch.mock.calls.some(([url]) => url === "/api/v1/about")).toBe(false);
  });
});
