import { useEffect, useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  ArrowRight,
  ChevronRight,
  FileCode,
  FilePlus2,
  FileQuestion,
  FolderInput,
  GitPullRequestArrow,
  History,
  Info,
  Link2,
  MoreHorizontal,
  Pencil,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { toast } from "sonner";
import type { Page } from "@handbook/shared/api/pages";
import type { Space } from "@handbook/shared/api/spaces";
import { BUILT_IN_KEYS, BUILT_IN_PROPERTIES, splitFrontmatter, type PageStatus } from "@handbook/shared/page";
import { pageMarkdownUrl, parentPath, resolveLink } from "@handbook/shared/paths";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Page as PageLayout } from "@/components/ui/page";
import { MarkdownView } from "@/components/markdown";
import { pageByPathQuery, spaceQuery } from "@/components/page/queries";
import { StatusBadge } from "@/components/page/status-badge";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/states";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ApiError, api, errorMessage } from "@/lib/api";
import { useFormatter } from "@/lib/format";
import { cn } from "@/components/ui/utils";
import { initials } from "@/lib/utils";
import { useT } from "@/i18n";
import { messages } from "./messages";
import { MoveDialog } from "./move-dialog";

/** A page of a space, by path (old paths of moved pages redirect). */
export function PageView({ space, path }: { space: string; path: string }) {
  const t = useT(messages);
  const navigate = useNavigate();
  const query = useQuery(pageByPathQuery(space, path));
  const spaceData = useQuery(spaceQuery(space)).data;

  const actualPath = query.data?.path;
  useEffect(() => {
    // The page moved: show its current address.
    if (actualPath && actualPath !== path) {
      void navigate({
        to: "/s/$space/$",
        params: { space, _splat: actualPath },
        hash: window.location.hash.slice(1) || undefined,
        replace: true,
      });
    }
  }, [actualPath, path, space, navigate]);

  if (!query.data) {
    const missing = query.error instanceof ApiError && query.error.status === 404;
    return (
      <PageLayout>
        {query.isPending ? (
          <LoadingState />
        ) : missing ? (
          <EmptyState
            icon={<FileQuestion />}
            title={t("notFound")}
            description={t("notFoundHint")}
            action={
              <Button variant="outline" asChild>
                <Link to="/s/$space" params={{ space }}>
                  {t("backToSpace")}
                </Link>
              </Button>
            }
          />
        ) : (
          <ErrorState error={query.error} onRetry={() => void query.refetch()} />
        )}
      </PageLayout>
    );
  }
  return <PageContent page={query.data} space={spaceData} />;
}

/** Scrolls to the heading of the URL's #anchor once the page is shown. */
function useScrollToAnchor(ready: boolean) {
  useEffect(() => {
    if (!ready || !window.location.hash) return;
    const id = decodeURIComponent(window.location.hash.slice(1));
    window.requestAnimationFrame(() => document.getElementById(id)?.scrollIntoView());
  }, [ready]);
}

/** About how long the text takes to read, in minutes (at least 1). */
export function readingMinutes(markdown: string): number {
  const words = markdown.split(/\s+/).filter((word) => /[\p{L}\p{N}]/u.test(word)).length;
  return Math.max(1, Math.round(words / 230));
}

function Breadcrumbs({ page }: { page: Page }) {
  const t = useT(messages);
  return (
    <nav
      aria-label={t("pages")}
      className="text-muted-foreground flex min-w-0 flex-wrap items-center gap-1 text-sm"
    >
      <Link to="/s/$space" params={{ space: page.space }} className="hover:text-foreground truncate">
        {page.spaceName}
      </Link>
      {page.breadcrumbs
        .filter((crumb) => crumb.id !== page.id)
        .map((crumb) => (
          <span key={crumb.id} className="flex min-w-0 items-center gap-1">
            <ChevronRight className="size-3.5 shrink-0" aria-hidden />
            <Link
              to="/s/$space/$"
              params={{ space: crumb.space, _splat: crumb.path }}
              className="hover:text-foreground truncate"
            >
              {crumb.title}
            </Link>
          </span>
        ))}
    </nav>
  );
}

/** One line of news about the page: deprecated, someone editing, a draft, suggested changes. */
function Notice(props: { icon: ReactNode; tone?: "warning"; children: ReactNode }) {
  return (
    <div
      className={cn(
        "flex items-start gap-2.5 rounded-xl border px-3.5 py-2.5 text-sm [&>svg]:mt-0.5 [&>svg]:size-4 [&>svg]:shrink-0",
        props.tone === "warning"
          ? "border-amber-500/30 bg-amber-500/[0.06] text-amber-950 dark:text-amber-100"
          : "bg-muted/40",
      )}
    >
      {props.icon}
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">{props.children}</div>
    </div>
  );
}

