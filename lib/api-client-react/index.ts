import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { UseQueryOptions, UseMutationOptions } from '@tanstack/react-query';
import * as apiSpec from '@mioagent/api-spec';

// Simple fetch wrapper
async function fetchApi<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, options);
  if (!response.ok) {
    let errorMsg = `API error: ${response.status} ${response.statusText}`;
    try {
      const errJson = await response.json();
      if (errJson.error) errorMsg = errJson.error;
    } catch {}
    throw new Error(errorMsg);
  }
  return response.json();
}

// Queries
export function useSession(options?: Omit<UseQueryOptions<apiSpec.SessionResponse, Error, apiSpec.SessionResponse, string[]>, 'queryKey' | 'queryFn'>) {
  return useQuery({
    queryKey: ['session'],
    queryFn: () => fetchApi<apiSpec.SessionResponse>('/api/auth/session'),
    ...options,
  });
}

export function useChatHistory(
  params?: apiSpec.PaginationParams,
  options?: Omit<UseQueryOptions<apiSpec.ChatHistoryResponse, Error, apiSpec.ChatHistoryResponse, (string | apiSpec.PaginationParams | undefined)[]>, 'queryKey' | 'queryFn'>,
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
  options?: Omit<UseQueryOptions<apiSpec.ActionsFeedResponse, Error, apiSpec.ActionsFeedResponse, (string | apiSpec.PaginationParams | undefined)[]>, 'queryKey' | 'queryFn'>,
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

export function useSettings(options?: Omit<UseQueryOptions<apiSpec.SettingsResponse, Error, apiSpec.SettingsResponse, string[]>, 'queryKey' | 'queryFn'>) {
  return useQuery({
    queryKey: ['settings'],
    queryFn: () => fetchApi<apiSpec.SettingsResponse>('/api/settings'),
    ...options,
  });
}

export function useMemory(options?: Omit<UseQueryOptions<apiSpec.MemoryResponse, Error, apiSpec.MemoryResponse, string[]>, 'queryKey' | 'queryFn'>) {
  return useQuery({
    queryKey: ['memory'],
    queryFn: () => fetchApi<apiSpec.MemoryResponse>('/api/memory'),
    ...options,
  });
}

export function useProtocols(options?: Omit<UseQueryOptions<apiSpec.ProtocolsListResponse, Error, apiSpec.ProtocolsListResponse, string[]>, 'queryKey' | 'queryFn'>) {
  return useQuery({
    queryKey: ['protocols'],
    queryFn: () => fetchApi<apiSpec.ProtocolsListResponse>('/api/protocols'),
    ...options,
  });
}

export function usePortfolio(
  address?: string,
  options?: Omit<UseQueryOptions<apiSpec.PortfolioResponse, Error, apiSpec.PortfolioResponse, (string | undefined)[]>, 'queryKey' | 'queryFn'>
) {
  return useQuery({
    queryKey: ['portfolio', address],
    queryFn: () => {
      const url = new URL('/api/portfolio', 'http://localhost');
      if (address) url.searchParams.set('address', address);
      return fetchApi<apiSpec.PortfolioResponse>(url.pathname + url.search);
    },
    // Smart polling: the backend provider cache makes repeated calls cheap, but
    // the frontend should not hammer the API every tick. Auto-refetch on a slow
    // cadence; rely on the cache + manual refresh for everything else.
    enabled: !!address,
    refetchInterval: 60000,
    refetchOnWindowFocus: false,
    ...options,
  });
}

export function useStatus(options?: Omit<UseQueryOptions<apiSpec.StatusResponse, Error, apiSpec.StatusResponse, string[]>, 'queryKey' | 'queryFn'>) {
  return useQuery({
    queryKey: ['status'],
    queryFn: () => fetchApi<apiSpec.StatusResponse>('/api/status'),
    // Status is cheap and triggers no expensive provider calls, so it can poll
    // more often to surface cache/budget diagnostics.
    refetchInterval: 15000,
    ...options,
  });
}

// Mutations

export function useCreateRecommendation(
  options?: Omit<UseMutationOptions<{ success: boolean; actionId: string }, Error, { instruction: string; walletAddress?: string; chainEnv?: string }>, 'mutationFn'>
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data) => fetchApi<{ success: boolean; actionId: string }>('/api/actions/recommend', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['actions', 'feed'] }),
    ...options,
  });
}


export function useClearChatHistory(
  options?: Omit<UseMutationOptions<{ success: boolean }, Error, void>, 'mutationFn'>
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => fetchApi<{ success: boolean }>('/api/chat/history', { method: 'DELETE' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['chat', 'history'] }),
    ...options,
  });
}

export function useClearActions(
  options?: Omit<UseMutationOptions<{ success: boolean; count?: number }, Error, void>, 'mutationFn'>
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => fetchApi<{ success: boolean; count?: number }>('/api/actions/demo', { method: 'DELETE' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['actions', 'feed'] }),
    ...options,
  });
}

