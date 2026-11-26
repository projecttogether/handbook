import { diffTextLines } from "@handbook/shared/merge";
import { DiffLineText } from "@/components/changes/line-diff";
import { cn } from "@/components/ui/utils";
import { defineMessages, useT } from "@/i18n";

const messages = defineMessages({
  en: {
    added: "Added",
    removed: "Removed",
    same: "Unchanged",
    label: "Changes",
    hidden: "{count} unchanged lines",
  },
});

const CONTEXT = 3;

/**
 * A line diff of two files: added lines green, removed red, long unchanged
 * stretches folded to a few lines of context.
 */
export function DiffView({
  before,
  after,
  className,
}: {
  before: string;
  after: string;
  className?: string;
}) {
  const t = useT(messages);
  const lines = diffTextLines(before, after, { words: true });
  const changed = lines.map((line) => line.kind !== "same");
  const visible = lines.map((_, index) => {
    for (let offset = -CONTEXT; offset <= CONTEXT; offset += 1) if (changed[index + offset]) return true;
    return false;
  });
  const rows: ({ kind: "line"; index: number } | { kind: "gap"; count: number })[] = [];
  lines.forEach((_, index) => {
    if (visible[index]) rows.push({ kind: "line", index });
    else {
      const last = rows.at(-1);
      if (last?.kind === "gap") last.count += 1;
      else rows.push({ kind: "gap", count: 1 });
    }
  });
  return (
    <div
      className={cn("rounded-md border font-mono text-xs leading-5", className)}
      role="table"
      aria-label={t("label")}
    >
      {rows.map((row, position) => {
        if (row.kind === "gap") {
          return (
            <div
              key={`gap-${position}`}
              className="bg-muted/50 text-muted-foreground px-3 py-1 italic"
              role="row"
            >
              {t("hidden", { count: row.count })}
            </div>
          );
        }
        const line = lines[row.index]!;
        return (
          <div
            key={row.index}
            role="row"
            className={cn(
              "flex gap-2 px-3 whitespace-pre-wrap",
              line.kind === "added" && "bg-green-500/10 text-green-900 dark:text-green-200",
              line.kind === "removed" && "bg-red-500/10 text-red-900 dark:text-red-200",
            )}
          >
            <span aria-label={t(line.kind)} className="w-3 shrink-0 select-none">
              {line.kind === "added" ? "+" : line.kind === "removed" ? "−" : " "}
            </span>
            <DiffLineText line={line} />
          </div>
        );
      })}
    </div>
  );
}
