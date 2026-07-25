import type { ExecutionCallV1 } from '@mioagent/route-domain';
import { SimulationProviderRequestBodyV1Schema } from './schemas.js';

// T59 decision 2 — the provider interface is deliberately narrow: chainId is
// pinned to the literal 8453 (Base mainnet only), and the only fields ever
// sent to the provider are chainId/from/calls — no chat history, no email,
// no tenantId, no secrets. blueprintHash/callsHash are carried for the
// caller's own request-hash bookkeeping; they are NOT part of the HTTP body.
export interface SimulationProviderRequestV1 {
  chainId: 8453;
  walletAddress: string;
  blueprintHash: string;
  callsHash: string;
  calls: readonly ExecutionCallV1[];
}

// Transport-level result only — NOT yet validated against
// SimulationProviderResponseV1Schema. The coordinator (decision 7) owns
// running `body` through that schema so that "malformed response" and
// "provider unreachable" stay two distinct, honestly-reported failure modes
// (invalid_response vs paid_service_failed).
/** T63B extends this union additively. The three original codes are exactly
 * what the T59 generic HTTP provider still emits; the `provider_*` codes are
 * the normalized taxonomy an RPC-level adapter needs (chain/blueprint binding,
 * JSON-RPC errors, schema failures, call-count mismatch). Every member is a
 * TRANSPORT/plumbing failure — a simulated revert is a successful result, not
 * a member of this union. */
export type SimulationProviderErrorCodeV1 =
  | 'timeout'
  | 'network_error'
  | 'http_error'
  | 'provider_not_configured'
  | 'provider_timeout'
  | 'provider_rate_limited'
  | 'provider_http_error'
  | 'provider_rpc_error'
  | 'provider_invalid_schema'
  | 'provider_call_count_mismatch'
  | 'provider_chain_mismatch'
  | 'provider_blueprint_mismatch';

export type SimulationProviderResultV1 =
  | { ok: true; body: unknown }
  | { ok: false; errorCode: SimulationProviderErrorCodeV1; detail: string };

export interface SimulationProvider {
  readonly providerId: string;
  simulate(request: SimulationProviderRequestV1): Promise<SimulationProviderResultV1>;
}

export interface CreateHttpSimulationProviderOptions {
  /** Resolved caller-side (env-read happens in the API layer, never here). */
  url: string;
  providerId: string;
  timeoutMs?: number;
  fetchImpl?: typeof globalThis.fetch;
}

const DEFAULT_SIMULATION_TIMEOUT_MS = 4_000;

function isTimeoutError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /timeout|timed out|aborted/i.test(message) || (error as { name?: string })?.name === 'TimeoutError' || (error as { name?: string })?.name === 'AbortError';
}

/**
 * POSTs {chainId, from, calls, blockTag:'latest'} to `url` and returns the
 * raw (unvalidated) JSON body. Never performs runtime discovery/Bazaar
 * lookups, never retries, never sends anything beyond the whitelisted
 * request fields.
 */
export function createHttpSimulationProvider(
  options: CreateHttpSimulationProviderOptions,
): SimulationProvider {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_SIMULATION_TIMEOUT_MS;

  return {
    providerId: options.providerId,
    async simulate(request): Promise<SimulationProviderResultV1> {
      const body = SimulationProviderRequestBodyV1Schema.parse({
        chainId: request.chainId,
        from: request.walletAddress,
        calls: request.calls.map((call) => ({ to: call.to, value: call.valueWei, data: call.data })),
        blockTag: 'latest',
      });
      try {
        const response = await fetchImpl(options.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!response.ok) {
          return { ok: false, errorCode: 'http_error', detail: `simulation provider returned HTTP ${response.status}` };
        }
        let parsedBody: unknown;
        try {
          parsedBody = await response.json();
        } catch {
          return { ok: false, errorCode: 'http_error', detail: 'simulation provider response was not valid JSON' };
        }
        return { ok: true, body: parsedBody };
      } catch (error) {
        if (isTimeoutError(error)) {
          return { ok: false, errorCode: 'timeout', detail: 'simulation provider request timed out' };
        }
        const detail = error instanceof Error ? error.message : String(error);
        return { ok: false, errorCode: 'network_error', detail };
      }
    },
  };
}

