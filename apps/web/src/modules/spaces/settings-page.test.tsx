import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Space } from "@handbook/shared/api/spaces";
import { SettingsPage } from "./settings-page";

function space(overrides: Partial<Space> = {}): Space {
  return {
    id: "0b5a3e5e-3c1f-4d8e-9f3a-000000000001",
    slug: "it",
    name: "IT",
    description: "Laptops and accounts.",
    archived: false,
    pageCount: 3,
    myRole: "owner",
    updatedAt: "2026-11-17T10:00:00.000Z",
    properties: [],
    pageTypes: [],
    abilities: {
      editLive: true,
      review: true,
      manage: true,
      manageOwners: false,
      propose: true,
      seeDrafts: true,
    },
    openChangeSets: 0,
    createdAt: "2026-11-01T10:00:00.000Z",
    ...overrides,
  };
}

function renderSettings(client: QueryClient) {
  const rootRoute = createRootRoute();
  const route = createRoute({
    getParentRoute: () => rootRoute,
    path: "/s/$space/-/settings",
    component: () => <SettingsPage space="it" />,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([route]),
    history: createMemoryHistory({ initialEntries: ["/s/it/-/settings"] }),
  });
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

afterEach(() => vi.unstubAllGlobals());

/** Refetches the space and lets React render the answer (queries notify on a timer). */
async function refetchSpace(client: QueryClient) {
  await act(() => client.refetchQueries({ queryKey: ["space", "it"] }));
  await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
}

describe("space settings", () => {
  it("keeps unsaved text when the space changes elsewhere", async () => {
    let current = space();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const path = url.split("?")[0];
        const body = path === "/api/v1/spaces/it" ? current : { items: [] };
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderSettings(client);
    const description = await screen.findByLabelText("Description");
    await userEvent.clear(description);
    await userEvent.type(description, "Laptops, phones and accounts.");

    // Someone saves a page of the space: the space's updatedAt moves, nothing the card edits.
    current = space({ updatedAt: "2026-11-17T11:00:00.000Z" });
    await refetchSpace(client);
    expect(screen.getByLabelText("Description")).toHaveValue("Laptops, phones and accounts.");

    // Someone saves a new description: the card shows it.
    current = space({ updatedAt: "2026-11-17T12:00:00.000Z", description: "Everything IT." });
    await refetchSpace(client);
    expect(screen.getByLabelText("Description")).toHaveValue("Everything IT.");
  });

  it("adds what a template has and the space doesn't", async () => {
    const ownPolicy = { key: "policy", label: "Rule", template: "", requiredProperties: [] };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const path = url.split("?")[0];
        const body = path === "/api/v1/spaces/it" ? space({ pageTypes: [ownPolicy] }) : { items: [] };
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );
    renderSettings(new QueryClient({ defaultOptions: { queries: { retry: false } } }));
    expect(await screen.findByText("Adds the page types Overview, How-to, Reference.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Add to this space" }));
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining("/api/v1/spaces/it"),
        expect.objectContaining({ method: "PATCH" }),
      ),
    );
    const patch = vi.mocked(fetch).mock.calls.find(([, init]) => init?.method === "PATCH")!;
    const body = JSON.parse(patch[1]!.body as string) as { pageTypes: { key: string }[]; properties?: [] };
    expect(body.pageTypes.map((pageType) => pageType.key)).toEqual([
      "policy",
      "overview",
      "how-to",
      "reference",
    ]);
    // Properties don't change: not sent, so a list saved meanwhile elsewhere stays.
    expect(body).not.toHaveProperty("properties");
  });

  it("asks to save page type edits before a template adds page types", async () => {
    const ownPolicy = {
      key: "policy",
      label: "Rule",
      template: "",
      requiredProperties: ["owner", "reviewed"],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const path = url.split("?")[0];
        const body = path === "/api/v1/spaces/it" ? space({ pageTypes: [ownPolicy] }) : { items: [] };
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );
    renderSettings(new QueryClient({ defaultOptions: { queries: { retry: false } } }));
    const rule = await screen.findByRole("group", { name: "Rule" });
    await userEvent.type(within(rule).getByLabelText("Label"), "s");
    expect(screen.getByText(/Save or undo your changes/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add to this space" })).toBeDisabled();

    // Undone: nothing would be lost.
    await userEvent.type(within(rule).getByLabelText("Label"), "{Backspace}");
    expect(screen.queryByText(/Save or undo your changes/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add to this space" })).toBeEnabled();

    // A required property unchecked and checked again is no change either.
    await userEvent.click(within(rule).getByRole("checkbox", { name: "Owner" }));
    expect(screen.getByRole("button", { name: "Add to this space" })).toBeDisabled();
    await userEvent.click(within(rule).getByRole("checkbox", { name: "Owner" }));
    expect(screen.getByRole("button", { name: "Add to this space" })).toBeEnabled();
  });

  it("keeps the key of a saved page type when its label changes", async () => {
    const overview = { key: "overview", label: "Overview", template: "", requiredProperties: [] };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const path = url.split("?")[0];
        const body = path === "/api/v1/spaces/it" ? space({ pageTypes: [overview] }) : { items: [] };
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );
    renderSettings(new QueryClient({ defaultOptions: { queries: { retry: false } } }));
    const saved = await screen.findByRole("group", { name: "Overview" });
    await userEvent.type(within(saved).getByLabelText("Label"), " page");
    expect(within(saved).getByLabelText("Key")).toHaveValue("overview");

    // A new page type's key follows its label.
    await userEvent.click(screen.getByRole("button", { name: "Add page type" }));
    const added = screen.getAllByRole("group", { name: "Add page type" }).at(-1)!;
    await userEvent.type(within(added).getByLabelText("Label"), "Meeting notes");
    expect(within(added).getByLabelText("Key")).toHaveValue("meeting-notes");
  });
});
