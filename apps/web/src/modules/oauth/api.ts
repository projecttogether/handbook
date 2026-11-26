import { useMutation, useQuery } from "@tanstack/react-query";
import type { OauthRequest } from "@handbook/shared/api/tokens";
import { api } from "@/lib/api";

export function useOauthRequest(id: string) {
  return useQuery({
    queryKey: ["oauth-request", id],
    queryFn: ({ signal }) => api.get<OauthRequest>(`/oauth/requests/${id}`, undefined, signal),
    enabled: id !== "",
    retry: false,
    staleTime: Infinity,
  });
}

/** Approves or denies a sign-in request; the answer says where the browser goes next. */
export function useOauthDecision(id: string) {
  return useMutation({
    mutationFn: (decision: "approve" | "deny") =>
      api.post<{ redirectUrl: string }>(`/oauth/requests/${id}/${decision}`),
  });
}
