/**
 * Text changes of the editor's toolbar, as pure functions of the text and
 * the selection, so they can be tested without an editor.
 */

export type Selection = { from: number; to: number };
/** Replace `from`–`to` with `insert`, then select `select` (absolute positions after the change). */
export type Edit = { from: number; to: number; insert: string; select: Selection };

/** Wraps the selection (or a placeholder) in markers, e.g. `**bold**`. */
export function wrap(
  text: string,
  selection: Selection,
  before: string,
  after: string,
  placeholder: string,
): Edit {
  const selected = text.slice(selection.from, selection.to);
  const inner = selected || placeholder;
  return {
    from: selection.from,
    to: selection.to,
    insert: `${before}${inner}${after}`,
    select: { from: selection.from + before.length, to: selection.from + before.length + inner.length },
  };
}

function lineStart(text: string, position: number): number {
  return text.lastIndexOf("\n", position - 1) + 1;
}

function lineEnd(text: string, position: number): number {
  const index = text.indexOf("\n", position);
  return index === -1 ? text.length : index;
}

/**
 * Puts a prefix before every selected line (lists, tasks, headings), or
 * removes it when every line has it already.
 */
export function prefixLines(
  text: string,
  selection: Selection,
  prefix: string | ((index: number) => string),
): Edit {
  const from = lineStart(text, selection.from);
  const to = lineEnd(text, Math.max(selection.from, selection.to - (selection.to > selection.from ? 1 : 0)));
  const lines = text.slice(from, to).split("\n");
  const prefixes = lines.map((_, index) => (typeof prefix === "string" ? prefix : prefix(index)));
  const allHave = lines.every((line, index) => line.startsWith(prefixes[index]!));
  const changed = lines.map((line, index) =>
    allHave
      ? line.slice(prefixes[index]!.length)
      : `${prefixes[index]}${line.replace(/^(#{1,6} |[-*] (\[[ x]\] )?|\d+\. )/, "")}`,
  );
  const insert = changed.join("\n");
  return { from, to, insert, select: { from, to: from + insert.length } };
}

/** Inserts a block (table, callout, code) on its own lines at the cursor. */
export function insertBlock(text: string, selection: Selection, block: string, selectPart?: string): Edit {
  const before = text.slice(0, selection.from);
  const after = text.slice(selection.to);
  const leading = before === "" || before.endsWith("\n\n") ? "" : before.endsWith("\n") ? "\n" : "\n\n";
  const trailing = after === "" || after.startsWith("\n\n") ? "" : after.startsWith("\n") ? "\n" : "\n\n";
  const insert = `${leading}${block}${trailing}`;
  const start = selection.from + leading.length;
  const partIndex = selectPart ? block.indexOf(selectPart) : -1;
  const select =
    partIndex >= 0
      ? { from: start + partIndex, to: start + partIndex + selectPart!.length }
      : { from: start + block.length, to: start + block.length };
  return { from: selection.from, to: selection.to, insert, select };
}

export const TABLE_BLOCK = "| Column | Column |\n| --- | --- |\n| Text | Text |";
export const CODE_BLOCK = "```\ncode\n```";
export const CALLOUT_BLOCK = "> [!NOTE]\n> Text";

/** A link to a page, written as the page's absolute path (it survives moves through redirects). */
export function pageLinkMarkdown(title: string, space: string, path: string): string {
  const label = title.replace(/[[\]]/g, "");
  return `[${label}](/s/${space}/${path})`;
}
