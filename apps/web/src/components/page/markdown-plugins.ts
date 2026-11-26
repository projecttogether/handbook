import GithubSlugger from "github-slugger";
import type { Blockquote, Heading, Root, RootContent } from "mdast";
import { visit } from "unist-util-visit";

/**
 * Remark plugins of the page renderer. They run on the Markdown tree before
 * it becomes HTML, so the anchors match the server's search sections
 * (apps/server/src/pages/analyze.ts) exactly.
 */

export const CALLOUT_TYPES = ["note", "tip", "important", "warning", "caution"] as const;
export type CalloutType = (typeof CALLOUT_TYPES)[number];

type AnyNode = { type: string; value?: unknown; alt?: unknown; children?: AnyNode[] };

/** Plain text of a node, like mdast-util-to-string (image alt texts included). */
export function nodeText(node: AnyNode): string {
  if (typeof node.value === "string") return node.value;
  if (node.type === "image") return typeof node.alt === "string" ? node.alt : "";
  return (node.children ?? []).map(nodeText).join("");
}

const normalized = (text: string) => text.trim().replace(/\s+/g, " ").toLowerCase();

/**
 * Gives every heading its GitHub-style anchor (`id`), counted over all
 * headings of the page in order. A first-level heading at the very top that
 * repeats `title` is counted, then removed: the page shows its title itself.
 */
export function remarkHeadingIds(options: { title?: string } = {}) {
  return (tree: Root) => {
    const slugger = new GithubSlugger();
    const first = tree.children[0];
    let hidden: RootContent | null = null;
    if (
      options.title &&
      first?.type === "heading" &&
      first.depth === 1 &&
      normalized(nodeText(first)) === normalized(options.title)
    ) {
      hidden = first;
    }
    visit(tree, "heading", (node: Heading) => {
      const id = slugger.slug(nodeText(node).trim());
      node.data = { ...node.data, hProperties: { ...node.data?.hProperties, id } };
    });
    if (hidden) tree.children = tree.children.filter((node) => node !== hidden);
  };
}

const MARKER = /^\[!(note|tip|important|warning|caution)\][ \t]*(?:\n|$)/i;

/** The callout type of a blockquote that starts with `[!NOTE]` etc., and removes the marker. */
export function takeCallout(node: Blockquote): CalloutType | null {
  const paragraph = node.children[0];
  if (paragraph?.type !== "paragraph") return null;
  const text = paragraph.children[0];
  if (text?.type !== "text") return null;
  const match = MARKER.exec(text.value);
  if (!match) return null;
  text.value = text.value.slice(match[0].length);
  if (text.value === "") paragraph.children.shift();
  // A soft line break right after the marker line.
  const next = paragraph.children[0];
  if (next?.type === "break") paragraph.children.shift();
  if (paragraph.children.length === 0) node.children.shift();
  return match[1]!.toLowerCase() as CalloutType;
}

/**
 * GitHub callouts: `> [!NOTE]` (also TIP, IMPORTANT, WARNING, CAUTION)
 * become `<div data-callout="note">`, which the renderer shows as a box.
 */
export function remarkCallouts() {
  return (tree: Root) => {
    visit(tree, "blockquote", (node: Blockquote) => {
      const type = takeCallout(node);
      if (!type) return;
      node.data = { ...node.data, hName: "div", hProperties: { dataCallout: type } };
    });
  };
}
