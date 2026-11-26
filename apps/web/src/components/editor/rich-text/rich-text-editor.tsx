import { useEffect, useMemo, useRef, useState } from "react";
import { Extension, getSchema, type Editor, type JSONContent } from "@tiptap/core";
import { Placeholder } from "@tiptap/extensions";
import { EditorContent, useEditor } from "@tiptap/react";
import { toast } from "sonner";
import { resolveLink } from "@handbook/shared/paths";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { errorMessage } from "@/lib/api";
import { useT } from "@/i18n";
import { LinkEditor } from "./link-editor";
import { markdownProblem } from "@handbook/shared/markdown";
import { attachNodes, inlineFromMarkdown, parseBody, serializeBody, type BodyOrigin } from "./markdown";
import { FormatMenu, InsertButton, TableMenu } from "./menus";
import { richTextMessages } from "./messages";
import { EditorCallout, EditorRawMarkdown } from "./node-views";
import { schemaExtensions } from "./schema";
import { SlashMenu, SlashStore, slashCommand } from "./slash-menu";

export type RichTextEditorProps = {
  /** The page body (Markdown, without frontmatter). */
  value: string;
  onChange: (body: string) => void;
  /** Space and path of the page, for images with relative addresses. */
  space: string;
  path: string;
  /** Uploads a file and returns the Markdown to insert; leave out to turn uploads off. */
  onUpload?: (file: File) => Promise<string>;
  /** Called on every change the person makes (for the edit lock). */
  onActivity?: () => void;
  readOnly?: boolean;
  label: string;
};

/** Pasted plain text that is probably Markdown (from an agent, a README, another page). */
function looksLikeMarkdown(text: string): boolean {
  return (
    /^(?:#{1,6}\s|[-*+]\s|\d{1,9}[.)]\s|>\s|```|\|.*\|)/m.test(text) ||
    /\*\*[^*\n]+\*\*|\[[^\]\n]+\]\([^)\s]+\)/.test(text)
  );
}

/** An image address as the browser loads it from the editor (pages may use relative addresses). */
function imageSource(src: string, space: string, path: string): string {
  const target = resolveLink(src, { space, path });
  return target.kind === "file" || target.kind === "external" ? target.href : src;
}

/**
 * The page body as rich text (Tiptap). It reads and writes Markdown through
 * markdown.ts, which keeps every block nobody changed exactly as written.
 * Typing Markdown works too (`## `, `- `, `**bold**`); `/` inserts blocks.
 */
