import type { JSONContent } from "@tiptap/core";
import type { Node as PMNode, Schema } from "@tiptap/pm/model";
import type {
  Blockquote,
  List,
  ListItem,
  Nodes,
  Parents,
  PhrasingContent,
  Root,
  RootContent,
  Table,
  TableCell,
} from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown, gfmToMarkdown } from "mdast-util-gfm";
import { toMarkdown, type Handle, type Handlers, type Options } from "mdast-util-to-markdown";
import { gfm } from "micromark-extension-gfm";
import { takeCallout } from "@/components/page/markdown-plugins";

/**
 * Converts a page body between Markdown and the rich-text document.
 *
 * Markdown is shared: agents write it, change sets diff it line by line and
 * saves merge it word by word. So the rich-text editor must not rewrite
 * text nobody changed. `parseBody` remembers each top-level block's source;
 * `serializeBody` writes a block back exactly as it was unless its content
 * changed, and only changed blocks get the canonical Markdown form below.
 * Markdown the document cannot hold becomes a `rawMarkdown` block with its
 * source, so nothing is lost either way.
 */

class Unsupported extends Error {}

type MarkJSON = { type: string; attrs?: Record<string, unknown> };

/** Parses Markdown the way pages are read (GitHub-flavored). */
export function parseMarkdown(markdown: string): Root {
  return fromMarkdown(markdown, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
}

// ---------- Markdown → document ----------

function hasContent(nodes: JSONContent[]): boolean {
  return nodes.some((node) => node.type === "image" || (node.type === "text" && node.text !== ""));
}

function inline(nodes: PhrasingContent[], marks: MarkJSON[] = []): JSONContent[] {
  const result: JSONContent[] = [];
  const withMarks = (node: JSONContent, extra: MarkJSON[] = []) => {
    const all = [...marks, ...extra];
    return all.length > 0 ? { ...node, marks: all } : node;
  };
  for (const node of nodes) {
    switch (node.type) {
      case "text": {
        // A soft line break is a space; the editor wraps lines itself.
        const text = node.value.replace(/\n/g, " ");
        if (text) result.push(withMarks({ type: "text", text }));
        break;
      }
      case "emphasis":
        result.push(...inline(node.children, [...marks, { type: "italic" }]));
        break;
      case "strong":
        result.push(...inline(node.children, [...marks, { type: "bold" }]));
        break;
      case "delete":
        result.push(...inline(node.children, [...marks, { type: "strike" }]));
        break;
      case "inlineCode": {
        const text = node.value.replace(/\n/g, " ");
        if (text) result.push(withMarks({ type: "text", text }, [{ type: "code" }]));
        break;
      }
      case "break":
        result.push({ type: "hardBreak" });
        break;
      case "link": {
        const children = inline(node.children, [
          ...marks,
          { type: "link", attrs: { href: node.url, title: node.title ?? null } },
        ]);
        // A link without text would vanish in rich text.
        if (!hasContent(children)) throw new Unsupported("empty link");
        result.push(...children);
        break;
      }
      case "image":
        result.push(
          withMarks({
            type: "image",
            attrs: { src: node.url, alt: node.alt ?? null, title: node.title ?? null },
          }),
        );
        break;
      default:
        // HTML, footnote references, reference links.
        throw new Unsupported(node.type);
    }
  }
  return result;
}

const paragraph = (content: JSONContent[]): JSONContent =>
  content.length > 0 ? { type: "paragraph", content } : { type: "paragraph" };

function blocks(nodes: RootContent[]): JSONContent[] {
  const result = nodes.map(block);
  return result.length > 0 ? result : [paragraph([])];
}

function listItemContent(item: ListItem): JSONContent[] {
  const content = item.children.map(block);
  // Rich-text list items start with a paragraph.
  if (content[0]?.type !== "paragraph") content.unshift(paragraph([]));
  return content;
}

function list(node: List): JSONContent {
  const checks = node.children.map((item) => item.checked);
  const task = checks.length > 0 && checks.every((checked) => typeof checked === "boolean");
  if (!task && checks.some((checked) => typeof checked === "boolean")) throw new Unsupported("mixed list");
  if (task && node.ordered) throw new Unsupported("ordered task list");
  const spread = node.spread === true;
  if (task) {
    return {
      type: "taskList",
      attrs: { spread },
      content: node.children.map((item) => ({
        type: "taskItem",
        attrs: { checked: item.checked === true },
        content: listItemContent(item),
      })),
    };
  }
  return {
    type: node.ordered ? "orderedList" : "bulletList",
    attrs: node.ordered ? { spread, start: node.start ?? 1 } : { spread },
    content: node.children.map((item) => ({ type: "listItem", content: listItemContent(item) })),
  };
}

function table(node: Table): JSONContent {
  const columns = node.children[0]?.children.length ?? 0;
  const align = node.align ?? [];
  const cell = (value: TableCell | undefined, header: boolean, column: number): JSONContent => ({
    type: header ? "tableHeader" : "tableCell",
    attrs: { align: align[column] ?? null },
    content: [paragraph(value ? inline(value.children) : [])],
  });
  return {
    type: "table",
    content: node.children.map((row, rowIndex) => ({
      type: "tableRow",
      content: Array.from({ length: columns }, (_, column) =>
        cell(row.children[column], rowIndex === 0, column),
      ),
    })),
  };
}

function block(node: RootContent): JSONContent {
  switch (node.type) {
    case "paragraph":
      return paragraph(inline(node.children));
    case "heading": {
      const content = inline(node.children);
      return content.length > 0
        ? { type: "heading", attrs: { level: node.depth }, content }
        : { type: "heading", attrs: { level: node.depth } };
    }
    case "thematicBreak":
      return { type: "horizontalRule" };
    case "blockquote": {
      const type = takeCallout(node);
      const content = blocks(node.children);
      return type ? { type: "callout", attrs: { type }, content } : { type: "blockquote", content };
    }
    case "list":
      return list(node);
    case "code":
      return {
        type: "codeBlock",
        attrs: { language: node.lang ?? null, meta: node.meta ?? null },
        ...(node.value ? { content: [{ type: "text", text: node.value }] } : {}),
      };
    case "table":
      return table(node);
    default:
      // HTML, link definitions, footnotes.
      throw new Unsupported(node.type);
  }
}

function toNode(node: RootContent, source: string, schema: Schema): PMNode {
  try {
    const result = schema.nodeFromJSON(block(node));
    result.check();
    return result;
  } catch {
    return schema.node("rawMarkdown", { source });
  }
}

/** One top-level block of the original body: where it was, its text, and its canonical Markdown. */
export type SourceBlock = { start: number; end: number; source: string; canonical: string };
/**
 * `nodes`: the document's top-level nodes as first read, by block. A node
 * edits never touched is the same object, so it maps to its own source even
 * when another block looks the same.
 */
export type BodyOrigin = { body: string; blocks: SourceBlock[]; nodes?: readonly PMNode[] };

/** Ties the origin to the top-level nodes of a document read from it (e.g. by the editor). */
export function attachNodes(origin: BodyOrigin, doc: PMNode) {
  if (doc.childCount !== origin.blocks.length) return;
  const nodes: PMNode[] = [];
  doc.forEach((node) => nodes.push(node));
  origin.nodes = nodes;
}

/** The document of a page body, and what is needed to write unchanged blocks back as they were. */
export function parseBody(body: string, schema: Schema): { doc: PMNode; origin: BodyOrigin } {
  const tree = parseMarkdown(body);
  const nodes: PMNode[] = [];
  const sources: SourceBlock[] = [];
  for (const child of tree.children) {
    let start = child.position?.start.offset ?? 0;
    const end = child.position?.end.offset ?? start;
    // The block's indentation is part of it (an indented fence's lines are relative to it).
    const lineStart = body.lastIndexOf("\n", start - 1) + 1;
    if (/^[ \t]*$/.test(body.slice(lineStart, start))) start = lineStart;
    const source = body.slice(start, end);
    nodes.push(toNode(child, source, schema));
    sources.push({ start, end, source, canonical: "" });
  }
  const doc = schema.node("doc", null, nodes.length > 0 ? nodes : [schema.node("paragraph")]);
  sources.forEach((source, index) => {
    source.canonical = blockMarkdown(doc.child(index));
  });
  const origin: BodyOrigin = { body, blocks: sources };
  attachNodes(origin, doc);
  return { doc, origin };
}

/** The inline content of a Markdown snippet (e.g. an uploaded file's link), to insert at the cursor. */
export function inlineFromMarkdown(markdown: string, schema: Schema): JSONContent[] {
  const { doc } = parseBody(markdown, schema);
  const first = doc.firstChild;
  if (first?.type.name !== "paragraph") return [];
  return (first.toJSON() as JSONContent).content ?? [];
}

// ---------- document → Markdown ----------

type Callout = { type: "callout"; calloutType: string; children: RootContent[] };
type Raw = { type: "raw"; value: string };
type Phrasing = PhrasingContent;
type PhrasingParent = Extract<PhrasingContent, { children: unknown }>;

/** The order marks nest in, outermost first; code is always innermost (a leaf in Markdown). */
const MARK_ORDER = ["link", "bold", "italic", "strike"];

function markKey(mark: { type: { name: string }; attrs: Record<string, unknown> }): string {
  return mark.type.name === "link"
    ? `link\u0000${String(mark.attrs.href ?? "")}\u0000${String(mark.attrs.title ?? "")}`
    : mark.type.name;
}

function openMark(mark: { type: { name: string }; attrs: Record<string, unknown> }): PhrasingParent {
  switch (mark.type.name) {
    case "link":
      return {
        type: "link",
        url: String(mark.attrs.href ?? ""),
        title: typeof mark.attrs.title === "string" && mark.attrs.title ? mark.attrs.title : null,
        children: [],
      };
    case "bold":
      return { type: "strong", children: [] };
    case "italic":
      return { type: "emphasis", children: [] };
    default:
      return { type: "delete", children: [] };
  }
}

/** Moves spaces at the edges of bold, italic and struck text outside it (`** a**` is not bold). */
function hoistSpaces(nodes: Phrasing[]): Phrasing[] {
  const result: Phrasing[] = [];
  for (const node of nodes) {
    if (node.type !== "strong" && node.type !== "emphasis" && node.type !== "delete") {
      if (node.type === "link") node.children = hoistSpaces(node.children);
      result.push(node);
      continue;
    }
    node.children = hoistSpaces(node.children);
    const first = node.children[0];
    const last = node.children.at(-1);
    let before = "";
    let after = "";
    if (first?.type === "text") {
      before = /^\s*/.exec(first.value)![0];
      first.value = first.value.slice(before.length);
    }
    if (last?.type === "text") {
      after = /\s*$/.exec(last.value)![0];
      last.value = last.value.slice(0, last.value.length - after.length);
    }
    node.children = node.children.filter((child) => child.type !== "text" || child.value !== "");
    if (before) result.push({ type: "text", value: before });
    if (node.children.length > 0) result.push(node);
    if (after) result.push({ type: "text", value: after });
  }
  return result;
}

function inlineToMdast(parent: PMNode, options: { breaks: boolean } = { breaks: true }): Phrasing[] {
  const root: Phrasing[] = [];
  const stack: { key: string; node: PhrasingParent }[] = [];
  const target = () => (stack.length > 0 ? (stack.at(-1)!.node.children as Phrasing[]) : root);
  parent.forEach((child) => {
    const marks = child.marks
      .filter((mark) => MARK_ORDER.includes(mark.type.name))
      .sort((a, b) => MARK_ORDER.indexOf(a.type.name) - MARK_ORDER.indexOf(b.type.name));
    const keys = marks.map(markKey);
    let common = 0;
    while (common < stack.length && common < keys.length && stack[common]!.key === keys[common]) common++;
    stack.length = common;
    for (const mark of marks.slice(common)) {
      const node = openMark(mark);
      target().push(node);
      stack.push({ key: markKey(mark), node });
    }
    if (child.isText) {
      const text = child.text ?? "";
      const code = child.marks.some((mark) => mark.type.name === "code");
      target().push(code ? { type: "inlineCode", value: text } : { type: "text", value: text });
    } else if (child.type.name === "hardBreak") {
      target().push(options.breaks ? { type: "break" } : { type: "text", value: " " });
    } else if (child.type.name === "image") {
      target().push({
        type: "image",
        url: String(child.attrs.src ?? ""),
        alt: typeof child.attrs.alt === "string" ? child.attrs.alt : null,
        title: typeof child.attrs.title === "string" && child.attrs.title ? child.attrs.title : null,
      });
    }
  });
  return hoistSpaces(root);
}

function isEmptyParagraph(node: PMNode | null | undefined): boolean {
  return node?.type.name === "paragraph" && node.childCount === 0;
}

function childBlocks(node: PMNode): RootContent[] {
  const result: RootContent[] = [];
  node.forEach((child) => result.push(blockToMdast(child)));
  return result;
}

function listItemToMdast(item: PMNode, task: boolean, spread: boolean): ListItem {
  const children = childBlocks(item);
  // An empty first paragraph only stood in for an item that starts with another block.
  if (children.length > 1 && isEmptyParagraph(item.firstChild)) children.shift();
  return {
    type: "listItem",
    spread,
    checked: task ? item.attrs.checked === true : null,
    children: children as ListItem["children"],
  };
}

function blockToMdast(node: PMNode): RootContent {
  switch (node.type.name) {
    case "paragraph":
      return { type: "paragraph", children: inlineToMdast(node) };
    case "heading":
      return {
        type: "heading",
        depth: Math.min(Math.max(Number(node.attrs.level) || 1, 1), 6) as 1 | 2 | 3 | 4 | 5 | 6,
        children: inlineToMdast(node),
      };
    case "horizontalRule":
      return { type: "thematicBreak" };
    case "blockquote":
      return { type: "blockquote", children: childBlocks(node) as Blockquote["children"] };
    case "callout":
      return {
        type: "callout",
        calloutType: String(node.attrs.type ?? "note"),
        children: childBlocks(node),
      } as unknown as RootContent;
    case "bulletList":
    case "orderedList":
    case "taskList": {
      const ordered = node.type.name === "orderedList";
      const task = node.type.name === "taskList";
      const spread = node.attrs.spread === true;
      const items: ListItem[] = [];
      node.forEach((item) => items.push(listItemToMdast(item, task, spread)));
      // Ordered lists may start at 0.
      const start = Number(node.attrs.start);
      return {
        type: "list",
        ordered,
        start: ordered ? (Number.isInteger(start) && start >= 0 ? start : 1) : null,
        spread,
        children: items,
      };
    }
    case "codeBlock":
      return {
        type: "code",
        lang: typeof node.attrs.language === "string" && node.attrs.language ? node.attrs.language : null,
        meta: typeof node.attrs.meta === "string" && node.attrs.meta ? node.attrs.meta : null,
        value: node.textContent,
      };
    case "table": {
      const align: Table["align"] = [];
      node.firstChild?.forEach((cell) => {
        const value = cell.attrs.align;
        align.push(value === "left" || value === "right" || value === "center" ? value : null);
      });
      const rows: Table["children"] = [];
      node.forEach((row) => {
        const cells: TableCell[] = [];
        row.forEach((cell) => {
          const content = cell.firstChild;
          // A table cell is one line: line breaks become spaces.
          cells.push({
            type: "tableCell",
            children: content ? inlineToMdast(content, { breaks: false }) : [],
          });
        });
        rows.push({ type: "tableRow", children: cells });
      });
      return { type: "table", align, children: rows };
    }
    case "rawMarkdown":
      return { type: "raw", value: String(node.attrs.source ?? "") } as unknown as RootContent;
    default:
      return { type: "paragraph", children: [{ type: "text", value: node.textContent }] };
  }
}

const calloutHandler: Handle = (node: Callout, _parent, state, info) => {
  const exit = state.enter("blockquote");
  const tracker = state.createTracker(info);
  tracker.move("> ");
  tracker.shift(2);
  const inner = state.containerFlow(node as unknown as Parents & Root, tracker.current());
  exit();
  const text = `[!${node.calloutType.toUpperCase()}]${inner ? `\n${inner}` : ""}`;
  return state.indentLines(text, (line, _, blank) => `>${blank ? "" : " "}${line}`);
};

const rawHandler: Handle = (node: Raw) => node.value;

const OPTIONS: Options = {
  bullet: "-",
  bulletOther: "*",
  bulletOrdered: ".",
  emphasis: "_",
  strong: "*",
  fence: "`",
  fences: true,
  listItemIndent: "one",
  rule: "-",
  resourceLink: false,
  incrementListMarker: true,
  setext: false,
  extensions: [
    gfmToMarkdown(),
    { handlers: { callout: calloutHandler, raw: rawHandler } as unknown as Partial<Handlers> },
  ],
};

type MarkerOptions = Pick<Options, "bullet" | "bulletOther" | "bulletOrdered">;

const canonicalCache = new WeakMap<PMNode, string>();

/** The canonical Markdown of one top-level block, without a final line break. */
export function blockMarkdown(node: PMNode, markers?: MarkerOptions): string {
  if (!markers) {
    const cached = canonicalCache.get(node);
    if (cached !== undefined) return cached;
  }
  let text: string;
  try {
    const tree: Root = { type: "root", children: [blockToMdast(node)] };
    text = toMarkdown(tree as Nodes, { ...OPTIONS, ...markers }).replace(/\n+$/, "");
  } catch {
    text = node.textContent;
  }
  if (!markers) canonicalCache.set(node, text);
  return text;
}

function listFamily(node: PMNode): "bullet" | "ordered" | null {
  const name = node.type.name;
  if (name === "orderedList") return "ordered";
  return name === "bulletList" || name === "taskList" ? "bullet" : null;
}

/** The list marker a list's text starts with: `-`, `*`, `+`, or the delimiter of `1.`/`1)`. */
function listMarker(text: string): string | null {
  const match = /^[ \t]*(?:([-*+])|\d{1,9}([.)]))/.exec(text);
  return match ? (match[1] ?? match[2] ?? null) : null;
}

