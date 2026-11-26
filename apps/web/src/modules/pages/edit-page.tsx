import { useEffect, useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useBlocker, useNavigate } from "@tanstack/react-router";
import { AlertCircle, ArrowLeft, CheckCircle2, GitMerge, Lock, Pencil } from "lucide-react";
import { toast } from "sonner";
import type { ChangeSet } from "@handbook/shared/api/changes";
import type { Draft, Page } from "@handbook/shared/api/pages";
import type { FileInfo, Space } from "@handbook/shared/api/spaces";
import { hasConflictMarkers } from "@handbook/shared/merge";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { readPageConflict, saveBlocker, type PageConflict } from "@/components/editor/conflict";
import { lockToken, readLockHolder } from "@/components/editor/lock";
import { apiErrorOf, rawRequest } from "@/components/editor/raw-api";
import { useEditLock } from "@/components/editor/use-edit-lock";
import { discardDraft, useDraftAutosave } from "@/components/editor/use-draft";
import { Page as PageLayout } from "@/components/ui/page";
import { EditorBanner, PageEditor } from "@/components/editor/page-editor";
import { ChangeSetDialog, submitSuggestion } from "@/components/page/change-set-dialog";
import { changeSetPageQuery, changeSetQuery, pageQuery, spaceQuery } from "@/components/page/queries";
import { ErrorState, LoadingState } from "@/components/ui/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Spinner } from "@/components/ui/spinner";
import { ApiError, api, errorMessage } from "@/lib/api";
import { useFormatter } from "@/lib/format";
import { useT } from "@/i18n";
import { messages } from "./messages";

export type ChangeSetParam = number | "new" | undefined;

type EditorInit = {
  pageId: string;
  space: Space;
  path: string;
  title: string;
  file: string;
  baseRevision: number;
  mode: "live" | "changeSet";
  /** The change set to save into; null: create one on save. */
  changeSetNumber: number | null;
  changeSetTitle: string | null;
  draft: Page["draft"];
};

/**
 * The page editor. Live: with the edit lock, drafts and conflict merging.
 * With `changeSet`: saves into a change set (a suggestion), no lock.
 */
export function EditPage({ pageId, changeSet }: { pageId: string; changeSet: ChangeSetParam }) {
  const navigate = useNavigate();
  const number = typeof changeSet === "number" ? changeSet : null;
  const changeSetData = useQuery({ ...changeSetQuery(number ?? 0), enabled: number !== null });
  const item = useQuery({
    ...changeSetPageQuery(number ?? 0, pageId),
    enabled: number !== null,
    retry: false,
  });
  const itemMissing = item.error instanceof ApiError && item.error.status === 404;
  const needLive = number === null || itemMissing;
  const live = useQuery({ ...pageQuery(pageId), enabled: needLive, staleTime: Infinity });
  const spaceSlug = live.data?.space ?? changeSetData.data?.space.slug;
  const space = useQuery({ ...spaceQuery(spaceSlug ?? ""), enabled: Boolean(spaceSlug) });

  // Readers who open the live editor suggest instead.
  const mustSuggest = changeSet === undefined && live.data !== undefined && !live.data.abilities.editLive;
  useEffect(() => {
    if (mustSuggest) {
      void navigate({
        to: "/pages/$id/edit",
        params: { id: pageId },
        search: { changeSet: "new" },
        replace: true,
      });
    }
  }, [mustSuggest, navigate, pageId]);

  const error =
    (needLive ? live.error : null) ??
    (number !== null ? changeSetData.error : null) ??
    (number !== null && !itemMissing ? item.error : null) ??
    space.error;
  if (error) {
    return (
      <PageLayout>
        <ErrorState error={error} />
      </PageLayout>
    );
  }

  let init: EditorInit | null = null;
  if (space.data && !mustSuggest) {
    if (number !== null && item.data && changeSetData.data) {
      init = {
        pageId,
        space: space.data,
        path: item.data.item.path,
        title: item.data.item.title,
        file: item.data.proposed ?? item.data.live ?? "",
        baseRevision: item.data.item.baseRevision ?? 0,
        mode: "changeSet",
        changeSetNumber: number,
        changeSetTitle: changeSetData.data.title,
        draft: null,
      };
    } else if (live.data && (number === null || (itemMissing && changeSetData.data))) {
      init = {
        pageId,
        space: space.data,
        path: live.data.path,
        title: live.data.title,
        file: live.data.markdown,
        baseRevision: live.data.revision,
        mode: changeSet === undefined ? "live" : "changeSet",
        changeSetNumber: number,
        changeSetTitle: changeSetData.data?.title ?? null,
        draft: changeSet === undefined ? live.data.draft : null,
      };
    }
  }
  if (!init) {
    return (
      <PageLayout>
        <LoadingState />
      </PageLayout>
    );
  }
  return <Editor key={`${pageId}-${String(changeSet)}`} init={init} />;
}

