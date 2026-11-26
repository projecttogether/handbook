import { CircleCheck, CircleDot, CircleSlash, GitMerge } from "lucide-react";
import type { ChangeSetStatus } from "@handbook/shared/api/changes";
import { Badge } from "@/components/ui/badge";
import { defineMessages, useT } from "@/i18n";
import { cn } from "@/components/ui/utils";

const messages = defineMessages({
  en: { open: "Open", in_review: "In review", merged: "Merged", closed: "Closed" },
});

const STYLES: Record<ChangeSetStatus, string> = {
  open: "border-sky-600/30 bg-sky-500/10 text-sky-800 dark:text-sky-300",
  in_review: "border-amber-600/30 bg-amber-500/10 text-amber-800 dark:text-amber-300",
  merged: "border-violet-600/30 bg-violet-500/10 text-violet-800 dark:text-violet-300",
  closed: "border-border bg-muted text-muted-foreground",
};

const ICONS = { open: CircleDot, in_review: CircleCheck, merged: GitMerge, closed: CircleSlash };

/** The status of a change set: open, in review, merged or closed. */
export function ChangeSetStatusBadge({ status, className }: { status: ChangeSetStatus; className?: string }) {
  const t = useT(messages);
  const Icon = ICONS[status];
  return (
    <Badge variant="outline" className={cn(STYLES[status], className)}>
      <Icon aria-hidden />
      {t(status)}
    </Badge>
  );
}
