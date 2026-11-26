import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { FolderClosed, Plus } from "lucide-react";
import type { ChangeSetSummary } from "@handbook/shared/api/changes";
import { spacesQuery } from "@/components/layout/app-layout";
import { Page as PageLayout, PageHeader } from "@/components/ui/page";
import { changeSetListQuery } from "@/components/page/queries";
import { RecentChanges } from "@/components/page/recent-changes";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useMe } from "@/hooks/use-me";
import { useFormatter } from "@/lib/format";
import { useT } from "@/i18n";
import { messages } from "./messages";

function ChangeSetList({ items, empty }: { items: ChangeSetSummary[]; empty: string }) {
  const t = useT(messages);
  const format = useFormatter();
  if (items.length === 0) return <p className="text-muted-foreground text-sm">{empty}</p>;
  return (
    <ul className="divide-y">
      {items.map((changeSet) => (
        <li key={changeSet.id} className="py-2.5">
          <Link
            to="/changes/$number"
            params={{ number: String(changeSet.number) }}
            className="font-medium underline-offset-4 hover:underline"
          >
            #{changeSet.number} {changeSet.title}
          </Link>
          <p className="text-muted-foreground text-xs">
            {changeSet.space.name} · {changeSet.status === "in_review" ? t("inReview") : t("open")} ·{" "}
            {changeSet.clientName
              ? t("byVia", { name: changeSet.author?.name ?? "", client: changeSet.clientName })
              : (changeSet.author?.name ?? "")}{" "}
            · {format.relative(changeSet.updatedAt)}
          </p>
        </li>
      ))}
    </ul>
  );
}

/** The start page: spaces, what changed, and change sets waiting for the person. */
export function HomePage() {
  const t = useT(messages);
  const me = useMe();
  const spaces = useQuery(spacesQuery);
  const inReview = useQuery(changeSetListQuery({ status: "in_review" }));
  const mine = useQuery(changeSetListQuery({ mine: true }));
  const editable = new Set(me.spaces.map((space) => space.slug));
  const waiting = (inReview.data?.items ?? []).filter((item) => me.isAdmin || editable.has(item.space.slug));

  return (
    <PageLayout>
      <PageHeader
        title={t("title")}
        description={t("description")}
        actions={
          me.isAdmin ? (
            <Button variant="outline" asChild>
              <Link to="/admin/spaces">
                <Plus />
                {t("createSpace")}
              </Link>
            </Button>
          ) : null
        }
      />
      <div className="grid min-w-0 gap-8 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <section aria-label={t("title")} className="min-w-0">
          {spaces.isPending ? (
            <LoadingState />
          ) : spaces.error ? (
            <ErrorState error={spaces.error} onRetry={() => void spaces.refetch()} />
          ) : spaces.data.items.length === 0 ? (
            <EmptyState
              icon={<FolderClosed />}
              title={t("noSpaces")}
              description={me.isAdmin ? t("noSpacesAdmin") : t("noSpacesReader")}
            />
          ) : (
            <ul className="grid gap-4 sm:grid-cols-2">
              {spaces.data.items.map((space) => (
                <li key={space.id}>
                  <Link
                    to="/s/$space"
                    params={{ space: space.slug }}
                    className="block h-full rounded-xl focus-visible:outline-2"
                  >
                    <Card className="hover:bg-accent/50 h-full transition-colors">
                      <CardHeader>
                        <CardTitle className="flex flex-wrap items-center gap-2">
                          <span className="truncate">{space.name}</span>
                          {space.myRole ? (
                            <Badge variant="secondary">
                              {space.myRole === "owner" ? t("owner") : t("editor")}
                            </Badge>
                          ) : null}
                          {space.archived ? <Badge variant="outline">{t("archived")}</Badge> : null}
                        </CardTitle>
                        {space.description ? (
                          <CardDescription className="line-clamp-3">{space.description}</CardDescription>
                        ) : null}
                        <p className="text-muted-foreground text-xs">
                          {t("pages", { count: space.pageCount })}
                        </p>
                      </CardHeader>
                    </Card>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
        <aside className="flex min-w-0 flex-col gap-6">
          {waiting.length > 0 || me.isAdmin || editable.size > 0 ? (
            <section aria-labelledby="home-waiting">
              <h2 id="home-waiting" className="mb-1 text-lg font-semibold">
                {t("waiting")}
              </h2>
              {inReview.isPending ? (
                <LoadingState />
              ) : (
                <ChangeSetList items={waiting} empty={t("noneWaiting")} />
              )}
            </section>
          ) : null}
          <section aria-labelledby="home-mine">
            <h2 id="home-mine" className="mb-1 text-lg font-semibold">
              {t("mine")}
            </h2>
            {mine.isPending ? (
              <LoadingState />
            ) : (
              <ChangeSetList items={mine.data?.items ?? []} empty={t("noneMine")} />
            )}
            <Link
              to="/changes"
              className="text-muted-foreground mt-2 inline-block text-sm underline underline-offset-4"
            >
              {t("allChanges")}
            </Link>
          </section>
          <section aria-labelledby="home-recent">
            <h2 id="home-recent" className="mb-1 text-lg font-semibold">
              {t("recent")}
            </h2>
            <RecentChanges limit={12} showSpace />
          </section>
        </aside>
      </div>
    </PageLayout>
  );
}
