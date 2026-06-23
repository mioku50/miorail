import { useQuery, useMutation, UseQueryOptions, UseMutationOptions } from '@tanstack/react-query';
import * as apiSpec from '@mioagent/api-spec';

// Simple fetch wrapper
async function fetchApi<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, options);
  if (!response.ok) {
    throw new Error(`API error: ${response.status} ${response.statusText}`);
  }
  return response.json();
}

// Queries
export function useSession(options?: UseQueryOptions<apiSpec.SessionResponse>) {
  return useQuery({
    queryKey: ['session'],
    queryFn: () => fetchApi<apiSpec.SessionResponse>('/api/auth/session'),
    ...options,
  });
}

export function useChatHistory(
  params?: apiSpec.PaginationParams,
  options?: UseQueryOptions<apiSpec.ChatHistoryResponse>,
) {
  return useQuery({
    queryKey: ['chat', 'history', params],
    queryFn: () => {
      const url = new URL('/api/chat/history', 'http://localhost');
      if (params?.limit) url.searchParams.set('limit', params.limit.toString());
      if (params?.cursor) url.searchParams.set('cursor', params.cursor);
      return fetchApi<apiSpec.ChatHistoryResponse>(url.pathname + url.search);
    },
    ...options,
  });
}

export function useActionsFeed(
  params?: apiSpec.PaginationParams,
  options?: UseQueryOptions<apiSpec.ActionsFeedResponse>,
) {
  return useQuery({
    queryKey: ['actions', 'feed', params],
    queryFn: () => {
      const url = new URL('/api/actions', 'http://localhost');
      if (params?.limit) url.searchParams.set('limit', params.limit.toString());
      if (params?.cursor) url.searchParams.set('cursor', params.cursor);
      return fetchApi<apiSpec.ActionsFeedResponse>(url.pathname + url.search);
    },
    ...options,
  });
}

export function useSettings(options?: UseQueryOptions<apiSpec.SettingsResponse>) {
  return useQuery({
    queryKey: ['settings'],
    queryFn: () => fetchApi<apiSpec.SettingsResponse>('/api/settings'),
    ...options,
  });
}

export function useMemory(options?: UseQueryOptions<apiSpec.MemoryResponse>) {
  return useQuery({
    queryKey: ['memory'],
    queryFn: () => fetchApi<apiSpec.MemoryResponse>('/api/memory'),
    ...options,
  });
}

export function useProtocols(options?: UseQueryOptions<apiSpec.ProtocolsListResponse>) {
  return useQuery({
    queryKey: ['protocols'],
    queryFn: () => fetchApi<apiSpec.ProtocolsListResponse>('/api/protocols'),
    ...options,
  });
}

export function usePortfolio(options?: UseQueryOptions<apiSpec.PortfolioResponse>) {
  return useQuery({
    queryKey: ['portfolio'],
    queryFn: () => fetchApi<apiSpec.PortfolioResponse>('/api/portfolio'),
    ...options,
  });
}

// Mutations
export function useSendMessage(
  options?: UseMutationOptions<apiSpec.ChatMessageResponse, Error, apiSpec.ChatMessageRequest>,
) {
  return useMutation({
    mutationFn: (data: apiSpec.ChatMessageRequest) =>
      fetchApi<apiSpec.ChatMessageResponse>('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      }),
    ...options,
  });
}

export function useExecuteAction(
  options?: UseMutationOptions<apiSpec.ExecuteActionResponse, Error, apiSpec.ExecuteActionRequest>,
) {
  return useMutation({
    mutationFn: (data: apiSpec.ExecuteActionRequest) =>
      fetchApi<apiSpec.ExecuteActionResponse>(`/api/actions/${data.actionId}/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      }),
    ...options,
  });
}

export function useDismissAction(
  options?: UseMutationOptions<apiSpec.DismissActionResponse, Error, apiSpec.DismissActionRequest>,
) {
  return useMutation({
    mutationFn: (data: apiSpec.DismissActionRequest) =>
      fetchApi<apiSpec.DismissActionResponse>(`/api/actions/${data.actionId}/dismiss`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      }),
    ...options,
  });
}

export function useUpdateSettings(
  options?: UseMutationOptions<
    apiSpec.UpdateSettingsResponse,
    Error,
    apiSpec.UpdateSettingsRequest
  >,
) {
  return useMutation({
    mutationFn: (data: apiSpec.UpdateSettingsRequest) =>
      fetchApi<apiSpec.UpdateSettingsResponse>('/api/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      }),
    ...options,
  });
}

export function useUpdateMemory(
  options?: UseMutationOptions<apiSpec.UpdateMemoryResponse, Error, apiSpec.UpdateMemoryRequest>,
) {
  return useMutation({
    mutationFn: (data: apiSpec.UpdateMemoryRequest) =>
      fetchApi<apiSpec.UpdateMemoryResponse>('/api/memory', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      }),
    ...options,
  });
}

export function useToggleProtocol(
  options?: UseMutationOptions<
    apiSpec.ToggleProtocolResponse,
    Error,
    apiSpec.ToggleProtocolRequest
  >,
) {
  return useMutation({
    mutationFn: (data: apiSpec.ToggleProtocolRequest) =>
      fetchApi<apiSpec.ToggleProtocolResponse>(`/api/protocols/${data.protocolId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: data.enabled }),
      }),
    ...options,
  });
}

export function useLogin(
  options?: UseMutationOptions<apiSpec.LoginResponse, Error, apiSpec.LoginRequest>,
) {
  return useMutation({
    mutationFn: (data: apiSpec.LoginRequest) =>
      fetchApi<apiSpec.LoginResponse>('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      }),
    ...options,
  });
}

export function useLogout(options?: UseMutationOptions<{ success: boolean }, Error, void>) {
  return useMutation({
    mutationFn: () =>
      fetchApi<{ success: boolean }>('/api/auth/logout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      }),
    ...options,
  });
}
