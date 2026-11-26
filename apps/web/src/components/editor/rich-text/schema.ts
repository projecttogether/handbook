import { Extension, Node, mergeAttributes, type Extensions } from "@tiptap/core";
import Code from "@tiptap/extension-code";
import Image from "@tiptap/extension-image";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { Table, TableCell, TableHeader, TableRow } from "@tiptap/extension-table";
import StarterKit from "@tiptap/starter-kit";
import { CALLOUT_TYPES, type CalloutType } from "@/components/page/markdown-plugins";

/**
 * The document model of the rich-text editor: what a page body can hold
 * while it is edited as rich text. Every node and mark here has a Markdown
 * form (markdown.ts converts both ways); Markdown the model cannot hold
 * stays as a `rawMarkdown` block, so nothing is lost.
 *
 * No React here: the converter and its tests use the same schema.
 */

export function isCalloutType(value: unknown): value is CalloutType {
  return typeof value === "string" && (CALLOUT_TYPES as readonly string[]).includes(value);
}

/** A GitHub callout (`> [!NOTE]`): a box of blocks with a type. */
export const Callout = Node.create({
  name: "callout",
  group: "block",
  content: "block+",
  defining: true,
  addAttributes() {
    return {
      type: {
        default: "note",
        parseHTML: (element) => {
          const type = element.getAttribute("data-callout");
          return isCalloutType(type) ? type : "note";
        },
        renderHTML: (attributes) => ({ "data-callout": attributes.type as string }),
      },
    };
  },
  parseHTML() {
    return [{ tag: "div[data-callout]", contentElement: "[data-callout-body]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return [
      "div",
      mergeAttributes(HTMLAttributes, { role: "note" }),
      ["div", { "data-callout-body": "" }, 0],
    ];
  },
});

/** Markdown that has no rich-text form (HTML, footnotes, references), kept as written. */
export const RawMarkdown = Node.create({
  name: "rawMarkdown",
  group: "block",
  atom: true,
  selectable: true,
  addAttributes() {
    return { source: { default: "", rendered: false } };
  },
  parseHTML() {
    return [
      { tag: "pre[data-raw-markdown]", getAttrs: (element) => ({ source: element.textContent ?? "" }) },
    ];
  },
  renderHTML({ node }) {
    return ["pre", { "data-raw-markdown": "" }, String(node.attrs.source)];
  },
});

/** Markdown details the editor keeps but does not show: loose lists, code info, column alignment. */
const MarkdownAttributes = Extension.create({
  name: "markdownAttributes",
  addGlobalAttributes() {
    return [
      {
        types: ["bulletList", "orderedList", "taskList"],
        attributes: { spread: { default: false, rendered: false } },
      },
      { types: ["codeBlock"], attributes: { meta: { default: null, rendered: false } } },
      {
        types: ["tableHeader", "tableCell"],
        attributes: {
          align: {
            default: null,
            parseHTML: (element) => element.style.textAlign || null,
            renderHTML: (attributes) =>
              attributes.align ? { style: `text-align: ${String(attributes.align)}` } : {},
          },
        },
      },
    ];
  },
});

export type SchemaOptions = {
  /** Turns an image address of the page into one the browser can load. */
  resolveImage?: (src: string) => string;
  /** The editor's versions of the custom nodes (with node views); the same schema. */
  callout?: typeof Callout;
  rawMarkdown?: typeof RawMarkdown;
};

/** The extensions that define the document model (no editor behavior beyond Markdown shortcuts). */
export function schemaExtensions(options: SchemaOptions = {}): Extensions {
  const resolve = options.resolveImage ?? ((src: string) => src);
  return [
    StarterKit.configure({
      underline: false,
      trailingNode: false,
      code: false,
      heading: { levels: [1, 2, 3, 4, 5, 6] },
      link: {
        openOnClick: false,
        autolink: true,
        linkOnPaste: true,
        HTMLAttributes: { target: null, rel: null },
      },
    }),
    // Inline code may sit inside links and bold text, as in Markdown.
    Code.extend({ excludes: "code" }),
    Image.extend({
      parseHTML() {
        return [
          {
            tag: "img[src]",
            getAttrs: (element) => ({
              src: element.getAttribute("data-src") ?? element.getAttribute("src"),
              alt: element.getAttribute("alt"),
              title: element.getAttribute("title"),
            }),
          },
        ];
      },
      renderHTML({ HTMLAttributes }) {
        const src = String(HTMLAttributes.src ?? "");
        return ["img", mergeAttributes(HTMLAttributes, { src: resolve(src), "data-src": src })];
      },
    }).configure({ inline: true, allowBase64: false }),
    TaskList,
    TaskItem.configure({ nested: true }),
    Table.configure({ resizable: false }),
    TableRow,
    // Markdown table cells hold one line of text.
    TableHeader.extend({ content: "paragraph" }),
    TableCell.extend({ content: "paragraph" }),
    options.callout ?? Callout,
    options.rawMarkdown ?? RawMarkdown,
    MarkdownAttributes,
  ];
}
