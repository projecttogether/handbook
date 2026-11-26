import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { toast } from "sonner";
import { ArrowRight, ChevronDown, ChevronRight, Pencil, RefreshCw, TriangleAlert, Undo2 } from "lucide-react";
import type { ChangeSet, ChangeSetItem, ChangeSetPage } from "@handbook/shared/api/changes";
import { readFrontmatterValues, splitFrontmatter } from "@handbook/shared/page";
import { LineDiff } from "@/components/changes/line-diff";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { MarkdownView } from "@/components/markdown";
import { ErrorState, LoadingState } from "@/components/ui/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useT } from "@/i18n";
import { errorMessage } from "@/lib/api";
import { cn } from "@/components/ui/utils";
import { changeSetApi, useChangeSetAction, useChangeSetPage } from "./api";
import { messages } from "./messages";

type ItemKind = "create" | "update" | "move" | "delete";

/** What a change does to its page; an update that changes the path is a move. */
export function itemKind(item: ChangeSetItem): ItemKind {
  if (item.action === "update" && item.fromPath && item.fromPath !== item.path) return "move";
  return item.action;
}

const KIND_STYLES: Record<ItemKind, string> = {
  create: "border-emerald-600/30 bg-emerald-500/10 text-emerald-800 dark:text-emerald-300",
  update: "border-sky-600/30 bg-sky-500/10 text-sky-800 dark:text-sky-300",
  move: "border-violet-600/30 bg-violet-500/10 text-violet-800 dark:text-violet-300",
  delete: "border-rose-600/30 bg-rose-500/10 text-rose-800 dark:text-rose-300",
};

/** The body and title of a page file, for the preview. */
function previewOf(markdown: string): { body: string; title?: string } {
  const parts = splitFrontmatter(markdown);
  if (!parts) return { body: markdown };
  const values = readFrontmatterValues(parts.yaml);
  const title =
    "values" in values && typeof values.values.title === "string" ? values.values.title : undefined;
  return { body: parts.body, title };
}

function ItemDetails(props: { changeSet: ChangeSet; item: ChangeSetItem; page: ChangeSetPage }) {
  const t = useT(messages);
  const { page, item, changeSet } = props;
  const [view, setView] = useState<"diff" | "preview">("diff");
  const liveChanged = page.base !== null && page.live !== null && page.base !== page.live;
  const [compare, setCompare] = useState<"base" | "live">("base");
  const before = compare === "live" ? (page.live ?? "") : (page.base ?? page.live ?? "");
  const after = page.proposed ?? "";
  const preview = page.proposed ? previewOf(page.proposed) : null;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {page.proposed !== null ? (
          <Tabs value={view} onValueChange={(value) => setView(value as "diff" | "preview")}>
            <TabsList>
              <TabsTrigger value="diff">{t("viewDiff")}</TabsTrigger>
              <TabsTrigger value="preview">{t("viewPreview")}</TabsTrigger>
            </TabsList>
          </Tabs>
        ) : null}
        {view === "diff" && liveChanged ? (
          <Tabs value={compare} onValueChange={(value) => setCompare(value as "base" | "live")}>
            <TabsList>
              <TabsTrigger value="base">{t("compareBase")}</TabsTrigger>
              <TabsTrigger value="live">{t("compareLive")}</TabsTrigger>
            </TabsList>
          </Tabs>
        ) : null}
      </div>
      {liveChanged ? <p className="text-muted-foreground text-sm">{t("liveChanged")}</p> : null}
      {page.proposed === null ? <p className="text-sm font-medium">{t("deletedPage")}</p> : null}
      {view === "preview" && preview ? (
        <div className="rounded-md border p-4">
          {preview.title ? <h2 className="mb-3 text-xl font-semibold">{preview.title}</h2> : null}
          <MarkdownView
            markdown={preview.body}
            space={changeSet.space.slug}
            path={item.path}
            title={preview.title}
          />
        </div>
      ) : (
        <LineDiff before={before} after={after} />
      )}
    </div>
  );
}

function ItemPanel(props: { changeSet: ChangeSet; item: ChangeSetItem }) {
  const page = useChangeSetPage(props.changeSet.number, props.item.pageId, true);
  if (page.isLoading) return <LoadingState />;
  if (page.isError || !page.data)
    return <ErrorState error={page.error} onRetry={() => void page.refetch()} />;
  return <ItemDetails changeSet={props.changeSet} item={props.item} page={page.data} />;
}

