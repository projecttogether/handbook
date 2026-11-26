/**
 * Markdown the parser cannot handle well. micromark (the parser of the
 * server and, through react-markdown, of the web app) is slow on some text:
 * quadratic on long paragraphs full of links or emphasis, on many quotes and
 * lists, on long runs of lazy lines, and it runs out of stack on deep
 * nesting. Page files are refused when `markdownProblem` names a problem.
 *
 * It reads the lines once, without parsing, and estimates how long the
 * parser takes, generously (every sign may make it search the whole
 * paragraph). The weights are measured against micromark: within the limit,
 * a page parses in under a second; ordinary pages stay below it up to a few
 * hundred thousand characters. Where the scan cannot be sure how the parser
 * reads a line (in HTML, say), it assumes the slower reading.
 */

/** Quotes, list items and footnotes inside each other. */
export const MAX_NESTING = 16;
/** `*`, `_` and `~` in one paragraph (they nest: emphasis in emphasis). */
export const MAX_EMPHASIS_MARKS = 1000;
/** Characters in one paragraph (longer ones hit slow paths of the parser). */
export const MAX_PARAGRAPH_CHARACTERS = 20_000;

/** Microseconds the parser may take (estimated). */
const PARSE_LIMIT = 700_000;
const COST = {
  /** Each line. */
  line: 7,
  /** Each character… */
  character: 0.6,
  /** …more for each of `*_~[]!<>&\` and `` ` `` (the parser tries a construct there). */
  mark: 3,
  /** Each list item, table cell, link and heading. */
  structure: 20,
  /** Each quote, list or footnote level of each line. */
  level: 4.5,
  /** Each sign (`*`, `_`, `~`, `]`, `<`, start of `` ` `` runs) × characters of its paragraph. */
  search: 0.008,
  /** Each line in a quote, list item or footnote × lines before it in its paragraph. */
  lazyLine: 0.045,
  /** Each underlined heading and end of a quote or list × lines before it… */
  rebuild: 0.04,
  /** …and × such ends before it. */
  rebuildAgain: 0.06,
};

const BULLET_ITEM = /^ {0,3}([-+*])( +|\t[ \t]*)\S/;
const FIRST_ORDERED_ITEM = /^ {0,3}1([.)])( +|\t[ \t]*)\S/;
const ORDERED_ITEM = /^ {0,3}\d{1,9}([.)])( +|\t[ \t]*)\S/;
const HEADING = /^ {0,3}#{1,6}(?:[ \t]|$)/;
const THEMATIC_BREAK = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const FENCE = /^ {0,3}(`{3,}(?=[^`]*$)|~{3,})/;
const UNDERLINE = /^(?:=+|-+)[ \t]*$/;
const TABLE_DELIMITER_ROW = /^\|(?:[ \t]*:?-+:?[ \t]*\|)+[ \t]*$/;
/** Tags that start an HTML block ending at the next blank line (CommonMark, as micromark has them). */
const HTML_BLOCK_NAMES = new Set(
  (
    "address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt " +
    "fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link " +
    "main menu menuitem nav noframes ol optgroup option p param search section summary table tbody td tfoot th thead " +
    "title tr track ul"
  ).split(" "),
);

/** The start of an HTML block that ends at the next blank line. */
function isHtmlBlockStart(text: string): boolean {
  const tag = /^<\/?([A-Za-z][A-Za-z0-9-]*)(?:[ \t>]|\/>|$)/.exec(text);
  return tag !== null && HTML_BLOCK_NAMES.has(tag[1]!.toLowerCase());
}

/** HTML that ends on its line (`<!-- … -->`, `<!DOCTYPE …>`). */
function isOneLineHtml(text: string): boolean {
  if (text.startsWith("<!--")) return text.includes("-->", 4);
  return /^<![A-Za-z]/.test(text) && text.includes(">", 2);
}

