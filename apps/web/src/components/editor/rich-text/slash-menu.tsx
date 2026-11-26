import { useEffect, useRef, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { Extension, type Editor } from "@tiptap/core";
import { PluginKey } from "@tiptap/pm/state";
import Suggestion, { type SuggestionProps } from "@tiptap/suggestion";
import { cn } from "@/components/ui/utils";
import { useT } from "@/i18n";
import {
  BLOCK_COMMANDS,
  filterCommands,
  runBlockCommand,
  type BlockCommand,
  type BlockCommandKey,
} from "./commands";
import { richTextMessages } from "./messages";

type SlashState = {
  items: BlockCommand[];
  query: string;
  rect: DOMRect | null;
  index: number;
  pick: (item: BlockCommand) => void;
};

/** The open `/` menu, shared between the editor plugin and its React popup. */
export class SlashStore {
  private state: SlashState | null = null;
  private listeners = new Set<() => void>();

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  get = () => this.state;

  set(next: SlashState | null) {
    this.state = next;
    for (const listener of this.listeners) listener();
  }

  select(index: number) {
    if (this.state) this.set({ ...this.state, index });
  }

  /** Arrow keys move, Enter or Tab picks; true when the key was used. */
  keyDown(event: KeyboardEvent): boolean {
    const state = this.state;
    if (!state) return false;
    const count = state.items.length;
    if (event.key === "ArrowDown" && count > 0) {
      this.select((state.index + 1) % count);
      return true;
    }
    if (event.key === "ArrowUp" && count > 0) {
      this.select((state.index - 1 + count) % count);
      return true;
    }
    if ((event.key === "Enter" || event.key === "Tab") && count > 0) {
      state.pick(state.items[state.index]!);
      return true;
    }
    if (event.key === "Escape") this.set(null);
    return false;
  }
}

export type SlashOptions = {
  store: SlashStore;
  label: (key: BlockCommandKey) => string;
  canUpload: () => boolean;
  /** Uploads and page links need the editor's UI (a file picker, a search). */
  onSpecial: (key: "upload" | "pageLink", editor: Editor) => void;
};

/** Typing `/` at the start of a line or after a space opens a menu of blocks to insert. */
export function slashCommand(options: SlashOptions) {
  return Extension.create({
    name: "slashCommand",
    addProseMirrorPlugins() {
      const toState = (props: SuggestionProps<BlockCommand, BlockCommand>, index: number): SlashState => ({
        items: props.items,
        query: props.query,
        rect: props.clientRect?.() ?? null,
        index: Math.min(index, Math.max(props.items.length - 1, 0)),
        pick: (item) => props.command(item),
      });
      return [
        Suggestion<BlockCommand, BlockCommand>({
          pluginKey: new PluginKey("slashCommand"),
          editor: this.editor,
          char: "/",
          allow: ({ state, range }) => {
            const $from = state.doc.resolve(range.from);
            if ($from.parent.type.name !== "paragraph") return false;
            for (let depth = $from.depth; depth > 0; depth--) {
              const name = $from.node(depth).type.name;
              if (name === "table" || name === "codeBlock") return false;
            }
            return true;
          },
          items: ({ query }) =>
            filterCommands(
              BLOCK_COMMANDS.filter((command) => command.key !== "upload" || options.canUpload()),
              query,
              options.label,
            ),
          command: ({ editor, range, props }) => {
            const special = runBlockCommand(editor, props.key, range);
            if (special) options.onSpecial(special, editor);
          },
          render: () => ({
            onStart: (props) => options.store.set(toState(props, 0)),
            onUpdate: (props) => options.store.set(toState(props, 0)),
            onKeyDown: ({ event }) => options.store.keyDown(event),
            onExit: () => options.store.set(null),
          }),
        }),
      ];
    },
  });
}

/** The `/` menu's popup, below the typed `/` (above it near the bottom of the window). */
export function SlashMenu({ store }: { store: SlashStore }) {
  const t = useT(richTextMessages);
  const state = useSyncExternalStore(store.subscribe, store.get);
  const list = useRef<HTMLDivElement>(null);
  const index = state?.index ?? 0;

  useEffect(() => {
    list.current?.querySelector(`[data-index="${index}"]`)?.scrollIntoView({ block: "nearest" });
  }, [index]);

  if (!state?.rect) return null;
  const below = window.innerHeight - state.rect.bottom > 340;
  const left = Math.max(8, Math.min(state.rect.left, window.innerWidth - 300));
  return createPortal(
    <div
      ref={list}
      role="listbox"
      aria-label={t("insert")}
      style={{
        left,
        top: below ? state.rect.bottom + 8 : undefined,
        bottom: below ? undefined : window.innerHeight - state.rect.top + 8,
      }}
      className="bg-popover text-popover-foreground fixed z-50 max-h-80 w-72 overflow-y-auto rounded-xl border p-1.5 shadow-xl"
    >
      <p className="text-muted-foreground px-2 pt-1 pb-1.5 text-[0.6875rem] font-semibold tracking-wider uppercase">
        {t("insert")}
      </p>
      {state.items.length === 0 ? (
        <p className="text-muted-foreground px-2 py-1.5 text-sm">{t("noMatches", { query: state.query })}</p>
      ) : (
        state.items.map((item, i) => (
          <button
            key={item.key}
            type="button"
            role="option"
            data-index={i}
            aria-selected={i === index}
            onMouseDown={(event) => event.preventDefault()}
            onMouseEnter={() => store.select(i)}
            onClick={() => state.pick(item)}
            className={cn(
              "flex w-full items-center gap-3 rounded-lg px-2 py-1.5 text-left text-sm",
              i === index && "bg-accent",
            )}
          >
            <span className="bg-background grid size-8 shrink-0 place-items-center rounded-md border">
              <item.icon className="size-4" aria-hidden />
            </span>
            <span className="flex-1">{t(item.key)}</span>
            {item.hint ? (
              <span className="text-muted-foreground font-mono text-xs" aria-hidden>
                {item.hint}
              </span>
            ) : null}
          </button>
        ))
      )}
    </div>,
    document.body,
  );
}
