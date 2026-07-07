import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { UseQueryOptions, UseMutationOptions } from '@tanstack/react-query';
import * as apiSpec from '@mioagent/api-spec';

// T19.1: re-export the production action-type whitelist so both surfaces can
// gate the confirm button without a new dep (api-spec already re-exports it
// from api-zod). Runtime values, not just types.
export const isProductionActionType = apiSpec.isProductionActionType;
export const PRODUCTION_ACTION_TYPES = apiSpec.PRODUCTION_ACTION_TYPES;

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
    // No automatic polling: provider calls are budgeted, so the frontend must not
    // burn them on a timer. The query is gated by `enabled` (default: wallet connected)
    // and is only fetched on explicit refresh/analyze unless the caller overrides.
    enabled: !!address,
    refetchInterval: false,
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

// T19.2: /recommend now returns success:false (HTTP 200) for honest
// non-action outcomes — e.g. "No active approval found for this spender —
// nothing to revoke." — with no actionId. actionId/error are optional so
// consumers can branch on `success` and surface the message.
export type CreateRecommendationResponse = {
  success: boolean;
  actionId?: string;
  error?: string;
};

export function useCreateRecommendation(
  options?: Omit<UseMutationOptions<CreateRecommendationResponse, Error, { instruction: string; walletAddress?: string; chainEnv?: string }>, 'mutationFn'>
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data) => fetchApi<CreateRecommendationResponse>('/api/actions/recommend', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    }),
    onSuccess: (res) => {
      // Only refresh the feed when an action was actually created.
      if (res?.success) queryClient.invalidateQueries({ queryKey: ['actions', 'feed'] });
    },
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

// T19: user-confirmed flow. `prepare` returns an unsigned EIP-5792 payload;
// `confirm` records the wallet's onchain result. Neither broadcasts from the
// server. The wagmi orchestration (sendCalls + getCallsStatus) lives in
// @mioagent/wallet-actions so this package stays wagmi-free.
export function usePrepareAction(
  options?: Omit<UseMutationOptions<apiSpec.PrepareActionResponse, Error, apiSpec.PrepareActionRequest>, 'mutationFn'>,
) {
  return useMutation({
    mutationFn: (data: apiSpec.PrepareActionRequest) =>
      fetchApi<apiSpec.PrepareActionResponse>(`/api/actions/${data.actionId}/prepare`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      }),
    ...options,
  });
}

export function useConfirmAction(
  options?: Omit<UseMutationOptions<apiSpec.ConfirmActionResponse, Error, apiSpec.ConfirmActionRequest>, 'mutationFn'>,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: apiSpec.ConfirmActionRequest) =>
      fetchApi<apiSpec.ConfirmActionResponse>(`/api/actions/${data.actionId}/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ batchId: data.batchId, status: data.status, txHash: data.txHash, receipts: data.receipts, proof: data.proof }),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['actions', 'feed'] }),
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

// Autonomy hooks
export function useAutonomy(options?: Omit<UseQueryOptions<apiSpec.AutonomyStateResponse, Error, apiSpec.AutonomyStateResponse, string[]>, 'queryKey' | 'queryFn'>) {
  return useQuery({
    queryKey: ['autonomy'],
    queryFn: () => fetchApi<apiSpec.AutonomyStateResponse>('/api/autonomy'),
    ...options,
  });
}

export function useConfigureAutonomy(options?: Omit<UseMutationOptions<apiSpec.ConfigureAutonomyResponse, Error, apiSpec.ConfigureAutonomyRequest>, 'mutationFn'>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: apiSpec.ConfigureAutonomyRequest) =>
      fetchApi<apiSpec.ConfigureAutonomyResponse>('/api/autonomy/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['autonomy'] }),
    ...options,
  });
}

export function useKillAutonomy(options?: Omit<UseMutationOptions<apiSpec.KillAutonomyResponse, Error, void>, 'mutationFn'>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      fetchApi<apiSpec.KillAutonomyResponse>('/api/autonomy/kill', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['autonomy'] }),
    ...options,
  });
}

export function useResetAutonomy(options?: Omit<UseMutationOptions<apiSpec.KillAutonomyResponse, Error, void>, 'mutationFn'>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      fetchApi<apiSpec.KillAutonomyResponse>('/api/autonomy/reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['autonomy'] }),
    ...options,
  });
}

export function useTestnetConfigureAutonomy(options?: any) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: any) =>
      fetchApi<any>('/api/autonomy/testnet/configure', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['autonomy'] }),
    ...options,
  });
}

export function useTestnetRevokeAutonomy(options?: any) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data?: any) =>
      fetchApi<any>('/api/autonomy/testnet/revoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data || {}),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['autonomy'] }),
    ...options,
  });
}

export function useTestnetExecuteAction(options?: any) {
  return useMutation({
    mutationFn: (data: any) =>
      fetchApi<any>('/api/autonomy/testnet/execute-test-action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      }),
    ...options,
  });
}

// x402 hooks
export function useX402Ledger(options?: Omit<UseQueryOptions<apiSpec.X402LedgerResponse, Error, apiSpec.X402LedgerResponse, string[]>, 'queryKey' | 'queryFn'>) {
  return useQuery({
    queryKey: ['x402', 'ledger'],
    queryFn: () => fetchApi<apiSpec.X402LedgerResponse>('/api/x402/ledger'),
    ...options,
  });
}

export function useX402Pricing(options?: Omit<UseQueryOptions<apiSpec.X402PricingResponse, Error, apiSpec.X402PricingResponse, string[]>, 'queryKey' | 'queryFn'>) {
  return useQuery({
    queryKey: ['x402', 'pricing'],
    queryFn: () => fetchApi<apiSpec.X402PricingResponse>('/api/x402/pricing'),
    ...options,
  });
}
