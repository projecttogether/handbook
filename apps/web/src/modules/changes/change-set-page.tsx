import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import {
  CircleAlert,
  CircleCheck,
  CircleSlash,
  FilePlus,
  GitMerge,
  MessageSquareWarning,
  Pencil,
  RotateCcw,
  Send,
  TriangleAlert,
  Undo2,
} from "lucide-react";
import type { ChangeSet } from "@handbook/shared/api/changes";
import { ChangeSetStatusBadge } from "@/components/changes/status-badge";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Page } from "@/components/ui/page";
import { MarkdownView } from "@/components/markdown";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/states";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { useT } from "@/i18n";
import { common } from "@/i18n/common";
import { ApiError, errorMessage } from "@/lib/api";
import { useFormatter } from "@/lib/format";
import {
  changeSetApi,
  mergeChangeSet,
  MergeConflictError,
  useChangeSet,
  useChangeSetAction,
  type MergeConflicts,
} from "./api";
import { useAuthorLabel } from "./author";
import { ChangeSetActivity } from "./change-set-activity";
import { ChangeSetItems } from "./change-set-items";
import { messages } from "./messages";

function EditDetailsDialog(props: {
  changeSet: ChangeSet;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useT(messages);
  const tc = useT(common);
  const [title, setTitle] = useState(props.changeSet.title);
  const [description, setDescription] = useState(props.changeSet.description);
  const save = useChangeSetAction((input: { title: string; description: string }) =>
    changeSetApi.update(props.changeSet.number, input),
  );
  const fields = save.error instanceof ApiError ? (save.error.fields ?? {}) : {};
  const submit = (event: FormEvent) => {
    event.preventDefault();
    save.mutate(
      { title: title.trim(), description: description.trim() },
      {
        onSuccess: () => {
          toast.success(t("saved"));
          props.onOpenChange(false);
        },
        onError: (error) => {
          if (!(error instanceof ApiError && error.fields)) toast.error(errorMessage(error));
        },
      },
    );
  };
  return (
    <Dialog open={props.open} onOpenChange={(open) => !save.isPending && props.onOpenChange(open)}>
      <DialogContent className="sm:max-w-xl">
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{t("editDetails")}</DialogTitle>
          </DialogHeader>
          <Field data-invalid={Boolean(fields.title)}>
            <FieldLabel htmlFor="change-set-title">{t("titleLabel")}</FieldLabel>
            <Input
              id="change-set-title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              maxLength={200}
              required
              aria-invalid={Boolean(fields.title)}
            />
            {fields.title ? <FieldError>{fields.title}</FieldError> : null}
          </Field>
          <Field data-invalid={Boolean(fields.description)}>
            <FieldLabel htmlFor="change-set-description">{t("descriptionLabel")}</FieldLabel>
            <Textarea
              id="change-set-description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              rows={6}
              maxLength={10_000}
            />
            <FieldDescription>{t("descriptionHint")}</FieldDescription>
            {fields.description ? <FieldError>{fields.description}</FieldError> : null}
          </Field>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => props.onOpenChange(false)}
              disabled={save.isPending}
            >
              {tc("cancel")}
            </Button>
            <Button type="submit" disabled={save.isPending || title.trim() === ""}>
              {save.isPending ? <Spinner /> : null}
              {t("save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function RequestChangesDialog(props: {
  changeSet: ChangeSet;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useT(messages);
  const tc = useT(common);
  const [body, setBody] = useState("");
  const send = useChangeSetAction((text: string) =>
    changeSetApi.requestChanges(props.changeSet.number, text),
  );
  const submit = (event: FormEvent) => {
    event.preventDefault();
    send.mutate(body.trim(), {
      onSuccess: () => {
        toast.success(t("changesRequested"));
        setBody("");
        props.onOpenChange(false);
      },
      onError: (error) => toast.error(errorMessage(error)),
    });
  };
  return (
    <Dialog open={props.open} onOpenChange={(open) => !send.isPending && props.onOpenChange(open)}>
      <DialogContent className="sm:max-w-xl">
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{t("requestChangesTitle")}</DialogTitle>
            <DialogDescription>{t("requestChangesHint")}</DialogDescription>
          </DialogHeader>
          <Field>
            <FieldLabel htmlFor="request-changes-body">{t("commentLabel")}</FieldLabel>
            <Textarea
              id="request-changes-body"
              value={body}
              onChange={(event) => setBody(event.target.value)}
              rows={5}
              maxLength={10_000}
              required
            />
          </Field>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => props.onOpenChange(false)}
              disabled={send.isPending}
            >
              {tc("cancel")}
            </Button>
            <Button type="submit" disabled={send.isPending || body.trim() === ""}>
              {send.isPending ? <Spinner /> : null}
              {t("requestChangesSend")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

type Confirming = "merge" | "close" | "revert" | null;

function Actions(props: { changeSet: ChangeSet; onConflicts: (conflicts: MergeConflicts | null) => void }) {
  const t = useT(messages);
  const navigate = useNavigate();
  const { changeSet } = props;
  const { permissions } = changeSet;
  const number = changeSet.number;
  const [editing, setEditing] = useState(false);
  const [requesting, setRequesting] = useState(false);
  const [confirming, setConfirming] = useState<Confirming>(null);
  const submit = useChangeSetAction(() => changeSetApi.submit(number));
  const reopen = useChangeSetAction(() => changeSetApi.reopen(number));
  const close = useChangeSetAction(() => changeSetApi.close(number));
  const merge = useChangeSetAction(() => mergeChangeSet(number));
  const revert = useChangeSetAction(() => changeSetApi.revert(number));

  const fail = (error: unknown) => {
    toast.error(errorMessage(error));
    throw error;
  };

  const runMerge = () =>
    merge.mutateAsync(undefined).then(
      () => {
        props.onConflicts(null);
        toast.success(t("merged"));
      },
      (error: unknown) => {
        if (error instanceof MergeConflictError) {
          props.onConflicts(error.conflicts);
          // The dialog closes; the conflicts show on the page.
          return;
        }
        return fail(error);
      },
    );

  const runRevert = () =>
    revert.mutateAsync(undefined).then((result) => {
      toast.success(result.merged ? t("revertedMerged") : t("revertedOpen"));
      void navigate({ to: "/changes/$number", params: { number: String(result.number) } });
    }, fail);

  return (
    <div className="flex flex-wrap items-center gap-2">
      {permissions.edit ? (
        <Button variant="outline" onClick={() => setEditing(true)}>
          <Pencil />
          {t("editDetails")}
        </Button>
      ) : null}
      {permissions.submit ? (
        <Button
          // The next step for authors: editors only see change sets in review.
          variant={permissions.merge ? "outline" : "default"}
          disabled={submit.isPending}
          onClick={() =>
            submit.mutate(undefined, {
              onSuccess: () => toast.success(t("submitted")),
              onError: (error) => toast.error(errorMessage(error)),
            })
          }
        >
          {submit.isPending ? <Spinner /> : <Send />}
          {t("submit")}
        </Button>
      ) : null}
      {permissions.review && changeSet.status === "in_review" ? (
        <Button variant="outline" onClick={() => setRequesting(true)}>
          <MessageSquareWarning />
          {t("requestChanges")}
        </Button>
      ) : null}
      {permissions.merge ? (
        <Button onClick={() => setConfirming("merge")}>
          <GitMerge />
          {t("merge")}
        </Button>
      ) : null}
      {permissions.reopen ? (
        <Button
          variant="outline"
          disabled={reopen.isPending}
          onClick={() =>
            reopen.mutate(undefined, {
              onSuccess: () => toast.success(t("reopened")),
              onError: (error) => toast.error(errorMessage(error)),
            })
          }
        >
          {reopen.isPending ? <Spinner /> : <RotateCcw />}
          {t("reopen")}
        </Button>
      ) : null}
      {permissions.revert ? (
        <Button variant="outline" onClick={() => setConfirming("revert")}>
          <Undo2 />
          {t("revert")}
        </Button>
      ) : null}
      {permissions.close ? (
        <Button variant="ghost" onClick={() => setConfirming("close")}>
          <CircleSlash />
          {t("close")}
        </Button>
      ) : null}

      {editing ? <EditDetailsDialog changeSet={changeSet} open={editing} onOpenChange={setEditing} /> : null}
      <RequestChangesDialog changeSet={changeSet} open={requesting} onOpenChange={setRequesting} />
      <ConfirmDialog
        open={confirming === "merge"}
        onOpenChange={(open) => setConfirming(open ? "merge" : null)}
        title={t("mergeTitle")}
        description={t("mergeDescription", { count: changeSet.items.length })}
        confirmLabel={t("merge")}
        onConfirm={runMerge}
      />
      <ConfirmDialog
        open={confirming === "close"}
        onOpenChange={(open) => setConfirming(open ? "close" : null)}
        title={t("closeTitle")}
        description={t("closeDescription")}
        confirmLabel={t("close")}
        onConfirm={() =>
          close.mutateAsync(undefined).then(() => {
            toast.success(t("closed"));
          }, fail)
        }
      />
      <ConfirmDialog
        open={confirming === "revert"}
        onOpenChange={(open) => setConfirming(open ? "revert" : null)}
        title={t("revertTitle")}
        description={t("revertDescription")}
        confirmLabel={t("revert")}
        destructive
        onConfirm={runRevert}
      />
    </div>
  );
}

function Checks({ changeSet }: { changeSet: ChangeSet }) {
  const t = useT(messages);
  if (changeSet.status === "merged" || changeSet.status === "closed") return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("checks")}</CardTitle>
      </CardHeader>
      <CardContent>
        {changeSet.checks.length === 0 ? (
          <p className="flex items-center gap-2 text-sm text-emerald-700 dark:text-emerald-400">
            <CircleCheck className="size-4" aria-hidden />
            {t("checksOk")}
          </p>
        ) : (
          <ul className="space-y-2">
            {changeSet.checks.map((check, index) => {
              const Icon = check.level === "error" ? CircleAlert : TriangleAlert;
              return (
                <li
                  key={`${check.pageId ?? "set"}-${index}`}
                  className={
                    check.level === "error"
                      ? "text-destructive flex gap-2 text-sm"
                      : "flex gap-2 text-sm text-amber-700 dark:text-amber-400"
                  }
                >
                  <Icon className="mt-0.5 size-4 shrink-0" aria-hidden />
                  <span className="sr-only">
                    {check.level === "error" ? t("checkError") : t("checkWarning")}:{" "}
                  </span>
                  <span className="min-w-0 break-words">
                    {check.path ? (
                      <>
                        <Link
                          to="/s/$space/$"
                          params={{ space: changeSet.space.slug, _splat: check.path }}
                          className="font-mono underline"
                        >
                          {check.path}
                        </Link>
                        {": "}
                      </>
                    ) : null}
                    {check.message}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function Header({ changeSet }: { changeSet: ChangeSet }) {
  const t = useT(messages);
  const format = useFormatter();
  const authorLabel = useAuthorLabel();
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <ChangeSetStatusBadge status={changeSet.status} />
        <Link
          to="/s/$space"
          params={{ space: changeSet.space.slug }}
          className="text-muted-foreground text-sm hover:underline"
        >
          {t("inSpace", { space: changeSet.space.name })}
        </Link>
      </div>
      <h1 className="text-2xl font-semibold tracking-tight break-words">
        <span className="text-muted-foreground font-normal">#{changeSet.number}</span> {changeSet.title}
      </h1>
      <div className="text-muted-foreground flex flex-wrap gap-x-4 gap-y-1 text-sm">
        <span>
          {t("openedBy", {
            name: authorLabel(changeSet.author, changeSet.clientName),
            when: format.relative(changeSet.createdAt),
          })}
        </span>
        {changeSet.mergedAt ? (
          <span>
            {changeSet.mergedBy
              ? t("mergedBy", { name: changeSet.mergedBy.name, when: format.relative(changeSet.mergedAt) })
              : t("mergedWhen", { when: format.relative(changeSet.mergedAt) })}
          </span>
        ) : null}
        {changeSet.revertOf ? (
          <Link to="/changes/$number" params={{ number: String(changeSet.revertOf) }} className="underline">
            {t("revertOf", { number: changeSet.revertOf })}
          </Link>
        ) : null}
        {changeSet.revertedBy ? (
          <Link to="/changes/$number" params={{ number: String(changeSet.revertedBy) }} className="underline">
            {t("revertedBy", { number: changeSet.revertedBy })}
          </Link>
        ) : null}
      </div>
    </div>
  );
}

function ConflictsAlert(props: { conflicts: MergeConflicts; space: string }) {
  const t = useT(messages);
  return (
    <Alert variant="destructive">
      <TriangleAlert />
      <AlertTitle>{t("mergeConflicts")}</AlertTitle>
      <AlertDescription>
        <ul className="list-disc space-y-1 pl-4">
          {props.conflicts.map((conflict) => (
            <li key={conflict.pageId}>
              <Link
                to="/s/$space/$"
                params={{ space: props.space, _splat: conflict.path }}
                className="font-mono underline"
              >
                {conflict.path}
              </Link>
              {conflict.reason ? `: ${conflict.reason}` : null}
            </li>
          ))}
        </ul>
        <p className="mt-2">{t("mergeConflictsHint")}</p>
      </AlertDescription>
    </Alert>
  );
}

export function ChangeSetView({ changeSet }: { changeSet: ChangeSet }) {
  const t = useT(messages);
  const [conflicts, setConflicts] = useState<MergeConflicts | null>(null);
  return (
    <Page>
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <Header changeSet={changeSet} />
        <Actions changeSet={changeSet} onConflicts={setConflicts} />
      </div>
      {conflicts && conflicts.length > 0 ? (
        <ConflictsAlert conflicts={conflicts} space={changeSet.space.slug} />
      ) : null}
      {changeSet.permissions.submit && !changeSet.permissions.merge ? (
        <Alert>
          <Send />
          <AlertTitle>{t("notSubmittedTitle")}</AlertTitle>
          <AlertDescription>{t("notSubmittedText")}</AlertDescription>
        </Alert>
      ) : null}
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="min-w-0 space-y-6">
          <Card>
            <CardContent>
              {changeSet.description ? (
                <MarkdownView markdown={changeSet.description} space={changeSet.space.slug} path="" />
              ) : (
                <p className="text-muted-foreground text-sm">{t("noDescription")}</p>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
              <CardTitle className="text-base">{t("changes")}</CardTitle>
              {changeSet.permissions.edit ? (
                <Button variant="outline" size="sm" asChild>
                  <Link
                    to="/s/$space/-/new"
                    params={{ space: changeSet.space.slug }}
                    search={{ changeSet: changeSet.number }}
                  >
                    <FilePlus />
                    {t("addPage")}
                  </Link>
                </Button>
              ) : null}
            </CardHeader>
            <CardContent>
              <ChangeSetItems changeSet={changeSet} />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t("activity")}</CardTitle>
            </CardHeader>
            <CardContent>
              <ChangeSetActivity changeSet={changeSet} />
            </CardContent>
          </Card>
        </div>
        <div className="space-y-6">
          <Checks changeSet={changeSet} />
        </div>
      </div>
    </Page>
  );
}

export function ChangeSetPage({ number }: { number: number }) {
  const t = useT(messages);
  const changeSet = useChangeSet(number);
  if (changeSet.isLoading) return <LoadingState />;
  if (changeSet.error instanceof ApiError && changeSet.error.status === 404) {
    return (
      <Page>
        <EmptyState title={t("notFound")} />
      </Page>
    );
  }
  if (changeSet.isError || !changeSet.data) {
    return (
      <Page>
        <ErrorState error={changeSet.error} onRetry={() => void changeSet.refetch()} />
      </Page>
    );
  }
  return <ChangeSetView changeSet={changeSet.data} />;
}
