import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Space, SpaceCreate, SpaceSummary } from "@handbook/shared/api/spaces";
import type { ServiceToken, TokenCreate, TokenCreated } from "@handbook/shared/api/tokens";
import type { Person, PersonUpdate } from "@handbook/shared/api/users";
import { api } from "@/lib/api";

export const adminKeys = {
  spaces: ["admin", "spaces"] as const,
  people: (q: string) => ["admin", "people", q] as const,
  serviceTokens: ["admin", "service-tokens"] as const,
};

export function useAllSpaces() {
  return useQuery({
    queryKey: adminKeys.spaces,
    queryFn: ({ signal }) => api.get<{ items: SpaceSummary[] }>("/spaces", { archived: "include" }, signal),
  });
}

/** Refreshes every list of spaces (the sidebar's too). */
function useRefreshSpaces() {
  const client = useQueryClient();
  return () =>
    Promise.all([
      client.invalidateQueries({ queryKey: adminKeys.spaces }),
      client.invalidateQueries({ queryKey: ["spaces"] }),
      client.invalidateQueries({ queryKey: ["space"] }),
    ]);
}

export function useCreateSpace() {
  const refresh = useRefreshSpaces();
  return useMutation({
    mutationFn: (input: SpaceCreate) => api.post<Space>("/spaces", input),
    onSettled: refresh,
  });
}

export function useArchiveSpace() {
  const refresh = useRefreshSpaces();
  return useMutation({
    mutationFn: (input: { slug: string; archive: boolean }) =>
      api.post<Space>(`/spaces/${input.slug}/${input.archive ? "archive" : "unarchive"}`),
    onSettled: refresh,
  });
}

export function usePeople(q: string) {
  return useQuery({
    queryKey: adminKeys.people(q),
    queryFn: ({ signal }) => api.get<{ items: Person[] }>("/admin/people", { q }, signal),
    placeholderData: keepPreviousData,
  });
}

export function useUpdatePerson() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; update: PersonUpdate }) =>
      api.patch<Person>(`/admin/people/${input.id}`, input.update),
    onSettled: () =>
      Promise.all([
        client.invalidateQueries({ queryKey: ["admin", "people"] }),
        client.invalidateQueries({ queryKey: ["me"] }),
      ]),
  });
}

/** Removes a person: their history stays under REMOVED_PERSON_NAME (`@handbook/shared/api/users`). */
export function useRemovePerson() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/admin/people/${id}`),
    onSettled: () => client.invalidateQueries({ queryKey: ["admin", "people"] }),
  });
}

export function useServiceTokens() {
  return useQuery({
    queryKey: adminKeys.serviceTokens,
    queryFn: ({ signal }) => api.get<{ items: ServiceToken[] }>("/admin/service-tokens", undefined, signal),
  });
}

export function useCreateServiceToken() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: TokenCreate) => api.post<TokenCreated>("/admin/service-tokens", input),
    onSettled: () => client.invalidateQueries({ queryKey: adminKeys.serviceTokens }),
  });
}

export function useRevokeServiceToken() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/admin/service-tokens/${id}`),
    onSettled: () => client.invalidateQueries({ queryKey: adminKeys.serviceTokens }),
  });
}
