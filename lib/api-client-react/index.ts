import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import type { QueryClient, UseQueryOptions, UseMutationOptions } from '@tanstack/react-query';
import * as apiSpec from '@mioagent/api-spec';

// T19.1: re-export the production action-type whitelist so both surfaces can
// gate the confirm button without a new dep (api-spec already re-exports it
// from api-zod). Runtime values, not just types.
export const isProductionActionType = apiSpec.isProductionActionType;
export const PRODUCTION_ACTION_TYPES = apiSpec.PRODUCTION_ACTION_TYPES;

export type WalletEnvironment = 'baseapp' | 'web';
let walletEnvironment: WalletEnvironment = 'web';

export function setWalletEnvironment(value: WalletEnvironment): void {
  walletEnvironment = value;
}

// Simple fetch wrapper
async function fetchApi<T>(url: string, options?: RequestInit): Promise<T> {
  const headers = new Headers(options?.headers);
  headers.set('x-miorail-wallet-environment', walletEnvironment);
  const response = await fetch(url, { credentials: 'same-origin', ...options, headers });
  if (!response.ok) {
    let errorMsg = `API error: ${response.status} ${response.statusText}`;
    try {
      const errJson = await response.json();
      // The `detail` is what makes a stable code actionable. Dropping it put
      // bare codes like "nft_compare_failed" on the screen while the server
      // had already said exactly what went wrong.
      if (errJson.error) {
        errorMsg = typeof errJson.detail === 'string' && errJson.detail.length > 0
          ? `${errJson.error}: ${errJson.detail}`
          : errJson.error;
      }
    } catch {
      // Preserve the HTTP status message when the error body is not JSON.
    }
    throw new Error(errorMsg);
  }
  return response.json();
}

export interface EvaluateSwapRouteInput {
  message: string;
  walletAddress: `0x${string}`;
  requestId?: string;
}

export class RoutePlanRequestIdentity {
  private lastMaterial = '';
  private lastRequestId = '';

  resolve(input: EvaluateSwapRouteInput): string {
    if (input.requestId) return input.requestId;
    const material = `${input.walletAddress.toLowerCase()}\u0000${input.message.trim()}`;
    if (material !== this.lastMaterial || !this.lastRequestId) {
      this.lastMaterial = material;
      this.lastRequestId = globalThis.crypto.randomUUID();
    }
    return this.lastRequestId;
  }
}

