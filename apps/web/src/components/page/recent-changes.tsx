import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ErrorState, LoadingState } from "@/components/ui/states";
import { useFormatter } from "@/lib/format";
import { defineMessages, useT } from "@/i18n";
import { recentQuery } from "./queries";

const messages = defineMessages({
  en: {
    empty: "No changes yet.",
    by: "{name}",
    via: "{name} via {client}",
    moved: "moved",
    deleted: "deleted",
    restored: "restored",
    edited: "edited",
  },
});

/** The latest page changes, of one space or all. */
export function RecentChanges({
  space,
  limit = 10,
  showSpace,
}: {
  space?: string;
  limit?: number;
  showSpace?: boolean;
}) {
  const t = useT(messages);
  const format = useFormatter();
  const query = useQuery(recentQuery(space, limit));
  if (query.isPending) return <LoadingState />;
  if (query.error) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  const items = query.data.items;
  if (items.length === 0) return <p className="text-muted-foreground text-sm">{t("empty")}</p>;
  const kind = { save: t("edited"), move: t("moved"), delete: t("deleted"), restore: t("restored") };
  return (
    <ul className="divide-y">
      {items.map(({ page, revision }) => (
        <li key={`${page.id}-${revision.number}`} className="flex flex-col gap-0.5 py-2.5">
          <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
            {revision.kind === "delete" ? (
              <span className="truncate font-medium">{page.title}</span>
            ) : (
              <Link
                to="/s/$space/$"
                params={{ space: page.space, _splat: page.path }}
                className="truncate font-medium underline-offset-4 hover:underline"
              >
                {page.title}
              </Link>
            )}
            {showSpace ? <span className="text-muted-foreground text-xs">{page.space}</span> : null}
          </span>
          <span className="text-muted-foreground text-xs">
            {kind[revision.kind]} ·{" "}
            {revision.author
              ? revision.clientName
                ? t("via", { name: revision.author.name, client: revision.clientName })
                : t("by", { name: revision.author.name })
              : null}{" "}
            · <time dateTime={revision.createdAt}>{format.relative(revision.createdAt)}</time>
          </span>
        </li>
      ))}
    </ul>
  );
}
