import type { ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Link } from "@tanstack/react-router";
import { AlertTriangle, Info, Lightbulb, MessageSquareWarning, OctagonAlert } from "lucide-react";
import { markdownProblem } from "@handbook/shared/markdown";
import { resolveLink } from "@handbook/shared/paths";
import { cn } from "@/components/ui/utils";
import { defineMessages, useT } from "@/i18n";
import { remarkCallouts, remarkHeadingIds, type CalloutType } from "./page/markdown-plugins";

/**
 * Renders a page body (Markdown, no HTML) the way every view shows it:
 * GitHub-flavored Markdown, callouts (`> [!NOTE]`), heading anchors that
 * match the server's search sections, and links between pages resolved
 * like files (`@handbook/shared/paths`).
 */
export type MarkdownViewProps = {
  /** The body without frontmatter. */
  markdown: string;
  /** Space and path of the page the body belongs to, for relative links. */
  space: string;
  path: string;
  /** Leave out a first-level heading at the top that repeats this title. */
  title?: string;
  className?: string;
  /** "article": the page reading style (serif text in a reading column), as on pages and in the editor. */
  variant?: "default" | "article";
};

const messages = defineMessages({
  en: {
    note: "Note",
    tip: "Tip",
    important: "Important",
    warning: "Warning",
    caution: "Caution",
    brokenLink: "This link does not point to a page",
    opensNewTab: "(opens in a new tab)",
  },
});

const CALLOUT_STYLE: Record<CalloutType, { icon: typeof Info; className: string }> = {
  note: {
    icon: Info,
    className:
      "border-blue-500/60 bg-blue-500/5 [&_[data-callout-title]]:text-blue-700 dark:[&_[data-callout-title]]:text-blue-300",
  },
  tip: {
    icon: Lightbulb,
    className:
      "border-green-600/60 bg-green-600/5 [&_[data-callout-title]]:text-green-700 dark:[&_[data-callout-title]]:text-green-300",
  },
  important: {
    icon: MessageSquareWarning,
    className:
      "border-violet-500/60 bg-violet-500/5 [&_[data-callout-title]]:text-violet-700 dark:[&_[data-callout-title]]:text-violet-300",
  },
  warning: {
    icon: AlertTriangle,
    className:
      "border-amber-500/70 bg-amber-500/5 [&_[data-callout-title]]:text-amber-700 dark:[&_[data-callout-title]]:text-amber-300",
  },
  caution: {
    icon: OctagonAlert,
    className:
      "border-red-500/60 bg-red-500/5 [&_[data-callout-title]]:text-red-700 dark:[&_[data-callout-title]]:text-red-300",
  },
};

function Callout({ type, children, article }: { type: CalloutType; children: ReactNode; article?: boolean }) {
  const t = useT(messages);
  const style = CALLOUT_STYLE[type];
  const Icon = style.icon;
  return (
    <div
      data-callout={type}
      role="note"
      className={article ? undefined : cn("my-4 rounded-md border-l-4 px-4 py-3", style.className)}
    >
      <p
        data-callout-title
        className={article ? undefined : "mb-1 flex items-center gap-2 text-sm font-semibold"}
      >
        <Icon className={article ? "size-[1.1em]" : "size-4"} aria-hidden />
        {t(type)}
      </p>
      <div data-callout-body className="[&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
        {children}
      </div>
    </div>
  );
}

function MarkdownLink({
  href,
  children,
  from,
  article,
}: {
  href: string | undefined;
  children: ReactNode;
  from: { space: string; path: string };
  article?: boolean;
}) {
  const t = useT(messages);
  const className = article
    ? undefined
    : "text-link font-medium underline underline-offset-4 hover:no-underline";
  if (!href) return <span>{children}</span>;
  const target = resolveLink(href, from);
  switch (target.kind) {
    case "page":
      return target.path === "" ? (
        <Link to="/s/$space" params={{ space: target.space }} className={className}>
          {children}
        </Link>
      ) : (
        <Link
          to="/s/$space/$"
          params={{ space: target.space, _splat: target.path }}
          hash={target.anchor ?? undefined}
          className={className}
        >
          {children}
        </Link>
      );
    case "anchor":
      return (
        <a href={`#${encodeURIComponent(target.anchor)}`} className={className}>
          {children}
        </a>
      );
    case "file":
      return (
        <a href={target.href} className={className}>
          {children}
        </a>
      );
    case "external":
      return (
        <a href={target.href} target="_blank" rel="noopener noreferrer" className={className}>
          {children}
          <span className="sr-only"> {t("opensNewTab")}</span>
        </a>
      );
    case "invalid":
      return (
        <span
          data-broken-link
          title={t("brokenLink")}
          className="text-destructive underline decoration-dotted"
        >
          {children}
        </span>
      );
  }
}

const headingClass = "scroll-mt-20 font-semibold tracking-tight";

