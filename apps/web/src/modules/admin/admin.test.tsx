import { Suspense } from "react";
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
import type { Me, Person } from "@handbook/shared/api/users";
import { AdminPeoplePage } from "./people-page";
import { AdminSpacesPage, spaceSlugFrom } from "./spaces-page";

const me: Me = {
  id: "0b5a3e5e-3c1f-4d8e-9f3a-555555555555",
  email: "ada@example.org",
  name: "Ada Lovelace",
  image: null,
  isAdmin: true,
  spaces: [],
};

function person(overrides: Partial<Person>): Person {
  return {
    id: "0b5a3e5e-3c1f-4d8e-9f3a-666666666666",
    email: "rita@example.org",
    name: "Rita Reader",
    isAdmin: false,
    adminSource: null,
    blocked: false,
    spaces: [],
    lastSignInAt: null,
    createdAt: "2026-11-01T10:00:00.000Z",
    ...overrides,
  };
}

function routeFetch(routes: Record<string, unknown>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const body = routes[`${init?.method ?? "GET"} ${url.split("?")[0]}`];
      return new Response(JSON.stringify(body ?? { error: { code: "x", message: "No reply" } }), {
        status: body ? 200 : 500,
        headers: { "content-type": "application/json" },
      });
    }),
  );
}

function renderAdmin(path: "/admin/people" | "/admin/spaces") {
  const rootRoute = createRootRoute();
  const route = createRoute({
    getParentRoute: () => rootRoute,
    path,
    component: () => (
      <Suspense fallback={null}>
        {path === "/admin/people" ? <AdminPeoplePage /> : <AdminSpacesPage />}
      </Suspense>
    ),
  });
  const settings = createRoute({ getParentRoute: () => rootRoute, path: "/s/$space/-/settings" });
  const router = createRouter({
    routeTree: rootRoute.addChildren([route, settings]),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("admin", () => {
  it("makes space slugs from names", () => {
    expect(spaceSlugFrom("People & Culture")).toBe("people-culture");
    expect(spaceSlugFrom("A".repeat(60))).toHaveLength(40);
  });

  it("creates a space from the chosen template", async () => {
    routeFetch({
      "GET /api/v1/spaces": { items: [] },
      "POST /api/v1/spaces": { slug: "it" },
    });
    renderAdmin("/admin/spaces");
    const user = userEvent.setup();
    await user.click((await screen.findAllByRole("button", { name: "New space" }))[0]!);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("radio", { name: /^Blank/ })).toBeChecked();
    expect(dialog).toHaveTextContent("Starts without pages.");
    await user.click(within(dialog).getByRole("radio", { name: /^IT/ }));
    expect(dialog).toHaveTextContent(
      "Page types: Overview, How-to, Policy, Reference, Tool, Troubleshooting. Starts with these pages: Software,",
    );
    await user.type(within(dialog).getByLabelText("Name"), "IT and devices");
    await user.click(within(dialog).getByRole("button", { name: "Create space" }));
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining("/api/v1/spaces"),
        expect.objectContaining({ method: "POST" }),
      ),
    );
    const post = vi.mocked(fetch).mock.calls.find(([, init]) => init?.method === "POST")!;
    expect(JSON.parse(post[1]!.body as string)).toEqual({
      name: "IT and devices",
      slug: "it-and-devices",
      description: "",
      template: "it",
    });
  });

  it("protects yourself and admins from ADMIN_EMAILS", async () => {
    routeFetch({
      "GET /api/v1/me": me,
      "GET /api/v1/admin/people": {
        items: [
          person({ id: me.id, email: me.email, name: me.name, isAdmin: true, adminSource: "app" }),
          person({
            id: "0b5a3e5e-3c1f-4d8e-9f3a-777777777777",
            email: "root@example.org",
            name: "",
            isAdmin: true,
            adminSource: "environment",
          }),
          person({ spaces: [{ slug: "it", name: "IT", role: "editor" }] }),
        ],
      },
    });
    renderAdmin("/admin/people");
    const self = (await screen.findByText("(you)")).closest("tr")!;
    expect(within(self).getByRole("switch")).toBeDisabled();
    expect(within(self).queryByRole("button", { name: "Block" })).not.toBeInTheDocument();
    expect(within(self).queryByRole("button", { name: "Remove" })).not.toBeInTheDocument();
    const environment = screen.getByText("root@example.org").closest("tr")!;
    expect(within(environment).getByRole("switch")).toBeDisabled();
    expect(within(environment).getByText("From ADMIN_EMAILS")).toBeInTheDocument();
    expect(within(environment).queryByRole("button", { name: "Remove" })).not.toBeInTheDocument();
    const rita = screen.getByText("Rita Reader").closest("tr")!;
    expect(within(rita).getByRole("switch")).toBeEnabled();
    expect(within(rita).getByRole("button", { name: "Block" })).toBeInTheDocument();
    expect(within(rita).getByRole("button", { name: "Remove" })).toBeInTheDocument();
    expect(within(rita).getByRole("link", { name: "IT · editor" })).toHaveAttribute("href", "/s/it");
  });

  it("removes a person after asking", async () => {
    const rita = person({});
    routeFetch({
      "GET /api/v1/me": me,
      "GET /api/v1/admin/people": { items: [rita] },
      [`DELETE /api/v1/admin/people/${rita.id}`]: {},
    });
    renderAdmin("/admin/people");
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Remove" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Remove Rita Reader?" });
    expect(dialog).toHaveTextContent("shown as “Removed person”");
    expect(fetch).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ method: "DELETE" }));
    await user.click(within(dialog).getByRole("button", { name: "Remove" }));
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining(`/api/v1/admin/people/${rita.id}`),
        expect.objectContaining({ method: "DELETE" }),
      ),
    );
  });
});
