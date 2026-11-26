import { useId, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useBlocker, useNavigate } from "@tanstack/react-router";
import { ArrowLeft, FolderClosed, Link2 } from "lucide-react";
import { toast } from "sonner";
import type { ChangeSet } from "@handbook/shared/api/changes";
import type { Page } from "@handbook/shared/api/pages";
import type { FileInfo, Space } from "@handbook/shared/api/spaces";
import { newPageFile } from "@handbook/shared/page";
import { joinPath, slugify } from "@handbook/shared/paths";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { bodyOf, valuesOf, withBody, withValues } from "@/components/editor/file";
import { Page as PageLayout } from "@/components/ui/page";
import { PageEditor } from "@/components/editor/page-editor";
import { ChangeSetDialog, submitSuggestion } from "@/components/page/change-set-dialog";
import { changeSetQuery, spaceQuery, treeQuery } from "@/components/page/queries";
import { buildTree, flattenTree } from "@/components/page/tree";
import { ErrorState, LoadingState } from "@/components/ui/states";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { ApiError, api, errorMessage } from "@/lib/api";
import { cn } from "@/components/ui/utils";
import { useT } from "@/i18n";
import { messages } from "./messages";

const TOP = "__top";

/** A new page, created live (editors) or suggested in a change set. */
export function NewPagePage(props: { space: string; parent?: string; changeSet?: number | "new" }) {
  const space = useQuery(spaceQuery(props.space));
  const tree = useQuery(treeQuery(props.space));
  const changeSet = useQuery({
    ...changeSetQuery(typeof props.changeSet === "number" ? props.changeSet : 0),
    enabled: typeof props.changeSet === "number",
  });
  const error = space.error ?? tree.error ?? changeSet.error;
  if (error) {
    return (
      <PageLayout>
        <ErrorState error={error} />
      </PageLayout>
    );
  }
  if (!space.data || !tree.data || (typeof props.changeSet === "number" && !changeSet.data)) {
    return (
      <PageLayout>
        <LoadingState />
      </PageLayout>
    );
  }
  // Readers can only suggest.
  const target = props.changeSet ?? (space.data.abilities.editLive ? undefined : "new");
  return (
    <NewPageForm
      space={space.data}
      pages={flattenTree(buildTree(tree.data.items))}
      parent={props.parent}
      changeSet={target}
      changeSetTitle={changeSet.data?.title ?? null}
    />
  );
}

