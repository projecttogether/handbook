import type { ReactNode } from "react";
import type { Editor } from "@tiptap/core";
import { NodeSelection } from "@tiptap/pm/state";
import { useEditorState } from "@tiptap/react";
import { BubbleMenu, FloatingMenu } from "@tiptap/react/menus";
import {
  BetweenHorizontalEnd,
  BetweenHorizontalStart,
  BetweenVerticalEnd,
  BetweenVerticalStart,
  Bold,
  Code,
  Italic,
  Link2,
  Plus,
  Quote,
  Strikethrough,
  Trash2,
} from "lucide-react";
import { cn } from "@/components/ui/utils";
import { useT } from "@/i18n";
import { LinkEditor } from "./link-editor";
import { richTextMessages } from "./messages";

function MenuButton(props: {
  label: string;
  active?: boolean;
  onClick: () => void;
  children: ReactNode;
  tone?: "dark" | "light";
}) {
  return (
    <button
      type="button"
      aria-label={props.label}
      title={props.label}
      aria-pressed={props.active ?? undefined}
      onMouseDown={(event) => event.preventDefault()}
      onClick={props.onClick}
      className={cn(
        "grid h-8 min-w-8 place-items-center rounded-md px-1.5 text-[0.8125rem] font-semibold transition-colors [&_svg]:size-4",
        props.tone === "light"
          ? "text-foreground hover:bg-accent"
          : "hover:bg-white/15 dark:hover:bg-black/10",
        props.active && (props.tone === "light" ? "bg-accent" : "text-emerald-300 dark:text-emerald-700"),
      )}
    >
      {props.children}
    </button>
  );
}

const Separator = () => <span aria-hidden className="mx-0.5 h-5 w-px bg-white/20 dark:bg-black/15" />;

/** The toolbar over selected text: emphasis, code, links, headings, quotes. */
export function FormatMenu(props: {
  editor: Editor;
  linking: boolean;
  onLinking: (linking: boolean) => void;
}) {
  const { editor } = props;
  const t = useT(richTextMessages);
  const state = useEditorState({
    editor,
    selector: ({ editor: current }) => ({
      bold: current.isActive("bold"),
      italic: current.isActive("italic"),
      strike: current.isActive("strike"),
      code: current.isActive("code"),
      link: current.isActive("link"),
      h2: current.isActive("heading", { level: 2 }),
      h3: current.isActive("heading", { level: 3 }),
      quote: current.isActive("blockquote"),
      inTable: current.isActive("table"),
    }),
  });
  return (
    <BubbleMenu
      editor={editor}
      pluginKey="formatMenu"
      shouldShow={({ editor: current, state: editorState, from, to }) =>
        current.isEditable &&
        (props.linking ||
          (from !== to &&
            !(editorState.selection instanceof NodeSelection) &&
            !current.isActive("codeBlock")))
      }
      options={{ placement: "top", offset: 10, onHide: () => props.onLinking(false) }}
      className="z-40"
    >
      {props.linking ? (
        <div className="bg-popover text-popover-foreground rounded-xl border shadow-xl">
          <LinkEditor editor={editor} onDone={() => props.onLinking(false)} />
        </div>
      ) : (
        <div
          role="toolbar"
          aria-label={t("formatting")}
          className="flex items-center gap-0.5 rounded-lg bg-neutral-900 p-1 text-white shadow-xl dark:bg-neutral-100 dark:text-neutral-900"
        >
          <MenuButton
            label={t("bold")}
            active={state.bold}
            onClick={() => editor.chain().focus().toggleBold().run()}
          >
            <Bold />
          </MenuButton>
          <MenuButton
            label={t("italic")}
            active={state.italic}
            onClick={() => editor.chain().focus().toggleItalic().run()}
          >
            <Italic />
          </MenuButton>
          <MenuButton
            label={t("strike")}
            active={state.strike}
            onClick={() => editor.chain().focus().toggleStrike().run()}
          >
            <Strikethrough />
          </MenuButton>
          <MenuButton
            label={t("code")}
            active={state.code}
            onClick={() => editor.chain().focus().toggleCode().run()}
          >
            <Code />
          </MenuButton>
          <MenuButton label={t("link")} active={state.link} onClick={() => props.onLinking(true)}>
            <Link2 />
          </MenuButton>
          {state.inTable ? null : (
            <>
              <Separator />
              <MenuButton
                label={t("h2")}
                active={state.h2}
                onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
              >
                H2
              </MenuButton>
              <MenuButton
                label={t("h3")}
                active={state.h3}
                onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
              >
                H3
              </MenuButton>
              <MenuButton
                label={t("quote")}
                active={state.quote}
                onClick={() => editor.chain().focus().toggleBlockquote().run()}
              >
                <Quote />
              </MenuButton>
            </>
          )}
        </div>
      )}
    </BubbleMenu>
  );
}