export function useEvaluateSwapRoute(
  options?: Omit<
    UseMutationOptions<apiSpec.RoutePlanResponseV1, Error, EvaluateSwapRouteInput>,
    'mutationFn' | 'retry'
  >,
) {
  const identity = useRef<RoutePlanRequestIdentity | null>(null);
  identity.current ??= new RoutePlanRequestIdentity();
  return useMutation({
    ...options,
    retry: false,
    mutationFn: async (input) => {
      const request = apiSpec.RoutePlanRequestV1Schema.parse({
        message: input.message,
        walletAddress: input.walletAddress,
        requestId: identity.current!.resolve(input),
      });
      const response = await fetchApi<unknown>('/api/route-intelligence/swap/evaluate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      });
      return apiSpec.RoutePlanResponseV1Schema.parse(response);
    },
  });
}

// T61: earn comparison -> Earn Route Card. The sibling of useEvaluateSwapRoute:
// a plain authenticated POST (same-origin cookie session) with NO signTypedData,
// NO x402/payment header, and NO wagmi. The server does the offline comparison;
// the client only renders the returned card (or its honest degraded/clarify
// state). Reuses RoutePlanRequestIdentity so an accidental re-submit of the same
// message replays the same idempotent requestId.
export interface EarnCompareInput {
  message: string;
  walletAddress: `0x${string}`;
  requestId?: string;
}

export function useEarnCompare(
  options?: Omit<
    UseMutationOptions<apiSpec.EarnCompareResponseV1, Error, EarnCompareInput>,
    'mutationFn' | 'retry'
  >,
) {
  const identity = useRef<RoutePlanRequestIdentity | null>(null);
  identity.current ??= new RoutePlanRequestIdentity();
  return useMutation({
    ...options,
    retry: false,
    mutationFn: async (input) => {
      const request = apiSpec.EarnCompareRequestV1Schema.parse({
        message: input.message,
        walletAddress: input.walletAddress,
        requestId: identity.current!.resolve(input),
      });
      const response = await fetchApi<unknown>('/api/route-intelligence/earn/compare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      });
      return apiSpec.EarnCompareResponseV1Schema.parse(response);
    },
  });
}

// T64: commerce comparison -> Commerce Route Card. The third sibling of
// useEvaluateSwapRoute/useEarnCompare: a plain authenticated POST with NO
// signTypedData, NO x402 header, and NO wagmi. Comparing a gift card is
// read-only and repeatable; buying one is not, which is why the checkout hook
// below is a separate call behind a separate server gate.
export interface CommerceCompareInput {
  message: string;
  walletAddress: `0x${string}`;
  requestId?: string;
}

export function useCommerceCompare(
  options?: Omit<
    UseMutationOptions<apiSpec.CommerceCompareResponseV1, Error, CommerceCompareInput>,
    'mutationFn' | 'retry'
  >,
) {
  const identity = useRef<RoutePlanRequestIdentity | null>(null);
  identity.current ??= new RoutePlanRequestIdentity();
  return useMutation({
    ...options,
    retry: false,
    mutationFn: async (input) => {
      const request = apiSpec.CommerceCompareRequestV1Schema.parse({
        message: input.message,
        walletAddress: input.walletAddress,
        requestId: identity.current!.resolve(input),
      });
      const response = await fetchApi<unknown>('/api/route-intelligence/commerce/compare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      });
      return apiSpec.CommerceCompareResponseV1Schema.parse(response);
    },
  });
}

// T64: opens a price-locked checkout and returns the exact payment terms for
// review. It does NOT pay: the returned CommercePaymentRequirementsV1 is what
// the wallet authorizes afterwards, and nothing is signed by this call.
export interface CommerceOrderInput {
  /** T64.2: the persisted run, not a message — the server loads the stored
   * Route Card so the reviewed price is the price the order is checked
   * against. */
  routeRunId: string;
  walletAddress: `0x${string}`;
  routeCardHash: string;
  selectedCandidateHash: string;
  requestId?: string;
}

export function useCreateCommerceOrder(
  options?: Omit<
    UseMutationOptions<apiSpec.CommerceOrderCreateResponseV1, Error, CommerceOrderInput>,
    'mutationFn' | 'retry'
  >,
) {
  const identity = useRef<SwapPrepareRequestIdentity | null>(null);
  identity.current ??= new SwapPrepareRequestIdentity();
  return useMutation({
    ...options,
    retry: false,
    mutationFn: async (input) => {
      const request = apiSpec.CommerceOrderCreateRequestV1Schema.parse({
        routeRunId: input.routeRunId,
        walletAddress: input.walletAddress,
        routeCardHash: input.routeCardHash,
        selectedCandidateHash: input.selectedCandidateHash,
        requestId:
          input.requestId ??
          identity.current!.resolve({
            walletAddress: input.walletAddress,
            routeRunId: input.routeRunId,
            routeCardHash: input.routeCardHash,
            selectedCandidateHash: input.selectedCandidateHash,
          }),
      });
      const response = await fetchApi<unknown>('/api/route-intelligence/commerce/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      });
      return apiSpec.CommerceOrderCreateResponseV1Schema.parse(response);
    },
  });
}

// T64: the order + its three-leg proof. Polled while a checkout is open; a
// settled payment with no confirmed order comes back as `order_unconfirmed`,
// which the surface must show as reconciliation, never as a purchase.
export function useCommerceOrderStatus(
  invoiceId: string | null,
  options?: Omit<
    UseQueryOptions<apiSpec.CommerceOrderStatusResponseV1, Error>,
    'queryKey' | 'queryFn'
  >,
) {
  return useQuery({
    ...options,
    queryKey: ['commerce-order-status', invoiceId],
    enabled: (options?.enabled ?? true) && typeof invoiceId === 'string' && invoiceId.length > 0,
    queryFn: async () => {
      const response = await fetchApi<unknown>(
        `/api/route-intelligence/commerce/orders/${encodeURIComponent(invoiceId ?? '')}`,
      );
      return apiSpec.CommerceOrderStatusResponseV1Schema.parse(response);
    },
  });
}

// T64.2: one reconcile POST against a durable order. Never automatic — an
// uncertain checkout must be reconciled deliberately, because a blind retry is
// exactly how a duplicate invoice gets created.
export function useReconcileCommerceOrder(
  options?: Omit<
    UseMutationOptions<apiSpec.CommerceOrderStatusResponseV1, Error, { invoiceId: string }>,
    'mutationFn' | 'retry'
  >,
) {
  return useMutation({
    ...options,
    retry: false,
    mutationFn: async (input) => {
      const response = await fetchApi<unknown>(
        `/api/route-intelligence/commerce/orders/${encodeURIComponent(input.invoiceId)}/reconcile`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
      );
      return apiSpec.CommerceOrderStatusResponseV1Schema.parse(response);
    },
  });
}

export function useCommerceHistory(
  options?: Omit<UseQueryOptions<apiSpec.CommerceHistoryResponseV1, Error>, 'queryKey' | 'queryFn'>,
) {
  return useQuery({
    ...options,
    queryKey: ['commerce-history'],
    queryFn: async () => {
      const response = await fetchApi<unknown>('/api/route-intelligence/commerce/history');
      return apiSpec.CommerceHistoryResponseV1Schema.parse(response);
    },
  });
}

// T56: candidate selection -> Transaction Composer. Mirrors
// RoutePlanRequestIdentity — a stable requestId per identical selection so an
// accidental double-submit (same candidate, same card) replays the same
// idempotent prepare request instead of minting a new one every render.
export interface PrepareSwapBlueprintInput {
  walletAddress: `0x${string}`;
  routeRunId: string;
  routeCardHash: string;
  selectedCandidateHash: string;
  requestId?: string;
}

export class SwapPrepareRequestIdentity {
  private lastMaterial = '';
  private lastRequestId = '';

  resolve(input: PrepareSwapBlueprintInput): string {
    if (input.requestId) return input.requestId;
    const material = [
      input.walletAddress.toLowerCase(),
      input.routeRunId,
      input.routeCardHash,
      input.selectedCandidateHash,
    ].join(' ');
    if (material !== this.lastMaterial || !this.lastRequestId) {
      this.lastMaterial = material;
      this.lastRequestId = globalThis.crypto.randomUUID();
    }
    return this.lastRequestId;
  }
}

export function usePrepareSwapBlueprint(
  options?: Omit<
    UseMutationOptions<apiSpec.SwapPrepareResponseV1, Error, PrepareSwapBlueprintInput>,
    'mutationFn' | 'retry'
  >,
) {
  const identity = useRef<SwapPrepareRequestIdentity | null>(null);
  identity.current ??= new SwapPrepareRequestIdentity();
  return useMutation({
    ...options,
    retry: false,
    mutationFn: async (input) => {
      const request = apiSpec.SwapPrepareRequestV1Schema.parse({
        routeRunId: input.routeRunId,
        routeCardHash: input.routeCardHash,
        selectedCandidateHash: input.selectedCandidateHash,
        walletAddress: input.walletAddress,
        requestId: identity.current!.resolve(input),
      });
      const response = await fetchApi<unknown>('/api/route-intelligence/swap/prepare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      });
      return apiSpec.SwapPrepareResponseV1Schema.parse(response);
    },
  });
}

// T57: blueprint approval + submission record. Pure mutations (retry:false,
// no polling) with response re-validation against the api-spec schemas. The
// approve response is the ONLY source of the wallet payload — these hooks
// never accept or emit client-modified calls. wagmi orchestration lives in
// @mioagent/wallet-actions so this package stays wagmi-free.
export interface ApproveSwapBlueprintInput {
  walletAddress: `0x${string}`;
  routeRunId: string;
  blueprintId: string;
  blueprintHash: string;
}

export function useApproveSwapBlueprint(
  options?: Omit<
    UseMutationOptions<apiSpec.SwapBlueprintApproveResponseV1, Error, ApproveSwapBlueprintInput>,
    'mutationFn' | 'retry'
  >,
) {
  return useMutation({
    ...options,
    retry: false,
    mutationFn: async (input) => {
      const request = apiSpec.SwapBlueprintApproveRequestV1Schema.parse({
        routeRunId: input.routeRunId,
        blueprintHash: input.blueprintHash,
        walletAddress: input.walletAddress,
      });
      const response = await fetchApi<unknown>(
        `/api/route-intelligence/swap/blueprints/${encodeURIComponent(input.blueprintId)}/approve`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(request),
        },
      );
      return apiSpec.SwapBlueprintApproveResponseV1Schema.parse(response);
    },
  });
}

export interface RecordBlueprintSubmissionInput {
  walletAddress: `0x${string}`;
  routeRunId: string;
  blueprintId: string;
  approvedCallsHash: string;
  status: 'submitted' | 'confirmed' | 'failed' | 'cancelled' | 'submitted_unknown';
  batchId?: string;
  transactionHashes?: string[];
  receipts?: unknown[];
  error?: string;
  /** T67C.2: the recovery attempt this record belongs to, when one is open. */
  submissionAttemptId?: string;
}

export function useRecordBlueprintSubmission(
  options?: Omit<
    UseMutationOptions<apiSpec.SwapBlueprintSubmissionResponseV1, Error, RecordBlueprintSubmissionInput>,
    'mutationFn' | 'retry'
  >,
) {
  return useMutation({
    ...options,
    retry: false,
    mutationFn: async (input) => {
      const request = apiSpec.SwapBlueprintSubmissionRequestV1Schema.parse({
        routeRunId: input.routeRunId,
        walletAddress: input.walletAddress,
        approvedCallsHash: input.approvedCallsHash,
        status: input.status,
        ...(input.batchId !== undefined ? { batchId: input.batchId } : {}),
        ...(input.transactionHashes !== undefined ? { transactionHashes: input.transactionHashes } : {}),
        ...(input.receipts !== undefined ? { receipts: input.receipts } : {}),
        ...(input.error !== undefined ? { error: input.error } : {}),
        ...(input.submissionAttemptId !== undefined
          ? { submissionAttemptId: input.submissionAttemptId }
          : {}),
      });
      const response = await fetchApi<unknown>(
        `/api/route-intelligence/swap/blueprints/${encodeURIComponent(input.blueprintId)}/submission`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(request),
        },
      );
      return apiSpec.SwapBlueprintSubmissionResponseV1Schema.parse(response);
    },
  });
}

// T62 — Persisted Earn Execution client hooks. Mirror the swap prepare/approve/
// submission hooks exactly but hit the /earn/* routes: the server owns ALL
// calldata (the client passes only run/card/candidate hashes), and the approve
// response is the ONLY source of the wallet payload. Pure mutations
// (retry:false); responses are re-validated against the api-spec schemas.
export interface PrepareEarnDepositInput {
  walletAddress: `0x${string}`;
  routeRunId: string;
  routeCardHash: string;
  selectedCandidateHash: string;
  requestId?: string;
}

export function usePrepareEarnDeposit(
  options?: Omit<
    UseMutationOptions<apiSpec.EarnPrepareResponseV1, Error, PrepareEarnDepositInput>,
    'mutationFn' | 'retry'
  >,
) {
  // Reuse the swap prepare identity: a stable requestId per identical selection
  // so an accidental double-submit replays the idempotent prepare request.
  const identity = useRef<SwapPrepareRequestIdentity | null>(null);
  identity.current ??= new SwapPrepareRequestIdentity();
  return useMutation({
    ...options,
    retry: false,
    mutationFn: async (input) => {
      const request = apiSpec.EarnPrepareRequestV1Schema.parse({
        routeRunId: input.routeRunId,
        routeCardHash: input.routeCardHash,
        selectedCandidateHash: input.selectedCandidateHash,
        walletAddress: input.walletAddress,
        requestId: identity.current!.resolve(input),
      });
      const response = await fetchApi<unknown>('/api/route-intelligence/earn/prepare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      });
      return apiSpec.EarnPrepareResponseV1Schema.parse(response);
    },
  });
}

export interface ApproveEarnBlueprintInput {
  walletAddress: `0x${string}`;
  routeRunId: string;
  blueprintId: string;
  blueprintHash: string;
}

export function useApproveEarnBlueprint(
  options?: Omit<
    UseMutationOptions<apiSpec.EarnBlueprintApproveResponseV1, Error, ApproveEarnBlueprintInput>,
    'mutationFn' | 'retry'
  >,
) {
  return useMutation({
    ...options,
    retry: false,
    mutationFn: async (input) => {
      const request = apiSpec.EarnBlueprintApproveRequestV1Schema.parse({
        routeRunId: input.routeRunId,
        blueprintHash: input.blueprintHash,
        walletAddress: input.walletAddress,
      });
      const response = await fetchApi<unknown>(
        `/api/route-intelligence/earn/blueprints/${encodeURIComponent(input.blueprintId)}/approve`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(request),
        },
      );
      return apiSpec.EarnBlueprintApproveResponseV1Schema.parse(response);
    },
  });
}

export function useRecordEarnBlueprintSubmission(
  options?: Omit<
    UseMutationOptions<apiSpec.SwapBlueprintSubmissionResponseV1, Error, RecordBlueprintSubmissionInput>,
    'mutationFn' | 'retry'
  >,
) {
  return useMutation({
    ...options,
    retry: false,
    mutationFn: async (input) => {
      // The submission request/response shapes are goal-agnostic — reuse the
      // swap schemas, just against the /earn submission route.
      const request = apiSpec.SwapBlueprintSubmissionRequestV1Schema.parse({
        routeRunId: input.routeRunId,
        walletAddress: input.walletAddress,
        approvedCallsHash: input.approvedCallsHash,
        status: input.status,
        ...(input.batchId !== undefined ? { batchId: input.batchId } : {}),
        ...(input.transactionHashes !== undefined ? { transactionHashes: input.transactionHashes } : {}),
        ...(input.receipts !== undefined ? { receipts: input.receipts } : {}),
        ...(input.error !== undefined ? { error: input.error } : {}),
        ...(input.submissionAttemptId !== undefined
          ? { submissionAttemptId: input.submissionAttemptId }
          : {}),
      });
      const response = await fetchApi<unknown>(
        `/api/route-intelligence/earn/blueprints/${encodeURIComponent(input.blueprintId)}/submission`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(request),
        },
      );
      return apiSpec.SwapBlueprintSubmissionResponseV1Schema.parse(response);
    },
  });
}

// Queries
export function useSession(options?: Omit<UseQueryOptions<apiSpec.SessionResponse, Error, apiSpec.SessionResponse, string[]>, 'queryKey' | 'queryFn'>) {
  return useQuery({
    queryKey: ['session'],
    queryFn: () => fetchApi<apiSpec.SessionResponse>('/api/auth/session'),
    ...options,
  });
}

export function useWalletChallenge(
  options?: Omit<UseMutationOptions<apiSpec.WalletChallengeResponse, Error, apiSpec.WalletChallengeRequest>, 'mutationFn'>,
) {
  return useMutation({
    mutationFn: (data) => fetchApi<apiSpec.WalletChallengeResponse>('/api/auth/challenge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    }),
    ...options,
  });
}

export function useVerifyWallet(
  options?: Omit<UseMutationOptions<apiSpec.LoginResponse, Error, apiSpec.LoginRequest>, 'mutationFn'>,
) {
  return useMutation({
    mutationFn: (data) => fetchApi<apiSpec.LoginResponse>('/api/auth/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    }),
    ...options,
  });
}

export async function logoutWalletSession(): Promise<void> {
  await fetchApi<{ success: boolean }>('/api/auth/logout', { method: 'POST' });
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

export function useReconcileBaseMcpTransactions(
  options?: Omit<UseMutationOptions<apiSpec.ChatReconcileResponse, Error, void>, 'mutationFn'>,
) {
  const queryClient = useQueryClient();
  const { onSuccess, ...mutationOptions } = options || {};
  return useMutation({
    ...mutationOptions,
    mutationFn: () => fetchApi<apiSpec.ChatReconcileResponse>('/api/chat/reconcile', { method: 'POST' }),
    onSuccess: (data, variables, onMutateResult, context) => {
      queryClient.setQueriesData<apiSpec.ChatHistoryResponse>(
        { queryKey: ['chat', 'history'] },
        (current) => current ? { ...current, messages: data.messages } : { messages: data.messages },
      );
      queryClient.setQueryData<apiSpec.AutonomyStateResponse>(['autonomy'], (current) => current
        ? {
            ...current,
            sessionKey: {
              ...current.sessionKey,
              spentTodayUsdc: data.autonomy.spentTodayUsdc,
              reservedTodayUsdc: data.autonomy.reservedTodayUsdc,
            },
            autonomy: {
              ...current.autonomy,
              reservedTodayUsdc: data.autonomy.reservedTodayUsdc,
            },
          }
        : current);
      void queryClient.invalidateQueries({ queryKey: ['autonomy'], refetchType: 'active' });
      return onSuccess?.(data, variables, onMutateResult, context);
    },
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
  options?: Omit<UseQueryOptions<apiSpec.PortfolioResponse, Error, apiSpec.PortfolioResponse, (string | undefined)[]>, 'queryKey' | 'queryFn'>,
  params?: { includeApprovals?: boolean; refresh?: boolean; chainEnv?: string },
) {
  return useQuery({
    queryKey: ['portfolio', address, params?.includeApprovals ? 'approvals' : 'portfolio', params?.chainEnv],
    queryFn: () => {
      const url = new URL('/api/portfolio', 'http://localhost');
      if (address) url.searchParams.set('address', address);
      if (params?.includeApprovals) url.searchParams.set('includeApprovals', '1');
      if (params?.refresh) url.searchParams.set('refresh', '1');
      if (params?.chainEnv) url.searchParams.set('chainEnv', params.chainEnv);
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

/**
 * T65.2A — the console's price rail.
 *
 * A real read, re-validated against its contract. The refetch interval matches
 * the server's cache TTL: polling faster would spend CoinGecko's free-tier
 * allowance without producing a newer number. The response says `live` or
 * `cached` and always carries `observedAt`, so a surface can show the AGE of a
 * price rather than implying every answer is current.
 */
export function useMarketSnapshot(
  options?: Omit<
    UseQueryOptions<apiSpec.MarketSnapshotResponseV1, Error, apiSpec.MarketSnapshotResponseV1, string[]>,
    'queryKey' | 'queryFn'
  >,
) {
  return useQuery({
    queryKey: ['market-snapshot'],
    queryFn: async () => {
      const response = await fetchApi<unknown>('/api/market/snapshot');
      return apiSpec.MarketSnapshotResponseV1Schema.parse(response);
    },
    refetchInterval: 60_000,
    ...options,
  });
}

/**
 * T67E §1 — B20 Control for one token, read-only.
 *
 * A POST behind `useQuery` on purpose. `/b20/inspect` is idempotent per
 * (tenant, token, block) and returns the STORED snapshot inside its TTL, so it
 * reads like a query even though it writes one row the first time. Modelling it
 * as a mutation would mean the card only appears after something clicks it, and
 * the whole point is that a route shows the token's controls before a user acts.
 *
 * `enabled` is off for a null address: the native asset has no contract to
 * inspect, and asking about one would be a guaranteed 400.
 */
export function useB20Inspect(
  tokenAddress: string | null | undefined,
  options?: { enabled?: boolean },
) {
  const address = typeof tokenAddress === 'string' ? tokenAddress.toLowerCase() : null;
  return useQuery({
    queryKey: ['b20-inspect', address ?? 'none'],
    queryFn: async () => {
      const response = await fetchApi<unknown>('/api/route-intelligence/b20/inspect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chainId: 8453, tokenAddress: address }),
      });
      return apiSpec.B20InspectResponseV1Schema.parse(response);
    },
    // A B20 read is an on-chain call against a metered endpoint, and the server
    // already caches by block. Retrying a refusal (flag off, not a B20, no RPC)
    // would multiply that cost for an answer that will not change.
    retry: false,
    enabled: options?.enabled !== false && address !== null,
    staleTime: 30_000,
  });
}

/**
 * T67E §2.2 — the caller's recent Intelligence Charges.
 *
 * `enabled` is off whenever paid intelligence is off, so a server with the gate
 * down never gets a request that would 404 on every render.
 */
export function useIntelligenceCharges(options?: { enabled?: boolean; limit?: number }) {
  const limit = options?.limit ?? 20;
  return useQuery({
    queryKey: ['intelligence-charges', limit],
    queryFn: async () => {
      const response = await fetchApi<unknown>(`/api/route-intelligence/intelligence-charges?limit=${limit}`);
      return apiSpec.IntelligenceChargesResponseV1Schema.parse(response);
    },
    retry: false,
    enabled: options?.enabled !== false,
  });
}

/**
 * T67F — the Control Watch sweep over the tokens the caller holds.
 *
 * A mutation, not a query, and deliberately so: each run is up to 25 on-chain
 * reads against a metered endpoint, and a query would re-run it on every
 * remount, refocus and reconnect. The user asks for the sweep; it does not
 * happen to them.
 */
export function useB20Watch(
  options?: Omit<
    UseMutationOptions<apiSpec.B20WatchResponseV1, Error, { tokens: string[] }>,
    'mutationFn' | 'retry'
  >,
) {
  return useMutation({
    ...options,
    retry: false,
    mutationFn: async (input) => {
      const response = await fetchApi<unknown>('/api/route-intelligence/b20/watch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chainId: 8453, tokens: input.tokens }),
      });
      return apiSpec.B20WatchResponseV1Schema.parse(response);
    },
  });
}

/**
 * T68B — the watchlist a background sweep reads.
 *
 * A query, unlike `useB20Watch`: reading the list costs one row lookup and no
 * chain access at all, so it can refresh freely. What it returns includes
 * `lastSweptAt` per token, which is the only honest way for a page to say when
 * Miorail last looked — as opposed to when this browser last asked it to.
 */
export function useB20Watchlist(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ['b20-watchlist'],
    queryFn: async () => {
      const response = await fetchApi<unknown>('/api/route-intelligence/b20/watchlist');
      return apiSpec.B20WatchlistResponseV1Schema.parse(response);
    },
    // A server without migration 0024, or with the flag off, answers the same
    // way every time. Retrying multiplies a refusal that will not change.
    retry: false,
    enabled: options?.enabled !== false,
  });
}

/**
 * T70 §1 — the Discover feed behind the Opportunities home screen.
 *
 * Read-only. It cannot create a clearance, prepare a plan or reach a wallet;
 * the response is display context over evidence the workers already stored.
 *
 * `retry: false` on purpose: every failure mode this endpoint has — the flag
 * off, no migration, no start block, storage down — answers identically on the
 * second attempt, and the pipeline status in the body already explains which
 * one it is. Retrying just delays that sentence reaching the screen.
 */
export function useB20Opportunities(
  input?: { state?: 'all' | 'candidate' | 'provisional' | 'rejected' | 'unmeasured'; freshness?: 'all' | 'fresh' | 'stale'; limit?: number },
  options?: { enabled?: boolean; refetchInterval?: number | false },
) {
  const state = input?.state ?? 'all';
  const freshness = input?.freshness ?? 'all';
  const limit = input?.limit ?? 25;
  return useQuery({
    queryKey: ['b20-opportunities', state, freshness, limit],
    queryFn: async () => {
      const query = new URLSearchParams({ state, freshness, limit: String(limit) });
      const response = await fetchApi<unknown>(`/api/route-intelligence/opportunities/b20?${query.toString()}`);
      return apiSpec.B20OpportunityFeedResponseV1Schema.parse(response);
    },
    retry: false,
    enabled: options?.enabled !== false,
    refetchInterval: options?.refetchInterval ?? false,
  });
}

/**
 * T73-UI — the two market rails.
 *
 * Read-only over stored observations. The server does the ranking; this hook
 * exists to fetch it, and the client sorts nothing.
 */
export function useB20MarketRails(options?: { enabled?: boolean; limit?: number }) {
  const limit = options?.limit ?? 10;
  return useQuery({
    queryKey: ['b20-market-rails', limit],
    queryFn: async () => {
      const response = await fetchApi<unknown>(
        `/api/route-intelligence/opportunities/b20/market/rails?limit=${limit}`,
      );
      return apiSpec.B20MarketRailsResponseV1Schema.parse(response);
    },
    // Every failure mode here answers the same way twice; the pipeline status
    // in the body already says which one it is.
    retry: false,
    enabled: options?.enabled !== false,
  });
}

export function useAddB20Watch(
  options?: Omit<UseMutationOptions<apiSpec.B20WatchlistResponseV1, Error, { tokenAddress: string }>, 'mutationFn'>,
) {
  const queryClient = useQueryClient();
  return useMutation({
    retry: false,
    mutationFn: async (input) => {
      const response = await fetchApi<unknown>('/api/route-intelligence/b20/watchlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chainId: 8453, tokenAddress: input.tokenAddress.toLowerCase() }),
      });
      return apiSpec.B20WatchlistResponseV1Schema.parse(response);
    },
    ...options,
    onSuccess: (data, variables, onMutateResult, context) => {
      // The response IS the new list, so it is written straight into the cache
      // rather than invalidated: a refetch would show the old list for a beat,
      // and a watchlist that flickers back to its previous state reads as a
      // failed add.
      queryClient.setQueryData(['b20-watchlist'], data);
      options?.onSuccess?.(data, variables, onMutateResult, context);
    },
  });
}

export function useRemoveB20Watch(
  options?: Omit<UseMutationOptions<apiSpec.B20WatchlistResponseV1, Error, { tokenAddress: string }>, 'mutationFn'>,
) {
  const queryClient = useQueryClient();
  return useMutation({
    retry: false,
    mutationFn: async (input) => {
      const response = await fetchApi<unknown>(
        `/api/route-intelligence/b20/watchlist/${encodeURIComponent(input.tokenAddress.toLowerCase())}`,
        { method: 'DELETE' },
      );
      return apiSpec.B20WatchlistResponseV1Schema.parse(response);
    },
    ...options,
    onSuccess: (data, variables, onMutateResult, context) => {
      queryClient.setQueryData(['b20-watchlist'], data);
      options?.onSuccess?.(data, variables, onMutateResult, context);
    },
  });
}

/**
 * T68C — "can I get back out, and at what cost."
 *
 * A mutation, deliberately. Each check is a dozen-odd metered router calls, so
 * it happens when a user asks for it and never on a remount, a refocus or a
 * reconnect. The one question this page exists to answer is also the one that
 * costs money to ask.
 */
export function useB20ExitCheck(
  options?: Omit<
    UseMutationOptions<
      apiSpec.B20ExitCheckResponseV1,
      Error,
      { tokenAddress: string; positionAtomic: string; maxRoundTripBps: number; maxSlippageBps: number }
    >,
    'mutationFn' | 'retry'
  >,
) {
  return useMutation({
    ...options,
    retry: false,
    mutationFn: async (input) => {
      const response = await fetchApi<unknown>('/api/route-intelligence/b20/exit-check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chainId: 8453, ...input, tokenAddress: input.tokenAddress.toLowerCase() }),
      });
      return apiSpec.B20ExitCheckResponseV1Schema.parse(response);
    },
  });
}

/**
 * T68D — the only call that can confirm an exit.
 *
 * It runs two simulations against the connected wallet's real balance, so it
 * happens when a user asks and never on a remount. A pass here is what issues
 * the clearance that opens the entry route; nothing on the quote path can.
 */
export function useB20OpportunitySimulate(
  options?: Omit<
    UseMutationOptions<
      apiSpec.B20OpportunitySimulateResponseV1,
      Error,
      { tokenAddress: string; positionAtomic: string; maxRoundTripBps: number; maxExitSlippageBps: number }
    >,
    'mutationFn' | 'retry'
  >,
) {
  return useMutation({
    ...options,
    retry: false,
    mutationFn: async (input) => {
      const response = await fetchApi<unknown>('/api/route-intelligence/b20/opportunity/simulate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chainId: 8453, ...input, tokenAddress: input.tokenAddress.toLowerCase() }),
      });
      return apiSpec.B20OpportunitySimulateResponseV1Schema.parse(response);
    },
  });
}

// ---------------------------------------------------------------------------
// T68F — preparing, reviewing and submitting a cleared B20 entry.
//
// Every one of these is a MUTATION except the status read, and none of them
// ever sends a call, a router, an amount or a recipient. The server recovers
// every executable byte from the stored plan by id; the client's whole
// contribution is "this plan, this profile, this idempotency handle".
// ---------------------------------------------------------------------------

/** Prepare and persist a plan from a qualified clearance. */
export function useB20PrepareEntry(
  options?: Omit<
    UseMutationOptions<
      apiSpec.B20EntryPrepareResponseV1,
      Error,
      { clearanceId: string; profileIdentity: string; requestId: string }
    >,
    'mutationFn' | 'retry'
  >,
) {
  return useMutation({
    ...options,
    retry: false,
    mutationFn: async (input) => {
      const response = await fetchApi<unknown>(
        `/api/route-intelligence/opportunities/${encodeURIComponent(input.clearanceId)}/prepare-entry`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chainId: 8453,
            profileIdentity: input.profileIdentity,
            requestId: input.requestId,
          }),
        },
      );
      return apiSpec.B20EntryPrepareResponseV1Schema.parse(response);
    },
  });
}

/**
 * Open a submission and receive the wallet request.
 *
 * The response's `payload` is the ONLY place executable bytes reach the
 * browser, and they are always the stored ones. Nothing here builds calldata.
 */
export function useB20BeginEntrySubmission(
  options?: Omit<
    UseMutationOptions<
      apiSpec.B20EntryBeginSubmissionResponseV1,
      Error,
      { planId: string; profileIdentity: string; attemptRequestId: string }
    >,
    'mutationFn' | 'retry'
  >,
) {
  return useMutation({
    ...options,
    retry: false,
    mutationFn: async (input) => {
      const response = await fetchApi<unknown>(
        `/api/route-intelligence/opportunities/entry-plans/${encodeURIComponent(input.planId)}/begin-submission`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chainId: 8453,
            profileIdentity: input.profileIdentity,
            attemptRequestId: input.attemptRequestId,
          }),
        },
      );
      return apiSpec.B20EntryBeginSubmissionResponseV1Schema.parse(response);
    },
  });
}

