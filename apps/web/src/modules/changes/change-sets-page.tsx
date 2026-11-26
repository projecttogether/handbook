import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { GitPullRequestArrow } from "lucide-react";
import type { ChangeSetSummary } from "@handbook/shared/api/changes";
import { ChangeSetStatusBadge } from "@/components/changes/status-badge";
import { spacesQuery } from "@/components/layout/app-layout";
import { Page, PageHeader } from "@/components/ui/page";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/states";
import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useT } from "@/i18n";
import { useFormatter } from "@/lib/format";
import { useChangeSets, type ChangeSetFilters } from "./api";
import { useAuthorLabel } from "./author";
import { messages } from "./messages";

const STATUS_OPTIONS: ChangeSetFilters["status"][] = [
  "active",
  "open",
  "in_review",
  "merged",
  "closed",
  "all",
];
const ALL_SPACES = "__all__";

function ChangeSetRow({ item }: { item: ChangeSetSummary }) {
  const t = useT(messages);
  const format = useFormatter();
  const authorLabel = useAuthorLabel();
  return (
    <li>
      <Link
        to="/changes/$number"
        params={{ number: String(item.number) }}
        className="hover:bg-muted/50 focus-visible:bg-muted/50 flex flex-col gap-1.5 px-4 py-3 outline-none sm:flex-row sm:items-center sm:gap-4"
      >
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <ChangeSetStatusBadge status={item.status} />
            <span className="text-muted-foreground font-mono text-sm">#{item.number}</span>
            <span className="min-w-0 font-medium break-words">{item.title}</span>
          </div>
          <div className="text-muted-foreground flex flex-wrap gap-x-3 gap-y-0.5 text-sm">
            <span>{item.space.name}</span>
            <span>{t("by", { name: authorLabel(item.author, item.clientName) })}</span>
            <span>{t("pages", { count: item.pages })}</span>
          </div>
        </div>
        <time
          dateTime={item.updatedAt}
          title={format.dateTime(item.updatedAt)}
          className="text-muted-foreground shrink-0 text-sm"
        >
          {t("updated", { when: format.relative(item.updatedAt) })}
        </time>
      </Link>
    </li>
  );
}

export function ChangeSetsPage(props: {
  filters: ChangeSetFilters;
  onFilters: (filters: ChangeSetFilters) => void;
}) {
  const t = useT(messages);
  const { filters } = props;
  const list = useChangeSets(filters);
  const spaces = useQuery(spacesQuery).data?.items ?? [];
  const statusLabel = (status: ChangeSetFilters["status"]) =>
    status === "active" ? t("statusActive") : status === "all" ? t("statusAll") : t(`status_${status}`);

  return (
    <Page>
      <PageHeader title={t("title")} description={t("description")} />
      <div className="flex flex-wrap items-end gap-4">
        <div className="grid gap-1.5">
          <Label htmlFor="change-set-status">{t("filterStatus")}</Label>
          <Select
            value={filters.status}
            onValueChange={(value) =>
              props.onFilters({ ...filters, status: value as ChangeSetFilters["status"] })
            }
          >
            <SelectTrigger id="change-set-status" className="w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {STATUS_OPTIONS.map((status) => (
                <SelectItem key={status} value={status}>
                  {statusLabel(status)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="change-set-space">{t("filterSpace")}</Label>
          <Select
            value={filters.space ?? ALL_SPACES}
            onValueChange={(value) =>
              props.onFilters({ ...filters, space: value === ALL_SPACES ? undefined : value })
            }
          >
            <SelectTrigger id="change-set-space" className="w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_SPACES}>{t("allSpaces")}</SelectItem>
              {spaces.map((space) => (
                <SelectItem key={space.slug} value={space.slug}>
                  {space.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex h-9 items-center gap-2">
          <Switch
            id="change-set-mine"
            checked={filters.mine ?? false}
            onCheckedChange={(checked) => props.onFilters({ ...filters, mine: checked || undefined })}
          />
          <Label htmlFor="change-set-mine">{t("onlyMine")}</Label>
        </div>
      </div>
      {list.isLoading ? (
        <LoadingState />
      ) : list.isError || !list.data ? (
        <ErrorState error={list.error} onRetry={() => void list.refetch()} />
      ) : list.data.items.length === 0 ? (
        <EmptyState icon={<GitPullRequestArrow />} title={t("empty")} description={t("emptyHint")} />
      ) : (
        <Card className="py-0">
          <ul className="divide-y">
            {list.data.items.map((item) => (
              <ChangeSetRow key={item.id} item={item} />
            ))}
          </ul>
        </Card>
      )}
    </Page>
  );
}