/** Row and column tools while the cursor is in a table. */
export function TableMenu({ editor }: { editor: Editor }) {
  const t = useT(richTextMessages);
  const tools = [
    { key: "rowAbove", icon: BetweenHorizontalStart, run: () => editor.chain().focus().addRowBefore().run() },
    { key: "rowBelow", icon: BetweenHorizontalEnd, run: () => editor.chain().focus().addRowAfter().run() },
    {
      key: "columnLeft",
      icon: BetweenVerticalStart,
      run: () => editor.chain().focus().addColumnBefore().run(),
    },
    {
      key: "columnRight",
      icon: BetweenVerticalEnd,
      run: () => editor.chain().focus().addColumnAfter().run(),
    },
  ] as const;
  return (
    <BubbleMenu
      editor={editor}
      pluginKey="tableMenu"
      shouldShow={({ editor: current, state }) =>
        current.isEditable && state.selection.empty && current.isActive("table")
      }
      options={{ placement: "top-start", offset: 12 }}
      className="z-30"
    >
      <div
        role="toolbar"
        aria-label={t("tableActions")}
        className="bg-popover text-popover-foreground flex items-center gap-0.5 rounded-lg border p-1 shadow-lg"
      >
        {tools.map((tool) => (
          <MenuButton key={tool.key} tone="light" label={t(tool.key)} onClick={tool.run}>
            <tool.icon />
          </MenuButton>
        ))}
        <span aria-hidden className="bg-border mx-0.5 h-5 w-px" />
        <MenuButton
          tone="light"
          label={t("deleteRow")}
          onClick={() => editor.chain().focus().deleteRow().run()}
        >
          <span className="flex items-center gap-1 text-xs font-medium">
            <Trash2 />
            {t("row")}
          </span>
        </MenuButton>
        <MenuButton
          tone="light"
          label={t("deleteColumn")}
          onClick={() => editor.chain().focus().deleteColumn().run()}
        >
          <span className="flex items-center gap-1 text-xs font-medium">
            <Trash2 />
            {t("column")}
          </span>
        </MenuButton>
        <MenuButton
          tone="light"
          label={t("deleteTable")}
          onClick={() => editor.chain().focus().deleteTable().run()}
        >
          <span className="flex items-center gap-1 text-xs font-medium">
            <Trash2 />
            {t("wholeTable")}
          </span>
        </MenuButton>
      </div>
    </BubbleMenu>
  );
}

/** A + beside an empty line: opens the / menu, for those who don't know the shortcut. */
export function InsertButton({ editor }: { editor: Editor }) {
  const t = useT(richTextMessages);
  return (
    <FloatingMenu
      editor={editor}
      pluginKey="insertButton"
      shouldShow={({ editor: current, state }) => {
        const { $anchor, empty } = state.selection;
        return (
          current.isEditable &&
          empty &&
          $anchor.depth === 1 &&
          $anchor.parent.type.name === "paragraph" &&
          $anchor.parent.content.size === 0
        );
      }}
      options={{ placement: "left", offset: 14 }}
      className="z-30"
    >
      <button
        type="button"
        aria-label={t("addBlock")}
        title={t("addBlock")}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => editor.chain().focus().insertContent("/").run()}
        className="border-muted-foreground/40 text-muted-foreground hover:border-foreground hover:text-foreground bg-background grid size-7 place-items-center rounded-full border transition-colors"
      >
        <Plus className="size-4" aria-hidden />
      </button>
    </FloatingMenu>
  );
}
