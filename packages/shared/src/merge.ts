import { MAX_PAGE_CHARACTERS } from "./page";

/**
 * Text merging for pages. Two people (or a person and a change set) that
 * started from the same revision changed a page: `mergeText` combines both
 * changes line by line, like Git, and where both changed the same lines
 * (one paragraph is one line), word by word. Changes to the same words
 * become conflict blocks that a person resolves:
 *
 *   <<<<<<< yours
 *   your lines
 *   =======
 *   the current lines
 *   >>>>>>> current
 */

export const CONFLICT_START = "<<<<<<< yours";
export const CONFLICT_SEPARATOR = "=======";
export const CONFLICT_END = ">>>>>>> current";

export type MergeResult = { clean: boolean; text: string; conflicts: number };

function lines(text: string): string[] {
  if (text === "") return [];
  const result = text.split("\n");
  if (result.at(-1) === "") result.pop();
  return result;
}

/** The lines of each text as numbers: equal lines get the same number, so comparing them is cheap. */
function lineIds(...texts: string[][]): Int32Array[] {
  const ids = new Map<string, number>();
  return texts.map((list) =>
    Int32Array.from(list, (line) => {
      let id = ids.get(line);
      if (id === undefined) {
        id = ids.size;
        ids.set(line, id);
      }
      return id;
    }),
  );
}

/** Lines `oldStart..oldEnd` of the old text became lines `newStart..newEnd` of the new one. */
type Hunk = { oldStart: number; oldEnd: number; newStart: number; newEnd: number };

/**
 * The most work (comparisons and steps) one line diff may take, so that no
 * text within the page limit blocks the server for long. Past it, the diff
 * is one hunk from the first to the last changed line: still correct, only
 * coarser (a merge then conflicts instead of combining both changes).
 */
const DIFF_WORK_LIMIT = 2_000_000;

/** Work a diff may still take; diffs that share one take from it in turn. */
type Budget = { left: number };

/**
 * The most work all word merges of one `mergeText` take together (comparing
 * words, and the characters of the paragraphs they split). Past it, the
 * paragraphs left are conflicts, as without word merges.
 */
const WORD_MERGE_WORK_LIMIT = 2_000_000;

/** The same for the changed words that `diffTextLines` marks within changed lines. */
const WORD_DIFF_WORK_LIMIT = 1_000_000;

/** The changed parts between two texts (as line ids), in order. */
function diffHunks(
  before: Int32Array,
  after: Int32Array,
  budget: Budget = { left: DIFF_WORK_LIMIT },
): Hunk[] {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start += 1;
  let oldEnd = before.length;
  let newEnd = after.length;
  while (oldEnd > start && newEnd > start && before[oldEnd - 1] === after[newEnd - 1]) {
    oldEnd -= 1;
    newEnd -= 1;
  }
  if (start === oldEnd && start === newEnd) return [];
  const whole = [{ oldStart: start, oldEnd, newStart: start, newEnd }];
  // Only added or only removed lines.
  if (start === oldEnd || start === newEnd) return slideDown(whole, before, after);
  // The common end stays in: the diff matches lines as early as it can (a
  // kept paragraph keeps the blank line after it), cutting the end off
  // first would match them as late as possible.
  const hunks = shortestEdit(before.subarray(start), after.subarray(start), start, budget);
  return hunks ? slideDown(hunks, before, after) : whole;
}

/**
 * Moves removed or added runs as far down as they go without changing the
 * diff ("a, blank" rather than "blank, a" when a paragraph and its blank
 * line went away), so that changes to neighboring paragraphs merge cleanly.
 */
