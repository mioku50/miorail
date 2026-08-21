import type {
  SimulationProvider,
  SimulationProviderErrorCodeV1,
  SimulationProviderRequestV1,
  SimulationProviderResultV1,
} from '@mioagent/paid-intelligence';

// ---------------------------------------------------------------------------
// A narrow fallback for the free swap preflight.
//
// Alchemy eth_simulateV1 remains the primary provider because it can execute
// an ordered batch against one evolving state. A normal Base JSON-RPC cannot
// prove that for approval+swap batches. It can, however, safely execute ONE
// call from the real wallet against latest state. That is exactly the native
// ETH Aerodrome case which production was refusing when Alchemy returned 429.
//
// This adapter therefore fails closed for callCount !== 1 and never claims
// asset-change evidence: eth_call has no receipt logs. A passing eth_call plus
// estimateGas at a checked Base block is enough for the existing transaction
// safety gate, and no state or balance override is used.
// ---------------------------------------------------------------------------

const BASE_CHAIN_ID_V1 = 8453;
const DEFAULT_TIMEOUT_MS_V1 = 8_000;
const HEX_QUANTITY_V1 = /^0x[0-9a-fA-F]+$/u;

interface RpcEnvelopeV1 {
  jsonrpc?: unknown;
  id?: unknown;
  result?: unknown;
  error?: { code?: unknown; message?: unknown };
}

function fixedFailureV1(
  errorCode: SimulationProviderErrorCodeV1,
  detail: string,
): SimulationProviderResultV1 {
  return { ok: false, errorCode, detail } as SimulationProviderResultV1;
}

function decimalToHexV1(value: string): string | null {
  if (!/^(0|[1-9][0-9]*)$/u.test(value)) return null;
  return `0x${BigInt(value).toString(16)}`;
}

function isTimeoutV1(error: unknown): boolean {
  const name = (error as { name?: string })?.name;
  return name === 'AbortError' || name === 'TimeoutError' || /timeout|timed out|aborted/iu.test(String(error));
}

function safeRpcReasonV1(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) return 'RPC execution reverted';
  return value.replace(/https?:\/\/\S+/giu, '[endpoint]').slice(0, 500);
}

function rpcByIdV1(value: unknown): Map<number, RpcEnvelopeV1> | null {
  if (!Array.isArray(value)) return null;
  const rows = new Map<number, RpcEnvelopeV1>();
  for (const item of value) {
    if (!item || typeof item !== 'object') return null;
    const row = item as RpcEnvelopeV1;
    if (typeof row.id !== 'number') return null;
    rows.set(row.id, row);
  }
  return rows;
}

export interface CreateBaseRpcSwapSimulationOptionsV1 {
  rpcUrl: string | undefined;
  timeoutMs?: number;
  fetchImpl?: typeof globalThis.fetch;
}