// --- env resolution (decision 2) --------------------------------------------

export interface SimulationProviderConfigV1 {
  configured: boolean;
  /** Present ONLY for the generic HTTP provider. An RPC adapter builds its own
   * endpoint from a server-side secret, which must never travel in config. */
  url?: string;
  providerId: string;
  allowlist: string[];
  /** T63B: which adapter the resolved providerId selects. */
  kind?: SimulationProviderKindV1;
  missingReason?:
    | 'not_configured'
    | 'invalid_url'
    | 'host_not_allowlisted'
    | 'unknown_provider'
    | 'missing_api_key';
}

export type SimulationProviderKindV1 = 'generic_http' | 'alchemy_rpc';

export const GENERIC_SIMULATION_PROVIDER_ID_V1 = 'generic-sim-v1';
/** Duplicated from providers/alchemy.ts to keep this module dependency-free in
 * that direction (the registry imports both). Covered by a test that asserts
 * the two constants stay identical. */
const ALCHEMY_PROVIDER_ID = 'alchemy-eth-simulate-v1';

const DEFAULT_SIMULATION_PROVIDER_ID = GENERIC_SIMULATION_PROVIDER_ID_V1;

/**
 * Resolves the simulation provider strictly from env — no per-request
 * override, no discovery, no fallback between providers. The configured
 * MIORAIL_SIMULATION_PROVIDER_ID selects exactly one adapter:
 *
 *   generic-sim-v1          → URL + host allowlist (T59, unchanged)
 *   alchemy-eth-simulate-v1 → ALCHEMY_BASE_API_KEY, endpoint built server-side
 *
 * Anything else is an unknown provider and fails CLOSED — the caller responds
 * 503 simulation_provider_unavailable rather than quietly using a default.
 */
export function resolveSimulationProviderConfigV1(
  env: NodeJS.ProcessEnv = process.env,
): SimulationProviderConfigV1 {
  const providerId = env.MIORAIL_SIMULATION_PROVIDER_ID?.trim() || DEFAULT_SIMULATION_PROVIDER_ID;

  if (providerId === ALCHEMY_PROVIDER_ID) {
    const apiKey = env.ALCHEMY_BASE_API_KEY?.trim();
    if (!apiKey) {
      return { configured: false, providerId, allowlist: [], kind: 'alchemy_rpc', missingReason: 'missing_api_key' };
    }
    // No url: the endpoint embeds the key and is built inside the adapter.
    return { configured: true, providerId, allowlist: [], kind: 'alchemy_rpc' };
  }

  if (providerId !== GENERIC_SIMULATION_PROVIDER_ID_V1) {
    return { configured: false, providerId, allowlist: [], missingReason: 'unknown_provider' };
  }

  const rawUrl = env.MIORAIL_SIMULATION_PROVIDER_URL?.trim();
  const allowlist = (env.MIORAIL_SIMULATION_PROVIDER_ALLOWLIST ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);

  if (!rawUrl || allowlist.length === 0) {
    return { configured: false, providerId, allowlist, kind: 'generic_http', missingReason: 'not_configured' };
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { configured: false, providerId, allowlist, kind: 'generic_http', missingReason: 'invalid_url' };
  }

  // Rework N3: https only — signed EIP-712 payments must never fund a
  // simulation whose request/response ride plaintext HTTP (fail closed,
  // not silently downgraded).
  if (parsed.protocol !== 'https:') {
    return { configured: false, providerId, allowlist, kind: 'generic_http', missingReason: 'invalid_url' };
  }

  const host = parsed.host.toLowerCase();
  if (!allowlist.includes(host)) {
    return { configured: false, providerId, allowlist, kind: 'generic_http', missingReason: 'host_not_allowlisted' };
  }

  return { configured: true, url: rawUrl, providerId, allowlist, kind: 'generic_http' };
}