function Notices({ page }: { page: Page }) {
  const t = useT(messages);
  const format = useFormatter();
  const replacedBy = typeof page.properties.replaced_by === "string" ? page.properties.replaced_by : null;
  const replacement = replacedBy ? resolveLink(replacedBy, { space: page.space, path: page.path }) : null;
  const notices: ReactNode[] = [];
  if (page.status === "deprecated") {
    notices.push(
      <Notice key="deprecated" icon={<TriangleAlert />} tone="warning">
        <span>
          {t("deprecated")}{" "}
          {replacement?.kind === "page" && replacement.path ? (
            <>
              {t("seeInstead")}{" "}
              <Link
                to="/s/$space/$"
                params={{ space: replacement.space, _splat: replacement.path }}
                className="font-medium underline underline-offset-4"
              >
                {replacedBy}
              </Link>
            </>
          ) : null}
        </span>
      </Notice>,
    );
  }
  if (page.lock) {
    notices.push(
      <Notice key="lock" icon={<Info />}>
        <span>
          {page.lock.mine
            ? t("lockedMine")
            : t("lockedBy", { name: page.lock.user.name, time: format.relative(page.lock.since) })}
        </span>
      </Notice>,
    );
  }
  if (page.draft && page.abilities.editLive) {
    notices.push(
      <Notice key="draft" icon={<Pencil />}>
        <span>{t("draftNotice", { time: format.relative(page.draft.updatedAt) })}</span>
        <Link
          to="/pages/$id/edit"
          params={{ id: page.id }}
          className="font-medium underline underline-offset-4"
        >
          {t("continueEditing")}
        </Link>
      </Notice>,
    );
  }
  if (page.changeSets.length > 0) {
    notices.push(
      <Notice key="changes" icon={<GitPullRequestArrow />}>
        <span>
          <span className="font-medium">{t("pendingChanges")}: </span>
          {page.changeSets.map((changeSet, index) => (
            <span key={changeSet.number}>
              {index > 0 ? ", " : ""}
              <Link
                to="/changes/$number"
                params={{ number: String(changeSet.number) }}
                className="underline underline-offset-4"
              >
                #{changeSet.number} {changeSet.title}
              </Link>
            </span>
          ))}
        </span>
      </Notice>,
    );
  }
  if (notices.length === 0) return null;
  return <div className="mb-8 flex flex-col gap-2">{notices}</div>;
}

function formatValue(value: unknown, yes: string, no: string): string {
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "boolean") return value ? yes : no;
  return String(value);
}

