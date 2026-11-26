import { render, screen } from "@testing-library/react";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { describe, expect, it } from "vitest";
import { MarkdownView, type MarkdownViewProps } from "./markdown";

/** MarkdownView inside a router, so page links can render. */
function renderMarkdown(props: Partial<MarkdownViewProps> & { markdown: string }) {
  const root = createRootRoute({
    component: () => (
      <>
        <MarkdownView space="it" path="onboarding/laptop" {...props} />
        <Outlet />
      </>
    ),
  });
  const space = createRoute({ getParentRoute: () => root, path: "/s/$space" });
  const page = createRoute({ getParentRoute: () => root, path: "/s/$space/$" });
  const router = createRouter({
    routeTree: root.addChildren([space, page]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return render(<RouterProvider router={router} />);
}

describe("MarkdownView", () => {
  it("numbers heading anchors like the server, counting a hidden title", async () => {
    const { container } = renderMarkdown({
      title: "Laptop",
      markdown: "# Laptop\n\nIntro\n\n## Setup\n\n## Setup\n\n### Wi-Fi & VPN\n",
    });
    await screen.findByText("Intro");
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
    const ids = [...container.querySelectorAll("h2, h3")].map((heading) => heading.id);
    expect(ids).toEqual(["setup", "setup-1", "wi-fi--vpn"]);
  });

  it("keeps a first heading that is not the title, and counts it", async () => {
    const { container } = renderMarkdown({ title: "Other", markdown: "# Laptop\n\n# Laptop\n" });
    await screen.findAllByRole("heading", { level: 1 });
    expect([...container.querySelectorAll("h1")].map((heading) => heading.id)).toEqual([
      "laptop",
      "laptop-1",
    ]);
  });

  it("shows callouts as boxes without their marker", async () => {
    const { container } = renderMarkdown({
      markdown: "> [!WARNING]\n> Do not share passwords.\n\n> A plain quote\n",
    });
    await screen.findByText("Do not share passwords.");
    const callout = container.querySelector('[data-callout="warning"]');
    expect(callout).not.toBeNull();
    expect(callout?.textContent).toContain("Warning");
    expect(callout?.textContent).not.toContain("[!WARNING]");
    expect(screen.getByText("A plain quote").closest("blockquote")).not.toBeNull();
  });

  it("resolves page links like files and keeps other links", async () => {
    renderMarkdown({
      markdown: [
        "[VPN](vpn)",
        "[Policy](../policies/ai.md#data)",
        "[HR](/s/hr/leave)",
        "[Space](/s/hr)",
        "[Top](#setup)",
        "[File](/files/1/a.pdf)",
        "[Site](https://example.org)",
        "[Gone](../../../x)",
      ].join("\n\n"),
    });
    expect((await screen.findByText("VPN")).closest("a")).toHaveAttribute("href", "/s/it/onboarding/vpn");
    expect(screen.getByText("Policy").closest("a")).toHaveAttribute("href", "/s/it/policies/ai#data");
    expect(screen.getByText("HR").closest("a")).toHaveAttribute("href", "/s/hr/leave");
    expect(screen.getByText("Space").closest("a")).toHaveAttribute("href", "/s/hr");
    expect(screen.getByText("Top").closest("a")).toHaveAttribute("href", "#setup");
    expect(screen.getByText("File").closest("a")).toHaveAttribute("href", "/files/1/a.pdf");
    const external = screen.getByText("Site").closest("a");
    expect(external).toHaveAttribute("target", "_blank");
    expect(external).toHaveAttribute("rel", "noopener noreferrer");
    expect(screen.getByText("Gone").closest("a")).toBeNull();
    expect(screen.getByText("Gone")).toHaveAttribute("data-broken-link");
  });

  it("never renders HTML", async () => {
    const { container } = renderMarkdown({
      markdown: 'Hello <b>bold</b>\n\n<script>alert(1)</script>\n\n<img src=x onerror="x">',
    });
    await screen.findByText(/Hello/);
    expect(container.querySelector("b, script, img")).toBeNull();
  });

  it("renders tables in a scroll area and task lists", async () => {
    const { container } = renderMarkdown({
      markdown: "| A | B |\n| - | - |\n| 1 | 2 |\n\n- [x] done\n- [ ] open\n",
    });
    await screen.findByText("done");
    expect(container.querySelector("table")?.parentElement).toHaveClass("overflow-x-auto");
    expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(2);
  });

  it("shows Markdown the parser cannot handle as plain text", async () => {
    // 10,000 nested quotes (a comment may be that long) would run the renderer out of stack.
    const markdown = `${">".repeat(10_000)} deep`;
    const { container } = renderMarkdown({ markdown });
    await screen.findByText(/deep$/);
    expect(container.querySelector("blockquote")).toBeNull();
  });
});