/**
 * Report what the WALLET did.
 *
 * A browser cannot tell the server that a transaction succeeded, and this
 * contract does not let it try: the only result values are things the wallet
 * itself did, and only `submitted` may name a batch.
 */
export function useB20RecordEntrySubmission(
  options?: Omit<
    UseMutationOptions<
      apiSpec.B20EntryStatusResponseV1,
      Error,
      {
        planId: string;
        attemptId: string;
        result: 'submitted' | 'user_rejected' | 'wallet_failed' | 'cancelled';
        batchId: string | null;
      }
    >,
    'mutationFn' | 'retry'
  >,
) {
  const queryClient = useQueryClient();
  return useMutation({
    ...options,
    retry: false,
    mutationFn: async (input) => {
      const response = await fetchApi<unknown>(
        `/api/route-intelligence/opportunities/entry-plans/${encodeURIComponent(input.planId)}/record-submission`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            attemptId: input.attemptId,
            result: input.result,
            batchId: input.batchId,
          }),
        },
      );
      return apiSpec.B20EntryStatusResponseV1Schema.parse(response);
    },
    onSuccess: (data, variables, onMutateResult, context) => {
      // Written straight into the cache rather than invalidated: a refetch
      // would show the previous state for a beat, and a submitted entry
      // flickering back to `review` reads as a second Buy button.
      queryClient.setQueryData(['b20-entry-status', variables.planId], data);
      options?.onSuccess?.(data, variables, onMutateResult, context);
    },
  });
}

