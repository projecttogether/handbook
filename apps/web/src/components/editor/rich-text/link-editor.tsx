import { useState } from "react";
import type { Editor } from "@tiptap/core";
import { useQuery } from "@tanstack/react-query";
import { FileText, Link2Off } from "lucide-react";
import { HIGHLIGHT_END, HIGHLIGHT_START } from "@handbook/shared/api/search";
import { searchQuery } from "@/components/page/queries";
import { useDebounced } from "@/hooks/use-debounced";
import { useT } from "@/i18n";
import { richTextMessages } from "./messages";

const URL_LIKE = /^(?:[a-z][a-z0-9+.-]*:|\/|\.{1,2}\/|#)/i;
const DOMAIN_LIKE = /^[^\s/]+\.[a-z]{2,}(?:[/?#]\S*)?$/i;

/** What a typed link becomes: as written, or https:// before a bare domain; null when it is a search. */
export function linkTarget(value: string): string | null {
  const text = value.trim();
  if (!text || /\s/.test(text)) return null;
  if (URL_LIKE.test(text)) return text;
  if (DOMAIN_LIKE.test(text)) return `https://${text}`;
  return null;
}

const strip = (text: string) => text.split(HIGHLIGHT_START).join("").split(HIGHLIGHT_END).join("");

/**
 * Edits the link of the selection: paste an address, or type to find a
 * page (its link is the page's absolute path, which survives moves). With
 * nothing selected, a picked page is inserted with its title as the text.
 */
export function LinkEditor({ editor, onDone }: { editor: Editor; onDone: () => void }) {
  const t = useT(richTextMessages);
  const current = editor.getAttributes("link").href as string | undefined;
  const [value, setValue] = useState(current ?? "");
  const target = linkTarget(value);
  const q = useDebounced(target ? "" : value.trim(), 250);
  const results = useQuery({ ...searchQuery({ q }), enabled: q.length > 0 });
  const pages = (results.data?.results ?? []).slice(0, 6);

  const apply = (href: string, title?: string) => {
    const chain = editor.chain().focus();
    if (editor.state.selection.empty && !editor.isActive("link")) {
      chain.insertContent({ type: "text", text: title ?? href, marks: [{ type: "link", attrs: { href } }] });
    } else {
      chain.extendMarkRange("link").setLink({ href });
    }
    chain.run();
    onDone();
  };

  return (
    <div className="w-80 max-w-[calc(100vw-2rem)] p-1.5">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (target) apply(target);
          else if (pages[0]) apply(`/s/${pages[0].space.slug}/${pages[0].path}`, strip(pages[0].title));
        }}
      >
        <input
          // Opened on purpose (a click or Ctrl+K): typing goes here.
          autoFocus
          value={value}
          aria-label={t("linkPlaceholder")}
          placeholder={t("linkPlaceholder")}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              editor.commands.focus();
              onDone();
            }
          }}
          className="border-input bg-background focus-visible:ring-ring/50 h-9 w-full rounded-md border px-2.5 text-sm outline-none focus-visible:ring-[3px]"
        />
      </form>
      {q && !target ? (
        <ul className="mt-1.5 max-h-60 overflow-y-auto">
          {pages.length === 0 ? (
            <li className="text-muted-foreground px-2 py-1.5 text-sm">
              {results.isPending ? t("typeToSearch") : t("noPages")}
            </li>
          ) : (
            pages.map((page) => (
              <li key={page.pageId}>
                <button
                  type="button"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => apply(`/s/${page.space.slug}/${page.path}`, strip(page.title))}
                  className="hover:bg-accent flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-sm"
                >
                  <FileText className="text-muted-foreground mt-0.5 size-4 shrink-0" aria-hidden />
                  <span className="min-w-0">
                    <span className="block truncate">{strip(page.title)}</span>
                    <span className="text-muted-foreground block truncate text-xs">
                      {page.space.name} · {page.path}
                    </span>
                  </span>
                </button>
              </li>
            ))
          )}
        </ul>
      ) : null}
      {current ? (
        <button
          type="button"
          onClick={() => {
            editor.chain().focus().extendMarkRange("link").unsetLink().run();
            onDone();
          }}
          className="text-muted-foreground hover:bg-accent hover:text-foreground mt-1 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm"
        >
          <Link2Off className="size-4" aria-hidden />
          {t("removeLink")}
        </button>
      ) : null}
    </div>
  );
}
