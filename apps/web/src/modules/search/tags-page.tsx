import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowLeft, Tags } from "lucide-react";
import type { PageSummary } from "@handbook/shared/api/pages";
import { Page as PageLayout, PageHeader } from "@/components/ui/page";
import { StatusBadge } from "@/components/page/status-badge";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { useT } from "@/i18n";
import { messages } from "./messages";

export const tagsQuery = {
  queryKey: ["tags"] as const,
  queryFn: () => api.get<{ items: { tag: string; count: number }[] }>("/tags"),
};

const tagPagesQuery = (tag: string) => ({
  queryKey: ["tag", tag] as const,
  queryFn: () => api.get<{ items: PageSummary[] }>(`/tags/${encodeURIComponent(tag)}/pages`),
});

/** Every tag with how many pages have it. */
export function TagsPage() {
  const t = useT(messages);
  const tags = useQuery(tagsQuery);
  return (
    <PageLayout className="max-w-4xl">
      <PageHeader title={t("tagsTitle")} description={t("tagsDescription")} />
      {tags.isPending ? (
        <LoadingState />
      ) : tags.error ? (
        <ErrorState error={tags.error} onRetry={() => void tags.refetch()} />
      ) : tags.data.items.length === 0 ? (
        <EmptyState icon={<Tags />} title={t("noTags")} description={t("noTagsHint")} />
      ) : (
        <ul className="flex flex-wrap gap-2">
          {[...tags.data.items]
            .sort((a, b) => a.tag.localeCompare(b.tag))
            .map((item) => (
              <li key={item.tag}>
                <Badge variant="secondary" className="px-3 py-1 text-sm" asChild>
                  <Link to="/tags/$tag" params={{ tag: item.tag }}>
                    {item.tag}
                    <span
                      className="text-muted-foreground ml-1 text-xs"
                      aria-label={t("pages", { count: item.count })}
                    >
                      {item.count}
                    </span>
                  </Link>
                </Badge>
              </li>
            ))}
        </ul>
      )}
    </PageLayout>
  );
}

/** The pages of one tag, from every space. */
export function TagPage({ tag }: { tag: string }) {
  const t = useT(messages);
  const pages = useQuery(tagPagesQuery(tag));
  return (
    <PageLayout className="max-w-4xl">
      <div className="space-y-2">
        <Button variant="link" className="h-auto px-0 text-sm" asChild>
          <Link to="/tags">
            <ArrowLeft />
            {t("allTags")}
          </Link>
        </Button>
        <PageHeader title={t("tagTitle", { tag })} />
      </div>
      {pages.isPending ? (
        <LoadingState />
      ) : pages.error ? (
        <ErrorState error={pages.error} onRetry={() => void pages.refetch()} />
      ) : pages.data.items.length === 0 ? (
        <EmptyState icon={<Tags />} title={t("noTagged")} />
      ) : (
        <ul className="divide-y rounded-md border">
          {pages.data.items.map((page) => (
            <li key={page.id} className="flex flex-col gap-0.5 p-4">
              <span className="flex flex-wrap items-center gap-2">
                <Link
                  to="/s/$space/$"
                  params={{ space: page.space, _splat: page.path }}
                  className="font-medium underline-offset-4 hover:underline"
                >
                  {page.title}
                </Link>
                <StatusBadge status={page.status} />
                <span className="text-muted-foreground text-xs">{page.space}</span>
              </span>
              {page.description ? (
                <span className="text-muted-foreground text-sm">{page.description}</span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </PageLayout>
  );
}