/**
 * Where did it get to.
 *
 * A poll, because an in-flight batch resolves without anybody clicking. It
 * stops as soon as the server says the state is terminal — the server decides
 * that, not this hook.
 */
export function useB20EntryStatus(
  planId: string | null,
  options?: { enabled?: boolean; pollMs?: number },
) {
  return useQuery({
    queryKey: ['b20-entry-status', planId],
    enabled: Boolean(planId) && (options?.enabled ?? true),
    refetchInterval: (query) => {
      const data = query.state.data as apiSpec.B20EntryStatusResponseV1 | undefined;
      return data && !data.status.canRefresh ? false : (options?.pollMs ?? 4000);
    },
    queryFn: async () => {
      const response = await fetchApi<unknown>(
        `/api/route-intelligence/opportunities/entry-plans/${encodeURIComponent(planId!)}/status`,
      );
      return apiSpec.B20EntryStatusResponseV1Schema.parse(response);
    },
  });
}

/**
 * The native Base MCP plugin catalogue, and whether it has fallen behind.
 *
 * A QUERY, unlike the tool probe next to it, and the difference is the point:
 * the tools are a live authenticated read of somebody else's server with the
 * user's credentials attached, so the user asks for it. The plugins are Base's
 * published specs — public, and true whether or not this browser has ever
 * connected — so the page can simply show them.
 */
export function useBaseMcpPlugins(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ['base-mcp-plugins'],
    enabled: options?.enabled ?? true,
    staleTime: 15 * 60 * 1000,
    queryFn: async () => {
      const response = await fetchApi<unknown>('/api/mcp/base/plugins');
      return apiSpec.BaseMcpPluginCatalogueResponseSchema.parse(response);
    },
  });
}

