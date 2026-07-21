import {
  EarnCandidateV1Schema,
  EarnEvidenceV1Schema,
  hashEarnCandidateV1,
  hashEarnEvidenceV1,
  stableHashV1,
  type EarnCandidateV1,
  type EarnEvidenceV1,
  type EarnProtocolV1,
  type EarnRouteIntentV1,
  type EarnVenueRefV1,
  type HashV1,
} from '@mioagent/route-domain';
import { PINNED_BASE_USDC_V1, pinnedEarnVenueV1 } from './pinned-config.js';
import type { EarnDataSourceV1 } from './types.js';

const ZERO_HASH_V1 = `0x${'0'.repeat(64)}` as HashV1;

function deterministicId(prefix: string, parts: Record<string, unknown>): string {
  return `${prefix}:${stableHashV1(prefix, parts).slice(2, 26)}`;
}

export interface BuildEarnCandidateInputV1 {
  intent: EarnRouteIntentV1;
  protocol: EarnProtocolV1;
  now: Date;
}

export type EarnAdapterResultV1 =
  | { ok: true; candidate: EarnCandidateV1; evidence: EarnEvidenceV1 }
  | { ok: false; protocol: EarnProtocolV1; reason: string };

/**
 * Provider-neutral adapter: turns one pinned venue + one injected observation
 * into a validated EarnCandidateV1 + its EarnEvidenceV1. Never resolves a
 * market/vault dynamically (spec §3); the venue is always the pinned one for
 * the protocol. A `null` APY/liquidity datum is passed through untouched — the
 * engine turns that into a Not-scored dimension rather than an invented value.
 */
export async function buildEarnCandidateV1(
  deps: { dataSource: EarnDataSourceV1 },
  input: BuildEarnCandidateInputV1,
): Promise<EarnAdapterResultV1> {
  const venue = pinnedEarnVenueV1(input.protocol);
  const result = await deps.dataSource.observe({
    protocol: input.protocol,
    venue,
    amountAtomic: input.intent.amount.amountAtomic,
    now: input.now,
  });
  if (!result.ok) return { ok: false, protocol: input.protocol, reason: result.reason };
  const obs = result.observation;
  const nowIso = input.now.toISOString();

  const venueRef: EarnVenueRefV1 = {
    kind: venue.venueKind,
    protocol: venue.protocol,
    address: venue.target,
    identifier: venue.identifier,
  };
  const contracts = { asset: PINNED_BASE_USDC_V1, target: venue.target, approvalSpender: venue.approvalSpender };
  const provider = { id: obs.providerId, displayName: obs.providerDisplayName, kind: 'data_provider' as const, operator: 'miorail' };

  const candidateBase = {
    schemaVersion: 'earn-candidate/v1' as const,
    id: deterministicId('earn-candidate', { intentHash: input.intent.intentHash, protocol: input.protocol }),
    tenantId: input.intent.tenantId,
    walletAddress: input.intent.walletAddress,
    chainId: input.intent.chainId,
    createdAt: nowIso,
    updatedAt: nowIso,
    status: 'quoted' as const,
    intentHash: input.intent.intentHash,
    candidateHash: ZERO_HASH_V1,
    protocol: input.protocol,
    venue: venueRef,
    asset: input.intent.asset,
    amount: input.intent.amount,
    baseApyBps: obs.baseApyBps,
    rewardApyBps: obs.rewardApyBps,
    netApyBps: obs.netApyBps,
    availableLiquidityAtomic: obs.availableLiquidityAtomic,
    withdrawalModel: venue.withdrawalModel,
    estimatedGas: { gasUnits: venue.estimatedGasUnits, maxFeePerGasWei: null, estimatedCostNative: null, estimatedCostUsd: null },
    callCount: venue.callCount,
    approvalCount: venue.approvalCount,
    observedAt: obs.observedAt,
    expiresAt: obs.expiresAt,
    contracts,
    provider,
  };
  const candidate = EarnCandidateV1Schema.parse({
    ...candidateBase,
    candidateHash: hashEarnCandidateV1(candidateBase as unknown as EarnCandidateV1),
  });

  const evidenceBase = {
    schemaVersion: 'earn-evidence/v1' as const,
    id: deterministicId('earn-evidence', {
      intentHash: input.intent.intentHash,
      protocol: input.protocol,
      responseHash: obs.responseHash,
    }),
    tenantId: input.intent.tenantId,
    walletAddress: input.intent.walletAddress,
    chainId: input.intent.chainId,
    createdAt: nowIso,
    updatedAt: nowIso,
    status: 'fresh' as const,
    intentHash: input.intent.intentHash,
    candidateHash: candidate.candidateHash,
    evidenceHash: ZERO_HASH_V1,
    protocol: input.protocol,
    venue: venueRef,
    provider,
    baseApyBps: obs.baseApyBps,
    rewardApyBps: obs.rewardApyBps,
    netApyBps: obs.netApyBps,
    availableLiquidityAtomic: obs.availableLiquidityAtomic,
    fees: obs.fees,
    withdrawalTerms: obs.withdrawalTerms,
    contracts,
    blockNumber: obs.blockNumber,
    observedAt: obs.observedAt,
    expiresAt: obs.expiresAt,
    requestHash: obs.requestHash,
    responseHash: obs.responseHash,
    sourceIndependence: obs.sourceIndependence,
  };
  const evidence = EarnEvidenceV1Schema.parse({
    ...evidenceBase,
    evidenceHash: hashEarnEvidenceV1(evidenceBase as unknown as EarnEvidenceV1),
  });

  return { ok: true, candidate, evidence };
}
