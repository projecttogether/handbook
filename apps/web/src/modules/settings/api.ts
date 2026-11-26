import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  ConnectedApp,
  ConnectInfo,
  Token,
  TokenCreate,
  TokenCreated,
} from "@handbook/shared/api/tokens";
import { api } from "@/lib/api";

export const settingsKeys = {
  tokens: ["tokens"] as const,
  connectedApps: ["connected-apps"] as const,
  connectInfo: ["connect-info"] as const,
};

export function useTokens() {
  return useQuery({
    queryKey: settingsKeys.tokens,
    queryFn: ({ signal }) => api.get<{ items: Token[] }>("/tokens", undefined, signal),
  });
}

export function useCreateToken() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: TokenCreate) => api.post<TokenCreated>("/tokens", input),
    onSettled: () => client.invalidateQueries({ queryKey: settingsKeys.tokens }),
  });
}

export function useRevokeToken() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/tokens/${id}`),
    onSettled: () => client.invalidateQueries({ queryKey: settingsKeys.tokens }),
  });
}

export function useConnectedApps() {
  return useQuery({
    queryKey: settingsKeys.connectedApps,
    queryFn: ({ signal }) => api.get<{ items: ConnectedApp[] }>("/connected-apps", undefined, signal),
  });
}

export function useDisconnectApp() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/connected-apps/${id}`),
    onSettled: () => client.invalidateQueries({ queryKey: settingsKeys.connectedApps }),
  });
}

export function useConnectInfo() {
  return useQuery({
    queryKey: settingsKeys.connectInfo,
    queryFn: ({ signal }) => api.get<ConnectInfo>("/connect-info", undefined, signal),
    staleTime: Infinity,
  });
}
