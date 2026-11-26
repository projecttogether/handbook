import type { PageStatus } from "@handbook/shared/page";
import { Badge } from "@/components/ui/badge";
import { defineMessages, useT } from "@/i18n";

const messages = defineMessages({ en: { draft: "Draft", deprecated: "Deprecated", active: "Active" } });

/** Draft and deprecated pages get a badge; active pages none (unless `showActive`). */
export function StatusBadge({ status, showActive }: { status: PageStatus; showActive?: boolean }) {
  const t = useT(messages);
  if (status === "active" && !showActive) return null;
  return (
    <Badge
      variant={status === "active" ? "secondary" : "outline"}
      className={
        status === "draft"
          ? "border-amber-500/50 text-amber-700 dark:text-amber-300"
          : status === "deprecated"
            ? "border-red-500/50 text-red-700 dark:text-red-300"
            : undefined
      }
    >
      {t(status)}
    </Badge>
  );
}
