import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import type { RevisionSummary } from "@handbook/shared/api/pages";
import { Page as PageLayout, PageHeader } from "@/components/ui/page";
import { pageQuery, revisionsQuery } from "@/components/page/queries";
import { Pager } from "@/components/ui/pager";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useFormatter } from "@/lib/format";
import { useT } from "@/i18n";
import { messages } from "./messages";

/** What a revision did, in words. */
export function useRevisionLabel() {
  const t = useT(messages);
  return (revision: RevisionSummary) => {
    switch (revision.kind) {
      case "move":
        return t("kindMove", { path: revision.path });
      case "delete":
        return t("kindDelete");
      case "restore":
        return t("kindRestore");
      default:
        return t("kindSave");
    }
  };
}

/** Who made a revision and how: "Ada via Claude · from change set #4". */
export function RevisionMeta({ revision }: { revision: RevisionSummary }) {
  const t = useT(messages);
  return (
    <span className="text-muted-foreground text-sm">
      {revision.author?.name ?? ""}
      {revision.clientName ? ` ${t("viaAgent", { client: revision.clientName })}` : ""}
      {revision.changeSet ? (
        <>
          {" · "}
          <Link
            to="/changes/$number"
            params={{ number: String(revision.changeSet.number) }}
            className="underline underline-offset-4"
          >
            {t("fromChangeSet", { number: revision.changeSet.number })}
          </Link>
        </>
      ) : null}
    </span>
  );
}

const PAGE_SIZE = 50;

/** Every revision of a page, newest first, 50 at a time. */
export function HistoryPage(props: { pageId: string; page: number; onPage: (page: number) => void }) {
  const { pageId } = props;
  const t = useT(messages);
  const format = useFormatter();
  const page = useQuery(pageQuery(pageId));
  const revisions = useQuery(revisionsQuery(pageId, PAGE_SIZE, (props.page - 1) * PAGE_SIZE));
  const label = useRevisionLabel();

  if (page.error || revisions.error) {
    return (
      <PageLayout>
        <ErrorState error={page.error ?? revisions.error} onRetry={() => void revisions.refetch()} />
      </PageLayout>
    );
  }
  if (!page.data || !revisions.data) {
    return (
      <PageLayout>
        <LoadingState />
      </PageLayout>
    );
  }
  const items = [...revisions.data.items].sort((a, b) => b.number - a.number);
  return (
    <PageLayout>
      <div className="space-y-2">
        <Button variant="link" className="h-auto px-0 text-sm" asChild>
          <Link to="/s/$space/$" params={{ space: page.data.space, _splat: page.data.path }}>
            <ArrowLeft />
            {t("backToPage")}
          </Link>
        </Button>
        <PageHeader title={t("historyTitle", { title: page.data.title })} />
      </div>
      {items.length === 0 ? (
        <EmptyState title={t("noHistory")} />
      ) : (
        <ol className="divide-y rounded-md border">
          {items.map((revision) => (
            <li
              key={revision.number}
              className="flex flex-col gap-1 p-4 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="min-w-0 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <Link
                    to="/pages/$id/history/$number"
                    params={{ id: pageId, number: String(revision.number) }}
                    className="font-medium underline-offset-4 hover:underline"
                  >
                    {t("revision", { number: revision.number })}
                  </Link>
                  <span className="text-sm">{label(revision)}</span>
                  {revision.number === page.data.revision ? (
                    <Badge variant="secondary">{t("current")}</Badge>
                  ) : null}
                  {revision.kind === "save" ? (
                    <span className="font-mono text-xs">
                      <span className="text-green-700 dark:text-green-400">+{revision.added}</span>{" "}
                      <span className="text-red-700 dark:text-red-400">−{revision.removed}</span>
                    </span>
                  ) : null}
                </div>
                <RevisionMeta revision={revision} />
                {revision.message ? <p className="text-sm">{revision.message}</p> : null}
              </div>
              <time
                className="text-muted-foreground shrink-0 text-sm"
                dateTime={revision.createdAt}
                title={format.dateTime(revision.createdAt)}
              >
                {format.relative(revision.createdAt)}
              </time>
            </li>
          ))}
        </ol>
      )}
      {revisions.data.total > PAGE_SIZE ? (
        <Pager page={props.page} pageSize={PAGE_SIZE} total={revisions.data.total} onPage={props.onPage} />
      ) : null}
    </PageLayout>
  );
}
