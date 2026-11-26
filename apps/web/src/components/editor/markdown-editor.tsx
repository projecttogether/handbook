import { useMemo, useRef, useState } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { EditorView } from "@codemirror/view";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { useQuery } from "@tanstack/react-query";
import {
  Bold,
  Code,
  FileText,
  Heading2,
  ImageUp,
  Italic,
  Link2,
  List,
  ListChecks,
  MessageSquareWarning,
  Table,
} from "lucide-react";
import { toast } from "sonner";
import { HIGHLIGHT_END, HIGHLIGHT_START } from "@handbook/shared/api/search";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useDebounced } from "@/hooks/use-debounced";
import { errorMessage } from "@/lib/api";
import { useTheme } from "@/lib/theme";
import { defineMessages, useT } from "@/i18n";
import { searchQuery } from "@/components/page/queries";
import {
  CALLOUT_BLOCK,
  CODE_BLOCK,
  TABLE_BLOCK,
  insertBlock,
  pageLinkMarkdown,
  prefixLines,
  wrap,
  type Edit,
} from "./toolbar";

const messages = defineMessages({
  en: {
    toolbar: "Formatting",
    heading: "Heading",
    bold: "Bold",
    italic: "Italic",
    link: "Link to a page",
    list: "List",
    task: "Task list",
    table: "Table",
    callout: "Callout",
    code: "Code block",
    image: "Add an image or file",
    boldText: "bold text",
    italicText: "italic text",
    findPage: "Find a page…",
    noPages: "No pages found.",
    typeToSearch: "Type to search.",
    uploading: "Uploading {name}…",
    uploaded: "Added {name}",
  },
});

export type MarkdownEditorProps = {
  value: string;
  onChange: (value: string) => void;
  /** Space of the page, for uploads. */
  space: string;
  /** Uploads a file and returns the Markdown to insert; leave out to turn uploads off. */
  onUpload?: (file: File) => Promise<string>;
  /** Called on every change the person makes (for the edit lock). */
  onActivity?: () => void;
  label: string;
  readOnly?: boolean;
  minHeight?: string;
  /** Hide the toolbar (e.g. for the whole-file source view). */
  plain?: boolean;
};

function apply(view: EditorView, edit: Edit) {
  view.dispatch({
    changes: { from: edit.from, to: edit.to, insert: edit.insert },
    selection: { anchor: edit.select.from, head: edit.select.to },
    scrollIntoView: true,
  });
  view.focus();
}

function selectionOf(view: EditorView) {
  const range = view.state.selection.main;
  return { from: range.from, to: range.to };
}

