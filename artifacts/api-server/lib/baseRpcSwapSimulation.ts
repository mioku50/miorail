import {
  createEthSimulateV1ProviderV1,
  type SimulationProvider,
  type SimulationProviderErrorCodeV1,
  type SimulationProviderRequestV1,
  type SimulationProviderResultV1,
} from '@mioagent/paid-intelligence';

// ---------------------------------------------------------------------------
// Base RPC simulation, in two tiers.
//
// This file used to open by asserting that "a normal Base JSON-RPC cannot
// prove [an ordered batch] for approval+swap batches". That was measured false:
// `mainnet.base.org` serves `eth_simulateV1`, and it serves it with state
// evolving across calls — an `approve` followed by an `allowance` read in the
// same request returns the allowance the approve just set. The premise had
// made a paid key look mandatory for a capability the chain's own public
// endpoint already offered, and when that key's account ran out of monthly
// capacity every server-written-calldata route went dark behind it.
//
// So there are two providers here:
//
//   createBaseRpcBatchSimulationProviderV1  — eth_simulateV1, ANY call count,
//     one evolving state. This is a full batch simulator, not a fallback in
//     capability terms, and it is what proves approve-then-swap.
//
//   createBaseRpcSwapSimulationProviderV1   — eth_call + estimateGas, exactly
//     ONE call. Kept because not every Base RPC exposes eth_simulateV1 (Infura
//     answers -32601 for it), so a deployment pointed at such an endpoint still
//     gets its single-call native-ETH swaps proven.
//
// Neither uses a state or balance override: balances, allowances and nonces are
// whatever the chain really holds. The single-call tier additionally never
// claims asset-change evidence, because eth_call has no receipt logs.
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
  /** Overrides the provider id, so two endpoints of the same shape stay
   * distinguishable in health records and logs. */
  providerId?: string;
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

// --- Batch tier: eth_simulateV1 over the deployment's own Base RPC ----------

export const BASE_RPC_BATCH_SIMULATION_PROVIDER_ID_V1 = 'base-rpc-eth-simulate-v1';

/**
 * The same reviewed `eth_simulateV1` adapter the Alchemy provider uses, pointed
 * at the Base RPC this deployment is already configured with. No key of its
 * own, no second endpoint to configure, and no new request shape to review.
 *
 * The URL is passed as the redaction value as well: an endpoint that embeds a
 * key must not survive in an upstream error message. Returns null — never a
 * provider that fails at call time — when the URL is absent or not a plain
 * https endpoint, so an unusable configuration is absent capability rather
 * than a runtime surprise.
 */
export function createBaseRpcBatchSimulationProviderV1(
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
  return createEthSimulateV1ProviderV1({
    providerId: options.providerId ?? BASE_RPC_BATCH_SIMULATION_PROVIDER_ID_V1,
    label: 'Base RPC',
    url: rawUrl,
    redactValue: rawUrl,
    timeoutMs: options.timeoutMs,
    fetchImpl: options.fetchImpl,
  });
}

export function createBaseRpcBatchSimulationProviderFromEnvV1(
  env: NodeJS.ProcessEnv = process.env,
): SimulationProvider | null {
  return createBaseRpcBatchSimulationProviderV1({
    rpcUrl: env.MIORAIL_SIMULATION_RPC_URL || env.BASE_MAINNET_RPC_URL || env.BASE_RPC_URL,
    timeoutMs: Number(env.MIORAIL_RPC_SIMULATION_TIMEOUT_MS || DEFAULT_TIMEOUT_MS_V1),
  });
}

// ---------------------------------------------------------------------------
// The simulation endpoint is not the read endpoint.
//
// This deployment's BASE_MAINNET_RPC_URL is deliberately Infura: it was moved
// off Alchemy on 2026-08-10 because the monthly bucket was ~90% spent with 21
// days left, and Infura's resets daily, so an exhausted bucket costs part of a
// day instead of three weeks. That is the right call for the user-facing read
// path — and it is why simulation must not inherit it. Infura does not
// implement eth_simulateV1; it answers -32601. Alchemy implements it and is out
// of capacity. So the read RPC and the simulation RPC are chosen for different
// properties and must be configured separately.
//
// Order: an explicit MIORAIL_SIMULATION_RPC_URL, then whatever the read path
// uses, then Base's own public endpoint. The last one is a code-owned constant
// rather than configuration — it carries no key, it is the chain's canonical
// endpoint, and pinning it means no configuration mistake and no injected text
// can point simulation somewhere else.
// ---------------------------------------------------------------------------

export const BASE_PUBLIC_RPC_URL_V1 = 'https://mainnet.base.org';
export const BASE_PUBLIC_BATCH_SIMULATION_PROVIDER_ID_V1 = 'base-public-eth-simulate-v1';

/** The canonical public Base endpoint, used only when the configured RPC is
 * something else — otherwise it would be the same provider twice. */
export function createBasePublicBatchSimulationProviderFromEnvV1(
  env: NodeJS.ProcessEnv = process.env,
): SimulationProvider | null {
  const configured = (env.MIORAIL_SIMULATION_RPC_URL || env.BASE_MAINNET_RPC_URL || env.BASE_RPC_URL || '').trim();
  if (configured === BASE_PUBLIC_RPC_URL_V1) return null;
  return createBaseRpcBatchSimulationProviderV1({
    rpcUrl: BASE_PUBLIC_RPC_URL_V1,
    providerId: BASE_PUBLIC_BATCH_SIMULATION_PROVIDER_ID_V1,
    timeoutMs: Number(env.MIORAIL_RPC_SIMULATION_TIMEOUT_MS || DEFAULT_TIMEOUT_MS_V1),
  });
}
