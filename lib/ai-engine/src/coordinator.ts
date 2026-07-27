import type {
  AiEvidenceV1,
  AiRouteCandidateV1,
  AiRouteCardV1,
  AiRouteIntentV1,
  AiScoreDimensionV1,
} from '@mioagent/route-domain';
import { buildAiCandidatesV1, buildAiEvidenceV1 } from './candidates.js';
import { buildAiRouteCardV1 } from './routeCard.js';
import { VENICE_CATALOGUE_TTL_MS_DEFAULT_V1 } from './pinned-config.js';
import type { VeniceGatewayReasonV1, VeniceGatewayV1 } from './venice-gateway.js';

// ---------------------------------------------------------------------------
// T66B — the end-to-end AI comparison:
//   intent → model catalogue → candidates + evidence → scoring → AI Route Card.
//
// No I/O of its own; the gateway is injected, so unit tests never open a
// socket. THE PROMPT IS NOT AN ARGUMENT HERE. Comparison runs entirely on the
// intent's commitment and the provider's catalogue — a model is chosen before
// any text leaves the machine, and choosing it is not what sends it.
// ---------------------------------------------------------------------------

export type AiComparisonReasonV1 = VeniceGatewayReasonV1 | 'no_allowlisted_models';

export interface AiComparisonOkV1 {
  ok: true;
  card: AiRouteCardV1;
  selected: AiRouteCandidateV1;
  candidates: AiRouteCandidateV1[];
  evidence: AiEvidenceV1[];
  dimensions: AiScoreDimensionV1[];
}

export interface AiComparisonFailedV1 {
  ok: false;
  reason: AiComparisonReasonV1;
  /** Present whenever the catalogue could be read. A card with no model still
   * names what was considered and why none of it worked. */
  card: AiRouteCardV1 | null;
  candidates: AiRouteCandidateV1[];
  evidence: AiEvidenceV1[];
}

export type AiComparisonResultV1 = AiComparisonOkV1 | AiComparisonFailedV1;

export interface CompareAiRoutesInputV1 {
  runId: string;
  tenantId: string;
  walletAddress: `0x${string}`;
  chainId: 8453 | 84532;
  intent: AiRouteIntentV1;
  allowlist: readonly string[];
  /** The provider's published retention claim, from this deployment's own
   * configuration rather than from a response body — a provider asserting its
   * own privacy policy inside the data it returns is not evidence. */
  retentionClaim: string | null;
  x402Metered: boolean;
  now: Date;
  ttlMs?: number;
  catalogueTtlMs?: number;
}

const FAILURE_COPY_V1: Record<AiComparisonReasonV1, string> = {
  not_configured: 'No Venice key is configured on this server, so no model can be compared.',
  unauthorized: 'Miorail cannot reach Venice with the credentials it has.',
  not_found: 'Venice does not know that endpoint.',
  rate_limited: 'Venice is rate limiting Miorail. Try again shortly.',
  payment_required: 'The Venice account has no remaining balance for this request.',
  provider_unavailable: 'Venice did not answer.',
  provider_timeout: 'Venice did not answer in time.',
  provider_invalid_response: 'Venice returned a response Miorail could not read.',
  model_not_allowlisted: 'That model is not on this server’s allowlist.',
  model_offline: 'Venice reports that model as offline.',
  no_text_models: 'Venice returned no text models.',
  content_filtered: 'Venice declined to answer this request.',
  no_allowlisted_models:
    'None of the models on this server’s allowlist appear in the Venice catalogue. Check MIORAIL_VENICE_MODEL_ALLOWLIST.',
};

/** The one sentence a surface shows for a failed comparison. Fixed strings, so
 * a provider outage is never phrased as "no model can do this". */
export function aiComparisonCopyV1(reason: AiComparisonReasonV1): string {
  return FAILURE_COPY_V1[reason] ?? 'Miorail could not compare Venice models.';
}

export async function compareAiRoutesV1(
  deps: { gateway: VeniceGatewayV1 },
  input: CompareAiRoutesInputV1,
): Promise<AiComparisonResultV1> {
  // An empty allowlist stops the run BEFORE the catalogue call. The alternative
  // — read every model, then reject all of them — spends a request to reach a
  // conclusion the configuration already determined.
  if (input.allowlist.length === 0) {
    return { ok: false, reason: 'no_allowlisted_models', card: null, candidates: [], evidence: [] };
  }

  const catalogue = await deps.gateway.readTextModels({ now: input.now });
  if (!catalogue.ok) {
    return { ok: false, reason: catalogue.reason, card: null, candidates: [], evidence: [] };
  }

  const context = {
    runId: input.runId,
    tenantId: input.tenantId,
    walletAddress: input.walletAddress,
    chainId: input.chainId,
    intent: input.intent,
    allowlist: input.allowlist,
    now: input.now,
  };

  const candidates = buildAiCandidatesV1(context, catalogue.value);
  const evidence = buildAiEvidenceV1(context, catalogue.value, candidates, input.retentionClaim);

  const built = buildAiRouteCardV1({
    scoring: {
      ...context,
      evidence,
      catalogueObservedAt: catalogue.value.observedAt,
      catalogueTtlMs: input.catalogueTtlMs ?? VENICE_CATALOGUE_TTL_MS_DEFAULT_V1,
    },
    candidates,
    evidence,
    retentionClaim: input.retentionClaim,
    x402Metered: input.x402Metered,
    ttlMs: input.ttlMs ?? 120_000,
  });

  if (built.card.selected === null) {
    // Every model was refused. That is a real, explained answer, and the card
    // carries it — including the per-model reasons on the alternatives.
    return {
      ok: false,
      reason: 'no_allowlisted_models',
      card: built.card,
      candidates,
      evidence,
    };
  }

  return {
    ok: true,
    card: built.card,
    selected: built.card.selected,
    candidates,
    evidence,
    dimensions: built.dimensions,
  };
}