function ItemRow(props: { changeSet: ChangeSet; item: ChangeSetItem }) {
  const t = useT(messages);
  const { changeSet, item } = props;
  const [open, setOpen] = useState(false);
  const [confirmUndo, setConfirmUndo] = useState(false);
  const kind = itemKind(item);
  const number = changeSet.number;
  const rebase = useChangeSetAction(() => changeSetApi.rebase(number, item.pageId));
  const undo = useChangeSetAction(() => changeSetApi.undo(number, item.pageId));
  const canEdit = changeSet.permissions.edit;

  return (
    <li className="py-3">
      <Collapsible open={open} onOpenChange={setOpen}>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
          <CollapsibleTrigger asChild>
            <Button
              variant="ghost"
              className="h-auto min-w-0 flex-1 justify-start gap-3 px-2 py-1.5 text-left whitespace-normal"
              aria-label={`${open ? t("hideChanges") : t("showChanges")}: ${item.title}`}
            >
              {open ? <ChevronDown className="shrink-0" /> : <ChevronRight className="shrink-0" />}
              <Badge variant="outline" className={cn("shrink-0", KIND_STYLES[kind])}>
                {t(`action_${kind}`)}
              </Badge>
              <span className="min-w-0 flex-1">
                <span className="block font-medium break-words">{item.title}</span>
                <span className="text-muted-foreground flex flex-wrap items-center gap-1 font-mono text-xs break-all">
                  {kind === "move" && item.fromPath ? (
                    <>
                      <span>{item.fromPath}</span>
                      <ArrowRight className="size-3" aria-hidden />
                    </>
                  ) : null}
                  <span>{item.path}</span>
                </span>
              </span>
              <span className="shrink-0 font-mono text-xs">
                <span
                  className="text-emerald-700 dark:text-emerald-400"
                  title={t("linesAdded", { count: item.added })}
                >
                  +{item.added}
                </span>{" "}
                <span
                  className="text-rose-700 dark:text-rose-400"
                  title={t("linesRemoved", { count: item.removed })}
                >
                  −{item.removed}
                </span>
              </span>
              {item.conflict ? (
                <Badge variant="destructive" className="shrink-0" title={t("conflictHint")}>
                  <TriangleAlert aria-hidden />
                  {t("conflict")}
                </Badge>
              ) : null}
            </Button>
          </CollapsibleTrigger>
          {canEdit ? (
            <div className="flex flex-wrap gap-2 pl-9 sm:pl-0">
              {item.action !== "delete" ? (
                <Button variant="outline" size="sm" asChild>
                  <Link to="/pages/$id/edit" params={{ id: item.pageId }} search={{ changeSet: number }}>
                    <Pencil />
                    {t("editInChangeSet")}
                  </Link>
                </Button>
              ) : null}
              {item.conflict ? (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={rebase.isPending}
                  onClick={() =>
                    rebase.mutate(undefined, {
                      onSuccess: () => toast.success(t("rebased")),
                      onError: (error) => toast.error(errorMessage(error)),
                    })
                  }
                >
                  <RefreshCw />
                  {t("rebase")}
                </Button>
              ) : null}
              <Button variant="ghost" size="sm" onClick={() => setConfirmUndo(true)}>
                <Undo2 />
                {t("undo")}
              </Button>
            </div>
          ) : null}
        </div>
        <CollapsibleContent className="pt-3 sm:pl-9">
          {open ? <ItemPanel changeSet={changeSet} item={item} /> : null}
        </CollapsibleContent>
      </Collapsible>
      <ConfirmDialog
        open={confirmUndo}
        onOpenChange={setConfirmUndo}
        title={t("undoTitle", { title: item.title })}
        description={t("undoDescription")}
        confirmLabel={t("undo")}
        destructive
        onConfirm={() =>
          undo.mutateAsync(undefined).then(
            () => toast.success(t("undone")),
            (error: unknown) => {
              toast.error(errorMessage(error));
              throw error;
            },
          )
        }
      />
    </li>
  );
}

/** The pages a change set changes, each with its diff and actions. */
export function ChangeSetItems(props: { changeSet: ChangeSet }) {
  const t = useT(messages);
  const { changeSet } = props;
  if (changeSet.items.length === 0) {
    return <p className="text-muted-foreground py-3 text-sm">{t("noItems")}</p>;
  }
  return (
    <ul className="divide-y">
      {changeSet.items.map((item) => (
        <ItemRow key={item.pageId} changeSet={changeSet} item={item} />
      ))}
    </ul>
  );
}