export function createBaseRpcSwapSimulationProviderV1(
  options: CreateBaseRpcSwapSimulationOptionsV1,
): SimulationProvider | null {
  const rawUrl = options.rpcUrl?.trim();
  if (!rawUrl) return null;
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return null;
  const requestedTimeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS_V1;
  const timeoutMs = Number.isFinite(requestedTimeoutMs) && requestedTimeoutMs >= 250 && requestedTimeoutMs <= 30_000
    ? Math.trunc(requestedTimeoutMs)
    : DEFAULT_TIMEOUT_MS_V1;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;

  return {
    providerId: 'base-rpc-single-call-v1',
    async simulate(request: SimulationProviderRequestV1): Promise<SimulationProviderResultV1> {
      if (request.chainId !== BASE_CHAIN_ID_V1) {
        return fixedFailureV1('provider_chain_mismatch', 'Fallback RPC simulation is pinned to Base mainnet');
      }
      if (request.calls.length !== 1) {
        return fixedFailureV1('provider_method_unsupported', 'Fallback RPC proves only a single call, not an ordered batch');
      }
      const call = request.calls[0];
      const value = call ? decimalToHexV1(call.valueWei) : null;
      if (!call || !value) return fixedFailureV1('provider_invalid_schema', 'Persisted fallback call was malformed');
      const transaction = {
        from: request.walletAddress.toLowerCase(),
        to: call.to.toLowerCase(),
        value,
        data: call.data,
      };
      const body = [
        { jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] },
        { jsonrpc: '2.0', id: 2, method: 'eth_call', params: [transaction, 'latest'] },
        { jsonrpc: '2.0', id: 3, method: 'eth_estimateGas', params: [transaction, 'latest'] },
        { jsonrpc: '2.0', id: 4, method: 'eth_blockNumber', params: [] },
      ];
      let response: Response;
      try {
        response = await fetchImpl(parsed.toString(), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        return fixedFailureV1(
          isTimeoutV1(error) ? 'provider_timeout' : 'network_error',
          isTimeoutV1(error) ? 'Fallback Base RPC timed out' : 'Fallback Base RPC could not be reached',
        );
      }
      if (response.status === 429) return fixedFailureV1('provider_rate_limited', 'Fallback Base RPC rate limited the request');
      if (!response.ok) return fixedFailureV1('provider_http_error', `Fallback Base RPC returned HTTP ${response.status}`);
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        return fixedFailureV1('provider_invalid_schema', 'Fallback Base RPC returned invalid JSON');
      }
      const rows = rpcByIdV1(payload);
      if (!rows) return fixedFailureV1('provider_invalid_schema', 'Fallback Base RPC batch response was malformed');
      const chain = rows.get(1);
      const execution = rows.get(2);
      const estimate = rows.get(3);
      const block = rows.get(4);
      if (chain?.result !== '0x2105') return fixedFailureV1('provider_chain_mismatch', 'Fallback RPC did not report Base mainnet');
      if (!block || typeof block.result !== 'string' || !HEX_QUANTITY_V1.test(block.result)) {
        return fixedFailureV1('provider_invalid_schema', 'Fallback RPC returned no valid block number');
      }
      const blockNumber = Number(BigInt(block.result));
      if (!Number.isSafeInteger(blockNumber) || blockNumber <= 0) {
        return fixedFailureV1('provider_invalid_schema', 'Fallback RPC block number was outside the supported range');
      }
      const reverted = Boolean(execution?.error || estimate?.error);
      if (!reverted && (typeof execution?.result !== 'string' || !estimate || typeof estimate.result !== 'string' || !HEX_QUANTITY_V1.test(estimate.result))) {
        return fixedFailureV1('provider_invalid_schema', 'Fallback RPC returned an unreadable execution result');
      }
      const gasUsed = reverted ? '0' : BigInt(String(estimate!.result)).toString();
      const revertReason = reverted
        ? safeRpcReasonV1(execution?.error?.message ?? estimate?.error?.message)
        : null;
      return {
        ok: true,
        body: {
          status: reverted ? 'reverted' : 'success',
          blockNumber,
          gasUsed,
          stateChanges: [],
          revertReason,
          callResults: [{ index: 0, status: reverted ? 'reverted' : 'success', gasUsed, revertReason, logCount: 0 }],
          failedCallIndex: reverted ? 0 : null,
          assetChanges: {
            status: 'unavailable',
            unavailableReason: reverted ? 'simulation_reverted_no_state_change' : 'eth_call_returns_no_logs',
            changes: [],
          },
        },
      };
    },
  };
}

export function createBaseRpcSwapSimulationProviderFromEnvV1(
  env: NodeJS.ProcessEnv = process.env,
): SimulationProvider | null {
  return createBaseRpcSwapSimulationProviderV1({
    rpcUrl: env.BASE_MAINNET_RPC_URL || env.BASE_RPC_URL,
    timeoutMs: Number(env.MIORAIL_RPC_SIMULATION_TIMEOUT_MS || DEFAULT_TIMEOUT_MS_V1),
  });
}
