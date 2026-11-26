import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { AlertCircle, FileCode, SlidersHorizontal, Type } from "lucide-react";
import type { Space } from "@handbook/shared/api/spaces";
import { markdownProblem } from "@handbook/shared/markdown";
import { hasConflictMarkers } from "@handbook/shared/merge";
import { splitFrontmatter } from "@handbook/shared/page";
import { LoadingState } from "@/components/ui/states";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/components/ui/utils";
import { defineMessages, useT } from "@/i18n";
import { bodyOf, valuesOf, withBody, withValues, type Values } from "./file";
import { PropertiesForm, propertyErrors } from "./properties-form";

const RichTextEditor = lazy(() =>
  import("./rich-text/rich-text-editor").then((module) => ({ default: module.RichTextEditor })),
);
const MarkdownEditor = lazy(() =>
  import("./markdown-editor").then((module) => ({ default: module.MarkdownEditor })),
);

const messages = defineMessages({
  en: {
    editorMode: "How to edit",
    richText: "Rich text",
    markdown: "Markdown",
    settings: "Page settings",
    settingsHelp: "The page's properties, saved at the top of its file.",
    editAsMarkdown: "Edit everything as Markdown",
    title: "Title",
    titlePlaceholder: "Title",
    description: "Description",
    descriptionPlaceholder: "Add a one-sentence description",
    body: "Page text",
    source: "Whole page file: frontmatter and Markdown",
    pageType: "Page type",
    noType: "No page type",
    yamlError: "The frontmatter cannot be read: {message}. Fix it in the Markdown view.",
    noFrontmatter:
      "The file must start with its properties between two “---” lines. Fix it in the Markdown view.",
    tooComplex: "Rich text cannot show this text: {message}. Edit it in the Markdown view.",
    conflictsOnly: "Resolve the conflicts in Markdown first.",
    propertyErrors: "Some properties need a look.",
    openSettings: "Open the page settings",
  },
});

export type EditorMode = "rich" | "markdown";
const MODE_KEY = "handbook.editorMode";

function storedMode(): EditorMode {
  try {
    return window.localStorage.getItem(MODE_KEY) === "markdown" ? "markdown" : "rich";
  } catch {
    return "rich";
  }
}

/** A banner under the editor's top bar: a state of the page or the save, with actions. */
export function EditorBanner(props: {
  tone?: "info" | "warning" | "error";
  icon: ReactNode;
  title?: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
}) {
  const tone = props.tone ?? "info";
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={cn(
        "border-b px-4 py-2.5 text-sm sm:px-6",
        tone === "info" && "bg-muted/50",
        tone === "warning" && "border-amber-500/30 bg-amber-500/10 text-amber-950 dark:text-amber-100",
        tone === "error" && "border-destructive/30 bg-destructive/10 text-destructive",
      )}
    >
      <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-x-3 gap-y-2">
        <span className="shrink-0 [&>svg]:size-4">{props.icon}</span>
        <p className="min-w-0 flex-1">
          {props.title ? <span className="font-semibold">{props.title} </span> : null}
          {props.children}
        </p>
        {props.actions ? <div className="flex flex-wrap items-center gap-2">{props.actions}</div> : null}
      </div>
    </div>
  );
}

