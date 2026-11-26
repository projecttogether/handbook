import { keepPreviousData } from "@tanstack/react-query";
import type { ChangeSet, ChangeSetPage, ChangeSetSummary } from "@handbook/shared/api/changes";
import type {
  Draft,
  Page,
  PageSummary,
  Revision,
  RevisionList,
  recentChangeSchema,
} from "@handbook/shared/api/pages";
import type { SearchResponse } from "@handbook/shared/api/search";
import type { Space, SpaceMember } from "@handbook/shared/api/spaces";
import type { z } from "zod";
import { api } from "@/lib/api";

/** Queries of spaces and pages, shared by the content modules and the editor. */

export type RecentChange = z.infer<typeof recentChangeSchema>;

export const spaceQuery = (space: string) => ({
  queryKey: ["space", space] as const,
  queryFn: () => api.get<Space>(`/spaces/${encodeURIComponent(space)}`),
  staleTime: 30_000,
});

export const treeQuery = (space: string) => ({
  queryKey: ["space", space, "tree"] as const,
  queryFn: () => api.get<{ items: PageSummary[] }>(`/spaces/${encodeURIComponent(space)}/tree`),
});

export const membersQuery = (space: string) => ({
  queryKey: ["space", space, "members"] as const,
  queryFn: () => api.get<{ items: SpaceMember[] }>(`/spaces/${encodeURIComponent(space)}/members`),
});

export const trashQuery = (space: string) => ({
  queryKey: ["space", space, "trash"] as const,
  queryFn: () =>
    api.get<{ items: (PageSummary & { deletedAt: string; deletedBy: { name: string } | null })[] }>(
      `/spaces/${encodeURIComponent(space)}/trash`,
    ),
});

export const pageQuery = (id: string) => ({
  queryKey: ["page", id] as const,
  queryFn: () => api.get<Page>(`/pages/${id}`),
});

export const pageByPathQuery = (space: string, path: string) => ({
  queryKey: ["page-by-path", space, path] as const,
  queryFn: () => api.get<Page>(`/spaces/${encodeURIComponent(space)}/pages/by-path`, { path }),
});

export const draftQuery = (id: string) => ({
  queryKey: ["page", id, "draft"] as const,
  queryFn: () => api.get<Draft>(`/pages/${id}/draft`),
  staleTime: 0,
});

export const revisionsQuery = (id: string, limit: number, offset: number) => ({
  queryKey: ["page", id, "revisions", { limit, offset }] as const,
  queryFn: () => api.get<RevisionList>(`/pages/${id}/revisions`, { limit, offset }),
  placeholderData: keepPreviousData,
});

export const revisionQuery = (id: string, number: number) => ({
  queryKey: ["page", id, "revision", number] as const,
  queryFn: () => api.get<Revision>(`/pages/${id}/revisions/${number}`),
});

export const recentQuery = (space?: string, limit = 15) => ({
  queryKey: ["recent", space ?? null, limit] as const,
  queryFn: () => api.get<{ items: RecentChange[] }>("/recent", { space, limit }),
});

export const searchQuery = (params: { q: string; space?: string; tag?: string; type?: string }) => ({
  queryKey: ["search", params] as const,
  queryFn: () => api.get<SearchResponse>("/search", params),
});

export const changeSetQuery = (number: number) => ({
  queryKey: ["change-set", number] as const,
  queryFn: () => api.get<ChangeSet>(`/change-sets/${number}`),
});

export const changeSetPageQuery = (number: number, pageId: string) => ({
  queryKey: ["change-set", number, "page", pageId] as const,
  queryFn: () => api.get<ChangeSetPage>(`/change-sets/${number}/pages/${pageId}`),
  staleTime: 0,
});

export const changeSetListQuery = (params: { status?: string; mine?: boolean; space?: string }) => ({
  queryKey: ["change-sets", params] as const,
  queryFn: () =>
    api.get<{ items: ChangeSetSummary[] }>("/change-sets", {
      status: params.status,
      mine: params.mine ? "true" : undefined,
      space: params.space,
    }),
});