type Prefix = {
  /** Columns of whitespace before the first other character. */
  indent: number;
  /** The leading whitespace has a tab. */
  tab: boolean;
  quotes: number;
  /** List markers and footnote labels. */
  items: number;
  /** The last list marker (`-`, `+`, `*`, `.` or `)`), `^` for footnotes. */
  kind: string;
  /** Columns of whitespace among the markers. */
  space: number;
  /** Index of the first character after the markers. */
  end: number;
};

/** The quote, list and footnote markers at the start of a line. */
function prefixOf(line: string): Prefix {
  const prefix: Prefix = { indent: 0, tab: false, quotes: 0, items: 0, kind: "", space: 0, end: 0 };
  let index = 0;
  let column = 0;
  // Past MAX_NESTING markers, the line is refused anyway.
  while (prefix.quotes + prefix.items <= MAX_NESTING) {
    const leading = prefix.quotes + prefix.items === 0;
    const start = column;
    while (line[index] === " " || line[index] === "\t") {
      if (line[index] === "\t") {
        if (leading) prefix.tab = true;
        column += 4 - (column % 4);
      } else {
        column += 1;
      }
      index += 1;
    }
    if (leading) prefix.indent = column;
    prefix.space += column - start;
    const char = line[index];
    const after = (offset: number) => {
      const next = line[index + offset];
      return next === undefined || next === " " || next === "\t";
    };
    if (char === ">") {
      prefix.quotes += 1;
      index += 1;
      column += 1;
    } else if ((char === "-" || char === "+" || char === "*") && after(1)) {
      prefix.items += 1;
      prefix.kind = char;
      index += 1;
      column += 1;
    } else {
      const ordered = /^\d{1,9}[.)]/.exec(line.slice(index, index + 11));
      const footnote =
        char === "[" && line[index + 1] === "^"
          ? /^\[\^[^\]]{1,999}\]:/.exec(line.slice(index, index + 1004))
          : null;
      const marker = ordered && after(ordered[0].length) ? ordered[0] : footnote?.[0];
      if (!marker) break;
      prefix.items += 1;
      prefix.kind = marker === footnote?.[0] ? "^" : marker.slice(-1);
      index += marker.length;
      column += marker.length;
    }
  }
  prefix.end = index;
  return prefix;
}

/** Cells of a table row that starts and ends with `|` (`\|` is no separator); null for other rows. */
function cellsOf(line: string): number | null {
  const row = line.trimEnd();
  let pipes = 0;
  let last = -1;
  for (let index = 0; index < row.length; index += 1) {
    const char = row[index];
    if (char === "\\" && (row[index + 1] === "\\" || row[index + 1] === "|")) {
      index += 1;
    } else if (char === "|") {
      pipes += 1;
      last = index;
    }
  }
  return row.startsWith("|") && last === row.length - 1 && pipes >= 2 ? pipes - 1 : null;
}

/** Characters where the parser tries a construct. */
function marksOf(line: string): number {
  let count = 0;
  for (let index = 0; index < line.length; index += 1) {
    if ("*_~[]!<>&\\`".includes(line[index]!)) count += 1;
  }
  return count;
}