function slideDown(hunks: Hunk[], before: Int32Array, after: Int32Array): Hunk[] {
  hunks.forEach((hunk, index) => {
    const next = hunks[index + 1];
    // A common line must stay between this hunk and the next.
    const oldLimit = next ? next.oldStart - 1 : before.length;
    const newLimit = next ? next.newStart - 1 : after.length;
    const removed = hunk.newStart === hunk.newEnd;
    const added = hunk.oldStart === hunk.oldEnd;
    while (
      (removed && hunk.oldEnd < oldLimit && before[hunk.oldStart] === before[hunk.oldEnd]) ||
      (added && hunk.newEnd < newLimit && after[hunk.newStart] === after[hunk.newEnd])
    ) {
      hunk.oldStart += 1;
      hunk.oldEnd += 1;
      hunk.newStart += 1;
      hunk.newEnd += 1;
    }
  });
  return hunks;
}

/**
 * Myers' algorithm: the fewest lines removed and added that turn `a` into
 * `b`. Null when that takes more work than the budget has left (the work
 * done is taken from it). `offset` is added to the line numbers of the hunks.
 */
function shortestEdit(a: Int32Array, b: Int32Array, offset: number, budget: Budget): Hunk[] | null {
  const n = a.length;
  const m = b.length;
  // Round d takes at least 2d + 1 steps, so the limit also bounds the rounds.
  const rounds = Math.min(n + m, Math.ceil(Math.sqrt(Math.max(budget.left, 0))));
  const zero = rounds + 1;
  // furthest[zero + k]: the furthest line of `a` reached on diagonal k (= line of a - line of b).
  const furthest = new Int32Array(2 * zero + 1);
  // furthest of each round, for the way back.
  const trace: Int32Array[] = [];
  let work = 0;
  for (let d = 0; d <= rounds; d += 1) {
    for (let k = -d; k <= d; k += 2) {
      const down = k === -d || (k !== d && furthest[zero + k - 1]! < furthest[zero + k + 1]!);
      let x = down ? furthest[zero + k + 1]! : furthest[zero + k - 1]! + 1;
      let y = x - k;
      const from = x;
      while (x < n && y < m && a[x] === b[y]) {
        x += 1;
        y += 1;
      }
      furthest[zero + k] = x;
      work += x - from + 1;
      if (x >= n && y >= m) {
        budget.left -= work;
        trace.push(furthest.slice(zero - d, zero + d + 1));
        return hunksOf(trace, n, m, offset);
      }
      if (work > budget.left) {
        budget.left = 0;
        return null;
      }
    }
    trace.push(furthest.slice(zero - d, zero + d + 1));
  }
  budget.left = 0;
  return null;
}

/** Follows the rounds of `shortestEdit` back from the end and collects the removed and added lines as hunks. */
function hunksOf(trace: Int32Array[], n: number, m: number, offset: number): Hunk[] {
  const hunks: Hunk[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d > 0; d -= 1) {
    // Round d - 1 holds diagonals -(d - 1)..(d - 1) at indexes 0..2d - 2.
    const previous = trace[d - 1]!;
    const k = x - y;
    const down = k === -d || (k !== d && previous[k - 1 + d - 1]! < previous[k + 1 + d - 1]!);
    const previousK = down ? k + 1 : k - 1;
    const previousX = previous[previousK + d - 1]!;
    const previousY = previousX - previousK;
    // Going down adds line previousY of b; going right removes line previousX of a.
    const edit = down
      ? { oldStart: previousX, oldEnd: previousX, newStart: previousY, newEnd: previousY + 1 }
      : { oldStart: previousX, oldEnd: previousX + 1, newStart: previousY, newEnd: previousY };
    const last = hunks.at(-1);
    if (last && last.oldStart === edit.oldEnd && last.newStart === edit.newEnd) {
      last.oldStart = edit.oldStart;
      last.newStart = edit.newStart;
    } else {
      hunks.push(edit);
    }
    x = previousX;
    y = previousY;
  }
  hunks.reverse();
  for (const hunk of hunks) {
    hunk.oldStart += offset;
    hunk.oldEnd += offset;
    hunk.newStart += offset;
    hunk.newEnd += offset;
  }
  return hunks;
}

function sameLines(a: Int32Array, aStart: number, aEnd: number, b: Int32Array, bStart: number, bEnd: number) {
  if (aEnd - aStart !== bEnd - bStart) return false;
  for (let index = 0; index < aEnd - aStart; index += 1) {
    if (a[aStart + index] !== b[bStart + index]) return false;
  }
  return true;
}