/**
 * The Base MCP console: one question, one answer, one trace.
 *
 * A mutation, because it spends the user's Base MCP session and an LLM call.
 * Nothing about it is retried or refetched on focus.
 */
export function useBaseMcpConsole(
  options?: Omit<UseMutationOptions<apiSpec.BaseMcpConsoleResponseV1, Error, string>, 'mutationFn'>,
) {
  return useMutation({
    mutationFn: async (message: string) => {
      const response = await fetchApi<unknown>('/api/mcp/base/console', {
        method: 'POST',
        // `fetchApi` does not add this, and `express.json()` skips a body
        // without it — so the server saw `{}`, the schema rejected it, and the
        // console answered "could not reach the server" in one millisecond.
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message }),
      });
      return apiSpec.BaseMcpConsoleResponseV1Schema.parse(response);
    },
    ...options,
  });
}

export function useBaseMcpToolsProbe(
  options?: Omit<UseMutationOptions<apiSpec.BaseMcpToolProbeResponse, Error, void>, 'mutationFn'>
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => fetchApi<apiSpec.BaseMcpToolProbeResponse>('/api/mcp/base/tools'),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['status'] });
    },
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
        body: JSON.stringify({ walletAddress: data.walletAddress }),
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

export function syncConfiguredAutonomyState(
  queryClient: QueryClient,
  response: apiSpec.ConfigureAutonomyResponse,
): Promise<void> {
  // The API response is authoritative. Publish it synchronously so no render
  // can show the previous autonomy_policy_missing state after a successful save.
  queryClient.setQueryData<apiSpec.AutonomyStateResponse>(['autonomy'], response.state);
  return queryClient
    .cancelQueries({ queryKey: ['autonomy'] }, { revert: false })
    .then(() => queryClient.invalidateQueries({ queryKey: ['autonomy'], refetchType: 'active' }));
}

export function useConfigureAutonomy(options?: Omit<UseMutationOptions<apiSpec.ConfigureAutonomyResponse, Error, apiSpec.ConfigureAutonomyRequest>, 'mutationFn'>) {
  const queryClient = useQueryClient();
  const { onSuccess, ...mutationOptions } = options || {};
  return useMutation({
    ...mutationOptions,
    mutationFn: (data: apiSpec.ConfigureAutonomyRequest) =>
      fetchApi<apiSpec.ConfigureAutonomyResponse>('/api/autonomy/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      }),
    onSuccess: (data, variables, onMutateResult, context) => {
      const refresh = syncConfiguredAutonomyState(queryClient, data);
      const consumer = onSuccess?.(data, variables, onMutateResult, context);
      return Promise.all([refresh, consumer]).then(() => undefined);
    },
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

export function useX402Fuel(options?: Omit<UseQueryOptions<apiSpec.X402FuelResponse, Error, apiSpec.X402FuelResponse, string[]>, 'queryKey' | 'queryFn'>) {
  return useQuery({
    queryKey: ['x402', 'fuel'],
    queryFn: () => fetchApi<apiSpec.X402FuelResponse>('/api/x402/fuel'),
    ...options,
  });
}

export function useX402FuelOwner(options?: Omit<UseQueryOptions<apiSpec.X402FuelOwnerResponse, Error, apiSpec.X402FuelOwnerResponse, string[]>, 'queryKey' | 'queryFn'>) {
  return useQuery({
    queryKey: ['x402', 'fuel', 'subscription-owner'],
    queryFn: () => fetchApi<apiSpec.X402FuelOwnerResponse>('/api/x402/fuel/subscription-owner'),
    retry: false,
    ...options,
  });
}

export function useCreateX402FuelPermission(
  options?: Omit<UseMutationOptions<apiSpec.X402FuelPermissionResponse, Error, apiSpec.X402FuelPermissionRequest>, 'mutationFn'>,
) {
  const queryClient = useQueryClient();
  return useMutation({
    ...options,
    mutationFn: (data: apiSpec.X402FuelPermissionRequest) =>
      fetchApi<apiSpec.X402FuelPermissionResponse>('/api/x402/fuel/permission', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      }),
    onSuccess: (data, variables, context, mutCtx) => {
      queryClient.invalidateQueries({ queryKey: ['x402', 'fuel'] });
      queryClient.invalidateQueries({ queryKey: ['x402', 'ledger'] });
      queryClient.invalidateQueries({ queryKey: ['status'] });
      if (options?.onSuccess) {
        (options.onSuccess as any)(data, variables, context, mutCtx);
      }
    },
  });
}

// ---------------------------------------------------------------------------
// T58: Route Proof reconciliation + history hooks. The reconcile mutation is
// pure (retry:false, no polling); polling lives ONLY in
// useBoundedProofReconciliation's query refetchInterval callback, which is
// strictly bounded: it stops on a terminal finalStatus or after
// MAX_PROOF_POLL_ATTEMPTS polls, and unmount stops it automatically
// (react-query). The server is never polled into re-broadcasting anything —
// reconcile is a read-and-finalize step over already-submitted batches.
// ---------------------------------------------------------------------------

export interface ReconcileRouteProofInput {
  proofId: string;
  routeRunId: string;
  walletAddress: `0x${string}`;
}

export function useReconcileRouteProof(
  options?: Omit<
    UseMutationOptions<apiSpec.RouteProofReconcileResponseV1, Error, ReconcileRouteProofInput>,
    'mutationFn' | 'retry'
  >,
) {
  return useMutation({
    ...options,
    retry: false,
    mutationFn: async (input) => {
      const request = apiSpec.RouteProofReconcileRequestV1Schema.parse({
        routeRunId: input.routeRunId,
        walletAddress: input.walletAddress,
      });
      const response = await fetchApi<unknown>(
        `/api/route-intelligence/route-proofs/${encodeURIComponent(input.proofId)}/reconcile`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(request),
        },
      );
      return apiSpec.RouteProofReconcileResponseV1Schema.parse(response);
    },
  });
}

export function useRouteProof(
  proofId: string | null,
  options?: Omit<
    UseQueryOptions<apiSpec.RouteProofGetResponseV1, Error, apiSpec.RouteProofGetResponseV1, (string | null)[]>,
    'queryKey' | 'queryFn'
  >,
) {
  return useQuery({
    queryKey: ['route-proof', proofId],
    queryFn: async () => {
      const response = await fetchApi<unknown>(
        `/api/route-intelligence/route-proofs/${encodeURIComponent(proofId ?? '')}`,
      );
      return apiSpec.RouteProofGetResponseV1Schema.parse(response);
    },
    enabled: Boolean(proofId),
    // No polling by default — bounded polling is opt-in via
    // useBoundedProofReconciliation only.
    refetchInterval: false,
    refetchOnWindowFocus: false,
    retry: false,
    ...options,
  });
}

export function useRouteHistory(
  params?: { limit?: number; cursor?: string },
  options?: Omit<
    UseQueryOptions<apiSpec.RouteHistoryResponseV1, Error, apiSpec.RouteHistoryResponseV1, (string | number | undefined)[]>,
    'queryKey' | 'queryFn'
  >,
) {
  return useQuery({
    queryKey: ['route-history', params?.limit, params?.cursor],
    queryFn: async () => {
      const url = new URL('/api/route-intelligence/history', 'http://localhost');
      if (params?.limit) url.searchParams.set('limit', params.limit.toString());
      if (params?.cursor) url.searchParams.set('cursor', params.cursor);
      const response = await fetchApi<unknown>(url.pathname + url.search);
      return apiSpec.RouteHistoryResponseV1Schema.parse(response);
    },
    refetchInterval: false,
    refetchOnWindowFocus: false,
    retry: false,
    ...options,
  });
}

/** Bounded polling limits — exported for introspection tests and so both
 * surfaces render honest copy about when polling stops. */
export const MAX_PROOF_POLL_ATTEMPTS = 10;
export const PROOF_POLL_INTERVAL_MS = 4000;
/** Poll attempts at which reconcile is re-run when the proof is still
 * pending (receipts may have landed since the previous pass). */
export const PROOF_RECONCILE_RETRY_ATTEMPTS: readonly number[] = [3, 6];

export const PROOF_TERMINAL_FINAL_STATUSES: readonly string[] = [
  'completed',
  'partial_failure',
  'failed',
  'cancelled',
  'reconciliation_required',
];

export function isTerminalProofFinalStatus(status: string | null | undefined): boolean {
  return typeof status === 'string' && PROOF_TERMINAL_FINAL_STATUSES.includes(status);
}

export interface UseBoundedProofReconciliationArgs {
  proofId: string | null;
  routeRunId: string | null;
  walletAddress: `0x${string}` | null | undefined;
  enabled: boolean;
}

export interface UseBoundedProofReconciliationResult {
  proof: apiSpec.RouteProofProjectionV1 | null;
  lifecycle: apiSpec.BlueprintLifecycleStateV1 | null;
  events: apiSpec.RouteProofGetResponseV1['events'];
  outcome: apiSpec.RouteProofReconcileResponseV1['outcome'] | null;
  isLoading: boolean;
  error: Error | null;
}

/**
 * Composition: one reconcile POST when polling starts, then a GET-backed
 * query whose refetchInterval CALLBACK enforces the bound — it returns false
 * (stop) on any terminal finalStatus and after MAX_PROOF_POLL_ATTEMPTS
 * (~40s at 4s intervals); at attempts 3 and 6 it re-runs reconcile if the
 * proof is still pending. Unmount stops the query automatically. Mutations
 * themselves never poll.
 */
export function useBoundedProofReconciliation({
  proofId,
  routeRunId,
  walletAddress,
  enabled,
}: UseBoundedProofReconciliationArgs): UseBoundedProofReconciliationResult {
  const reconcile = useReconcileRouteProof();
  const attemptsRef = useRef(0);
  const startedForRef = useRef<string | null>(null);
  const active = Boolean(enabled && proofId && routeRunId && walletAddress);

  const reconcileMutate = reconcile.mutate;
  useEffect(() => {
    if (!active || !proofId || !routeRunId || !walletAddress) return;
    if (startedForRef.current === proofId) return;
    startedForRef.current = proofId;
    attemptsRef.current = 0;
    reconcileMutate({ proofId, routeRunId, walletAddress });
  }, [active, proofId, routeRunId, walletAddress, reconcileMutate]);

  const query = useRouteProof(active ? proofId : null, {
    enabled: active,
    refetchInterval: (current) => {
      const finalStatus = current.state.data?.proof.finalStatus ?? null;
      if (isTerminalProofFinalStatus(finalStatus)) return false;
      attemptsRef.current += 1;
      if (attemptsRef.current >= MAX_PROOF_POLL_ATTEMPTS) return false;
      if (
        PROOF_RECONCILE_RETRY_ATTEMPTS.includes(attemptsRef.current) &&
        finalStatus === 'pending' &&
        proofId && routeRunId && walletAddress
      ) {
        reconcileMutate({ proofId, routeRunId, walletAddress });
      }
      return PROOF_POLL_INTERVAL_MS;
    },
  });

  return {
    proof: query.data?.proof ?? reconcile.data?.proof ?? null,
    lifecycle: query.data?.lifecycle ?? reconcile.data?.lifecycle ?? null,
    events: query.data?.events ?? [],
    outcome: reconcile.data?.outcome ?? null,
    isLoading: active && query.isPending && reconcile.isPending,
    error: (query.error ?? reconcile.error) as Error | null,
  };
}

// ---------------------------------------------------------------------------
// T60: Intelligence Budget + Spend Permission payment hooks (decision 11).
//
// Four CRUD hooks over /api/route-intelligence/intelligence-budget plus
// useSimulateWithBudget — the [Use Intelligence Budget] surface. The whole
// point of T60 is that the user does NOT sign again: useSimulateWithBudget is
// a PLAIN authenticated POST (fetchApi, credentials same-origin). It NEVER
// calls signTypedData, NEVER runs an x402 challenge, NEVER touches wagmi or
// paidFetch — the bounded charge happens server-side against the user's
// EXISTING Spend Permission. Every response is re-validated against its
// api-spec schema, and every mutation is retry:false (money-touching requests
// must never silently auto-retry). This package stays wagmi-free.
// ---------------------------------------------------------------------------

// Re-exported so surfaces (interface/miniapp, which don't depend on api-spec
// directly) can type their budget response mappers and projection props.
export type {
  IntelligenceBudgetProjectionV1,
  IntelligenceBudgetResponseV1,
  AiCompareResponseV1,
  AiExecuteResponseV1,
  AiProofResponseV1,
  MarketSnapshotResponseV1,
  NftProofResponseV1,
  SimulateWithBudgetResponseV1,
} from '@mioagent/api-spec';

/** Deterministic requestId feeding the coordinator's idempotency key — a
 * repeated call for the SAME (wallet, blueprintHash) replays the same request
 * so a double-click never mints a second charge (the server resolves it to a
 * cached result). Pure and side-effect free; matches
 * SimulateWithBudgetRequestV1Schema's requestId regex. */
export function deterministicBudgetRequestIdV1(input: {
  walletAddress: string;
  blueprintHash: string;
}): string {
  const wallet = input.walletAddress.toLowerCase().replace(/^0x/, '');
  const blueprint = input.blueprintHash.toLowerCase().replace(/^0x/, '');
  return `budget-req-${wallet}-${blueprint}`;
}

export function useIntelligenceBudget(
  options?: Omit<
    UseQueryOptions<apiSpec.IntelligenceBudgetResponseV1, Error, apiSpec.IntelligenceBudgetResponseV1, string[]>,
    'queryKey' | 'queryFn'
  >,
) {
  return useQuery({
    queryKey: ['intelligence-budget'],
    queryFn: async () => {
      const response = await fetchApi<unknown>('/api/route-intelligence/intelligence-budget');
      return apiSpec.IntelligenceBudgetResponseV1Schema.parse(response);
    },
    retry: false,
    ...options,
  });
}

export interface CreateIntelligenceBudgetInput {
  spendPermissionId: string;
  walletAddress: `0x${string}`;
  periodLimitUsdc: string;
  maxPerCallUsdc: string;
  allowedCategories: string[];
}

export function useCreateIntelligenceBudget(
  options?: Omit<
    UseMutationOptions<apiSpec.IntelligenceBudgetResponseV1, Error, CreateIntelligenceBudgetInput>,
    'mutationFn' | 'retry'
  >,
) {
  const queryClient = useQueryClient();
  return useMutation({
    ...options,
    retry: false,
    mutationFn: async (input) => {
      const request = apiSpec.CreateIntelligenceBudgetRequestV1Schema.parse(input);
      const response = await fetchApi<unknown>('/api/route-intelligence/intelligence-budget', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      });
      return apiSpec.IntelligenceBudgetResponseV1Schema.parse(response);
    },
    onSuccess: (data, variables, context, mutCtx) => {
      queryClient.invalidateQueries({ queryKey: ['intelligence-budget'] });
      queryClient.invalidateQueries({ queryKey: ['status'] });
      if (options?.onSuccess) {
        (options.onSuccess as any)(data, variables, context, mutCtx);
      }
    },
  });
}

export interface UpdateIntelligenceBudgetInput {
  periodLimitUsdc?: string;
  maxPerCallUsdc?: string;
  allowedCategories?: string[];
}

export function useUpdateIntelligenceBudget(
  options?: Omit<
    UseMutationOptions<apiSpec.IntelligenceBudgetResponseV1, Error, UpdateIntelligenceBudgetInput>,
    'mutationFn' | 'retry'
  >,
) {
  const queryClient = useQueryClient();
  return useMutation({
    ...options,
    retry: false,
    mutationFn: async (input) => {
      const request = apiSpec.UpdateIntelligenceBudgetRequestV1Schema.parse(input);
      const response = await fetchApi<unknown>('/api/route-intelligence/intelligence-budget', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      });
      return apiSpec.IntelligenceBudgetResponseV1Schema.parse(response);
    },
    onSuccess: (data, variables, context, mutCtx) => {
      queryClient.invalidateQueries({ queryKey: ['intelligence-budget'] });
      queryClient.invalidateQueries({ queryKey: ['status'] });
      if (options?.onSuccess) {
        (options.onSuccess as any)(data, variables, context, mutCtx);
      }
    },
  });
}

