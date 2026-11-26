import { useMemo, useState } from "react";
import { diffTextLines, type DiffLine } from "@handbook/shared/merge";
import { Button } from "@/components/ui/button";
import { defineMessages, useT } from "@/i18n";
import { cn } from "@/components/ui/utils";

const messages = defineMessages({
  en: {
    showAll: "Show all lines",
    unchanged: "{count} unchanged lines",
    unchanged_one: "1 unchanged line",
    noChanges: "No changes to the text.",
    added: "Added",
    removed: "Removed",
  },
});

/** Unchanged lines shown around each change. */
const CONTEXT = 3;

export type DiffBlock = { kind: "lines"; lines: DiffLine[] } | { kind: "gap"; count: number };

/** Groups a line diff for display: long unchanged runs become gaps, keeping CONTEXT lines around changes. */
export function diffBlocks(lines: DiffLine[], context = CONTEXT): DiffBlock[] {
  const blocks: DiffBlock[] = [];
  let index = 0;
  while (index < lines.length) {
    if (lines[index]!.kind !== "same") {
      const start = index;
      while (index < lines.length && lines[index]!.kind !== "same") index += 1;
      blocks.push({ kind: "lines", lines: lines.slice(start, index) });
      continue;
    }
    const start = index;
    while (index < lines.length && lines[index]!.kind === "same") index += 1;
    const run = lines.slice(start, index);
    const keepBefore = start === 0 ? 0 : context;
    const keepAfter = index === lines.length ? 0 : context;
    if (run.length <= keepBefore + keepAfter + 1) {
      blocks.push({ kind: "lines", lines: run });
    } else {
      if (keepBefore > 0) blocks.push({ kind: "lines", lines: run.slice(0, keepBefore) });
      blocks.push({ kind: "gap", count: run.length - keepBefore - keepAfter });
      if (keepAfter > 0) blocks.push({ kind: "lines", lines: run.slice(run.length - keepAfter) });
    }
  }
  return blocks;
}

const LINE_STYLES: Record<DiffLine["kind"], string> = {
  same: "text-foreground/80",
  added: "bg-emerald-500/10 text-emerald-900 dark:text-emerald-200",
  removed: "bg-rose-500/10 text-rose-900 dark:text-rose-200",
};

/** The words that changed within an edited line. */
const CHANGED_STYLES: Record<DiffLine["kind"], string> = {
  same: "",
  added: "rounded-sm bg-emerald-500/30",
  removed: "rounded-sm bg-rose-500/30 line-through decoration-rose-500/60",
};

const PREFIX: Record<DiffLine["kind"], string> = { same: " ", added: "+", removed: "−" };

/**
 * The text of a diff line, wrapped: in an edited line only the changed
 * words are marked; a line without parts is marked whole.
 */
export function DiffLineText({ line }: { line: DiffLine }) {
  if (!line.parts) {
    return (
      <span
        className={cn(
          "min-w-0 flex-1 [overflow-wrap:anywhere]",
          line.kind === "removed" && "line-through decoration-rose-500/40",
        )}
      >
        {line.text || " "}
      </span>
    );
  }
  return (
    <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
      {line.parts.map((part, index) =>
        part.changed ? (
          <mark key={index} className={cn("text-inherit", CHANGED_STYLES[line.kind])}>
            {part.text}
          </mark>
        ) : (
          <span key={index}>{part.text}</span>
        ),
      )}
    </span>
  );
}

/** A unified line diff of two texts (Markdown files), with long unchanged runs folded. */
export function LineDiff(props: { before: string; after: string; className?: string }) {
  const t = useT(messages);
  const [expanded, setExpanded] = useState(false);
  const lines = useMemo(
    () => diffTextLines(props.before, props.after, { words: true }),
    [props.before, props.after],
  );
  const blocks = useMemo(
    () => (expanded ? [{ kind: "lines" as const, lines }] : diffBlocks(lines)),
    [expanded, lines],
  );
  if (!lines.some((line) => line.kind !== "same")) {
    return <p className="text-muted-foreground text-sm">{t("noChanges")}</p>;
  }
  return (
    <div className={cn("rounded-md border font-mono text-xs leading-5", props.className)}>
      {blocks.map((block, blockIndex) =>
        block.kind === "gap" ? (
          <div
            key={blockIndex}
            className="bg-muted/60 text-muted-foreground flex items-center gap-2 px-3 py-0.5"
          >
            <span>{t("unchanged", { count: block.count })}</span>
            <Button variant="link" size="sm" className="h-auto p-0 text-xs" onClick={() => setExpanded(true)}>
              {t("showAll")}
            </Button>
          </div>
        ) : (
          block.lines.map((line, lineIndex) => (
            <div
              key={`${blockIndex}-${lineIndex}`}
              className={cn("flex px-3 whitespace-pre-wrap", LINE_STYLES[line.kind])}
            >
              <span aria-hidden className="w-4 shrink-0 select-none">
                {PREFIX[line.kind]}
              </span>
              {line.kind !== "same" ? <span className="sr-only">{t(line.kind)}: </span> : null}
              <DiffLineText line={line} />
            </div>
          ))
        ),
      )}
    </div>
  );
}