/** The lines (or words) of one region that both sides changed differently. */
type Overlap = { base: string[]; yours: string[]; current: string[] };

/**
 * Three-way merge: `base` is the text both started from, `yours` the change
 * being saved, `current` the text saved meanwhile. Like diff3: the changes
 * of both sides against the base are combined. Where both changed the same
 * lines (or lines next to each other) differently, their words are merged
 * the same way; where both changed the same words, a conflict block shows
 * both versions of those lines.
 */
export function mergeText(base: string, yours: string, current: string): MergeResult {
  if (yours === current) return { clean: true, text: yours, conflicts: 0 };
  if (yours === base) return { clean: true, text: current, conflicts: 0 };
  if (current === base) return { clean: true, text: yours, conflicts: 0 };
  const wordBudget = { left: WORD_MERGE_WORK_LIMIT };
  let conflicts = 0;
  const output = combine(lines(base), lines(yours), lines(current), true, (overlap) => {
    const merged = mergeWords(overlap, wordBudget);
    if (merged) return merged;
    conflicts += 1;
    return [CONFLICT_START, ...overlap.yours, CONFLICT_SEPARATOR, ...overlap.current, CONFLICT_END];
  })!;
  const text = output.length > 0 ? `${output.join("\n")}\n` : "";
  return { clean: conflicts === 0, text, conflicts };
}

/**
 * Words, the spaces between them, line breaks and single other characters:
 * joined again, they are the text.
 */
const WORD = /[\p{L}\p{M}\p{N}_]+|[^\S\n]+|\n|[^\p{L}\p{M}\p{N}_\s]/gu;

function words(text: string): string[] {
  return text.match(WORD) ?? [];
}

/**
 * Merges the words of lines both sides changed. Null when both changed the
 * same words (or words next to each other), when the result does not keep
 * each side's changes exactly once (`keepsBothChanges`), or when the work
 * budget is spent.
 */
function mergeWords(overlap: Overlap, budget: Budget): string[] | null {
  const text = (list: string[]) => list.map((line) => `${line}\n`).join("");
  const texts = [text(overlap.base), text(overlap.yours), text(overlap.current)] as const;
  const size = texts[0].length + texts[1].length + texts[2].length;
  if (size > budget.left) return null;
  budget.left -= size;
  const [base, yours, current] = [words(texts[0]), words(texts[1]), words(texts[2])];
  const merged = combine(base, yours, current, budget, () => null);
  if (!merged || !keepsBothChanges(base, yours, current, merged)) return null;
  const joined = merged.join("");
  if (joined === "") return [];
  // Whole lines went in, so whole lines come out; anything else counts as a conflict.
  if (!joined.endsWith("\n")) return null;
  return joined.slice(0, -1).split("\n");
}

/**
 * True when the merge has every word as often as base plus both sides'
 * changes (yours + current − base). Repeated words make alignments
 * ambiguous: two diffs may match different copies of one word, and the
 * "clean" result then duplicates or drops words. Changes both sides made
 * alike also fail this, and conflict as before.
 */
function keepsBothChanges(base: string[], yours: string[], current: string[], merged: string[]): boolean {
  const counts = new Map<string, number>();
  const count = (list: string[], by: number) => {
    for (const word of list) counts.set(word, (counts.get(word) ?? 0) + by);
  };
  count(yours, 1);
  count(current, 1);
  count(base, -1);
  count(merged, -1);
  for (const left of counts.values()) if (left !== 0) return false;
  return true;
}

/**
 * The diff3 core of `mergeText`, for lines or words: the items of `base`
 * with the changes of both sides. `overlap` decides regions both sides
 * changed differently: the items to put there, or null to give up (then
 * `combine` returns null). `budget`: true gives each diff the usual work
 * limit; a shared budget is used up by the diffs in turn.
 */