export function useRevokeIntelligenceBudget(
  options?: Omit<
    UseMutationOptions<apiSpec.IntelligenceBudgetResponseV1, Error, void>,
    'mutationFn' | 'retry'
  >,
) {
  const queryClient = useQueryClient();
  return useMutation({
    ...options,
    retry: false,
    mutationFn: async () => {
      const response = await fetchApi<unknown>('/api/route-intelligence/intelligence-budget/revoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      return apiSpec.IntelligenceBudgetResponseV1Schema.parse(response);
    },
    onSuccess: (data, variables, context, mutCtx) => {
      queryClient.invalidateQueries({ queryKey: ['intelligence-budget'] });
      queryClient.invalidateQueries({ queryKey: ['status'] });
      if (options?.onSuccess) {
        (options.onSuccess as any)(data, variables, context, mutCtx);
      }
    },
  });
}

// ---------------------------------------------------------------------------
// T71 — the Spend Permission onboarding calls.
//
// `prepare` and `confirm` are deliberately NOT one call. Between them the
// user's Base Account opens, and the whole security argument is that the server
// decides what is asked for and separately decides whether what came back is
// real. A single endpoint would have to trust the client for one half or the
// other.
// ---------------------------------------------------------------------------

export function usePrepareSpendPermission(
  options?: Omit<
    UseMutationOptions<
      apiSpec.PrepareSpendPermissionResponseV1,
      Error,
      { periodLimitUsdc: string; maxPerCallUsdc: string }
    >,
    'mutationFn' | 'retry'
  >,
) {
  return useMutation({
    ...options,
    retry: false,
    mutationFn: async (input) => {
      const response = await fetchApi<unknown>(
        '/api/route-intelligence/intelligence-budget/permission/prepare',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(input),
        },
      );
      return apiSpec.PrepareSpendPermissionResponseV1Schema.parse(response);
    },
  });
}

