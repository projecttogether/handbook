import GithubSlugger from "github-slugger";
import type { Root, RootContent } from "mdast";
import { toString } from "mdast-util-to-string";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { visit } from "unist-util-visit";
import { markdownProblem } from "@handbook/shared/markdown";
import { resolveLink } from "@handbook/shared/paths";

/**
 * What the server derives from a page body: sections for search (split at
 * headings, with the anchors the web app renders) and links to other pages.
 */

const parser = unified().use(remarkParse).use(remarkGfm);

export function parseMarkdown(body: string): Root {
  // Saving refuses such Markdown; text stored otherwise (a change set item
  // with conflict blocks, say) stays plain text rather than block the server.
  if (markdownProblem(body)) {
    return { type: "root", children: [{ type: "paragraph", children: [{ type: "text", value: body }] }] };
  }
  return parser.parse(body);
}

export type Section = {
  position: number;
  /** null for the text before the first heading. */
  anchor: string | null;
  headingPath: string[];
  content: string;
};

/**
 * GitHub-style callout markers ("[!NOTE]") are formatting, not text. Only
 * spaces before them: `^\s*` would search on through every blank line below
 * each line start (quadratic on blank lines).
 */
const CALLOUT_MARKER = /^[ \t]*\[!(?:NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*/gim;

function plainText(nodes: RootContent[]): string {
  return nodes
    .map((node) => toString(node, { includeImageAlt: true }))
    .join("\n")
    .replace(CALLOUT_MARKER, "")
    .replace(/[ \t]+/g, " ")
    .trim();
}

/**
 * Splits a body into sections at headings. Anchors follow GitHub's rules
 * (github-slugger), counted over every heading of the page, exactly as the
 * web app numbers them.
 */
export function sectionsOf(body: string): Section[] {
  const tree = parseMarkdown(body);
  const slugger = new GithubSlugger();
  const sections: Section[] = [];
  const stack: { depth: number; text: string }[] = [];
  let current: { anchor: string | null; headingPath: string[]; nodes: RootContent[] } = {
    anchor: null,
    headingPath: [],
    nodes: [],
  };
  const flush = () => {
    const content = plainText(current.nodes);
    if (content || current.anchor) {
      sections.push({
        position: sections.length,
        anchor: current.anchor,
        headingPath: current.headingPath,
        content,
      });
    }
  };
  for (const node of tree.children) {
    if (node.type === "heading") {
      flush();
      const text = toString(node).trim();
      const anchor = slugger.slug(text);
      while (stack.length > 0 && stack.at(-1)!.depth >= node.depth) stack.pop();
      stack.push({ depth: node.depth, text });
      current = { anchor, headingPath: stack.map((entry) => entry.text), nodes: [] };
    } else {
      current.nodes.push(node);
    }
  }
  flush();
  return sections;
}

export type PageLinkTarget = { space: string; path: string };

/** Pages a body links to (resolved like files: relative to the page's own path). */
export function pageLinksOf(body: string, from: { space: string; path: string }): PageLinkTarget[] {
  const tree = parseMarkdown(body);
  const targets = new Map<string, PageLinkTarget>();
  visit(tree, (node) => {
    if (node.type !== "link" && node.type !== "definition") return;
    const target = resolveLink(node.url, from);
    if (target.kind !== "page" || target.path === "") return;
    targets.set(`${target.space}/${target.path}`, { space: target.space, path: target.path });
  });
  return [...targets.values()];
}