/** The article style: plain elements, styled by the `.article` rules in styles.css. */
function articleComponents(from: { space: string; path: string }): Components {
  return {
    input: ({ node: _node, ...props }) => <input {...props} aria-label="Task" />,
    div: ({ node: _node, ...props }) => {
      const callout = (props as Record<string, unknown>)["data-callout"];
      if (typeof callout === "string" && callout in CALLOUT_STYLE) {
        return (
          <Callout type={callout as CalloutType} article>
            {props.children}
          </Callout>
        );
      }
      return <div {...props} />;
    },
    a: ({ node: _node, href, children }) => (
      <MarkdownLink href={href} from={from} article>
        {children}
      </MarkdownLink>
    ),
    img: ({ node: _node, alt, ...props }) => <img {...props} alt={alt ?? ""} loading="lazy" />,
    table: ({ node: _node, ...props }) => (
      <div className="article-table">
        <table {...props} />
      </div>
    ),
  };
}

function components(from: { space: string; path: string }): Components {
  return {
    h1: ({ node: _node, ...props }) => <h1 {...props} className={cn(headingClass, "mt-8 mb-3 text-2xl")} />,
    h2: ({ node: _node, ...props }) => (
      <h2 {...props} className={cn(headingClass, "mt-8 mb-3 border-b pb-1 text-xl")} />
    ),
    h3: ({ node: _node, ...props }) => <h3 {...props} className={cn(headingClass, "mt-6 mb-2 text-lg")} />,
    h4: ({ node: _node, ...props }) => <h4 {...props} className={cn(headingClass, "mt-5 mb-2 text-base")} />,
    h5: ({ node: _node, ...props }) => <h5 {...props} className={cn(headingClass, "mt-4 mb-2 text-sm")} />,
    h6: ({ node: _node, ...props }) => (
      <h6 {...props} className={cn(headingClass, "text-muted-foreground mt-4 mb-2 text-sm")} />
    ),
    p: ({ node: _node, ...props }) => <p {...props} className="my-3 leading-7" />,
    ul: ({ node: _node, className, ...props }) => (
      <ul
        {...props}
        className={cn(
          "my-3 ml-6 list-disc space-y-1 [&_ol]:my-1 [&_ul]:my-1",
          className?.includes("contains-task-list") && "ml-1 list-none",
        )}
      />
    ),
    ol: ({ node: _node, ...props }) => <ol {...props} className="my-3 ml-6 list-decimal space-y-1" />,
    li: ({ node: _node, className, ...props }) => (
      <li
        {...props}
        className={cn("leading-7", className?.includes("task-list-item") && "flex items-start gap-2")}
      />
    ),
    input: ({ node: _node, ...props }) => <input {...props} className="mt-2 size-4" aria-label="Task" />,
    blockquote: ({ node: _node, ...props }) => (
      <blockquote {...props} className="text-muted-foreground my-4 border-l-4 pl-4 italic" />
    ),
    div: ({ node: _node, ...props }) => {
      const callout = (props as Record<string, unknown>)["data-callout"];
      if (typeof callout === "string" && callout in CALLOUT_STYLE) {
        return <Callout type={callout as CalloutType}>{props.children}</Callout>;
      }
      return <div {...props} />;
    },
    a: ({ node: _node, href, children }) => (
      <MarkdownLink href={href} from={from}>
        {children}
      </MarkdownLink>
    ),
    img: ({ node: _node, alt, ...props }) => (
      <img {...props} alt={alt ?? ""} loading="lazy" className="my-3 h-auto max-w-full rounded-md border" />
    ),
    hr: () => <hr className="my-6" />,
    pre: ({ node: _node, ...props }) => (
      <pre
        {...props}
        className="bg-muted my-4 overflow-x-auto rounded-md p-4 text-sm leading-6 [&_code]:bg-transparent [&_code]:p-0"
      />
    ),
    code: ({ node: _node, className, ...props }) => (
      <code {...props} className={cn("bg-muted rounded px-1 py-0.5 font-mono text-[0.9em]", className)} />
    ),
    table: ({ node: _node, ...props }) => (
      <div className="my-4 w-full overflow-x-auto">
        <table {...props} className="w-full border-collapse text-sm" />
      </div>
    ),
    th: ({ node: _node, ...props }) => (
      <th {...props} className="bg-muted/60 border px-3 py-2 text-left align-top font-semibold" />
    ),
    td: ({ node: _node, ...props }) => <td {...props} className="border px-3 py-2 align-top" />,
  };
}

export function MarkdownView(props: MarkdownViewProps) {
  const from = { space: props.space, path: props.path };
  const article = props.variant === "article";
  // Markdown the parser cannot handle in time (pages refuse it; comments may have it) stays plain text.
  if (markdownProblem(props.markdown)) {
    return (
      <div
        className={cn(
          "text-foreground min-w-0 text-[0.95rem] break-words whitespace-pre-wrap",
          props.className,
        )}
      >
        {props.markdown}
      </div>
    );
  }
  return (
    <div
      className={cn(
        article ? "article min-w-0" : "text-foreground min-w-0 text-[0.95rem] break-words",
        props.className,
      )}
    >
      <ReactMarkdown
        skipHtml
        remarkPlugins={[remarkGfm, remarkCallouts, [remarkHeadingIds, { title: props.title }]]}
        components={article ? articleComponents(from) : components(from)}
      >
        {props.markdown}
      </ReactMarkdown>
    </div>
  );
}
