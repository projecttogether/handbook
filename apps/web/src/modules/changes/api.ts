import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { z } from "zod";
import type {
  ChangeSet,
  ChangeSetPage,
  ChangeSetSummary,
  mergeConflictsSchema,
  revertResultSchema,
} from "@handbook/shared/api/changes";
import type { ErrorBody } from "@handbook/shared/api/common";
import { api, ApiError, apiUrl } from "@/lib/api";

export type ChangeSetFilters = {
  status: "active" | "open" | "in_review" | "merged" | "closed" | "all";
  space?: string;
  mine?: boolean;
};

export type MergeConflicts = z.infer<typeof mergeConflictsSchema>["conflicts"];
export type RevertResult = z.infer<typeof revertResultSchema>;

/** A 409 `merge_conflicts` answer: the pages whose live version changed in overlapping ways. */
export class MergeConflictError extends ApiError {
  constructor(
    message: string,
    readonly conflicts: MergeConflicts,
  ) {
    super(409, "merge_conflicts", message);
    this.name = "MergeConflictError";
  }
}

export const changeSetKeys = {
  all: ["change-sets"] as const,
  list: (filters: ChangeSetFilters) => ["change-sets", "list", filters] as const,
  detail: (number: number) => ["change-sets", "detail", number] as const,
  page: (number: number, pageId: string) => ["change-sets", "detail", number, "page", pageId] as const,
};

export function useChangeSets(filters: ChangeSetFilters) {
  return useQuery({
    queryKey: changeSetKeys.list(filters),
    queryFn: ({ signal }) =>
      api.get<{ items: ChangeSetSummary[] }>(
        "/change-sets",
        { status: filters.status, space: filters.space, mine: filters.mine ? "true" : undefined },
        signal,
      ),
  });
}

export function useChangeSet(number: number) {
  return useQuery({
    queryKey: changeSetKeys.detail(number),
    queryFn: ({ signal }) => api.get<ChangeSet>(`/change-sets/${number}`, undefined, signal),
  });
}

export function useChangeSetPage(number: number, pageId: string, enabled: boolean) {
  return useQuery({
    queryKey: changeSetKeys.page(number, pageId),
    queryFn: ({ signal }) =>
      api.get<ChangeSetPage>(`/change-sets/${number}/pages/${pageId}`, undefined, signal),
    enabled,
  });
}

/**
 * Merges a change set. A 409 `merge_conflicts` carries the conflicting
 * pages next to the error, which the shared client leaves out, so this
 * request reads the body itself.
 */
export async function mergeChangeSet(number: number): Promise<ChangeSet> {
  const response = await fetch(apiUrl(`/change-sets/${number}/merge`), {
    method: "POST",
    credentials: "same-origin",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: "{}",
  });
  const text = await response.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (response.ok) return body as ChangeSet;
  const error = (body as Partial<ErrorBody> | null)?.error;
  const message = error?.message ?? `Request failed (${response.status})`;
  if (response.status === 409 && error?.code === "merge_conflicts") {
    const conflicts = (body as { conflicts?: MergeConflicts }).conflicts ?? [];
    throw new MergeConflictError(message, conflicts);
  }
  throw new ApiError(response.status, error?.code ?? "internal_error", message, error?.fields);
}

/**
 * Runs a change set action and refreshes everything it may have changed:
 * change sets (lists, this page, the editor's), pages (by id and by path),
 * spaces (counts, trees) and the recent feed.
 */
export function useChangeSetAction<TInput, TResult>(run: (input: TInput) => Promise<TResult>) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: run,
    onSettled: () =>
      Promise.all(
        [
          changeSetKeys.all,
          ["change-set"],
          ["page"],
          ["page-by-path"],
          ["spaces"],
          ["space"],
          ["recent"],
        ].map((queryKey) => client.invalidateQueries({ queryKey })),
      ),
  });
}

export const changeSetApi = {
  update: (number: number, input: { title?: string; description?: string }) =>
    api.patch<ChangeSet>(`/change-sets/${number}`, input),
  submit: (number: number, note?: string) => api.post<ChangeSet>(`/change-sets/${number}/submit`, { note }),
  requestChanges: (number: number, body: string) =>
    api.post<ChangeSet>(`/change-sets/${number}/request-changes`, { body }),
  close: (number: number) => api.post<ChangeSet>(`/change-sets/${number}/close`),
  reopen: (number: number) => api.post<ChangeSet>(`/change-sets/${number}/reopen`),
  revert: (number: number) => api.post<RevertResult>(`/change-sets/${number}/revert`),
  comment: (number: number, body: string) => api.post<ChangeSet>(`/change-sets/${number}/comments`, { body }),
  rebase: (number: number, pageId: string) =>
    api.post<ChangeSet>(`/change-sets/${number}/pages/${pageId}/rebase`),
  undo: (number: number, pageId: string) => api.delete<ChangeSet>(`/change-sets/${number}/pages/${pageId}`),
};