export function useDismissAllRecommendations(
  options?: Omit<UseMutationOptions<apiSpec.DismissAllRecommendationsResponse, Error, void>, 'mutationFn'>
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => fetchApi<apiSpec.DismissAllRecommendationsResponse>('/api/actions/recommendations/dismiss-all', { method: 'PATCH' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['actions', 'feed'] }),
    ...options,
  });
}

export function useDeleteAllRecommendations(
  options?: Omit<UseMutationOptions<apiSpec.DeleteRecommendationsResponse, Error, { confirm?: boolean }>, 'mutationFn'>
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ confirm = true }: { confirm?: boolean }) => fetchApi<apiSpec.DeleteRecommendationsResponse>(`/api/actions/recommendations?confirm=${confirm}`, { method: 'DELETE' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['actions', 'feed'] }),
    ...options,
  });
}

export function useDeleteAction(
  options?: Omit<UseMutationOptions<apiSpec.DeleteSingleActionResponse, Error, { actionId: string }>, 'mutationFn'>
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ actionId }: { actionId: string }) => fetchApi<apiSpec.DeleteSingleActionResponse>(`/api/actions/${actionId}`, { method: 'DELETE' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['actions', 'feed'] }),
    ...options,
  });
}

export function useRegenerateAction(
  options?: Omit<UseMutationOptions<apiSpec.RegenerateRecommendationResponse, Error, { actionId: string; walletAddress?: string; chainEnv?: string }>, 'mutationFn'>
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ actionId, walletAddress, chainEnv }: { actionId: string; walletAddress?: string; chainEnv?: string }) =>
      fetchApi<apiSpec.RegenerateRecommendationResponse>(`/api/actions/${actionId}/regenerate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ walletAddress, chainEnv }),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['actions', 'feed'] }),
    ...options,
  });
}

export function useSendMessage(
  options?: Omit<UseMutationOptions<apiSpec.ChatMessageResponse, Error, apiSpec.ChatMessageRequest>, 'mutationFn'>,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: apiSpec.ChatMessageRequest) =>
      fetchApi<apiSpec.ChatMessageResponse>('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      }),
    onSuccess: (data, variables, context, mutCtx) => {
      queryClient.invalidateQueries({ queryKey: ['actions', 'feed'] });
      if (options?.onSuccess) {
        (options.onSuccess as any)(data, variables, context, mutCtx);
      }
    },
    ...options,
  });
}

export function useExecuteAction(
  options?: Omit<UseMutationOptions<apiSpec.ExecuteActionResponse, Error, apiSpec.ExecuteActionRequest>, 'mutationFn'>,
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
  options?: Omit<UseMutationOptions<apiSpec.DismissActionResponse, Error, apiSpec.DismissActionRequest>, 'mutationFn'>,
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
  options?: Omit<UseMutationOptions<apiSpec.UpdateSettingsResponse, Error, apiSpec.UpdateSettingsRequest>, 'mutationFn'>,
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
  options?: Omit<UseMutationOptions<apiSpec.UpdateMemoryResponse, Error, apiSpec.UpdateMemoryRequest>, 'mutationFn'>,
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
  options?: Omit<UseMutationOptions<apiSpec.ToggleProtocolResponse, Error, apiSpec.ToggleProtocolRequest>, 'mutationFn'>,
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
  options?: Omit<UseMutationOptions<apiSpec.LoginResponse, Error, apiSpec.LoginRequest>, 'mutationFn'>,
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

export function useLogout(options?: Omit<UseMutationOptions<{ success: boolean }, Error, void>, 'mutationFn'>) {
  return useMutation({
    mutationFn: () =>
      fetchApi<{ success: boolean }>('/api/auth/logout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      }),
    ...options,
  });
}

export function useWorkflows(
  options?: Omit<UseQueryOptions<apiSpec.WorkflowsListResponse, Error, apiSpec.WorkflowsListResponse, string[]>, 'queryKey' | 'queryFn'>
) {
  return useQuery<apiSpec.WorkflowsListResponse, Error, apiSpec.WorkflowsListResponse, string[]>({
    queryKey: ['workflows'],
    queryFn: () => {
      return fetchApi<apiSpec.WorkflowsListResponse>('/api/workflows');
    },
    ...options,
  });
}

export function useCreateWorkflow() {
  const queryClient = useQueryClient();
  return useMutation<apiSpec.CreateWorkflowResponse, Error, apiSpec.CreateWorkflowRequest>({
    mutationFn: (data) => {
      return fetchApi<apiSpec.CreateWorkflowResponse>('/api/workflows', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['workflows'] });
    },
  });
}

export function useDeleteWorkflow() {
  const queryClient = useQueryClient();
  return useMutation<apiSpec.DeleteWorkflowResponse, Error, { workflowId: string }>({
    mutationFn: ({ workflowId }) => {
      return fetchApi<apiSpec.DeleteWorkflowResponse>(`/api/workflows/${workflowId}`, {
        method: 'DELETE',
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['workflows'] });
    },
  });
}
