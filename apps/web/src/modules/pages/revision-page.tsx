import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeft, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import type { Page } from "@handbook/shared/api/pages";
import { splitFrontmatter } from "@handbook/shared/page";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Page as PageLayout, PageHeader } from "@/components/ui/page";
import { MarkdownView } from "@/components/markdown";
import { DiffView } from "@/components/page/diff-view";
import { pageQuery, revisionQuery } from "@/components/page/queries";
import { ErrorState, LoadingState } from "@/components/ui/states";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api, errorMessage } from "@/lib/api";
import { useFormatter } from "@/lib/format";
import { useT } from "@/i18n";
import { RevisionMeta, useRevisionLabel } from "./history-page";
import { messages } from "./messages";

/** One revision of a page: what changed, and the page as it was. */
export function RevisionPage({ pageId, number }: { pageId: string; number: number }) {
  const t = useT(messages);
  const format = useFormatter();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const label = useRevisionLabel();
  const page = useQuery(pageQuery(pageId));
  const revision = useQuery(revisionQuery(pageId, number));
  const [restoring, setRestoring] = useState(false);

  if (page.error || revision.error) {
    return (
      <PageLayout>
        <ErrorState error={page.error ?? revision.error} onRetry={() => void revision.refetch()} />
      </PageLayout>
    );
  }
  if (!page.data || !revision.data) {
    return (
      <PageLayout>
        <LoadingState />
      </PageLayout>
    );
  }
  const current = page.data;
  const data = revision.data;
  const body = splitFrontmatter(data.markdown)?.body ?? data.markdown;

  const restore = async () => {
    try {
      const restored = await api.post<Page>(`/pages/${pageId}/revisions/${number}/restore`, {
        baseRevision: current.revision,
      });
      await queryClient.invalidateQueries({ queryKey: ["page", pageId] });
      await queryClient.invalidateQueries({ queryKey: ["page-by-path", current.space] });
      toast.success(t("restored"));
      void navigate({
        to: "/s/$space/$",
        params: { space: current.space, _splat: restored?.path ?? current.path },
      });
    } catch (error) {
      toast.error(errorMessage(error));
      throw error;
    }
  };

  return (
    <PageLayout>
      <div className="space-y-2">
        <Button variant="link" className="h-auto px-0 text-sm" asChild>
          <Link to="/pages/$id/history" params={{ id: pageId }}>
            <ArrowLeft />
            {t("history")}
          </Link>
        </Button>
        <PageHeader
          title={`${t("revision", { number })} · ${data.title}`}
          description={
            <span className="flex flex-wrap items-center gap-x-2">
              <span>{label(data)}</span>
              <span>{format.dateTime(data.createdAt)}</span>
              <RevisionMeta revision={data} />
            </span>
          }
          actions={
            current.abilities.editLive && number !== current.revision && data.kind !== "delete" ? (
              <Button variant="outline" onClick={() => setRestoring(true)}>
                <RotateCcw />
                {t("restoreVersion")}
              </Button>
            ) : null
          }
        />
        {data.message ? <p className="text-sm">{data.message}</p> : null}
      </div>
      <Tabs defaultValue="changes">
        <TabsList>
          <TabsTrigger value="changes">{t("changes")}</TabsTrigger>
          <TabsTrigger value="page">{t("page")}</TabsTrigger>
        </TabsList>
        <TabsContent value="changes" className="mt-3">
          {data.previousMarkdown === null ? (
            <p className="text-muted-foreground mb-3 text-sm">{t("firstRevision")}</p>
          ) : null}
          {data.previousMarkdown === data.markdown ? (
            <p className="text-muted-foreground text-sm">{t("noChanges")}</p>
          ) : (
            <DiffView before={data.previousMarkdown ?? ""} after={data.markdown} />
          )}
        </TabsContent>
        <TabsContent value="page" className="mt-3">
          <MarkdownView markdown={body} space={current.space} path={data.path} title={data.title} />
        </TabsContent>
      </Tabs>
      <ConfirmDialog
        open={restoring}
        onOpenChange={setRestoring}
        title={t("restoreTitle", { number })}
        description={t("restoreText")}
        confirmLabel={t("restoreVersion")}
        onConfirm={restore}
      />
    </PageLayout>
  );
}