function NewPageForm(props: {
  space: Space;
  pages: { page: { id: string; path: string; title: string }; depth: number }[];
  parent?: string;
  changeSet: number | "new" | undefined;
  changeSetTitle: string | null;
}) {
  const t = useT(messages);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const slugId = useId();
  const schema = { properties: props.space.properties, pageTypes: props.space.pageTypes };
  const initial = newPageFile({ title: "" }, schema);
  const [file, setFile] = useState(initial);
  const [parent, setParent] = useState(
    props.parent && props.pages.some((item) => item.page.path === props.parent) ? props.parent : TOP,
  );
  const [slug, setSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);
  const [editingSlug, setEditingSlug] = useState(false);
  const [fields, setFields] = useState<Record<string, string> | undefined>();
  const [saving, setSaving] = useState(false);
  const [askChangeSet, setAskChangeSet] = useState(false);
  const [changeSetErrors, setChangeSetErrors] = useState<Record<string, string> | undefined>();
  const [createdNumber, setCreatedNumber] = useState<number | null>(
    typeof props.changeSet === "number" ? props.changeSet : null,
  );
  const allowLeave = useRef(false);
  // A change set made by this page's dialog: submitted for review once the page is in it.
  const submitAfterSave = useRef(false);

  const suggesting = props.changeSet !== undefined;
  const read = valuesOf(file);
  const values = "values" in read ? read.values : {};
  const title = typeof values.title === "string" ? values.title : "";
  const type = typeof values.type === "string" ? values.type : null;
  const effectiveSlug = slugEdited ? slug : title.trim() ? slugify(title) : "";
  const parentPath = parent === TOP ? null : parent;
  const path = effectiveSlug ? joinPath(parentPath, effectiveSlug) : (parentPath ?? "");
  const dirty = file !== initial;

  const blocker = useBlocker({
    shouldBlockFn: ({ current, next }) => !allowLeave.current && current.pathname !== next.pathname,
    enableBeforeUnload: () => !allowLeave.current && dirty,
    disabled: !dirty,
    withResolver: true,
  });

  const chooseType = (key: string | null) => {
    const previous = props.space.pageTypes.find((pageType) => pageType.key === type)?.template ?? "";
    const next = props.space.pageTypes.find((pageType) => pageType.key === key)?.template ?? "";
    let updated = withValues(file, { ...values, type: key }, schema);
    // Only replace the text while it is empty or still the previous template.
    const body = bodyOf(updated);
    if (body.trim() === "" || body.trim() === previous.trim()) updated = withBody(updated, next);
    setFile(updated);
  };

  const upload = async (picked: File) =>
    (await api.upload<FileInfo>(`/spaces/${encodeURIComponent(props.space.slug)}/files`, picked)).markdown;

  const done = (to: { page?: Page; number?: number }) => {
    allowLeave.current = true;
    if (to.number) void navigate({ to: "/changes/$number", params: { number: String(to.number) } });
    else if (to.page)
      void navigate({ to: "/s/$space/$", params: { space: to.page.space, _splat: to.page.path } });
  };

  const createLive = async () => {
    setSaving(true);
    setFields(undefined);
    try {
      const page = await api.post<Page>(`/spaces/${encodeURIComponent(props.space.slug)}/pages`, {
        parentPath,
        slug: effectiveSlug || undefined,
        markdown: file,
      });
      await queryClient.invalidateQueries({ queryKey: ["space", props.space.slug] });
      await queryClient.invalidateQueries({ queryKey: ["spaces"] });
      await queryClient.invalidateQueries({ queryKey: ["recent"] });
      toast.success(t("created"));
      done({ page });
    } catch (error) {
      if (error instanceof ApiError && error.fields) setFields(error.fields);
      toast.error(errorMessage(error));
    } finally {
      setSaving(false);
    }
  };

  const putInChangeSet = async (number: number) => {
    setSaving(true);
    setFields(undefined);
    try {
      await api.put<unknown>(`/change-sets/${number}/pages`, { path, markdown: file });
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
      toast.success(t(sent ? "suggestionSent" : "suggestionSaved", { number }));
      done({ number });
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
      const created = await api.post<ChangeSet>("/change-sets", { space: props.space.slug, ...value });
      submitAfterSave.current = true;
      setCreatedNumber(created.number);
      setAskChangeSet(false);
      setSaving(false);
      await putInChangeSet(created.number);
    } catch (error) {
      if (error instanceof ApiError && error.fields) setChangeSetErrors(error.fields);
      toast.error(errorMessage(error));
      setSaving(false);
    }
  };

  const save = () => {
    if (!title.trim()) {
      setFields({ "properties.title": t("titleFirst") });
      return;
    }
    if (!suggesting) return void createLive();
    if (createdNumber) return void putInChangeSet(createdNumber);
    setAskChangeSet(true);
  };

  const locationError = fields?.path ?? fields?.parentPath;
  const parentTitle =
    parent === TOP ? null : (props.pages.find((item) => item.page.path === parent)?.page.title ?? parent);
  const currentTemplate = props.space.pageTypes.find((pageType) => pageType.key === type)?.template ?? "";
  const body = bodyOf(file).trim();
  // Page types to start from, while nothing is written yet.
  const pristine = body === "" || body === currentTemplate.trim();
  const showTypes = props.space.pageTypes.length > 0 && pristine;
  const backTo =
    props.parent && parent !== TOP ? (
      <Link
        to="/s/$space/$"
        params={{ space: props.space.slug, _splat: parent }}
        aria-label={t("back")}
        title={t("back")}
      >
        <ArrowLeft />
      </Link>
    ) : (
      <Link to="/s/$space" params={{ space: props.space.slug }} aria-label={t("back")} title={t("back")}>
        <ArrowLeft />
      </Link>
    );

  const place = (
    <div className="mb-6">
      <Select value={parent} onValueChange={setParent}>
        <SelectTrigger
          size="sm"
          aria-label={t("parent")}
          aria-invalid={locationError ? true : undefined}
          className="text-foreground/80 h-8 max-w-full rounded-full px-3 text-[0.8125rem] shadow-none"
        >
          <FolderClosed className="size-3.5" />
          <SelectValue>
            <span className="truncate">
              {props.space.name}
              {parentTitle ? <span className="text-muted-foreground"> / {parentTitle}</span> : null}
            </span>
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={TOP}>{t("topLevel")}</SelectItem>
          {props.pages.map((item) => (
            <SelectItem key={item.page.id} value={item.page.path}>
              <span style={{ paddingLeft: `${item.depth * 0.75}rem` }}>{item.page.title}</span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {locationError ? <p className="text-destructive mt-1.5 text-sm">{locationError}</p> : null}
    </div>
  );

  const address = (
    <div className="mt-2.5">
      <div className="text-muted-foreground flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[0.8125rem]">
        <Link2 className="size-3.5 shrink-0" aria-hidden />
        {editingSlug ? (
          <>
            <span className="truncate">
              /s/{props.space.slug}/{parentPath ? `${parentPath}/` : ""}
            </span>
            <input
              id={slugId}
              aria-label={t("slug")}
              aria-invalid={fields?.slug ? true : undefined}
              value={effectiveSlug}
              onChange={(event) => {
                setSlugEdited(true);
                setSlug(event.target.value);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  setEditingSlug(false);
                }
              }}
              className="border-input bg-background text-foreground focus-visible:ring-ring/50 h-7 min-w-40 rounded-md border px-2 font-mono text-xs outline-none focus-visible:ring-[3px]"
            />
            <button
              type="button"
              onClick={() => setEditingSlug(false)}
              className="text-foreground underline underline-offset-4"
            >
              {t("done")}
            </button>
          </>
        ) : (
          <>
            <span className="min-w-0 truncate">
              /s/{props.space.slug}/{path ? <span className="text-foreground">{path}</span> : "…"}
            </span>
            <button
              type="button"
              onClick={() => setEditingSlug(true)}
              className="text-foreground underline underline-offset-4"
            >
              {t("changeAddress")}
            </button>
          </>
        )}
      </div>
      {fields?.slug ? <p className="text-destructive mt-1 text-sm">{fields.slug}</p> : null}
    </div>
  );

  const types = showTypes ? (
    <fieldset className="mt-9">
      <legend className="text-muted-foreground mb-3 text-xs font-semibold tracking-[0.07em] uppercase">
        {t("startFrom")}
      </legend>
      <div role="radiogroup" aria-label={t("pageType")} className="grid gap-3 sm:grid-cols-3">
        {[
          ...props.space.pageTypes.map((pageType) => ({
            key: pageType.key as string | null,
            label: pageType.label,
            help: pageType.help,
          })),
          { key: null, label: t("blank"), help: t("blankHelp") },
        ].map((option) => {
          const checked = type === option.key;
          return (
            <button
              key={option.key ?? "__blank"}
              type="button"
              role="radio"
              aria-checked={checked}
              onClick={() => chooseType(option.key)}
              className={cn(
                "hover:bg-muted/40 flex flex-col gap-1 rounded-xl border p-3.5 text-left transition-colors",
                checked && "border-foreground ring-foreground ring-1",
              )}
            >
              <span className="text-sm font-semibold">{option.label}</span>
              {option.help ? (
                <span className="text-muted-foreground line-clamp-2 text-[0.8125rem] leading-snug">
                  {option.help}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
    </fieldset>
  ) : null;

  return (
    <>
      <PageEditor
        file={file}
        onChange={setFile}
        space={props.space}
        path={path || "new-page"}
        fields={fields}
        onUpload={upload}
        onSave={() => {
          if (!saving) save();
        }}
        back={
          <Button variant="ghost" size="icon" className="rounded-full" asChild>
            {backTo}
          </Button>
        }
        context={
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="truncate font-medium">
              {suggesting
                ? t("suggestPageTitle", { space: props.space.name })
                : t("newPageTitle", { space: props.space.name })}
            </span>
            {createdNumber && props.changeSetTitle ? (
              <span className="text-muted-foreground truncate">
                · #{createdNumber} {props.changeSetTitle}
              </span>
            ) : null}
          </span>
        }
        status={dirty ? t("notSaved") : null}
        actions={
          <>
            <Button
              variant="ghost"
              className="hidden rounded-full sm:inline-flex"
              disabled={saving}
              onClick={() => void navigate({ to: "/s/$space", params: { space: props.space.slug } })}
            >
              {t("cancel")}
            </Button>
            <Button className="rounded-full px-4" onClick={save} disabled={saving}>
              {saving ? <Spinner /> : null}
              {suggesting ? t("saveSuggestion") : t("create")}
            </Button>
          </>
        }
        aboveTitle={place}
        belowTitle={address}
        belowDescription={types}
        typeChip={!showTypes}
        onTypeChange={chooseType}
      />

      {askChangeSet ? (
        <ChangeSetDialog
          open={askChangeSet}
          onOpenChange={setAskChangeSet}
          defaultTitle={title ? t("suggestNewTitle", { title }) : undefined}
          pending={saving}
          errors={changeSetErrors}
          onSubmit={(value) => void createChangeSet(value)}
        />
      ) : null}
      <ConfirmDialog
        open={blocker.status === "blocked"}
        onOpenChange={(open) => {
          if (!open) blocker.reset?.();
        }}
        title={t("leaveTitle")}
        description={t("leaveText")}
        confirmLabel={t("leave")}
        destructive
        onConfirm={() => blocker.proceed?.()}
      />
    </>
  );
}
