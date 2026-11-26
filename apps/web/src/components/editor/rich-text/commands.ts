import type { Editor, Range } from "@tiptap/core";
import {
  Code,
  FileText,
  Heading2,
  Heading3,
  ImageUp,
  List,
  ListChecks,
  ListOrdered,
  MessageSquareWarning,
  Minus,
  Pilcrow,
  Quote,
  Table,
  type LucideIcon,
} from "lucide-react";

/** What the `/` menu can insert. Labels are message keys of `richTextMessages`. */
export type BlockCommandKey =
  | "text"
  | "heading2"
  | "heading3"
  | "bulletList"
  | "orderedList"
  | "taskList"
  | "quote"
  | "callout"
  | "table"
  | "codeBlock"
  | "divider"
  | "upload"
  | "pageLink";

export type BlockCommand = {
  key: BlockCommandKey;
  icon: LucideIcon;
  /** The Markdown it stands for, shown as a hint. */
  hint: string;
  /** Other words people may type after `/`. */
  keywords: string[];
};

export const BLOCK_COMMANDS: BlockCommand[] = [
  { key: "text", icon: Pilcrow, hint: "", keywords: ["paragraph", "plain"] },
  { key: "heading2", icon: Heading2, hint: "##", keywords: ["heading", "title", "h2", "section"] },
  { key: "heading3", icon: Heading3, hint: "###", keywords: ["heading", "subheading", "h3"] },
  { key: "bulletList", icon: List, hint: "-", keywords: ["bullet", "unordered", "list"] },
  { key: "orderedList", icon: ListOrdered, hint: "1.", keywords: ["numbered", "ordered", "steps", "list"] },
  { key: "taskList", icon: ListChecks, hint: "[ ]", keywords: ["todo", "checkbox", "checklist", "task"] },
  { key: "quote", icon: Quote, hint: ">", keywords: ["blockquote", "citation"] },
  {
    key: "callout",
    icon: MessageSquareWarning,
    hint: "[!NOTE]",
    keywords: ["note", "tip", "warning", "important", "caution", "info", "box"],
  },
  { key: "table", icon: Table, hint: "|", keywords: ["grid", "columns", "rows"] },
  { key: "codeBlock", icon: Code, hint: "```", keywords: ["code", "snippet", "command"] },
  { key: "divider", icon: Minus, hint: "---", keywords: ["rule", "line", "separator", "hr"] },
  { key: "upload", icon: ImageUp, hint: "", keywords: ["image", "picture", "file", "upload", "attachment"] },
  { key: "pageLink", icon: FileText, hint: "", keywords: ["link", "page", "reference"] },
];

/** The commands whose label, key or keywords start with the query (or contain it). */
export function filterCommands(
  commands: BlockCommand[],
  query: string,
  label: (key: BlockCommandKey) => string,
): BlockCommand[] {
  const q = query.trim().toLowerCase();
  if (!q) return commands;
  const words = (command: BlockCommand) => [label(command.key).toLowerCase(), ...command.keywords];
  const starts = commands.filter((command) => words(command).some((word) => word.startsWith(q)));
  const contains = commands.filter(
    (command) => !starts.includes(command) && words(command).some((word) => word.includes(q)),
  );
  return [...starts, ...contains];
}

/**
 * Runs a block command at the cursor (after deleting the typed `/query`
 * when `range` is given). Uploads and page links need the editor's UI:
 * those return their key for the caller to handle.
 */
export function runBlockCommand(
  editor: Editor,
  key: BlockCommandKey,
  range?: Range,
): "upload" | "pageLink" | null {
  const chain = editor.chain().focus();
  if (range) chain.deleteRange(range);
  switch (key) {
    case "text":
      chain.setParagraph().run();
      return null;
    case "heading2":
      chain.setNode("heading", { level: 2 }).run();
      return null;
    case "heading3":
      chain.setNode("heading", { level: 3 }).run();
      return null;
    case "bulletList":
      chain.toggleBulletList().run();
      return null;
    case "orderedList":
      chain.toggleOrderedList().run();
      return null;
    case "taskList":
      chain.toggleTaskList().run();
      return null;
    case "quote":
      chain.toggleBlockquote().run();
      return null;
    case "callout":
      chain.wrapIn("callout", { type: "note" }).run();
      return null;
    case "table":
      chain.insertTable({ rows: 2, cols: 2, withHeaderRow: true }).run();
      return null;
    case "codeBlock":
      chain.toggleCodeBlock().run();
      return null;
    case "divider":
      chain.setHorizontalRule().run();
      return null;
    case "upload":
    case "pageLink":
      chain.run();
      return key;
  }
}
