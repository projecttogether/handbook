import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChangeSet } from "@handbook/shared/api/changes";
import { ChangeSetPage } from "./change-set-page";

const PAGE_ID = "0b5a3e5e-3c1f-4d8e-9f3a-111111111111";

function changeSet(overrides: Partial<ChangeSet> = {}): ChangeSet {
  return {
    id: "0b5a3e5e-3c1f-4d8e-9f3a-000000000012",
    number: 12,
    space: { slug: "it", name: "IT" },
    title: "Update the VPN guide",
    status: "in_review",
    author: { id: "0b5a3e5e-3c1f-4d8e-9f3a-222222222222", name: "Ada Lovelace", email: "ada@example.org" },
    clientName: "Claude",
    pages: 1,
    createdAt: "2026-11-17T09:00:00.000Z",
    updatedAt: "2026-11-17T10:00:00.000Z",
    mergedAt: null,
    description: "Explains the new client.",
    items: [
      {
        pageId: PAGE_ID,
        action: "update",
        path: "network/vpn",
        fromPath: null,
        title: "VPN",
        baseRevision: 3,
        liveRevision: 3,
        added: 4,
        removed: 1,
        conflict: false,
        updatedAt: "2026-11-17T10:00:00.000Z",
        updatedBy: null,
      },
    ],
    checks: [],
    events: [],
    mergedBy: null,
    revertOf: null,
    revertedBy: null,
    permissions: {
      edit: true,
      submit: false,
      review: true,
      merge: true,
      close: true,
      reopen: false,
      revert: false,
      comment: true,
    },
    ...overrides,
  };
}

type Reply = { status?: number; body?: unknown };

/** Answers by method and path; records every request. */
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

function renderPage(
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } }),
) {
  const rootRoute = createRootRoute();
  const route = createRoute({
    getParentRoute: () => rootRoute,
    path: "/changes/$number",
    component: () => <ChangeSetPage number={12} />,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([route]),
    history: createMemoryHistory({ initialEntries: ["/changes/12"] }),
  });
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("change set page", () => {
  it("offers review actions to editors", async () => {
    routeFetch({ "GET /api/v1/change-sets/12": { body: changeSet() } });
    renderPage();
    expect(await screen.findByRole("heading", { name: /Update the VPN guide/ })).toBeInTheDocument();
    expect(screen.getByText(/Ada Lovelace via Claude/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Merge" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Request changes" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Submit for review" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Revert" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Edit" })).toHaveAttribute(
      "href",
      `/pages/${PAGE_ID}/edit?changeSet=12`,
    );
  });

  it("lets an author without edit rights submit, but not merge", async () => {
    routeFetch({
      "GET /api/v1/change-sets/12": {
        body: changeSet({
          status: "open",
          permissions: {
            edit: true,
            submit: true,
            review: false,
            merge: false,
            close: true,
            reopen: false,
            revert: false,
            comment: true,
          },
        }),
      },
    });
    renderPage();
    expect(await screen.findByRole("button", { name: "Submit for review" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Merge" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Request changes" })).not.toBeInTheDocument();
    // Editors only see change sets in review: the author is told so.
    expect(screen.getByText("Not in review yet")).toBeInTheDocument();
    expect(screen.getByText(/editors see this change set once you submit it/)).toBeInTheDocument();
  });

  it("shows the conflicting pages when a merge fails", async () => {
    const fetch = routeFetch({
      "GET /api/v1/change-sets/12": { body: changeSet() },
      "POST /api/v1/change-sets/12/merge": {
        status: 409,
        body: {
          error: { code: "merge_conflicts", message: "Some pages changed meanwhile" },
          conflicts: [{ pageId: PAGE_ID, path: "network/vpn", reason: "Changed in the same lines" }],
        },
      },
    });
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "Merge" }));
    const dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: "Merge" }));
    const alert = await screen.findByText("These pages changed meanwhile in the same places");
    expect(alert).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "network/vpn" })).toHaveAttribute("href", "/s/it/network/vpn");
    expect(screen.getByText(/Changed in the same lines/)).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledWith(
      "/api/v1/change-sets/12/merge",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it.each([
    { action: "Merge", path: "merge", result: { status: "merged" as const } },
    { action: "Close", path: "close", result: { status: "closed" as const } },
  ])("refreshes the pages, the space and the editor after $action", async ({ action, path, result }) => {
    routeFetch({
      "GET /api/v1/change-sets/12": { body: changeSet() },
      [`POST /api/v1/change-sets/12/${path}`]: { body: changeSet(result) },
    });
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    // What other screens cached before: the page view, the space with its tree, the editor of this change set.
    const cached = [
      ["page-by-path", "it", "network/vpn"],
      ["page", PAGE_ID],
      ["space", "it"],
      ["space", "it", "tree"],
      ["change-set", 12],
      ["change-set", 12, "page", PAGE_ID],
    ];
    for (const key of cached) client.setQueryData(key, { cached: true });
    const user = userEvent.setup();
    renderPage(client);
    await user.click(await screen.findByRole("button", { name: action }));
    const dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: action }));
    await waitFor(() =>
      expect(
        cached.filter((key) => !client.getQueryState(key)?.isInvalidated).map((key) => key.join("/")),
      ).toEqual([]),
    );
  });

  it("says when a change set does not exist", async () => {
    routeFetch({
      "GET /api/v1/change-sets/12": {
        status: 404,
        body: { error: { code: "not_found", message: "Not found" } },
      },
    });
    renderPage();
    expect(await screen.findByText("No such change set")).toBeInTheDocument();
  });
});