function combine(
  base: string[],
  yours: string[],
  current: string[],
  budget: Budget | true,
  overlap: (region: Overlap) => string[] | null,
): string[] | null {
  const texts = { base, yours, current };
  const [baseIds, yoursIds, currentIds] = lineIds(texts.base, texts.yours, texts.current) as [
    Int32Array,
    Int32Array,
    Int32Array,
  ];
  const budgetOf = () => (budget === true ? { left: DIFF_WORK_LIMIT } : budget);
  // Sorted by where they start in the base; your hunks first where both start at the same line.
  const hunks = [
    ...diffHunks(baseIds, yoursIds, budgetOf()).map((hunk) => ({ ...hunk, yours: true })),
    ...diffHunks(baseIds, currentIds, budgetOf()).map((hunk) => ({ ...hunk, yours: false })),
  ].sort((first, second) => first.oldStart - second.oldStart);

  const output: string[] = [];
  const copy = (from: string[], start: number, end: number) => {
    for (let index = start; index < end; index += 1) output.push(from[index]!);
  };
  let position = 0;
  let index = 0;
  while (index < hunks.length) {
    // A region: hunks that overlap or touch in the base.
    const first = hunks[index]!;
    const regionStart = first.oldStart;
    let regionEnd = first.oldEnd;
    let next = index + 1;
    while (next < hunks.length && hunks[next]!.oldStart <= regionEnd) {
      regionEnd = Math.max(regionEnd, hunks[next]!.oldEnd);
      next += 1;
    }
    copy(texts.base, position, regionStart);
    if (next === index + 1) {
      copy(first.yours ? texts.yours : texts.current, first.newStart, first.newEnd);
    } else {
      // Both sides changed the region: each side's lines for all of it.
      const span = (yours: boolean) => {
        const sides = hunks.slice(index, next).filter((hunk) => hunk.yours === yours);
        const oldStart = Math.min(...sides.map((hunk) => hunk.oldStart));
        const oldEnd = Math.max(...sides.map((hunk) => hunk.oldEnd));
        const newStart = Math.min(...sides.map((hunk) => hunk.newStart));
        const newEnd = Math.max(...sides.map((hunk) => hunk.newEnd));
        return { start: newStart - (oldStart - regionStart), end: newEnd + (regionEnd - oldEnd) };
      };
      const mine = span(true);
      const theirs = span(false);
      if (sameLines(yoursIds, mine.start, mine.end, currentIds, theirs.start, theirs.end)) {
        copy(texts.yours, mine.start, mine.end);
      } else {
        const resolved = overlap({
          base: texts.base.slice(regionStart, regionEnd),
          yours: texts.yours.slice(mine.start, mine.end),
          current: texts.current.slice(theirs.start, theirs.end),
        });
        if (!resolved) return null;
        for (const item of resolved) output.push(item);
      }
    }
    position = regionEnd;
    index = next;
  }
  copy(texts.base, position, texts.base.length);
  return output;
}

/** True when the text still contains conflict blocks from a merge. */
export function hasConflictMarkers(text: string): boolean {
  return /^<<<<<<< yours$/m.test(text) && /^>>>>>>> current$/m.test(text);
}

export type TextEdit = { oldText: string; newText: string; replaceAll?: boolean };

export type EditResult = { ok: true; text: string } | { ok: false; index: number; message: string };

/**
 * Where `search` occurs in `text`, left to right, without overlaps; stops
 * after `limit` places. Knuth, Morris and Pratt's algorithm: linear time for
 * every input (indexOf takes quadratic time on some).
 */
