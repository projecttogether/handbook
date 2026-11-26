import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Space } from "@handbook/shared/api/spaces";
import { TooltipProvider } from "@/components/ui/tooltip";
import { PageEditor } from "./page-editor";

// The editors themselves are tested elsewhere (markdown.test.ts, end-to-end); here a text area stands in.
type EditorProps = { label: string; value: string; onChange: (value: string) => void };
const Stand = (props: EditorProps) => (
  <textarea
    aria-label={props.label}
    value={props.value}
    onChange={(event) => props.onChange(event.target.value)}
  />
);
vi.mock("./rich-text/rich-text-editor", () => ({ RichTextEditor: Stand }));
vi.mock("./markdown-editor", () => ({ MarkdownEditor: Stand }));

const space: Space = {
  id: "5f0c2a52-7f4a-4f0f-9a37-1f2d3c4b5a69",
  slug: "it",
  name: "IT",
  description: "",
  archived: false,
  pageCount: 2,
  myRole: "editor",
  updatedAt: "2026-11-17T09:00:00.000Z",
  properties: [],
  pageTypes: [],
  abilities: {
    editLive: true,
    review: true,
    manage: false,
    manageOwners: false,
    propose: true,
    seeDrafts: true,
  },
  openChangeSets: 0,
  createdAt: "2026-11-01T09:00:00.000Z",
};

function renderEditor(file: string) {
  const onChange = vi.fn();
  render(
    <TooltipProvider>
      <PageEditor
        file={file}
        onChange={onChange}
        space={space}
        path="vpn"
        back={null}
        context="IT"
        actions={null}
      />
    </TooltipProvider>,
  );
  return onChange;
}

beforeEach(() => window.localStorage.clear());

describe("PageEditor", () => {
  it("edits the title and the text where they appear on the page", async () => {
    const onChange = renderEditor("---\ntitle: VPN\n---\n\nText.\n");
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "VPN at home" } });
    expect(onChange).toHaveBeenLastCalledWith("---\ntitle: VPN at home\n---\n\nText.\n");
    fireEvent.change(await screen.findByLabelText("Page text"), { target: { value: "New text.\n" } });
    expect(onChange).toHaveBeenLastCalledWith("---\ntitle: VPN\n---\n\nNew text.\n");
  });

  it("shows the Markdown file when the properties lose their closing line", async () => {
    renderEditor("---\ntitle: VPN\n\nText.\n");
    expect(screen.getByRole("button", { name: "Rich text" })).toBeDisabled();
    expect(screen.getByText(/must start with its properties/)).toBeInTheDocument();
    expect(await screen.findByLabelText("Whole page file: frontmatter and Markdown")).toBeInTheDocument();
  });

  it("shows text too complex for rich text as Markdown, naming the line of the file", async () => {
    renderEditor(`---\ntitle: VPN\n---\n\nOK.\n\n${"*a* ".repeat(600)}\n`);
    expect(screen.getByRole("button", { name: "Rich text" })).toBeDisabled();
    expect(screen.getByText(/Line 7: this paragraph has more than/)).toBeInTheDocument();
  });

  it("shows the Markdown file while the text has conflict blocks", async () => {
    renderEditor("---\ntitle: VPN\n---\n\n<<<<<<< yours\nA\n=======\nB\n>>>>>>> current\n");
    expect(screen.getByRole("button", { name: "Rich text" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Markdown" })).toHaveAttribute("aria-pressed", "true");
    expect(await screen.findByLabelText("Whole page file: frontmatter and Markdown")).toBeInTheDocument();
    expect(screen.queryByLabelText("Title")).toBeNull();
  });
});
