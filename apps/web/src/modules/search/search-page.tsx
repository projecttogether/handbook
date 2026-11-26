import { useId, useState, type FormEvent, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ChevronRight, Search, X } from "lucide-react";
import { HIGHLIGHT_END, HIGHLIGHT_START, type SearchResult } from "@handbook/shared/api/search";
import { spacesQuery } from "@/components/layout/app-layout";
import { Page as PageLayout, PageHeader } from "@/components/ui/page";
import { searchQuery } from "@/components/page/queries";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useT } from "@/i18n";
import { messages } from "./messages";

export type SearchParams = { q?: string; space?: string; tag?: string; type?: string };

/** Splits a snippet at the highlight marks into text and <mark> parts. */
export function highlightParts(snippet: string): ReactNode[] {
  const parts: ReactNode[] = [];
  let rest = snippet;
  let key = 0;
  while (rest.length > 0) {
    const start = rest.indexOf(HIGHLIGHT_START);
    if (start === -1) {
      parts.push(rest);
      break;
    }
    if (start > 0) parts.push(rest.slice(0, start));
    const end = rest.indexOf(HIGHLIGHT_END, start + 1);
    const marked = end === -1 ? rest.slice(start + 1) : rest.slice(start + 1, end);
    parts.push(
      <mark key={key++} className="rounded-sm bg-yellow-200 px-0.5 text-inherit dark:bg-yellow-500/40">
        {marked}
      </mark>,
    );
    rest = end === -1 ? "" : rest.slice(end + 1);
  }
  return parts;
}

function Result({ result }: { result: SearchResult }) {
  return (
    <li className="space-y-1 py-4">
      <div className="text-muted-foreground flex flex-wrap items-center gap-1 text-xs">
        <span>{result.space.name}</span>
        {result.headingPath.map((heading, index) => (
          <span key={index} className="flex items-center gap-1">
            <ChevronRight className="size-3" aria-hidden />
            {heading}
          </span>
        ))}
      </div>
      <Link
        to="/s/$space/$"
        params={{ space: result.space.slug, _splat: result.path }}
        hash={result.anchor ?? undefined}
        className="text-link text-lg font-medium underline-offset-4 hover:underline"
      >
        {result.title}
      </Link>
      {result.snippet ? <p className="text-sm leading-6">{highlightParts(result.snippet)}</p> : null}
      {result.description && !result.snippet ? (
        <p className="text-muted-foreground text-sm">{result.description}</p>
      ) : null}
      {result.tags.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {result.tags.map((tag) => (
            <Badge key={tag} variant="secondary" asChild>
              <Link to="/tags/$tag" params={{ tag }}>
                {tag}
              </Link>
            </Badge>
          ))}
        </div>
      ) : null}
    </li>
  );
}

const ALL = "__all";

/** Full-text search over every space, with filters. */
export function SearchPage(props: { params: SearchParams; onChange: (params: SearchParams) => void }) {
  const t = useT(messages);
  const queryId = useId();
  const spaceId = useId();
  const [text, setText] = useState(props.params.q ?? "");
  const spaces = useQuery(spacesQuery).data?.items ?? [];
  const q = props.params.q?.trim() ?? "";
  const results = useQuery({
    ...searchQuery({ q, space: props.params.space, tag: props.params.tag, type: props.params.type }),
    enabled: q.length > 0,
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    props.onChange({ ...props.params, q: text.trim() || undefined });
  };

  return (
    <PageLayout className="max-w-4xl">
      <PageHeader title={t("title")} />
      <form role="search" onSubmit={submit} className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="min-w-0 flex-1 space-y-1">
          <label htmlFor={queryId} className="text-sm font-medium">
            {t("query")}
          </label>
          <Input
            id={queryId}
            type="search"
            value={text}
            placeholder={t("placeholder")}
            autoFocus
            onChange={(event) => setText(event.target.value)}
          />
        </div>
        <div className="space-y-1 sm:w-48">
          <label htmlFor={spaceId} className="text-sm font-medium">
            {t("space")}
          </label>
          <Select
            value={props.params.space ?? ALL}
            onValueChange={(value) =>
              props.onChange({ ...props.params, space: value === ALL ? undefined : value })
            }
          >
            <SelectTrigger id={spaceId} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>{t("allSpaces")}</SelectItem>
              {spaces.map((space) => (
                <SelectItem key={space.slug} value={space.slug}>
                  {space.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button type="submit">
          <Search />
          {t("submit")}
        </Button>
      </form>
      {props.params.tag || props.params.type ? (
        <div className="flex flex-wrap gap-2">
          {(["tag", "type"] as const).map((key) =>
            props.params[key] ? (
              <Badge key={key} variant="outline" className="gap-1 py-1">
                {key === "tag" ? `${t("tag")}: ` : ""}
                {props.params[key]}
                <button
                  type="button"
                  aria-label={t("clearFilter", { name: props.params[key] ?? "" })}
                  onClick={() => props.onChange({ ...props.params, [key]: undefined })}
                >
                  <X className="size-3" />
                </button>
              </Badge>
            ) : null,
          )}
        </div>
      ) : null}
      {!q ? (
        <EmptyState icon={<Search />} title={t("start")} description={t("startHint")} />
      ) : results.isPending ? (
        <LoadingState />
      ) : results.error ? (
        <ErrorState error={results.error} onRetry={() => void results.refetch()} />
      ) : results.data.results.length === 0 ? (
        <EmptyState icon={<Search />} title={t("noResults")} description={t("noResultsHint")} />
      ) : (
        <section aria-live="polite">
          <p className="text-muted-foreground text-sm">
            {t("results", { count: results.data.results.length })}
          </p>
          <ul className="divide-y">
            {results.data.results.map((result) => (
              <Result key={result.pageId} result={result} />
            ))}
          </ul>
        </section>
      )}
    </PageLayout>
  );
}