export function RichTextEditor(props: RichTextEditorProps) {
  const t = useT(richTextMessages);
  const latest = useRef(props);
  latest.current = props;
  const store = useMemo(() => new SlashStore(), []);
  const fileInput = useRef<HTMLInputElement>(null);
  const editorRef = useRef<Editor | null>(null);
  const [linking, setLinking] = useState(false);
  const [pageLink, setPageLink] = useState(false);

  const extensions = useMemo(
    () => [
      ...schemaExtensions({
        resolveImage: (src) => imageSource(src, latest.current.space, latest.current.path),
        callout: EditorCallout,
        rawMarkdown: EditorRawMarkdown,
      }),
      Placeholder.configure({
        placeholder: ({ editor, node, pos }) => {
          if (node.type.name === "heading") return t("headingPlaceholder");
          const parent = editor.state.doc.resolve(pos).parent.type.name;
          return parent === "doc" ? t("placeholder") : "";
        },
      }),
      slashCommand({
        store,
        label: (key) => t(key),
        canUpload: () => Boolean(latest.current.onUpload),
        onSpecial: (key) => {
          if (key === "upload") fileInput.current?.click();
          else setPageLink(true);
        },
      }),
      Extension.create({
        name: "linkShortcut",
        addKeyboardShortcuts() {
          return {
            "Mod-k": () => {
              // Nothing selected (also inside a link): the link dialog; selected text: the toolbar's link field.
              if (this.editor.state.selection.empty) setPageLink(true);
              else setLinking(true);
              return true;
            },
          };
        },
      }),
    ],
    [store, t],
  );

  const [initial] = useState(() => {
    const parsed = parseBody(props.value, getSchema(extensions));
    return { content: parsed.doc.toJSON() as JSONContent, origin: parsed.origin };
  });
  const origin = useRef<BodyOrigin>(initial.origin);
  const emitted = useRef(props.value);

  const uploadFiles = async (files: File[], at: number) => {
    const upload = latest.current.onUpload;
    const editor = editorRef.current;
    if (!upload || !editor) return;
    let position = at;
    for (const file of files) {
      const id = toast.loading(t("uploading", { name: file.name }));
      try {
        const markdown = await upload(file);
        editor.chain().focus().insertContentAt(position, inlineFromMarkdown(markdown, editor.schema)).run();
        position = editor.state.selection.to;
        toast.success(t("uploaded", { name: file.name }), { id });
      } catch (error) {
        toast.error(errorMessage(error), { id });
      }
    }
  };
  const uploadRef = useRef(uploadFiles);
  uploadRef.current = uploadFiles;

  const editor = useEditor({
    extensions,
    content: initial.content,
    editable: !props.readOnly,
    shouldRerenderOnTransaction: false,
    editorProps: {
      attributes: {
        class: "article rich-text min-h-[45vh] outline-none",
        "aria-label": props.label,
        "aria-multiline": "true",
        role: "textbox",
        spellcheck: "true",
      },
      handlePaste: (view, event) => {
        const files = [...(event.clipboardData?.files ?? [])];
        if (files.length > 0 && latest.current.onUpload) {
          event.preventDefault();
          void uploadRef.current(files, view.state.selection.from);
          return true;
        }
        const text = event.clipboardData?.getData("text/plain") ?? "";
        const html = event.clipboardData?.getData("text/html") ?? "";
        const current = editorRef.current;
        if (
          !html &&
          current &&
          looksLikeMarkdown(text) &&
          !markdownProblem(text) &&
          !current.isActive("codeBlock")
        ) {
          event.preventDefault();
          const { doc } = parseBody(text, view.state.schema);
          current
            .chain()
            .focus()
            .insertContent((doc.toJSON() as JSONContent).content ?? [])
            .run();
          return true;
        }
        return false;
      },
      handleDrop: (view, event) => {
        const files = [...(event.dataTransfer?.files ?? [])];
        if (files.length === 0 || !latest.current.onUpload) return false;
        event.preventDefault();
        const position = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos;
        void uploadRef.current(files, position ?? view.state.selection.from);
        return true;
      },
    },
    onCreate: ({ editor: current }) => attachNodes(origin.current, current.state.doc),
    onUpdate: ({ editor: current }) => {
      const body = serializeBody(current.state.doc, origin.current);
      // Only real changes reach the file (an update can come without one).
      if (body === emitted.current) return;
      emitted.current = body;
      latest.current.onChange(body);
      latest.current.onActivity?.();
    },
  });

  useEffect(() => {
    editorRef.current = editor;
  }, [editor]);

  useEffect(() => {
    // No update event: making the editor editable changes nothing in the text.
    editor?.setEditable(!props.readOnly, false);
  }, [editor, props.readOnly]);

  // A new text from outside (a restored draft, a merge, the Markdown view): read it again.
  useEffect(() => {
    if (!editor || props.value === emitted.current) return;
    const parsed = parseBody(props.value, editor.schema);
    origin.current = parsed.origin;
    emitted.current = props.value;
    editor.commands.setContent(parsed.doc.toJSON() as JSONContent, { emitUpdate: false });
    attachNodes(parsed.origin, editor.state.doc);
  }, [editor, props.value]);

  return (
    <div className="relative">
      <EditorContent editor={editor} />
      {editor && !props.readOnly ? (
        <>
          <FormatMenu editor={editor} linking={linking} onLinking={setLinking} />
          <TableMenu editor={editor} />
          <InsertButton editor={editor} />
          <SlashMenu store={store} />
        </>
      ) : null}
      {props.onUpload ? (
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
            if (editor && files.length > 0) void uploadFiles(files, editor.state.selection.from);
          }}
        />
      ) : null}
      <Dialog open={pageLink} onOpenChange={setPageLink}>
        <DialogContent className="gap-3 p-4 sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("pageLinkTitle")}</DialogTitle>
          </DialogHeader>
          {editor && pageLink ? <LinkEditor editor={editor} onDone={() => setPageLink(false)} /> : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}
