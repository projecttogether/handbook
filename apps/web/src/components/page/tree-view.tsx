import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { ChevronRight, FileText } from "lucide-react";
import type { PageSummary } from "@handbook/shared/api/pages";
import { Button } from "@/components/ui/button";
import { defineMessages, useT } from "@/i18n";
import { cn } from "@/components/ui/utils";
import { StatusBadge } from "./status-badge";
import { buildTree, type TreeNode } from "./tree";

const messages = defineMessages({
  en: { expand: "Show pages below {title}", collapse: "Hide pages below {title}" },
});

function TreeItem(props: {
  node: TreeNode;
  space: string;
  depth: number;
  current?: string;
  open: Set<string>;
  toggle: (id: string) => void;
}) {
  const t = useT(messages);
  const { page, children } = props.node;
  const isOpen = props.open.has(page.id);
  const active = props.current === page.path;
  return (
    <li>
      <div
        className={cn(
          "hover:bg-accent flex items-center gap-1 rounded-md pr-2",
          active && "bg-accent font-medium",
        )}
        style={{ paddingLeft: `${props.depth * 1}rem` }}
      >
        {children.length > 0 ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-7 shrink-0"
            aria-expanded={isOpen}
            aria-label={t(isOpen ? "collapse" : "expand", { title: page.title })}
            onClick={() => props.toggle(page.id)}
          >
            <ChevronRight className={cn("transition-transform", isOpen && "rotate-90")} />
          </Button>
        ) : (
          <span className="flex size-7 shrink-0 items-center justify-center">
            <FileText className="text-muted-foreground size-3.5" aria-hidden />
          </span>
        )}
        <Link
          to="/s/$space/$"
          params={{ space: props.space, _splat: page.path }}
          className="min-w-0 flex-1 truncate py-1.5 text-sm"
          aria-current={active ? "page" : undefined}
        >
          {page.title}
        </Link>
        <StatusBadge status={page.status} />
      </div>
      {children.length > 0 && isOpen ? (
        <ul>
          {children.map((child) => (
            <TreeItem key={child.page.id} {...props} node={child} depth={props.depth + 1} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

/** The pages of a space as an expandable tree; the path to `current` starts open. */
export function PageTree(props: { pages: PageSummary[]; space: string; current?: string; label: string }) {
  const tree = buildTree(props.pages);
  const [open, setOpen] = useState<Set<string>>(() => {
    const ids = new Set<string>();
    if (props.current) {
      const byPath = new Map(props.pages.map((page) => [page.path, page.id]));
      const parts = props.current.split("/");
      for (let index = 1; index < parts.length; index += 1) {
        const id = byPath.get(parts.slice(0, index).join("/"));
        if (id) ids.add(id);
      }
    }
    return ids;
  });
  const toggle = (id: string) =>
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  return (
    <nav aria-label={props.label}>
      <ul className="space-y-0.5">
        {tree.map((node) => (
          <TreeItem
            key={node.page.id}
            node={node}
            space={props.space}
            depth={0}
            current={props.current}
            open={open}
            toggle={toggle}
          />
        ))}
      </ul>
    </nav>
  );
}
