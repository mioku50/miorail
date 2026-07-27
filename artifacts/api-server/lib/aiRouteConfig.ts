import {
  VENICE_CATALOGUE_TTL_MS_DEFAULT_V1,
  VENICE_TIMEOUT_MS_DEFAULT_V1,
  parseVeniceModelAllowlistV1,
} from '@mioagent/ai-engine';

// ---------------------------------------------------------------------------
// T66 — the Private AI family's deployment configuration.
//
// The Venice key is read HERE and nowhere else, from the server environment
// only. Nothing in this codebase creates a key, prompts for one, or accepts
// one from a client: production uses the server-side VENICE_API_KEY or the
// family stays off.
//
// There is deliberately no base-URL setting. A configurable provider host is
// how a private prompt ends up somewhere other than where the review screen
// said it was going, so the host lives in lib/ai-engine as a constant.
// ---------------------------------------------------------------------------

export interface AiRouteConfigV1 {
  veniceApiKey: string;
  /** False when no key is configured. Every route checks this before it
   * pretends to have a provider. */
  configured: boolean;
  /** Models this deployment permits. EMPTY MEANS NONE — the family fails
   * closed, because "send the prompt to whatever Venice lists today" is not a
   * defensible default for private inference. */
  modelAllowlist: string[];
  timeoutMs: number;
  catalogueTtlMs: number;
  cardTtlMs: number;
  /** The provider's published retention claim, configured by the OPERATOR
   * rather than read from a Venice response. A provider asserting its own
   * privacy policy inside the data it returns is marketing, not evidence. */
  retentionClaim: string | null;
  /** Whether inference is billed through x402 rather than the server key. */
  x402Metered: boolean;
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt((value ?? '').trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function resolveAiRouteConfigV1(env: NodeJS.ProcessEnv = process.env): AiRouteConfigV1 {
  const veniceApiKey = env.VENICE_API_KEY?.trim() ?? '';
  const retentionClaim = env.MIORAIL_VENICE_RETENTION_CLAIM?.trim();
  return {
    veniceApiKey,
    configured: veniceApiKey.length > 0,
    modelAllowlist: parseVeniceModelAllowlistV1(env.MIORAIL_VENICE_MODEL_ALLOWLIST),
    timeoutMs: positiveInt(env.MIORAIL_VENICE_TIMEOUT_MS, VENICE_TIMEOUT_MS_DEFAULT_V1),
    catalogueTtlMs: positiveInt(env.MIORAIL_VENICE_CATALOGUE_TTL_MS, VENICE_CATALOGUE_TTL_MS_DEFAULT_V1),
    cardTtlMs: positiveInt(env.MIORAIL_AI_CARD_TTL_MS, 120_000),
    // Absent means the card says "not stated" and degrades — never that
    // nothing is retained.
    retentionClaim: retentionClaim && retentionClaim.length > 0 ? retentionClaim.slice(0, 400) : null,
    x402Metered: env.MIORAIL_PRIVATE_AI_X402_V1?.trim().toLowerCase() === 'true',
  };
}
