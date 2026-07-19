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
export type SimulationProviderResultV1 =
  | { ok: true; body: unknown }
  | { ok: false; errorCode: 'timeout' | 'network_error' | 'http_error'; detail: string };

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
  url?: string;
  providerId: string;
  allowlist: string[];
  missingReason?: 'not_configured' | 'invalid_url' | 'host_not_allowlisted';
}

const DEFAULT_SIMULATION_PROVIDER_ID = 'generic-sim-v1';

/**
 * Resolves the simulation provider strictly from env — no per-request
 * override, no discovery. `url`'s host MUST appear in the (comma-separated)
 * allowlist. Empty/missing allowlist or URL means the feature is NOT
 * configured (fail closed: the caller must respond 503
 * simulation_provider_unavailable, never silently fall back to an
 * unlisted host).
 */
export function resolveSimulationProviderConfigV1(
  env: NodeJS.ProcessEnv = process.env,
): SimulationProviderConfigV1 {
  const providerId = env.MIORAIL_SIMULATION_PROVIDER_ID?.trim() || DEFAULT_SIMULATION_PROVIDER_ID;
  const rawUrl = env.MIORAIL_SIMULATION_PROVIDER_URL?.trim();
  const allowlist = (env.MIORAIL_SIMULATION_PROVIDER_ALLOWLIST ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);

  if (!rawUrl || allowlist.length === 0) {
    return { configured: false, providerId, allowlist, missingReason: 'not_configured' };
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { configured: false, providerId, allowlist, missingReason: 'invalid_url' };
  }

  // Rework N3: https only — signed EIP-712 payments must never fund a
  // simulation whose request/response ride plaintext HTTP (fail closed,
  // not silently downgraded).
  if (parsed.protocol !== 'https:') {
    return { configured: false, providerId, allowlist, missingReason: 'invalid_url' };
  }

  const host = parsed.host.toLowerCase();
  if (!allowlist.includes(host)) {
    return { configured: false, providerId, allowlist, missingReason: 'host_not_allowlisted' };
  }

  return { configured: true, url: rawUrl, providerId, allowlist };
}