type Piece = { text: string; index: number | null; node: PMNode };

/** List markers to write a list with, other than the ones its neighbors use; null when none is left. */
function markersAvoiding(family: "bullet" | "ordered", avoid: Set<string | null>): MarkerOptions | null {
  if (family === "ordered") {
    const delimiter = ([".", ")"] as const).find((marker) => !avoid.has(marker));
    return delimiter ? { bulletOrdered: delimiter } : null;
  }
  const bullet = (["-", "*", "+"] as const).find((marker) => !avoid.has(marker));
  return bullet ? { bullet, bulletOther: bullet === "-" ? "*" : "-" } : null;
}

/**
 * The line that closes a fenced code block left without one (CommonMark: fences are indented
 * 0–3 spaces); null when the text is no such block.
 */
function missingClosingFence(source: string): string | null {
  const lines = source.split("\n");
  // `s`: the info string may hold any character but a line break, also U+2028 and U+2029.
  const open = /^( {0,3})(`{3,}|~{3,})(.*)$/s.exec(lines[0] ?? "");
  if (!open) return null;
  const fence = open[2]!;
  if (fence.startsWith("`") && open[3]!.includes("`")) return null;
  const closed =
    lines.length > 1 && new RegExp(`^ {0,3}[${fence[0]}]{${fence.length},}[ \\t]*$`).test(lines.at(-1)!);
  return closed ? null : `${open[1]}${fence}`;
}

/** Writes the document as Markdown, keeping unchanged blocks and the space between them as they were. */
export function serializeBody(doc: PMNode, origin: BodyOrigin | null): string {
  const sources = origin?.blocks ?? [];
  const known = new Map(origin?.nodes?.map((node, index) => [node, index]));
  const nodes: PMNode[] = [];
  doc.forEach((node) => {
    if (!isEmptyParagraph(node)) nodes.push(node);
  });
  // Untouched nodes keep their own block first, so that no look-alike can take it.
  const used = new Set<number>();
  const indexes = nodes.map((node) => {
    const same = known.get(node);
    if (same === undefined || used.has(same)) return null;
    used.add(same);
    return same;
  });
  let last = -1;
  const pieces: Piece[] = nodes.map((node, position) => {
    const canonical = blockMarkdown(node);
    let index = indexes[position] ?? null;
    if (index === null) {
      const next = last + 1;
      if (next < sources.length && !used.has(next) && sources[next]!.canonical === canonical) {
        index = next;
      } else {
        const found = sources.findIndex((source, i) => !used.has(i) && source.canonical === canonical);
        if (found !== -1) index = found;
      }
      if (index !== null) used.add(index);
    }
    if (index !== null) last = index;
    return { text: index !== null ? sources[index]!.source : canonical, index, node };
  });
  if (pieces.length === 0) return "";
  const body = origin?.body ?? "";
  const adjacent = (a: Piece, b: Piece) => a.index !== null && b.index === a.index + 1;

  // A code block left open at the end of the text would swallow what now follows it: close it,
  // keeping its text as written. (Only the text's last block can be one: it runs to the end.)
  pieces.forEach((piece, position) => {
    const lastBlock = piece.index !== null && piece.index === sources.length - 1;
    const close = position < pieces.length - 1 && lastBlock ? missingClosingFence(piece.text) : null;
    // After the code's last line break, if it has one (another would add an empty line to the code).
    if (close !== null) piece.text = `${piece.text}${piece.text.endsWith("\n") ? "" : "\n"}${close}`;
  });

  // Two lists of one kind with the same marker, newly next to each other, would read as one
  // list: give the changed one other markers, or put an empty HTML comment between them when
  // both are unchanged (rewriting one would change more than its markers) or no marker is left.
  const separated = new Set<number>();
  for (let i = 1; i < pieces.length; i++) {
    const previous = pieces[i - 1]!;
    const piece = pieces[i]!;
    const family = listFamily(piece.node);
    if (adjacent(previous, piece) || !family || family !== listFamily(previous.node)) continue;
    if (listMarker(previous.text) !== listMarker(piece.text)) continue;
    if (previous.index !== null && piece.index !== null) {
      separated.add(i);
      continue;
    }
    const target = previous.index === null && piece.index !== null ? i - 1 : i;
    const neighbor = pieces[target === i ? i + 1 : i - 2];
    const avoid = new Set([listMarker(previous.text), listMarker(piece.text)]);
    if (neighbor && listFamily(neighbor.node) === family) avoid.add(listMarker(neighbor.text));
    const markers = markersAvoiding(family, avoid);
    if (!markers) {
      separated.add(i);
      continue;
    }
    pieces[target]!.text = blockMarkdown(pieces[target]!.node, markers);
    pieces[target]!.index = null;
  }

  let result = "";
  pieces.forEach((piece, position) => {
    const previous = pieces[position - 1];
    if (!previous) {
      if (piece.index === 0) result += body.slice(0, sources[0]!.start);
    } else if (adjacent(previous, piece)) {
      result += body.slice(sources[previous.index!]!.end, sources[piece.index!]!.start);
    } else {
      result += separated.has(position) ? "\n\n<!-- -->\n\n" : "\n\n";
    }
    result += piece.text;
  });
  const final = pieces.at(-1)!;
  result +=
    final.index !== null && final.index === sources.length - 1 ? body.slice(sources[final.index]!.end) : "\n";
  return result;
}