function Editor({ init }: { init: EditorInit }) {
  const t = useT(messages);
  const format = useFormatter();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [file, setFile] = useState(init.file);
  const [savedFile, setSavedFile] = useState(init.file);
  const [baseRevision, setBaseRevision] = useState(init.baseRevision);
  const [conflict, setConflict] = useState<PageConflict | null>(null);
  const [fields, setFields] = useState<Record<string, string> | undefined>();
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [draftOpen, setDraftOpen] = useState(Boolean(init.draft));
  const [askChangeSet, setAskChangeSet] = useState(false);
  const [changeSetErrors, setChangeSetErrors] = useState<Record<string, string> | undefined>();
  const [createdNumber, setCreatedNumber] = useState<number | null>(init.changeSetNumber);
  // "Save as suggestion" after losing the lock turns the live editor into a suggestion.
  const [suggesting, setSuggesting] = useState(init.mode === "changeSet");
  const [confirmTakeover, setConfirmTakeover] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  const allowLeave = useRef(false);
  // A change set made by this editor's dialog: submitted for review once the change is in it.
  const submitAfterSave = useRef(false);

  const live = init.mode === "live";
  const lock = useEditLock(init.pageId, live);
  const lockStatus = lock.state.status;
  const dirty = file !== savedFile;
  const spaceSlug = init.space.slug;

  const { savedAt: draftSavedAt } = useDraftAutosave({
    pageId: init.pageId,
    file,
    baseRevision,
    savedFile,
    enabled: live && (lockStatus === "held" || lockStatus === "expired" || lockStatus === "lost"),
  });

  const blocker = useBlocker({
    shouldBlockFn: ({ current, next }) => !allowLeave.current && current.pathname !== next.pathname,
    enableBeforeUnload: () => !allowLeave.current && dirty,
    disabled: !dirty,
    withResolver: true,
  });

  const upload = async (picked: File) => {
    const info = await api.upload<FileInfo>(`/spaces/${encodeURIComponent(spaceSlug)}/files`, picked);
    return info.markdown;
  };

  const leaveTo = (to: { pathname: "page" | "changeSet"; number?: number; path?: string }) => {
    allowLeave.current = true;
    if (to.pathname === "changeSet" && to.number) {
      void navigate({ to: "/changes/$number", params: { number: String(to.number) } });
    } else {
      void navigate({ to: "/s/$space/$", params: { space: spaceSlug, _splat: to.path ?? init.path } });
    }
  };

  const invalidate = async (page?: Page) => {
    if (page) queryClient.setQueryData(pageQuery(init.pageId).queryKey, page);
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["page-by-path", spaceSlug] }),
      queryClient.invalidateQueries({ queryKey: ["space", spaceSlug] }),
      queryClient.invalidateQueries({ queryKey: ["recent"] }),
      queryClient.invalidateQueries({ queryKey: ["page", init.pageId] }),
    ]);
  };

  const saveLive = async () => {
    if (saveBlocker(file)) {
      toast.error(t("conflictMarkersLeft"));
      return;
    }
    setSaving(true);
    setFields(undefined);
    try {
      const response = await rawRequest("PUT", `/pages/${init.pageId}`, {
        body: {
          markdown: file,
          baseRevision,
          lockToken: lockToken(lock.state) ?? undefined,
          message: note.trim() || undefined,
        },
      });
      if (response.ok) {
        const page = response.body as Page;
        lock.forget();
        setSavedFile(file);
        void discardDraft(init.pageId);
        await invalidate(page);
        toast.success(page.revision > baseRevision + 1 ? t("mergedSaved") : t("saved"));
        leaveTo({ pathname: "page", path: page.path });
        return;
      }
      const conflictBody = response.status === 409 ? readPageConflict(response.body) : null;
      if (conflictBody) {
        setFile(conflictBody.merged);
        setBaseRevision(conflictBody.currentRevision);
        setConflict(conflictBody);
        toast.warning(t("conflictTitle"));
        return;
      }
      // Someone else opened the editor while this one's lock had ended.
      const holder = response.status === 423 ? readLockHolder(response.body) : null;
      if (holder && !holder.mine) lock.lostTo(holder.user.name);
      const error = apiErrorOf(response);
      if (error.fields) setFields(error.fields);
      toast.error(error.message);
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setSaving(false);
    }
  };

  const saveToChangeSet = async (number: number) => {
    setSaving(true);
    setFields(undefined);
    try {
      // The revision the text was written from: changes saved live meanwhile are merged, not undone.
      await api.put<unknown>(`/change-sets/${number}/pages`, {
        pageId: init.pageId,
        markdown: file,
        baseRevision: baseRevision > 0 ? baseRevision : undefined,
      });
      setSavedFile(file);
      let sent = false;
      if (submitAfterSave.current) {
        sent = await submitSuggestion(number).then(
          () => true,
          (error: unknown) => {
            toast.error(errorMessage(error));
            return false;
          },
        );
        submitAfterSave.current = false;
      }
      await queryClient.invalidateQueries({ queryKey: ["change-set", number] });
      await queryClient.invalidateQueries({ queryKey: ["change-sets"] });
      await queryClient.invalidateQueries({ queryKey: ["page", init.pageId] });
      toast.success(t(sent ? "suggestionSent" : "suggestionSaved", { number }));
      leaveTo({ pathname: "changeSet", number });
    } catch (error) {
      if (error instanceof ApiError && error.fields) setFields(error.fields);
      toast.error(errorMessage(error));
    } finally {
      setSaving(false);
    }
  };

  const createChangeSet = async (value: { title: string; description: string }) => {
    setSaving(true);
    setChangeSetErrors(undefined);
    try {
      const created = await api.post<ChangeSet>("/change-sets", { space: spaceSlug, ...value });
      submitAfterSave.current = true;
      setCreatedNumber(created.number);
      setAskChangeSet(false);
      setSaving(false);
      await saveToChangeSet(created.number);
    } catch (error) {
      if (error instanceof ApiError && error.fields) setChangeSetErrors(error.fields);
      toast.error(errorMessage(error));
      setSaving(false);
    }
  };

  const save = () => {
    if (!suggesting) return void saveLive();
    if (createdNumber) return void saveToChangeSet(createdNumber);
    setAskChangeSet(true);
  };

  // Leaving unmounts the editor, which releases the lock; unsaved text asks first.
  const cancel = () => void navigate({ to: "/s/$space/$", params: { space: spaceSlug, _splat: init.path } });

  const restoreDraft = async () => {
    try {
      const draft = await api.get<Draft>(`/pages/${init.pageId}/draft`);
      setFile(draft.markdown);
      setBaseRevision(draft.baseRevision);
      setDraftOpen(false);
      toast.success(t("draftRestored"));
    } catch (error) {
      toast.error(errorMessage(error));
    }
  };

  const copyText = async () => {
    try {
      await navigator.clipboard.writeText(file);
      toast.success(t("textCopied"));
    } catch (error) {
      toast.error(errorMessage(error));
    }
  };

  const lockBlocks =
    live && !suggesting && (lockStatus === "locked" || lockStatus === "acquiring" || lockStatus === "failed");
  // An expired lock still saves when nobody else took the page meanwhile (the server checks).
  const canSaveLive = lockStatus === "held" || lockStatus === "expired";
  const saveDisabled = saving || (!suggesting && !canSaveLive) || !dirty;

  let blocked: ReactNode = null;
  if (live && !suggesting && lock.state.status === "acquiring") {
    blocked = <LoadingState label={t("acquiring")} />;
  } else if (live && !suggesting && lock.state.status === "failed") {
    blocked = (
      <BlockedCard
        icon={<AlertCircle />}
        title={t("lockFailed", { message: lock.state.message })}
        actions={
          <Button className="rounded-full" onClick={lock.retry}>
            {t("retry")}
          </Button>
        }
      />
    );
  } else if (live && !suggesting && lock.state.status === "locked") {
    const holder = lock.state.holder;
    blocked = (
      <BlockedCard
        icon={<Lock />}
        title={t("lockedTitle")}
        text={
          holder.mine
            ? t("lockedMineText")
            : t("lockedText", { name: holder.user.name, time: format.relative(holder.since) })
        }
        actions={
          <>
            <Button
              className="rounded-full"
              onClick={() => (holder.mine ? void lock.takeOver() : setConfirmTakeover(true))}
            >
              {holder.mine ? t("editHere") : t("takeOver")}
            </Button>
            <Button variant="outline" className="rounded-full" asChild>
              <Link to="/pages/$id/edit" params={{ id: init.pageId }} search={{ changeSet: "new" }}>
                {t("suggestInstead")}
              </Link>
            </Button>
            <Button variant="ghost" className="rounded-full" asChild>
              <Link to="/s/$space/$" params={{ space: spaceSlug, _splat: init.path }}>
                {t("backToPage")}
              </Link>
            </Button>
          </>
        }
      />
    );
  }

  const banners = (
    <>
      {live && !suggesting && lock.state.status === "expired" ? (
        <EditorBanner tone="warning" icon={<Lock />} title={t("expiredTitle")}>
          {t("expiredText")}
        </EditorBanner>
      ) : null}
      {live && !suggesting && lock.state.status === "lost" ? (
        <EditorBanner
          tone="error"
          icon={<Lock />}
          title={t("lostTitle")}
          actions={
            <>
              <Button size="sm" variant="outline" onClick={() => void copyText()}>
                {t("copyText")}
              </Button>
              <Button
                size="sm"
                onClick={() => {
                  setSuggesting(true);
                  setAskChangeSet(true);
                }}
              >
                {t("saveAsSuggestion")}
              </Button>
            </>
          }
        >
          {lock.state.by ? t("lostText", { name: lock.state.by }) : t("lostTextUnknown")}
        </EditorBanner>
      ) : null}
      {live && draftOpen && init.draft ? (
        <EditorBanner
          icon={<Pencil />}
          title={t("draftTitle")}
          actions={
            <>
              <Button size="sm" onClick={() => void restoreDraft()}>
                {t("restoreDraft")}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  void discardDraft(init.pageId);
                  setDraftOpen(false);
                }}
              >
                {t("discardDraft")}
              </Button>
            </>
          }
        >
          {t("draftText", { time: format.relative(init.draft.updatedAt), revision: init.draft.baseRevision })}
        </EditorBanner>
      ) : null}
      {conflict ? (
        <EditorBanner
          tone={hasConflictMarkers(file) ? "warning" : "info"}
          icon={<GitMerge />}
          title={t("conflictTitle")}
        >
          {hasConflictMarkers(file)
            ? t("conflictText", { name: conflict.updatedBy ?? t("conflictSomeone") })
            : t("conflictResolved")}
        </EditorBanner>
      ) : null}
    </>
  );

  const status = saving ? (
    <>
      <Spinner />
      {t("saving")}
    </>
  ) : dirty && draftSavedAt ? (
    <>
      <CheckCircle2 className="text-emerald-600 dark:text-emerald-400" />
      {t("draftSaved")}
    </>
  ) : dirty ? (
    t("unsaved")
  ) : null;

  const actions = lockBlocks ? null : (
    <>
      <Button
        variant="ghost"
        className="hidden rounded-full sm:inline-flex"
        onClick={cancel}
        disabled={saving}
      >
        {t("cancel")}
      </Button>
      {suggesting ? (
        <Button className="rounded-full px-4" onClick={save} disabled={saveDisabled}>
          {saving ? <Spinner /> : null}
          {t("saveSuggestion")}
        </Button>
      ) : (
        <Popover open={noteOpen} onOpenChange={setNoteOpen}>
          <PopoverTrigger asChild>
            <Button className="rounded-full px-4" disabled={saveDisabled}>
              {saving ? <Spinner /> : null}
              {t("save")}
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-80">
            <form
              className="space-y-3"
              onSubmit={(event) => {
                event.preventDefault();
                setNoteOpen(false);
                void saveLive();
              }}
            >
              <div className="space-y-1.5">
                <Label htmlFor="edit-note">{t("note")}</Label>
                <Input
                  id="edit-note"
                  autoFocus
                  value={note}
                  maxLength={300}
                  placeholder={t("notePlaceholder")}
                  onChange={(event) => setNote(event.target.value)}
                />
                <p className="text-muted-foreground text-xs">{t("noteHelp")}</p>
              </div>
              <Button type="submit" className="w-full">
                {t("savePage")}
              </Button>
            </form>
          </PopoverContent>
        </Popover>
      )}
    </>
  );

  return (
    <>
      <PageEditor
        file={file}
        onChange={setFile}
        space={init.space}
        path={init.path}
        fields={fields}
        onUpload={upload}
        onActivity={lock.markActivity}
        onSave={() => {
          if (saveDisabled) return;
          if (suggesting) save();
          else void saveLive();
        }}
        back={
          <Button variant="ghost" size="icon" className="rounded-full" asChild>
            <Link
              to="/s/$space/$"
              params={{ space: spaceSlug, _splat: init.path }}
              aria-label={t("backToPage")}
              title={t("backToPage")}
            >
              <ArrowLeft />
            </Link>
          </Button>
        }
        context={
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="text-muted-foreground truncate">{init.space.name}</span>
            <span className="text-muted-foreground/60">/</span>
            <span className="truncate font-medium">{init.title}</span>
            {suggesting ? (
              createdNumber ? (
                <Link
                  to="/changes/$number"
                  params={{ number: String(createdNumber) }}
                  className="text-muted-foreground shrink-0 underline underline-offset-4"
                >
                  {t("changeSetLabel", { number: createdNumber, title: init.changeSetTitle ?? "" })}
                </Link>
              ) : (
                <Badge variant="secondary" className="shrink-0">
                  {t("suggestionBadge")}
                </Badge>
              )
            ) : null}
          </span>
        }
        status={status}
        actions={actions}
        banners={banners}
        blocked={blocked}
        typeChip
      />

      {askChangeSet ? (
        <ChangeSetDialog
          open={askChangeSet}
          onOpenChange={setAskChangeSet}
          pending={saving}
          errors={changeSetErrors}
          onSubmit={(value) => void createChangeSet(value)}
        />
      ) : null}
      <ConfirmDialog
        open={confirmTakeover}
        onOpenChange={setConfirmTakeover}
        title={t("takeOverTitle")}
        description={
          lock.state.status === "locked"
            ? t("takeOverText", { name: lock.state.holder.user.name })
            : undefined
        }
        confirmLabel={t("takeOver")}
        onConfirm={() => lock.takeOver()}
      />
      <ConfirmDialog
        open={blocker.status === "blocked"}
        onOpenChange={(open) => {
          if (!open) blocker.reset?.();
        }}
        title={t("leaveTitle")}
        description={live && !suggesting ? t("leaveText") : t("leaveTextSuggestion")}
        confirmLabel={t("leave")}
        destructive
        onConfirm={() => blocker.proceed?.()}
      />
    </>
  );
}

/** Instead of the editor: why the page cannot be edited here now, and what to do. */
function BlockedCard(props: { icon: ReactNode; title: string; text?: string; actions?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-5 text-center">
      <div className="bg-muted text-muted-foreground grid size-12 place-items-center rounded-full [&>svg]:size-5">
        {props.icon}
      </div>
      <div className="space-y-2">
        <h1 className="text-xl font-semibold tracking-tight">{props.title}</h1>
        {props.text ? <p className="text-muted-foreground">{props.text}</p> : null}
      </div>
      {props.actions ? <div className="flex flex-wrap justify-center gap-2">{props.actions}</div> : null}
    </div>
  );
}