/** The page's properties as facts at the end of the page (the type and tags show elsewhere). */
function Facts({ page, space }: { page: Page; space: Space | undefined }) {
  const t = useT(messages);
  const format = useFormatter();
  const replacedBy = typeof page.properties.replaced_by === "string" ? page.properties.replaced_by : null;
  const target = replacedBy ? resolveLink(replacedBy, { space: page.space, path: page.path }) : null;
  const custom = (space?.properties ?? []).filter((property) => page.properties[property.key] !== undefined);
  const builtIn = new Set<string>(BUILT_IN_KEYS);
  const others = Object.keys(page.properties).filter(
    (key) => !builtIn.has(key) && !space?.properties.some((property) => property.key === key),
  );
  const facts: { key: string; label: string; value: ReactNode }[] = [];
  if (page.status !== "active") {
    facts.push({
      key: "status",
      label: t("status"),
      value: <StatusBadge status={page.status as PageStatus} />,
    });
  }
  if (typeof page.properties.owner === "string") {
    facts.push({
      key: "owner",
      label: t("owner"),
      value: (
        <a href={`mailto:${page.properties.owner}`} className="underline underline-offset-4">
          {page.properties.owner}
        </a>
      ),
    });
  }
  if (typeof page.properties.reviewed === "string") {
    facts.push({ key: "reviewed", label: t("reviewed"), value: format.date(page.properties.reviewed) });
  }
  if (replacedBy) {
    facts.push({
      key: "replaced_by",
      label: t("replacedByLabel"),
      value:
        target?.kind === "page" && target.path ? (
          <Link
            to="/s/$space/$"
            params={{ space: target.space, _splat: target.path }}
            className="underline underline-offset-4"
          >
            {replacedBy}
          </Link>
        ) : (
          replacedBy
        ),
    });
  }
  for (const property of custom) {
    const value = page.properties[property.key];
    facts.push({
      key: property.key,
      label: property.label,
      value:
        property.type === "url" && typeof value === "string" ? (
          <a href={value} target="_blank" rel="noopener noreferrer" className="underline underline-offset-4">
            {value}
          </a>
        ) : property.type === "date" && typeof value === "string" ? (
          format.date(value)
        ) : (
          formatValue(value, t("yes"), t("no"))
        ),
    });
  }
  for (const key of others) {
    facts.push({
      key,
      label: BUILT_IN_PROPERTIES[key as keyof typeof BUILT_IN_PROPERTIES]?.label ?? key,
      value: formatValue(page.properties[key], t("yes"), t("no")),
    });
  }
  if (facts.length === 0) return null;
  return (
    <section aria-labelledby="page-facts" className="mt-10 border-y py-6">
      <h2 id="page-facts" className="sr-only">
        {t("properties")}
      </h2>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-5 text-sm sm:grid-cols-3">
        {facts.map((fact) => (
          <div key={fact.key} className="min-w-0">
            <dt className="text-muted-foreground text-xs">{fact.label}</dt>
            <dd className="mt-0.5 break-words">{fact.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/** The contents of the page in the margin: its sections, the one in view marked. */
function TableOfContents({ article, body }: { article: React.RefObject<HTMLElement | null>; body: string }) {
  const t = useT(messages);
  const [headings, setHeadings] = useState<{ id: string; text: string; level: number }[]>([]);
  const [active, setActive] = useState<string | null>(null);

  useEffect(() => {
    // Only the page text's own sections, not the parts the page view adds at its end.
    const nodes = [
      ...(article.current?.querySelectorAll<HTMLElement>(".article :is(h2, h3)[id]") ?? []),
    ].filter((node) => !node.closest("[data-footnotes]"));
    setHeadings(
      nodes.map((node) => ({
        id: node.id,
        text: node.textContent ?? "",
        level: node.tagName === "H2" ? 2 : 3,
      })),
    );
    let frame = 0;
    const update = () => {
      frame = 0;
      let current: string | null = nodes[0]?.id ?? null;
      for (const node of nodes) if (node.getBoundingClientRect().top < 140) current = node.id;
      setActive(current);
    };
    const onScroll = () => {
      if (!frame) frame = window.requestAnimationFrame(update);
    };
    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [article, body]);

  if (headings.length < 2) return null;
  return (
    <nav aria-label={t("onThisPage")} className="sticky top-24 text-[0.8125rem] leading-snug">
      <p className="text-muted-foreground mb-3.5 text-xs font-semibold">{t("onThisPage")}</p>
      <ul className="space-y-2.5">
        {headings.map((heading) => {
          const current = heading.id === active;
          return (
            <li key={heading.id} className={heading.level === 3 ? "pl-4" : undefined}>
              <a
                href={`#${encodeURIComponent(heading.id)}`}
                aria-current={current ? "location" : undefined}
                className={cn(
                  "group flex items-baseline gap-3 transition-colors",
                  current ? "text-foreground font-medium" : "text-muted-foreground hover:text-foreground",
                )}
              >
                <span
                  aria-hidden
                  className={cn(
                    "h-px shrink-0 translate-y-[-0.25em] transition-all",
                    current ? "bg-foreground w-5" : "bg-border w-3 group-hover:w-4",
                  )}
                />
                <span className="min-w-0">{heading.text}</span>
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

function PageContent({ page, space }: { page: Page; space: Space | undefined }) {
  const t = useT(messages);
  const format = useFormatter();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [moving, setMoving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const article = useRef<HTMLElement>(null);
  useScrollToAnchor(true);
  const body = splitFrontmatter(page.markdown)?.body ?? page.body;
  const abilities = page.abilities;
  const typeLabel = space?.pageTypes.find((pageType) => pageType.key === page.type)?.label ?? page.type;
  const owner = typeof page.properties.owner === "string" ? page.properties.owner : null;
  const reviewed = typeof page.properties.reviewed === "string" ? page.properties.reviewed : null;
  const person = owner ?? page.updatedBy?.name ?? page.spaceName;

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/s/${page.space}/${page.path}`);
      toast.success(t("linkCopied"));
    } catch {
      toast.error(errorMessage(new Error("Copy failed")));
    }
  };

  const remove = async () => {
    try {
      await api.delete(`/pages/${page.id}`);
      await queryClient.invalidateQueries({ queryKey: ["space", page.space] });
      queryClient.removeQueries({ queryKey: ["page", page.id] });
      toast.success(t("deleted"));
      const parent = parentPath(page.path);
      if (parent) void navigate({ to: "/s/$space/$", params: { space: page.space, _splat: parent } });
      else void navigate({ to: "/s/$space", params: { space: page.space } });
    } catch (error) {
      toast.error(errorMessage(error));
      throw error;
    }
  };

  const details = [
    t("readTime", { minutes: readingMinutes(body) }),
    reviewed ? t("reviewedOn", { date: format.date(reviewed) }) : null,
    page.updatedBy
      ? t("updatedBy", { time: format.relative(page.updatedAt), name: page.updatedBy.name })
      : t("updatedOn", { time: format.relative(page.updatedAt) }),
  ].filter(Boolean);

  return (
    <div className="@container w-full">
      <div className="mx-auto grid w-full max-w-[90rem] px-5 pt-8 pb-24 sm:px-8 sm:pt-12 @6xl:grid-cols-[minmax(0,1fr)_42.5rem_minmax(0,1fr)] @6xl:gap-x-12">
        <div className="hidden @6xl:block" />
        <article ref={article} className="mx-auto w-full max-w-[42.5rem] min-w-0">
          <Notices page={page} />
          <Breadcrumbs page={page} />
          {typeLabel || page.status !== "active" ? (
            <p className="text-muted-foreground mt-6 flex items-center gap-2 text-xs font-semibold tracking-[0.09em] uppercase">
              {typeLabel ? <span>{typeLabel}</span> : null}
              {page.status !== "active" ? <StatusBadge status={page.status as PageStatus} /> : null}
            </p>
          ) : null}
          <h1
            className={cn(
              "text-[2rem] leading-[1.15] font-bold tracking-[-0.024em] break-words sm:text-[2.75rem] sm:leading-[1.16]",
              typeLabel || page.status !== "active" ? "mt-3" : "mt-6",
            )}
          >
            {page.title}
          </h1>
          {page.description ? (
            <p className="text-muted-foreground mt-3 text-lg leading-snug sm:text-[1.375rem] sm:leading-[1.4]">
              {page.description}
            </p>
          ) : null}

          <div className="mt-8 flex items-center gap-3">
            <Avatar className="size-11">
              <AvatarFallback className="bg-amber-100 text-[0.9375rem] font-semibold text-amber-900 dark:bg-amber-900/40 dark:text-amber-100">
                {initials(person)}
              </AvatarFallback>
            </Avatar>
            <div className="min-w-0 text-sm">
              <p className="truncate">
                {owner ? (
                  <>
                    <span className="text-muted-foreground">{t("ownedBy")} </span>
                    <a href={`mailto:${owner}`} className="font-medium hover:underline">
                      {owner}
                    </a>
                  </>
                ) : (
                  <span className="font-medium">{page.updatedBy?.name ?? page.spaceName}</span>
                )}
              </p>
              <p className="text-muted-foreground">{details.join(" · ")}</p>
            </div>
          </div>

          <div className="mt-7 mb-10 flex items-center justify-between gap-2 border-y py-2">
            <div className="flex flex-wrap items-center gap-1">
              {abilities.editLive ? (
                <Button variant="secondary" size="sm" className="rounded-full px-3.5" asChild>
                  <Link to="/pages/$id/edit" params={{ id: page.id }}>
                    <Pencil />
                    {t("edit")}
                  </Link>
                </Button>
              ) : null}
              {abilities.propose ? (
                <Button
                  variant={abilities.editLive ? "ghost" : "secondary"}
                  size="sm"
                  className="rounded-full px-3.5"
                  asChild
                >
                  <Link to="/pages/$id/edit" params={{ id: page.id }} search={{ changeSet: "new" }}>
                    <GitPullRequestArrow />
                    {t("suggest")}
                  </Link>
                </Button>
              ) : null}
            </div>
            <div className="text-muted-foreground flex items-center">
              <Button variant="ghost" size="icon" className="rounded-full" asChild>
                <Link
                  to="/pages/$id/history"
                  params={{ id: page.id }}
                  aria-label={t("history")}
                  title={t("history")}
                >
                  <History />
                </Link>
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="rounded-full"
                aria-label={t("copyLink")}
                title={t("copyLink")}
                onClick={() => void copyLink()}
              >
                <Link2 />
              </Button>
              <Button variant="ghost" size="icon" className="hidden rounded-full sm:inline-flex" asChild>
                <a
                  href={pageMarkdownUrl(page.space, page.path)}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={t("markdownFile")}
                  title={t("markdownFile")}
                >
                  <FileCode />
                </a>
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon" className="rounded-full" aria-label={t("more")}>
                    <MoreHorizontal />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-56">
                  {abilities.editLive || abilities.propose ? (
                    <DropdownMenuItem asChild>
                      <Link
                        to="/s/$space/-/new"
                        params={{ space: page.space }}
                        search={{ parent: page.path, changeSet: abilities.editLive ? undefined : "new" }}
                      >
                        <FilePlus2 />
                        {t("newSubPage")}
                      </Link>
                    </DropdownMenuItem>
                  ) : null}
                  {abilities.editLive ? (
                    <DropdownMenuItem onSelect={() => setMoving(true)}>
                      <FolderInput />
                      {t("move")}
                    </DropdownMenuItem>
                  ) : null}
                  <DropdownMenuItem asChild className="sm:hidden">
                    <a
                      href={pageMarkdownUrl(page.space, page.path)}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <FileCode />
                      {t("markdownFile")}
                    </a>
                  </DropdownMenuItem>
                  {abilities.editLive ? (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem variant="destructive" onSelect={() => setDeleting(true)}>
                        <Trash2 />
                        {t("delete")}
                      </DropdownMenuItem>
                    </>
                  ) : null}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>

          <MarkdownView
            markdown={body}
            space={page.space}
            path={page.path}
            title={page.title}
            variant="article"
          />

          {page.tags.length > 0 ? (
            <div aria-label={t("tags")} className="mt-12 flex flex-wrap gap-2">
              {page.tags.map((tag) => (
                <Link
                  key={tag}
                  to="/tags/$tag"
                  params={{ tag }}
                  className="bg-muted hover:bg-accent rounded-full px-3.5 py-1.5 text-sm transition-colors"
                >
                  {tag}
                </Link>
              ))}
            </div>
          ) : null}

          <Facts page={page} space={space} />

          {page.children.length > 0 ? (
            <section aria-labelledby="page-children" className="mt-10">
              <h2 id="page-children" className="mb-4 text-base font-bold">
                {t("subPages")}
              </h2>
              <div className="grid gap-3 sm:grid-cols-2">
                {page.children.map((child) => (
                  <Link
                    key={child.id}
                    to="/s/$space/$"
                    params={{ space: child.space, _splat: child.path }}
                    className="group hover:bg-muted/40 flex flex-col gap-1.5 rounded-xl border p-4 transition-colors"
                  >
                    <span className="flex items-start justify-between gap-2">
                      <span className="font-semibold tracking-tight">{child.title}</span>
                      <StatusBadge status={child.status} />
                    </span>
                    {child.description ? (
                      <span className="text-muted-foreground line-clamp-2 text-sm">{child.description}</span>
                    ) : null}
                    <span className="mt-auto flex items-center gap-1 pt-1 text-xs font-medium">
                      {t("read")}
                      <ArrowRight
                        className="size-3 transition-transform group-hover:translate-x-0.5"
                        aria-hidden
                      />
                    </span>
                  </Link>
                ))}
              </div>
            </section>
          ) : null}

          {page.backlinks.length > 0 ? (
            <section aria-labelledby="page-backlinks" className="mt-10">
              <h2 id="page-backlinks" className="mb-3 text-base font-bold">
                {t("backlinks")}
              </h2>
              <ul className="flex flex-wrap gap-x-5 gap-y-2 text-[0.9375rem]">
                {page.backlinks.map((link) => (
                  <li key={link.id}>
                    <Link
                      to="/s/$space/$"
                      params={{ space: link.space, _splat: link.path }}
                      className="decoration-border hover:decoration-foreground underline underline-offset-4"
                    >
                      {link.title}
                    </Link>
                    {link.space !== page.space ? (
                      <span className="text-muted-foreground"> · {link.space}</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          <p className="text-muted-foreground mt-10 border-t pt-5 text-xs">
            {page.updatedBy
              ? t("lastChange", {
                  time: format.relative(page.updatedAt),
                  name: page.updatedBy.name,
                  revision: page.revision,
                })
              : t("lastChangeAnonymous", { time: format.relative(page.updatedAt), revision: page.revision })}
            {" · "}
            <Link to="/pages/$id/history" params={{ id: page.id }} className="underline underline-offset-4">
              {t("history")}
            </Link>
          </p>
        </article>
        <aside className="hidden pt-[13.5rem] @6xl:block">
          <TableOfContents article={article} body={body} />
        </aside>
      </div>

      {moving ? (
        <MoveDialog
          page={page}
          open={moving}
          onOpenChange={setMoving}
          onMoved={(moved) =>
            void navigate({ to: "/s/$space/$", params: { space: page.space, _splat: moved.path } })
          }
        />
      ) : null}
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={t("deleteTitle", { title: page.title })}
        description={t("deleteText")}
        confirmLabel={t("delete")}
        destructive
        onConfirm={remove}
      />
    </div>
  );
}