export function useConfirmSpendPermission(
  options?: Omit<
    UseMutationOptions<
      apiSpec.ConfirmSpendPermissionResponseV1,
      Error,
      apiSpec.ConfirmSpendPermissionRequestV1
    >,
    'mutationFn' | 'retry'
  >,
) {
  const queryClient = useQueryClient();
  return useMutation({
    ...options,
    // Never retried automatically. A confirmation is idempotent on the server,
    // but a silent retry would hide a `verification_unavailable` the user needs
    // to see and decide about.
    retry: false,
    mutationFn: async (input) => {
      const response = await fetchApi<unknown>(
        '/api/route-intelligence/intelligence-budget/permission/confirm',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(input),
        },
      );
      return apiSpec.ConfirmSpendPermissionResponseV1Schema.parse(response);
    },
    onSuccess: (data, variables, context, mutCtx) => {
      // T71.1 §5 — write the budget the server just returned BEFORE asking for
      // it again.
      //
      // A first activation answers 201 with the budget in the body. Invalidating
      // alone left a window where the query still held `{ budget: null }`, and
      // the panel renders that window as "Not configured" — the same words it
      // shows a user who has never granted anything. Priming the cache closes
      // the window; the refetch that follows is what keeps the value honest.
      //
      // Only on `activated`. A refusal carries `budget: null`, and writing that
      // would erase a budget the user already had.
      if (data.outcome === 'activated' && data.budget) {
        queryClient.setQueryData(['intelligence-budget'], { budget: data.budget });
      }
      queryClient.invalidateQueries({ queryKey: ['intelligence-budget'] });
      queryClient.invalidateQueries({ queryKey: ['status'] });
      if (options?.onSuccess) {
        (options.onSuccess as any)(data, variables, context, mutCtx);
      }
    },
  });
}

/** Pause and resume share one implementation: they are the same write with a
 * different path, and two copies would drift on cache invalidation. */
