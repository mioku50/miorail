import {
  GENERIC_SIMULATION_PROVIDER_ID_V1,
  createHttpSimulationProvider,
  resolveSimulationProviderConfigV1,
  type SimulationProvider,
  type SimulationProviderConfigV1,
} from './provider.js';
import {
  ALCHEMY_SIMULATION_PROVIDER_ID_V1,
  createAlchemySimulationProviderV1,
} from './providers/alchemy.js';

// ---------------------------------------------------------------------------
// T63B §7 — simulation provider registry.
//
// The set of providers is CLOSED and the choice comes from server config only.
// There is no discovery, no per-request selection, and — deliberately — no
// fallback from one provider to another: falling back after a settlement would
// mean the user paid for one service and silently received a different one.
// An unknown provider id resolves to nothing at all, so the route fails closed
// with 503 before any x402 challenge is ever issued.
// ---------------------------------------------------------------------------

export const SIMULATION_PROVIDER_IDS_V1 = [
  GENERIC_SIMULATION_PROVIDER_ID_V1,
  ALCHEMY_SIMULATION_PROVIDER_ID_V1,
] as const;

export type SimulationProviderIdV1 = (typeof SIMULATION_PROVIDER_IDS_V1)[number];

export function isKnownSimulationProviderIdV1(providerId: string): providerId is SimulationProviderIdV1 {
  return (SIMULATION_PROVIDER_IDS_V1 as readonly string[]).includes(providerId);
}

const DEFAULT_ALCHEMY_TIMEOUT_MS = 12_000;

function alchemyTimeoutMsV1(env: NodeJS.ProcessEnv): number {
  const raw = env.MIORAIL_ALCHEMY_SIMULATION_TIMEOUT_MS?.trim();
  if (!raw) return DEFAULT_ALCHEMY_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_ALCHEMY_TIMEOUT_MS;
  return Math.floor(parsed);
}

export interface CreateSimulationProviderDepsV1 {
  env?: NodeJS.ProcessEnv;
  /** Injected in tests so no unit test can reach a real endpoint. */
  fetchImpl?: typeof globalThis.fetch;
}

/**
 * Builds the configured provider, or null when the configuration is not usable.
 * The Alchemy branch reads ALCHEMY_BASE_API_KEY here and hands it straight to
 * the adapter: the key is never written into SimulationProviderConfigV1, so it
 * cannot reach a log line, a response body, or a provenance hash by accident.
 */
export function createSimulationProviderFromConfigV1(
  config: SimulationProviderConfigV1,
  deps: CreateSimulationProviderDepsV1 = {},
): SimulationProvider | null {
  if (!config.configured) return null;
  const env = deps.env ?? process.env;

  if (config.providerId === ALCHEMY_SIMULATION_PROVIDER_ID_V1) {
    return createAlchemySimulationProviderV1({
      apiKey: env.ALCHEMY_BASE_API_KEY,
      timeoutMs: alchemyTimeoutMsV1(env),
      fetchImpl: deps.fetchImpl,
    });
  }

  if (config.providerId === GENERIC_SIMULATION_PROVIDER_ID_V1) {
    if (!config.url) return null;
    return createHttpSimulationProvider({
      url: config.url,
      providerId: config.providerId,
      fetchImpl: deps.fetchImpl,
    });
  }

  // Unknown id — fail closed. Reached only if a caller hand-builds a config.
  return null;
}

/** Convenience for callers that have not resolved the config yet. */
export function createSimulationProviderFromEnvV1(
  deps: CreateSimulationProviderDepsV1 = {},
): SimulationProvider | null {
  const env = deps.env ?? process.env;
  return createSimulationProviderFromConfigV1(resolveSimulationProviderConfigV1(env), { ...deps, env });
}