function occurrences(text: string, search: string, limit: number): number[] {
  const positions: number[] = [];
  if (search.length > text.length) return positions;
  // fallback[i]: length of the longest proper prefix of search[0..i] that is also its suffix.
  const fallback = new Int32Array(search.length);
  for (let index = 1, matched = 0; index < search.length; index += 1) {
    const code = search.charCodeAt(index);
    while (matched > 0 && code !== search.charCodeAt(matched)) matched = fallback[matched - 1]!;
    if (code === search.charCodeAt(matched)) matched += 1;
    fallback[index] = matched;
  }
  const first = search.charAt(0);
  for (let index = 0, matched = 0; index < text.length; index += 1) {
    if (matched === 0) {
      // Skip to where a match can start (a fast search for one character).
      index = text.indexOf(first, index);
      if (index === -1) break;
    }
    const code = text.charCodeAt(index);
    while (matched > 0 && code !== search.charCodeAt(matched)) matched = fallback[matched - 1]!;
    if (code === search.charCodeAt(matched)) matched += 1;
    if (matched === search.length) {
      positions.push(index - matched + 1);
      if (positions.length >= limit) break;
      matched = 0;
    }
  }
  return positions;
}

/** Edits of one call replace at most this many places in all (each place costs time). */
export const MAX_REPLACEMENTS = 100_000;

/**
 * Applies "replace this exact text with that" edits in order, as coding
 * agents edit files. Each `oldText` must occur exactly once (or use
 * `replaceAll`), so an edit never lands in the wrong place. No edit may make
 * the text longer than a page may be.
 */
export function applyEdits(text: string, edits: TextEdit[]): EditResult {
  let result = text;
  let replaced = 0;
  for (const [index, edit] of edits.entries()) {
    if (edit.oldText === "") return { ok: false, index, message: `Edit ${index + 1}: oldText is empty` };
    const limit = edit.replaceAll ? MAX_REPLACEMENTS - replaced + 1 : Infinity;
    const positions = occurrences(result, edit.oldText, limit);
    if (positions.length === 0) {
      return {
        ok: false,
        index,
        message: `Edit ${index + 1}: oldText was not found. Read the page again and copy the text exactly, including line breaks.`,
      };
    }
    if (positions.length > 1 && !edit.replaceAll) {
      return {
        ok: false,
        index,
        message: `Edit ${index + 1}: oldText occurs ${positions.length} times. Include more surrounding text so it occurs once, or set replaceAll.`,
      };
    }
    replaced += positions.length;
    if (replaced > MAX_REPLACEMENTS) {
      return {
        ok: false,
        index,
        message: `Edit ${index + 1}: the edits replace more than ${MAX_REPLACEMENTS} places; replace fewer at a time`,
      };
    }
    if (
      result.length + positions.length * (edit.newText.length - edit.oldText.length) >
      MAX_PAGE_CHARACTERS
    ) {
      return {
        ok: false,
        index,
        message: `Edit ${index + 1}: a page may have at most ${MAX_PAGE_CHARACTERS} characters`,
      };
    }
    const parts: string[] = [];
    let last = 0;
    for (const position of positions) {
      parts.push(result.slice(last, position), edit.newText);
      last = position + edit.oldText.length;
    }
    parts.push(result.slice(last));
    result = parts.join("");
  }
  return { ok: true, text: result };
}

/** Added and removed lines between two texts. */
export function lineStats(before: string, after: string): { added: number; removed: number } {
  const [old, next] = lineIds(lines(before), lines(after)) as [Int32Array, Int32Array];
  let added = 0;
  let removed = 0;
  for (const hunk of diffHunks(old, next)) {
    removed += hunk.oldEnd - hunk.oldStart;
    added += hunk.newEnd - hunk.newStart;
  }
  return { added, removed };
}

/** A piece of a changed line; `changed` marks the words that differ from the paired line. */
export type DiffPart = { text: string; changed: boolean };

/**
 * One line of a diff. Changed lines paired with a line of the other side
 * (the first removed line of a change with its first added line, and so on)
 * have `parts` when asked for `words`: the line split where words changed.
 */
export type DiffLine = { kind: "same" | "added" | "removed"; text: string; parts?: DiffPart[] };

/**
 * A line diff for display. With `words`, changed lines that were edited
 * (not replaced) also mark which of their words changed.
 */