function isWordCharacter(code: number): boolean {
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

const TOO_COMPLEX = "The page is too long and complex to show; split it into several pages";

/**
 * What makes the text too slow or too deep for the parser, with its line
 * (`firstLine` is the number of the text's first line); null when it is fine.
 */
export function markdownProblem(text: string, firstLine = 1): string | null {
  const lines = text.split(/\r\n?|\n/);
  let estimate = 0;
  let deepest = 0;
  let rebuilt = 0;
  const rebuild = (count: number, index: number) => {
    estimate += count * (COST.rebuild * index + COST.rebuildAgain * rebuilt);
    rebuilt += count;
  };

  // The current block: lines where one paragraph may go on (a new one starts
  // for sure at a blank line, list item, heading, table row or code fence).
  let start = 0;
  let characters = 0;
  let signs = 0;
  let marks = 0;
  /** Lines since the block entered a quote, list item or footnote (they may be lazy lines). */
  let contained = -1;
  const endBlock = (next: number): string | null => {
    const line = start + firstLine;
    const length = characters;
    const search = COST.search * signs * characters;
    estimate += search;
    start = next;
    characters = 0;
    signs = 0;
    contained = -1;
    if (marks > MAX_EMPHASIS_MARKS) {
      return `Line ${line}: this paragraph has more than ${MAX_EMPHASIS_MARKS} *, _ and ~; split it up with blank lines`;
    }
    marks = 0;
    if (length > MAX_PARAGRAPH_CHARACTERS) {
      return `Line ${line}: this paragraph has more than ${MAX_PARAGRAPH_CHARACTERS} characters; split it up with blank lines`;
    }
    if (estimate > PARSE_LIMIT) {
      return search > PARSE_LIMIT / 2
        ? `Line ${line}: this paragraph is too long and complex to show; split it up with blank lines`
        : TOO_COMPLEX;
    }
    return null;
  };

  let previousBlank = true;
  /** No paragraph is open (after a blank line, heading or fence). */
  let atStart = true;
  let previousQuotes = 0;
  let previousDepth = 0;
  let previous: { item: boolean; indent: number; kind: string } | null = null;
  /** The code fence the lines are in; `skip`: its lines are only code for sure. */
  let fence: { marker: string; length: number; indent: number; skip: boolean } | null = null;
  /** After HTML, or a fence that may have ended early, fences are no longer sure. */
  let unsure = false;
  /** In an HTML block that ends at the next blank line (no Markdown in it). */
  let html = false;
  let table = false;
  /** Content column of the list item the lines are in; ordered items before it start new items. */
  let itemColumn: number | null = null;

  for (const [index, line] of lines.entries()) {
    estimate += COST.line + COST.character * (line.length + 1) + COST.mark * marksOf(line);
    if (fence) {
      const closing = FENCE.exec(line);
      if (
        closing?.[1] &&
        closing[1][0] === fence.marker &&
        closing[1].length >= fence.length &&
        line.slice(closing[0].length).trim() === ""
      ) {
        fence = null;
        atStart = true;
        const problem = endBlock(index + 1);
        if (problem) return problem;
        continue;
      }
      if (line.trim() !== "" && /^[ \t]*/.exec(line)![0].length < fence.indent) {
        // The fence may have been in a list item that ended here.
        unsure = true;
      }
      if (fence.skip) continue;
    }

    if (html && !/^[ \t]*$/.test(line)) continue;
    if (/^[ \t]*$/.test(line)) {
      html = false;
      const problem = endBlock(index + 1);
      if (problem) return problem;
      // A blank line ends quotes.
      rebuild(previousQuotes, index);
      previousBlank = true;
      atStart = true;
      previousQuotes = 0;
      previousDepth = 0;
      table = false;
      continue;
    }

    const prefix = prefixOf(line);
    const depth = prefix.quotes + prefix.items + Math.min(Math.floor(prefix.space / 2), deepest);
    if (depth > MAX_NESTING) {
      return `Line ${index + firstLine}: lists, quotes and footnotes are nested more than ${MAX_NESTING} levels deep`;
    }
    deepest = Math.max(deepest, depth);
    // A line without markers may go on the paragraph of the line before, at its depth.
    const lineDepth = prefix.quotes + prefix.items > 0 ? depth : Math.max(depth, previousDepth);
    estimate += COST.level * lineDepth + COST.structure * prefix.items;
    previousDepth = lineDepth;

    // Work of the whole page: ends of quotes and lists, underlined headings.
    let rebuilds = Math.max(0, previousQuotes - prefix.quotes);
    if (!previousBlank && UNDERLINE.test(line.replace(/^[ \t>]*/, ""))) rebuilds += 1;
    const item = prefix.items > 0;
    if (item) {
      // Lists opened inside the first item of the line end later; a new item ends quotes in the one before.
      rebuilds += prefix.items - 1 + 2 * Math.min(previousQuotes, prefix.quotes);
      const sameList =
        previous &&
        (previous.indent > prefix.indent ||
          (previous.item && previous.indent === prefix.indent && previous.kind === prefix.kind));
      if (!sameList) rebuilds += 1;
    } else if (previous && prefix.indent <= 1 && (previous.item || previous.indent >= 2)) {
      rebuilds += 1;
    }
    rebuild(rebuilds, index);
    previous = { item, indent: prefix.indent, kind: prefix.kind };
    previousQuotes = prefix.quotes;

    if (!fence && line[prefix.end] === "<") {
      const rest = line.slice(prefix.end);
      if (!unsure && prefix.end === 0 && isHtmlBlockStart(rest)) {
        html = true;
        previousBlank = false;
        const problem = endBlock(index + 1);
        if (problem) return problem;
        continue;
      }
      if (!isOneLineHtml(rest)) unsure = true;
    }

    // Where a new block starts for sure (a paragraph cannot go on there).
    let single = false;
    let starts = false;
    if (!fence && !prefix.tab && prefix.indent <= 3) {
      const opening = prefix.items === 0 ? FENCE.exec(line) : null;
      const bullet = BULLET_ITEM.exec(line) ?? FIRST_ORDERED_ITEM.exec(line);
      const ordered = ORDERED_ITEM.exec(line);
      if (opening?.[1]) {
        const skip = !unsure && prefix.indent === 0;
        fence = { marker: opening[1][0]!, length: opening[1].length, indent: prefix.indent, skip };
        itemColumn = null;
        table = false;
        const problem = endBlock(index + (skip ? 1 : 0));
        if (problem) return problem;
        previousBlank = false;
        if (skip) continue;
      } else if (bullet || (ordered && itemColumn !== null && prefix.indent < itemColumn)) {
        starts = true;
        const match = (bullet ?? ordered)!;
        const spaces = match[2]!;
        const markerEnd = match[0].length - spaces.length - 1;
        itemColumn = spaces.includes("\t") ? null : markerEnd + (spaces.length <= 4 ? spaces.length : 1);
      } else if (HEADING.test(line) || THEMATIC_BREAK.test(line)) {
        starts = true;
        single = true;
        itemColumn = null;
        if (HEADING.test(line)) estimate += COST.structure;
      } else if (table && line.startsWith("|")) {
        starts = true;
        single = true;
      } else if (
        atStart &&
        !unsure &&
        TABLE_DELIMITER_ROW.test(lines[index + 1] ?? "") &&
        cellsOf(line) !== null &&
        cellsOf(line) === cellsOf(lines[index + 1]!)
      ) {
        table = true;
        starts = true;
        single = true;
      } else if (itemColumn !== null && prefix.indent < itemColumn) {
        itemColumn = null;
      }
    } else if (!fence) {
      itemColumn = null;
    }
    if (!line.startsWith("|")) table = false;
    if (starts) {
      const problem = endBlock(index);
      if (problem) return problem;
    }

    if (contained >= 0) {
      estimate += COST.lazyLine * contained;
      contained += 1;
    } else if (item || prefix.quotes > 0 || (characters === 0 && prefix.indent >= 2)) {
      contained = 1;
    }
    characters += line.length + 1;
    for (let at = 0; at < line.length; at += 1) {
      const code = line.charCodeAt(at);
      if (code === 42 || code === 126) {
        // * and ~
        signs += 1;
        marks += 1;
      } else if (code === 95) {
        // _ inside a word is no emphasis.
        if (!(isWordCharacter(line.charCodeAt(at - 1)) && isWordCharacter(line.charCodeAt(at + 1)))) {
          signs += 1;
          marks += 1;
        }
      } else if (code === 93 || code === 124) {
        // ] (links) and | (table cells)
        if (code === 93) signs += 1;
        estimate += COST.structure;
      } else if (code === 60 || (code === 96 && line.charCodeAt(at - 1) !== 96)) {
        // < and the first ` of a run
        signs += 1;
      }
    }
    previousBlank = false;
    atStart = single;
    if (estimate > PARSE_LIMIT) return TOO_COMPLEX;
    if (single) {
      const problem = endBlock(index + 1);
      if (problem) return problem;
    }
  }
  return endBlock(lines.length);
}