function PageLinkPicker(props: { onPick: (markdown: string) => void; label: string }) {
  const t = useT(messages);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const q = useDebounced(query.trim(), 250);
  const results = useQuery({ ...searchQuery({ q }), enabled: open && q.length > 0 });
  const strip = (text: string) => text.split(HIGHLIGHT_START).join("").split(HIGHLIGHT_END).join("");
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button type="button" variant="ghost" size="icon" aria-label={props.label}>
              <Link2 />
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>{props.label}</TooltipContent>
      </Tooltip>
      <PopoverContent className="w-80 p-0" align="start">
        <Command shouldFilter={false}>
          <CommandInput placeholder={t("findPage")} value={query} onValueChange={setQuery} />
          <CommandList>
            <CommandEmpty>{q ? t("noPages") : t("typeToSearch")}</CommandEmpty>
            <CommandGroup>
              {(results.data?.results ?? []).map((result) => (
                <CommandItem
                  key={result.pageId}
                  value={result.pageId}
                  onSelect={() => {
                    props.onPick(pageLinkMarkdown(result.title, result.space.slug, result.path));
                    setOpen(false);
                    setQuery("");
                  }}
                >
                  <FileText />
                  <div className="min-w-0">
                    <p className="truncate">{strip(result.title)}</p>
                    <p className="text-muted-foreground truncate text-xs">
                      {result.space.name} · {result.path}
                    </p>
                  </div>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

/**
 * The Markdown text editor (CodeMirror 6): Markdown highlighting, a small
 * toolbar, and images or files pasted, dropped or picked, uploaded to the
 * space and inserted as Markdown.
 */
export function MarkdownEditor(props: MarkdownEditorProps) {
  const t = useT(messages);
  const { resolved } = useTheme();
  const viewRef = useRef<EditorView | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const uploadRef = useRef(props.onUpload);
  uploadRef.current = props.onUpload;
  const activityRef = useRef(props.onActivity);
  activityRef.current = props.onActivity;

  const uploadFiles = async (files: File[], view: EditorView, position: number) => {
    const upload = uploadRef.current;
    if (!upload) return;
    let at = position;
    for (const file of files) {
      const id = toast.loading(t("uploading", { name: file.name }));
      try {
        const text = await upload(file);
        const edit = insertBlock(view.state.doc.toString(), { from: at, to: at }, text);
        apply(view, edit);
        at = edit.select.to;
        toast.success(t("uploaded", { name: file.name }), { id });
      } catch (error) {
        toast.error(errorMessage(error), { id });
      }
    }
  };
  const uploadFilesRef = useRef(uploadFiles);
  uploadFilesRef.current = uploadFiles;

  const extensions = useMemo(
    () => [
      markdown({ base: markdownLanguage, codeLanguages: languages }),
      EditorView.lineWrapping,
      EditorView.contentAttributes.of({ "aria-label": props.label }),
      EditorView.domEventHandlers({
        paste(event, view) {
          const files = [...(event.clipboardData?.files ?? [])];
          if (files.length === 0 || !uploadRef.current) return false;
          event.preventDefault();
          void uploadFilesRef.current(files, view, view.state.selection.main.head);
          return true;
        },
        drop(event, view) {
          const files = [...(event.dataTransfer?.files ?? [])];
          if (files.length === 0 || !uploadRef.current) return false;
          event.preventDefault();
          const position =
            view.posAtCoords({ x: event.clientX, y: event.clientY }) ?? view.state.selection.main.head;
          void uploadFilesRef.current(files, view, position);
          return true;
        },
      }),
    ],
    [props.label],
  );

  const run = (make: (text: string, selection: { from: number; to: number }) => Edit) => {
    const view = viewRef.current;
    if (!view) return;
    apply(view, make(view.state.doc.toString(), selectionOf(view)));
  };

  const tools = [
    { key: "heading", icon: Heading2, action: () => run((text, sel) => prefixLines(text, sel, "## ")) },
    { key: "bold", icon: Bold, action: () => run((text, sel) => wrap(text, sel, "**", "**", t("boldText"))) },
    {
      key: "italic",
      icon: Italic,
      action: () => run((text, sel) => wrap(text, sel, "_", "_", t("italicText"))),
    },
    { key: "list", icon: List, action: () => run((text, sel) => prefixLines(text, sel, "- ")) },
    { key: "task", icon: ListChecks, action: () => run((text, sel) => prefixLines(text, sel, "- [ ] ")) },
    {
      key: "table",
      icon: Table,
      action: () => run((text, sel) => insertBlock(text, sel, TABLE_BLOCK, "Column")),
    },
    {
      key: "callout",
      icon: MessageSquareWarning,
      action: () => run((text, sel) => insertBlock(text, sel, CALLOUT_BLOCK, "Text")),
    },
    { key: "code", icon: Code, action: () => run((text, sel) => insertBlock(text, sel, CODE_BLOCK, "code")) },
  ] as const;

  return (
    <div className="bg-background flex min-w-0 flex-col overflow-hidden rounded-md border">
      {props.plain || props.readOnly ? null : (
        <div
          role="toolbar"
          aria-label={t("toolbar")}
          className="flex flex-wrap items-center gap-0.5 border-b p-1"
        >
          {tools.map((tool) => (
            <Tooltip key={tool.key}>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={t(tool.key)}
                  onClick={tool.action}
                >
                  <tool.icon />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t(tool.key)}</TooltipContent>
            </Tooltip>
          ))}
          <PageLinkPicker
            label={t("link")}
            onPick={(link) => run((text, sel) => wrap(text, sel, "", "", link))}
          />
          {props.onUpload ? (
            <>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={t("image")}
                    onClick={() => fileInput.current?.click()}
                  >
                    <ImageUp />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{t("image")}</TooltipContent>
              </Tooltip>
              <input
                ref={fileInput}
                type="file"
                multiple
                className="sr-only"
                tabIndex={-1}
                aria-hidden
                onChange={(event) => {
                  const files = [...(event.target.files ?? [])];
                  event.target.value = "";
                  const view = viewRef.current;
                  if (view && files.length > 0) void uploadFiles(files, view, view.state.selection.main.head);
                }}
              />
            </>
          ) : null}
        </div>
      )}
      <CodeMirror
        value={props.value}
        onChange={(value) => {
          props.onChange(value);
          activityRef.current?.();
        }}
        extensions={extensions}
        theme={resolved === "dark" ? "dark" : "light"}
        editable={!props.readOnly}
        readOnly={props.readOnly}
        minHeight={props.minHeight ?? "24rem"}
        basicSetup={{
          lineNumbers: false,
          foldGutter: false,
          highlightActiveLine: false,
          highlightActiveLineGutter: false,
          autocompletion: false,
        }}
        onCreateEditor={(view) => {
          viewRef.current = view;
        }}
        className="text-sm [&_.cm-editor]:outline-none [&_.cm-scroller]:font-mono"
      />
    </div>
  );
}
