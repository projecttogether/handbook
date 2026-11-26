import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import type { Me } from "@handbook/shared/api/users";
import type { SpaceRole } from "@handbook/shared/roles";
import { api } from "@/lib/api";

export const meQuery = { queryKey: ["me"] as const, queryFn: () => api.get<Me>("/me"), staleTime: 60_000 };

/** The signed-in person. Only use inside the signed-in app (its route loads it first). */
export function useMe(): Me {
  return useSuspenseQuery(meQuery).data;
}

/** The signed-in person, or undefined while loading or signed out. */
export function useMaybeMe(): Me | undefined {
  return useQuery({ ...meQuery, retry: false }).data;
}

/** Admins only see admin pages; the server checks access too. */
export function useIsAdmin(): boolean {
  return useMe().isAdmin;
}

/** The signed-in person's role in a space (owner, editor) or null. Admins may do everything anyway. */
export function useSpaceRole(space: string): SpaceRole | null {
  return useMe().spaces.find((item) => item.slug === space)?.role ?? null;
}
