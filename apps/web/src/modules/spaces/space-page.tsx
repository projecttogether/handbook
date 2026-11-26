import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  Archive,
  Download,
  FilePlus2,
  FolderSearch,
  GitPullRequestArrow,
  MoreHorizontal,
  Settings,
  Trash2,
} from "lucide-react";
import { Page as PageLayout, PageHeader } from "@/components/ui/page";
import { PageTree } from "@/components/page/tree-view";
import { spaceQuery, treeQuery } from "@/components/page/queries";
import { RecentChanges } from "@/components/page/recent-changes";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/states";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ApiError, apiUrl } from "@/lib/api";
import { useT } from "@/i18n";
import { messages } from "./messages";

/** The start page of a space: its pages as a tree and recent changes. */
export function SpacePage({ space: slug }: { space: string }) {
  const t = useT(messages);
  const space = useQuery(spaceQuery(slug));
  const tree = useQuery(treeQuery(slug));

  if (!space.data) {
    const missing = space.error instanceof ApiError && space.error.status === 404;
    return (
      <PageLayout>
        {space.isPending ? (
          <LoadingState />
        ) : missing ? (
          <EmptyState icon={<FolderSearch />} title={t("notFound")} description={t("notFoundHint")} />
        ) : (
          <ErrorState error={space.error} onRetry={() => void space.refetch()} />
        )}
      </PageLayout>
    );
  }
  const data = space.data;
  const abilities = data.abilities;
  const pages = tree.data?.items ?? [];

  const newPage = abilities.editLive ? (
    <Button asChild>
      <Link to="/s/$space/-/new" params={{ space: slug }}>
        <FilePlus2 />
        {t("newPage")}
      </Link>
    </Button>
  ) : abilities.propose ? (
    <Button asChild>
      <Link to="/s/$space/-/new" params={{ space: slug }} search={{ changeSet: "new" }}>
        <GitPullRequestArrow />
        {t("suggestPage")}
      </Link>
    </Button>
  ) : null;

  return (
    <PageLayout>
      <PageHeader
        title={data.name}
        description={data.description || undefined}
        actions={
          <>
            {newPage}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="icon" aria-label={t("more")}>
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-64">
                {abilities.editLive && abilities.propose ? (
                  <DropdownMenuItem asChild>
                    <Link to="/s/$space/-/new" params={{ space: slug }} search={{ changeSet: "new" }}>
                      <GitPullRequestArrow />
                      {t("suggestPage")}
                    </Link>
                  </DropdownMenuItem>
                ) : null}
                <DropdownMenuItem asChild>
                  <a href={apiUrl(`/spaces/${encodeURIComponent(slug)}/export`)} download>
                    <Download />
                    {t("export")}
                  </a>
                </DropdownMenuItem>
                {abilities.editLive ? (
                  <DropdownMenuItem asChild>
                    <Link to="/s/$space/-/trash" params={{ space: slug }}>
                      <Trash2 />
                      {t("trash")}
                    </Link>
                  </DropdownMenuItem>
                ) : null}
                {abilities.manage ? (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem asChild>
                      <Link to="/s/$space/-/settings" params={{ space: slug }}>
                        <Settings />
                        {t("settings")}
                      </Link>
                    </DropdownMenuItem>
                  </>
                ) : null}
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        }
      />
      {data.archived ? (
        <Alert>
          <Archive />
          <AlertDescription>{t("archived")}</AlertDescription>
        </Alert>
      ) : null}
      {data.myRole ? (
        <p className="text-muted-foreground -mt-3 text-sm">
          {t("yourRole", { role: data.myRole === "owner" ? t("owner") : t("editor") })}
          {data.openChangeSets > 0 ? (
            <>
              {" "}
              <Link
                to="/changes"
                search={{ space: slug }}
                className="text-foreground underline underline-offset-4"
              >
                {t("openChanges", { count: data.openChangeSets })}
              </Link>
            </>
          ) : null}
        </p>
      ) : data.openChangeSets > 0 ? (
        <p className="-mt-3 text-sm">
          <Link to="/changes" search={{ space: slug }} className="underline underline-offset-4">
            {t("openChanges", { count: data.openChangeSets })}
          </Link>
        </p>
      ) : null}

      <div className="grid min-w-0 gap-8 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <section aria-labelledby="space-pages" className="min-w-0">
          <h2 id="space-pages" className="mb-3 text-lg font-semibold">
            {t("pages")}
          </h2>
          {tree.isPending ? (
            <LoadingState />
          ) : tree.error ? (
            <ErrorState error={tree.error} onRetry={() => void tree.refetch()} />
          ) : pages.length === 0 ? (
            <EmptyState
              title={t("noPages")}
              description={abilities.editLive ? t("noPagesEditor") : t("noPagesReader")}
              action={newPage}
            />
          ) : (
            <PageTree pages={pages} space={slug} label={t("pages")} />
          )}
        </section>
        <section aria-labelledby="space-recent" className="min-w-0">
          <h2 id="space-recent" className="mb-1 text-lg font-semibold">
            {t("recent")}
          </h2>
          <RecentChanges space={slug} limit={10} />
        </section>
      </div>
    </PageLayout>
  );
}