function useBudgetPauseStateV1(
  path: 'pause' | 'resume',
  options?: Omit<UseMutationOptions<apiSpec.IntelligenceBudgetResponseV1, Error, void>, 'mutationFn' | 'retry'>,
) {
  const queryClient = useQueryClient();
  return useMutation({
    ...options,
    retry: false,
    mutationFn: async () => {
      const response = await fetchApi<unknown>(
        `/api/route-intelligence/intelligence-budget/${path}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        },
      );
      return apiSpec.IntelligenceBudgetResponseV1Schema.parse(response);
    },
    onSuccess: (data, variables, context, mutCtx) => {
      queryClient.invalidateQueries({ queryKey: ['intelligence-budget'] });
      queryClient.invalidateQueries({ queryKey: ['status'] });
      if (options?.onSuccess) {
        (options.onSuccess as any)(data, variables, context, mutCtx);
      }
    },
  });
}

export function usePauseIntelligenceBudget(
  options?: Omit<UseMutationOptions<apiSpec.IntelligenceBudgetResponseV1, Error, void>, 'mutationFn' | 'retry'>,
) {
  return useBudgetPauseStateV1('pause', options);
}

export function useResumeIntelligenceBudget(
  options?: Omit<UseMutationOptions<apiSpec.IntelligenceBudgetResponseV1, Error, void>, 'mutationFn' | 'retry'>,
) {
  return useBudgetPauseStateV1('resume', options);
}

export interface SimulateWithBudgetInput {
  routeRunId: string;
  walletAddress: `0x${string}`;
  blueprintId: string;
  blueprintHash: string;
  /** Optional explicit override; otherwise a deterministic id keeps a
   * double-click from ever minting a second charge. */
  requestId?: string;
}

export function useSimulateWithBudget(
  options?: Omit<
    UseMutationOptions<apiSpec.SimulateWithBudgetResponseV1, Error, SimulateWithBudgetInput>,
    'mutationFn' | 'retry'
  >,
) {
  const queryClient = useQueryClient();
  return useMutation({
    ...options,
    retry: false,
    mutationFn: async (input) => {
      // PLAIN authenticated POST — no typed-data signature, no payment
      // challenge, no wagmi signing. The user pays via their EXISTING Spend
      // Permission (see this hook's block comment above for the full rationale).
      const requestId =
        input.requestId ??
        deterministicBudgetRequestIdV1({ walletAddress: input.walletAddress, blueprintHash: input.blueprintHash });
      const request = apiSpec.SimulateWithBudgetRequestV1Schema.parse({
        routeRunId: input.routeRunId,
        walletAddress: input.walletAddress,
        blueprintHash: input.blueprintHash,
        requestId,
      });
      const response = await fetchApi<unknown>(
        `/api/route-intelligence/blueprints/${encodeURIComponent(input.blueprintId)}/simulate-with-budget`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(request),
        },
      );
      return apiSpec.SimulateWithBudgetResponseV1Schema.parse(response);
    },
    onSuccess: (data, variables, context, mutCtx) => {
      // A settled charge changes remaining budget headroom.
      queryClient.invalidateQueries({ queryKey: ['intelligence-budget'] });
      if (options?.onSuccess) {
        (options.onSuccess as any)(data, variables, context, mutCtx);
      }
    },
  });
}

// ---------------------------------------------------------------------------
// T65: the NFT purchase rail.
//
// The client sends a goal, then a Route Card HASH, then the hash of the calls
// it reviewed. It never sends calldata, a target, a value or a recipient —
// every byte a wallet is asked to sign is produced on the server from a pinned
// ABI.
// ---------------------------------------------------------------------------

export interface NftCompareInput {
  message: string;
  walletAddress: `0x${string}`;
  requestId?: string;
}

/**
 * Each NFT comparison is its OWN run, so the request id is fresh per call.
 *
 * The swap identity deliberately reuses one id for the same (wallet, goal), so
 * re-asking replays the same run. That is wrong for this family: a listing is
 * not a stable fact. Re-comparing at 22:24 what was observed at 22:04 is a NEW
 * observation, with its own price, its own expiry and its own evidence — and
 * the storage layer says so, since a run may hold only one candidate per order.
 * Reusing the id put the second observation into the first one's run and the
 * comparison failed with a 409 that named none of this.
 *
 * Double submits are held off by the surface instead: the Compare control is
 * disabled while the mutation is pending.
 */
export function useNftCompare(
  options?: Omit<UseMutationOptions<apiSpec.NftCompareResponseV1, Error, NftCompareInput>, 'mutationFn' | 'retry'>,
) {
  return useMutation({
    ...options,
    retry: false,
    mutationFn: async (input) => {
      const request = apiSpec.NftCompareRequestV1Schema.parse({
        message: input.message,
        walletAddress: input.walletAddress,
        requestId: input.requestId ?? globalThis.crypto.randomUUID(),
      });
      const response = await fetchApi<unknown>('/api/route-intelligence/nft/compare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      });
      return apiSpec.NftCompareResponseV1Schema.parse(response);
    },
  });
}

export interface NftPrepareInput {
  routeRunId: string;
  routeCardHash: string;
  walletAddress: `0x${string}`;
}

export function useNftPrepare(
  options?: Omit<UseMutationOptions<apiSpec.NftPrepareResponseV1, Error, NftPrepareInput>, 'mutationFn' | 'retry'>,
) {
  return useMutation({
    ...options,
    retry: false,
    mutationFn: async (input) => {
      const request = apiSpec.NftPrepareRequestV1Schema.parse(input);
      const response = await fetchApi<unknown>('/api/route-intelligence/nft/prepare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      });
      return apiSpec.NftPrepareResponseV1Schema.parse(response);
    },
  });
}

/** Deliberately the SAME input shape as the swap and earn approvals, so the one
 * shared submission hook can drive this family without a per-goal call site. */
export type NftApproveInput = ApproveEarnBlueprintInput;

export function useNftApprove(
  options?: Omit<UseMutationOptions<apiSpec.NftApproveResponseV1, Error, NftApproveInput>, 'mutationFn' | 'retry'>,
) {
  return useMutation({
    ...options,
    retry: false,
    mutationFn: async (input) => {
      const request = apiSpec.NftApproveRequestV1Schema.parse({
        routeRunId: input.routeRunId,
        blueprintHash: input.blueprintHash,
        walletAddress: input.walletAddress,
      });
      const response = await fetchApi<unknown>(
        `/api/route-intelligence/nft/blueprints/${encodeURIComponent(input.blueprintId)}/approve`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request) },
      );
      return apiSpec.NftApproveResponseV1Schema.parse(response);
    },
  });
}

/** What the WALLET returned, in the goal-agnostic submission shape swap and
 * earn already use. Recorded as a claim about a submission, never as a fact
 * about the chain — reconciliation reads that separately. */
export function useRecordNftBlueprintSubmission(
  options?: Omit<
    UseMutationOptions<apiSpec.NftSubmissionResponseV1, Error, RecordBlueprintSubmissionInput>,
    'mutationFn' | 'retry'
  >,
) {
  return useMutation({
    ...options,
    retry: false,
    mutationFn: async (input) => {
      const request = apiSpec.NftSubmissionRequestV1Schema.parse({
        routeRunId: input.routeRunId,
        walletAddress: input.walletAddress,
        approvedCallsHash: input.approvedCallsHash,
        status: input.status,
        ...(input.batchId !== undefined ? { batchId: input.batchId } : {}),
        ...(input.transactionHashes !== undefined ? { transactionHashes: input.transactionHashes } : {}),
        ...(input.receipts !== undefined ? { receipts: input.receipts } : {}),
        ...(input.error !== undefined ? { error: input.error } : {}),
        ...(input.submissionAttemptId !== undefined
          ? { submissionAttemptId: input.submissionAttemptId }
          : {}),
      });
      const response = await fetchApi<unknown>(
        `/api/route-intelligence/nft/blueprints/${encodeURIComponent(input.blueprintId)}/submission`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request) },
      );
      return apiSpec.NftSubmissionResponseV1Schema.parse(response);
    },
  });
}

export function useNftReconcile(
  options?: Omit<UseMutationOptions<apiSpec.NftProofResponseV1, Error, { proofId: string }>, 'mutationFn' | 'retry'>,
) {
  return useMutation({
    ...options,
    retry: false,
    mutationFn: async (input) => {
      const response = await fetchApi<unknown>(
        `/api/route-intelligence/nft/proofs/${encodeURIComponent(input.proofId)}/reconcile`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
      );
      return apiSpec.NftProofResponseV1Schema.parse(response);
    },
  });
}

// ---------------------------------------------------------------------------
// T66C — the Private AI rail.
//
// Two mutations and one read. What makes this rail different from every other
// one in this file: `useAiCompare` returns a NONCE that the caller must hold
// on to. The server does not keep it, and without it the commitment on the
// Route Card can never be opened — including by us. A surface that drops it
// between compare and execute cannot run the request it just reviewed.
//
// The prompt is sent twice on purpose: once to compare, once to execute. That
// is what lets the server prove the two are the same request without storing
// either copy.
// ---------------------------------------------------------------------------

export interface AiPromptMessageInputV1 {
  role: 'user' | 'assistant';
  text: string;
}

export interface AiCompareInput {
  messages: readonly AiPromptMessageInputV1[];
  walletAddress: `0x${string}`;
  systemText?: string | null;
  maxSpendUsd?: string | null;
  maxCompletionTokens?: number;
  privacyRequirement?: 'private_only' | 'prefer_private' | 'any';
  preferredModelId?: string | null;
  requiresToolCalling?: boolean;
  requiresResponseSchema?: boolean;
  requiresWebSearch?: boolean;
  /** Each comparison is its OWN run, so the request id is fresh per call
   * unless a caller pins one. A sticky id put a second observation into the
   * first run in T65 and collided on a unique index. */
  requestId?: string;
}

export function useAiCompare(
  options?: Omit<UseMutationOptions<apiSpec.AiCompareResponseV1, Error, AiCompareInput>, 'mutationFn' | 'retry'>,
) {
  return useMutation({
    ...options,
    retry: false,
    mutationFn: async (input) => {
      const request = apiSpec.AiCompareRequestV1Schema.parse({
        messages: input.messages,
        systemText: input.systemText ?? null,
        walletAddress: input.walletAddress,
        requestId: input.requestId ?? globalThis.crypto.randomUUID(),
        privacyRequirement: input.privacyRequirement ?? 'private_only',
        maxSpendUsd: input.maxSpendUsd ?? null,
        maxCompletionTokens: input.maxCompletionTokens ?? 1_024,
        preferredModelId: input.preferredModelId ?? null,
        requiresToolCalling: input.requiresToolCalling,
        requiresResponseSchema: input.requiresResponseSchema,
        requiresWebSearch: input.requiresWebSearch,
      });
      const response = await fetchApi<unknown>('/api/route-intelligence/ai/compare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      });
      return apiSpec.AiCompareResponseV1Schema.parse(response);
    },
  });
}

export interface AiExecuteInput {
  routeRunId: string;
  routeCardHash: string;
  walletAddress: `0x${string}`;
  /** The same messages that were compared. The server recomputes the
   * commitment and refuses anything else. */
  messages: readonly AiPromptMessageInputV1[];
  systemText?: string | null;
  /** From the compare response. Held by the client and nowhere else. */
  promptNonce: string;
  temperature?: number | null;
  responseSchema?: Record<string, unknown> | null;
}

export function useAiExecute(
  options?: Omit<UseMutationOptions<apiSpec.AiExecuteResponseV1, Error, AiExecuteInput>, 'mutationFn' | 'retry'>,
) {
  return useMutation({
    ...options,
    retry: false,
    mutationFn: async (input) => {
      const request = apiSpec.AiExecuteRequestV1Schema.parse({
        routeRunId: input.routeRunId,
        routeCardHash: input.routeCardHash,
        walletAddress: input.walletAddress,
        messages: input.messages,
        systemText: input.systemText ?? null,
        promptNonce: input.promptNonce,
        temperature: input.temperature ?? null,
        responseSchema: input.responseSchema ?? null,
      });
      const response = await fetchApi<unknown>('/api/route-intelligence/ai/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      });
      return apiSpec.AiExecuteResponseV1Schema.parse(response);
    },
  });
}

export function useAiProof(
  options?: Omit<UseMutationOptions<apiSpec.AiProofResponseV1, Error, { routeRunId: string }>, 'mutationFn' | 'retry'>,
) {
  return useMutation({
    ...options,
    retry: false,
    mutationFn: async (input) => {
      const response = await fetchApi<unknown>(
        `/api/route-intelligence/ai/proof/${encodeURIComponent(input.routeRunId)}`,
      );
      return apiSpec.AiProofResponseV1Schema.parse(response);
    },
  });
}

// ---------------------------------------------------------------------------
// T67C.2 — submission recovery.
//
// Three mutations and one query, and none of them touches a wallet. Creating
// an attempt, binding a batch id and abandoning a card are all server writes
// about a batch the wallet has already dealt with. The only code in this
// codebase that opens a wallet is still useSubmitApprovedBlueprint.
// ---------------------------------------------------------------------------

export interface CreateSubmissionAttemptInput {
  walletAddress: `0x${string}`;
  goal: 'swap' | 'earn' | 'nft';
  routeRunId: string;
  blueprintId: string;
  approvedCallsHash: string;
}

export function useCreateSubmissionAttempt(
  options?: Omit<
    UseMutationOptions<apiSpec.SubmissionAttemptResponseV1, Error, CreateSubmissionAttemptInput>,
    'mutationFn' | 'retry'
  >,
) {
  return useMutation({
    ...options,
    retry: false,
    mutationFn: async (input) => {
      const request = apiSpec.SubmissionAttemptCreateRequestV1Schema.parse(input);
      const response = await fetchApi<unknown>('/api/route-intelligence/submission-attempts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      });
      return apiSpec.SubmissionAttemptResponseV1Schema.parse(response);
    },
  });
}

export function useBindSubmissionBatch(
  options?: Omit<
    UseMutationOptions<
      apiSpec.SubmissionAttemptResponseV1,
      Error,
      { attemptId: string; batchId: string }
    >,
    'mutationFn' | 'retry'
  >,
) {
  return useMutation({
    ...options,
    retry: false,
    mutationFn: async (input) => {
      const request = apiSpec.SubmissionAttemptBatchRequestV1Schema.parse({ batchId: input.batchId });
      const response = await fetchApi<unknown>(
        `/api/route-intelligence/submission-attempts/${encodeURIComponent(input.attemptId)}/batch`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request) },
      );
      return apiSpec.SubmissionAttemptResponseV1Schema.parse(response);
    },
  });
}

export function useAbandonSubmissionAttempt(
  options?: Omit<
    UseMutationOptions<apiSpec.SubmissionAttemptResponseV1, Error, { attemptId: string }>,
    'mutationFn' | 'retry'
  >,
) {
  return useMutation({
    ...options,
    retry: false,
    mutationFn: async (input) => {
      const response = await fetchApi<unknown>(
        `/api/route-intelligence/submission-attempts/${encodeURIComponent(input.attemptId)}/abandon`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' } },
      );
      return apiSpec.SubmissionAttemptResponseV1Schema.parse(response);
    },
  });
}

export function useRecoverableSubmissionAttempts(
  options?: Omit<
    UseQueryOptions<
      apiSpec.RecoverableSubmissionAttemptsResponseV1,
      Error,
      apiSpec.RecoverableSubmissionAttemptsResponseV1,
      string[]
    >,
    'queryKey' | 'queryFn'
  >,
) {
  return useQuery({
    ...options,
    queryKey: ['submission-attempts', 'recoverable'],
    queryFn: async () => {
      // No wallet parameter: the server reads the wallet from the signed
      // session, so a caller cannot ask about somebody else's attempts.
      const response = await fetchApi<unknown>('/api/route-intelligence/submission-attempts/recoverable');
      return apiSpec.RecoverableSubmissionAttemptsResponseV1Schema.parse(response);
    },
  });
}

// ---------------------------------------------------------------------------
// T67C.2 — publishing and revoking a proof link.
//
// Both are owner actions against a proof that already exists. Neither sends
// any proof content: the server rebuilds the bundle from its own records on
// every public read, so a link can never drift from the record it points at.
// ---------------------------------------------------------------------------

export interface ProofShareInput {
  proofId: string;
  /** `route` covers swap and earn; NFT keeps its own proof contract. */
  proofFamily?: 'route' | 'nft';
}

function proofSharePathV1(input: ProofShareInput): string {
  const id = encodeURIComponent(input.proofId);
  return input.proofFamily === 'nft'
    ? `/api/route-intelligence/nft/proofs/${id}/share`
    : `/api/route-intelligence/route-proofs/${id}/share`;
}

export function useShareProof(
  options?: Omit<
    UseMutationOptions<apiSpec.PublicProofShareResponseV1, Error, ProofShareInput>,
    'mutationFn' | 'retry'
  >,
) {
  return useMutation({
    ...options,
    retry: false,
    mutationFn: async (input) => {
      const response = await fetchApi<unknown>(proofSharePathV1(input), { method: 'POST' });
      return apiSpec.PublicProofShareResponseV1Schema.parse(response);
    },
  });
}

export function useRevokeProofShare(
  options?: Omit<UseMutationOptions<{ revoked: boolean }, Error, ProofShareInput>, 'mutationFn' | 'retry'>,
) {
  return useMutation({
    ...options,
    retry: false,
    mutationFn: async (input) => {
      const response = await fetchApi<{ revoked?: boolean }>(proofSharePathV1(input), { method: 'DELETE' });
      return { revoked: Boolean(response?.revoked) };
    },
  });
}