/** A text field that looks like the page's title or description and grows with its text. */
function CanvasField(props: {
  value: string;
  onChange: (value: string) => void;
  label: string;
  placeholder: string;
  className: string;
  error?: string;
  readOnly?: boolean;
  onEnter?: () => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${element.scrollHeight}px`;
  }, [props.value]);
  return (
    <div>
      <textarea
        ref={ref}
        rows={1}
        value={props.value}
        aria-label={props.label}
        aria-invalid={props.error ? true : undefined}
        placeholder={props.placeholder}
        readOnly={props.readOnly}
        onChange={(event) => props.onChange(event.target.value.replace(/\s*\n\s*/g, " "))}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            props.onEnter?.();
          }
        }}
        className={cn(
          "placeholder:text-muted-foreground/45 block w-full resize-none overflow-hidden bg-transparent outline-none",
          props.className,
        )}
      />
      {props.error ? <p className="text-destructive mt-1 text-sm">{props.error}</p> : null}
    </div>
  );
}

export type PageEditorProps = {
  /** The whole page file: frontmatter and body. */
  file: string;
  onChange: (file: string) => void;
  space: Space;
  /** The page's path (or the planned path of a new page), for links and images. */
  path: string;
  /** Field errors of the last save (`properties.<key>`, `markdown`). */
  fields?: Record<string, string>;
  onUpload?: (file: File) => Promise<string>;
  onActivity?: () => void;
  readOnly?: boolean;
  /** Ctrl/Cmd+S. */
  onSave?: () => void;
  /** Top bar: the way back, where the page is, how saving goes, and the buttons. */
  back: ReactNode;
  context: ReactNode;
  status?: ReactNode;
  actions: ReactNode;
  /** Under the top bar: the page's and the save's states. */
  banners?: ReactNode;
  /** Instead of the page (someone else edits it, the editor is opening). */
  blocked?: ReactNode;
  /** On the page, above the title and below it (new pages: place and address). */
  aboveTitle?: ReactNode;
  belowTitle?: ReactNode;
  /** Below the description (new pages: page types to start from). */
  belowDescription?: ReactNode;
  /** A page type picker above the title. */
  typeChip?: boolean;
  /** Choosing a page type (new pages also fill in its template); default: set the property. */
  onTypeChange?: (type: string | null) => void;
  /** At the top of the settings sheet (new pages: place and address). */
  settingsExtra?: ReactNode;
};

/**
 * The page editor's frame: a quiet top bar, the page as it will look
 * (title, description, text) in rich text or as the Markdown file, and the
 * properties in a settings sheet. All of it edits one file string.
 */
export function PageEditor(props: PageEditorProps) {
  const t = useT(messages);
  const [mode, setModeState] = useState<EditorMode>(storedMode);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const read = valuesOf(props.file);
  const hasFrontmatter = splitFrontmatter(props.file) !== null;
  const values = "values" in read ? read.values : null;
  const normalized = props.file.replace(/\r\n?/g, "\n");
  const body = bodyOf(normalized);
  const conflicts = hasConflictMarkers(props.file);
  // Only text can show conflict blocks, a file without readable frontmatter, and Markdown
  // the parser would take too long on (the page view checks the same before showing it).
  // Line numbers of the whole file, as the Markdown view shows it.
  const problem = markdownProblem(
    body,
    normalized.slice(0, normalized.length - body.length).split("\n").length,
  );
  const forced = conflicts || values === null || !hasFrontmatter || problem !== null;
  const effective: EditorMode = forced ? "markdown" : mode;
  const schema = { properties: props.space.properties, pageTypes: props.space.pageTypes };
  const errors = propertyErrors(props.fields);
  const otherErrors = Object.keys(errors).some((key) => key !== "title" && key !== "description");
  const title = values && typeof values.title === "string" ? values.title : "";
  const description = values && typeof values.description === "string" ? values.description : "";
  const type = values && typeof values.type === "string" ? values.type : null;
  const canvas = useRef<HTMLDivElement>(null);

  const setMode = (next: EditorMode) => {
    setModeState(next);
    try {
      window.localStorage.setItem(MODE_KEY, next);
    } catch {
      // The choice then lasts until reload.
    }
  };

  const setValues = (next: Values) => {
    if (props.onTypeChange && (next.type ?? null) !== type) {
      props.onTypeChange(typeof next.type === "string" ? next.type : null);
      return;
    }
    props.onChange(withValues(props.file, next, schema));
    props.onActivity?.();
  };

  const onSave = useRef(props.onSave);
  onSave.current = props.onSave;
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "s") {
        event.preventDefault();
        onSave.current?.();
      }
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);

  const focusBody = () => canvas.current?.querySelector<HTMLElement>("[contenteditable=true]")?.focus();
  const focusDescription = () =>
    canvas.current?.querySelector<HTMLTextAreaElement>(`textarea[aria-label="${t("description")}"]`)?.focus();

  const typeChip =
    props.typeChip && props.space.pageTypes.length > 0 ? (
      <Select
        value={type ?? "__none"}
        disabled={props.readOnly}
        onValueChange={(next) => values && setValues({ ...values, type: next === "__none" ? null : next })}
      >
        <SelectTrigger
          size="sm"
          aria-label={t("pageType")}
          className="text-muted-foreground mb-4 h-7 rounded-full px-3 text-xs font-semibold tracking-[0.07em] uppercase shadow-none"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="__none">{t("noType")}</SelectItem>
          {type && !props.space.pageTypes.some((pageType) => pageType.key === type) ? (
            <SelectItem value={type}>{type}</SelectItem>
          ) : null}
          {props.space.pageTypes.map((pageType) => (
            <SelectItem key={pageType.key} value={pageType.key}>
              {pageType.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    ) : null;

  return (
    <div className="flex min-h-svh flex-col">
      <header className="bg-background/90 supports-[backdrop-filter]:bg-background/75 sticky top-0 z-40 border-b backdrop-blur">
        <div className="flex h-14 items-center gap-1.5 px-2 sm:gap-2.5 sm:px-4">
          {props.back}
          <div className="flex min-w-0 flex-1 items-center gap-3 text-sm">
            <span className="hidden min-w-0 truncate md:inline">{props.context}</span>
            {props.status ? (
              <span className="text-muted-foreground flex min-w-0 items-center gap-1.5 text-[0.8125rem] [&>svg]:size-3.5 [&>svg]:shrink-0">
                {props.status}
              </span>
            ) : null}
          </div>
          {props.blocked ? null : (
            <>
              <div
                role="group"
                aria-label={t("editorMode")}
                className="bg-muted flex items-center rounded-full p-0.5"
              >
                {(["rich", "markdown"] as const).map((value) => (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={effective === value}
                    aria-label={t(value === "rich" ? "richText" : "markdown")}
                    disabled={forced && value === "rich"}
                    title={forced && value === "rich" ? t("conflictsOnly") : undefined}
                    onClick={() => setMode(value)}
                    className={cn(
                      "flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[0.8125rem] font-medium transition-colors disabled:opacity-50 sm:px-3",
                      effective === value
                        ? "bg-background text-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {value === "rich" ? <Type className="size-3.5" /> : <FileCode className="size-3.5" />}
                    <span className="hidden sm:inline">{t(value === "rich" ? "richText" : "markdown")}</span>
                  </button>
                ))}
              </div>
              <Button
                variant="ghost"
                size="icon"
                className="rounded-full"
                aria-label={t("settings")}
                title={t("settings")}
                onClick={() => setSettingsOpen(true)}
              >
                <SlidersHorizontal />
              </Button>
            </>
          )}
          {props.actions}
        </div>
      </header>

      {props.blocked ? null : (
        <>
          {props.banners}
          {!hasFrontmatter ? (
            <EditorBanner tone="error" icon={<AlertCircle />}>
              {t("noFrontmatter")}
            </EditorBanner>
          ) : null}
          {problem !== null && hasFrontmatter ? (
            <EditorBanner tone="warning" icon={<AlertCircle />}>
              {t("tooComplex", { message: problem })}
            </EditorBanner>
          ) : null}
          {values === null && "error" in read ? (
            <EditorBanner tone="error" icon={<AlertCircle />}>
              {t("yamlError", { message: read.error })}
            </EditorBanner>
          ) : null}
          {props.fields?.markdown ? (
            <EditorBanner tone="error" icon={<AlertCircle />}>
              {props.fields.markdown}
            </EditorBanner>
          ) : null}
          {otherErrors ? (
            <EditorBanner
              tone="error"
              icon={<AlertCircle />}
              actions={
                <Button size="sm" variant="outline" onClick={() => setSettingsOpen(true)}>
                  {t("openSettings")}
                </Button>
              }
            >
              {t("propertyErrors")}
            </EditorBanner>
          ) : null}
        </>
      )}

      <div className="flex-1">
        {props.blocked ? (
          <div className="mx-auto w-full max-w-xl px-5 py-16 sm:py-24">{props.blocked}</div>
        ) : (
          <div
            ref={canvas}
            className={cn(
              "mx-auto w-full px-5 pt-10 pb-[40vh] sm:pt-16",
              effective === "rich" ? "max-w-[calc(42.5rem+2.5rem)] sm:px-5" : "max-w-4xl",
            )}
          >
            {props.aboveTitle}
            {effective === "rich" && values ? (
              <>
                {typeChip}
                <CanvasField
                  value={title}
                  onChange={(next) => setValues({ ...values, title: next })}
                  label={t("title")}
                  placeholder={t("titlePlaceholder")}
                  error={errors.title}
                  readOnly={props.readOnly}
                  onEnter={focusDescription}
                  className="text-[2rem] leading-[1.15] font-bold tracking-[-0.024em] sm:text-[2.75rem] sm:leading-[1.16]"
                />
                {props.belowTitle}
                <div className="mt-3">
                  <CanvasField
                    value={description}
                    onChange={(next) => setValues({ ...values, description: next })}
                    label={t("description")}
                    placeholder={t("descriptionPlaceholder")}
                    error={errors.description}
                    readOnly={props.readOnly}
                    onEnter={focusBody}
                    className="text-muted-foreground text-lg leading-snug sm:text-[1.375rem] sm:leading-[1.4]"
                  />
                </div>
                {props.belowDescription}
                <div className="mt-10" data-page-body>
                  <Suspense fallback={<LoadingState />}>
                    <RichTextEditor
                      value={body}
                      onChange={(next) => props.onChange(withBody(props.file, next))}
                      space={props.space.slug}
                      path={props.path}
                      onUpload={props.onUpload}
                      onActivity={props.onActivity}
                      readOnly={props.readOnly}
                      label={t("body")}
                    />
                  </Suspense>
                </div>
              </>
            ) : (
              <Suspense fallback={<LoadingState />}>
                {props.belowTitle ? <div className="mb-6">{props.belowTitle}</div> : null}
                <MarkdownEditor
                  value={props.file}
                  onChange={props.onChange}
                  space={props.space.slug}
                  onUpload={props.onUpload}
                  onActivity={props.onActivity}
                  label={t("source")}
                  readOnly={props.readOnly}
                  minHeight="60vh"
                />
              </Suspense>
            )}
          </div>
        )}
      </div>

      <Sheet open={settingsOpen} onOpenChange={setSettingsOpen}>
        <SheetContent side="right" className="w-full gap-0 overflow-y-auto sm:max-w-md">
          <SheetHeader className="border-b">
            <SheetTitle>{t("settings")}</SheetTitle>
            <SheetDescription>{t("settingsHelp")}</SheetDescription>
          </SheetHeader>
          <div className="space-y-6 p-4">
            {props.settingsExtra}
            {values ? (
              <PropertiesForm
                values={values}
                schema={schema}
                errors={errors}
                disabled={props.readOnly}
                omit={["title", "description"]}
                single
                onChange={setValues}
              />
            ) : null}
            <Button
              variant="outline"
              className="w-full"
              onClick={() => {
                setMode("markdown");
                setSettingsOpen(false);
              }}
            >
              <FileCode />
              {t("editAsMarkdown")}
            </Button>
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