export function diffTextLines(before: string, after: string, options?: { words?: boolean }): DiffLine[] {
  const old = lines(before);
  const next = lines(after);
  const [oldIds, nextIds] = lineIds(old, next) as [Int32Array, Int32Array];
  const budget = { left: WORD_DIFF_WORK_LIMIT };
  const result: DiffLine[] = [];
  let position = 0;
  for (const hunk of diffHunks(oldIds, nextIds)) {
    for (; position < hunk.oldStart; position += 1) result.push({ kind: "same", text: old[position]! });
    const removed: DiffLine[] = [];
    const added: DiffLine[] = [];
    for (let index = hunk.oldStart; index < hunk.oldEnd; index += 1) {
      removed.push({ kind: "removed", text: old[index]! });
    }
    for (let index = hunk.newStart; index < hunk.newEnd; index += 1) {
      added.push({ kind: "added", text: next[index]! });
    }
    if (options?.words) {
      for (let index = 0; index < Math.min(removed.length, added.length); index += 1) {
        const parts = wordParts(removed[index]!.text, added[index]!.text, budget);
        if (parts) [removed[index]!.parts, added[index]!.parts] = parts;
      }
    }
    // One push per line: a hunk can have more lines than a call takes arguments.
    for (const line of removed) result.push(line);
    for (const line of added) result.push(line);
    position = hunk.oldEnd;
  }
  for (; position < old.length; position += 1) result.push({ kind: "same", text: old[position]! });
  return result;
}

/**
 * The words of two versions of a line, split where they differ. Null when
 * they share no word (the line was replaced, not edited) or the budget is spent.
 */
function wordParts(before: string, after: string, budget: Budget): [DiffPart[], DiffPart[]] | null {
  const size = before.length + after.length;
  if (size > budget.left) return null;
  budget.left -= size;
  const oldWords = words(before);
  const newWords = words(after);
  const [oldIds, newIds] = lineIds(oldWords, newWords) as [Int32Array, Int32Array];
  const hunks = diffHunks(oldIds, newIds, budget);
  const oldParts: DiffPart[] = [];
  const newParts: DiffPart[] = [];
  let sharesWord = false;
  let oldPosition = 0;
  hunks.forEach((hunk, index) => {
    const between = oldWords.slice(oldPosition, hunk.oldStart).join("");
    // Spaces alone between two changes belong to the change: "the helpdesk", not "the", "helpdesk".
    const changed = index > 0 && /^\s+$/.test(between);
    if (!changed && /[\p{L}\p{N}]/u.test(between)) sharesWord = true;
    pushPart(oldParts, between, changed);
    pushPart(newParts, between, changed);
    pushPart(oldParts, oldWords.slice(hunk.oldStart, hunk.oldEnd).join(""), true);
    pushPart(newParts, newWords.slice(hunk.newStart, hunk.newEnd).join(""), true);
    oldPosition = hunk.oldEnd;
  });
  const rest = oldWords.slice(oldPosition).join("");
  if (/[\p{L}\p{N}]/u.test(rest)) sharesWord = true;
  pushPart(oldParts, rest, false);
  pushPart(newParts, rest, false);
  return sharesWord ? [tidyParts(oldParts), tidyParts(newParts)] : null;
}

function pushPart(parts: DiffPart[], text: string, changed: boolean) {
  if (text === "") return;
  const last = parts.at(-1);
  if (last && last.changed === changed) last.text += text;
  else parts.push({ text, changed });
}

/** Spaces at the edges of a change go to the unchanged text next to it, so only words are marked. */
function tidyParts(parts: DiffPart[]): DiffPart[] {
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index]!;
    if (!part.changed) continue;
    const next = parts[index + 1];
    const trailing = part.text.slice(part.text.trimEnd().length);
    if (next && trailing && trailing.length < part.text.length) {
      part.text = part.text.slice(0, -trailing.length);
      next.text = trailing + next.text;
    }
    const previous = parts[index - 1];
    const leading = part.text.slice(0, part.text.length - part.text.trimStart().length);
    if (previous && leading && leading.length < part.text.length) {
      part.text = part.text.slice(leading.length);
      previous.text += leading;
    }
  }
  return parts;
}
