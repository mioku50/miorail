import {
  ZERO_HASH_V1,
  hashEvidenceRecordV1,
  hashEvidenceSetV1,
  hashExecutionBlueprintV1,
  hashIntelligenceChargeV1,
  hashPathScoreDimensionV1,
  hashPathScoreV1,
  hashRouteCandidateV1,
  hashRouteCardV1,
  hashRouteIntentV1,
  hashRouteProofEventPayloadV1,
  hashRouteProofEventV1,
  hashRouteProofV1,
  EvidenceRecordV1Schema,
  EvidenceSetV1Schema,
  ExecutionBlueprintV1Schema,
  IntelligenceChargeV1Schema,
  PathScoreDimensionV1Schema,
  PathScoreV1Schema,
  RouteCandidateV1Schema,
  RouteCardV1Schema,
  RouteIntentV1Schema,
  RouteProofEventV1Schema,
  RouteProofV1Schema,
  type EvidenceRecordV1,
  type EvidenceSetV1,
  type ExecutionBlueprintV1,
  type IntelligenceChargeV1,
  type PathScoreDimensionV1,
  type PathScoreV1,
  type RouteCandidateV1,
  type RouteCardV1,
  type RouteIntentV1,
  type RouteProofEventV1,
  type RouteProofV1,
} from '@mioagent/route-domain';
import {
  completeEvidenceSetFixture,
  completedRouteProofFixture,
  missingSafetyEvidenceSetFixture,
  partialFailureRouteProofFixture,
  pathScoreWithNotScoredFixture,
  routeProofEventHistoryFixture,
  settledIntelligenceChargeFixture,
  staleEvidenceFixture,
  validBlueprintFixture,
  validKyberSwapCandidateFixture,
  validRouteCardFixture,
  validSwapIntentFixture,
  validUniswapCandidateFixture,
} from '@mioagent/route-domain/fixtures';

export interface RouteStorageFixtureGraph {
  intent: RouteIntentV1;
  uniswapCandidate: RouteCandidateV1;
  kyberSwapCandidate: RouteCandidateV1;
  staleEvidence: EvidenceRecordV1;
  completeEvidenceSet: EvidenceSetV1;
  missingSafetyEvidenceSet: EvidenceSetV1;
  pathScore: PathScoreV1;
  routeCard: RouteCardV1;
  blueprint: ExecutionBlueprintV1;
  completedProof: RouteProofV1;
  partialFailureProof: RouteProofV1;
  proofEvents: RouteProofEventV1[];
  intelligenceCharge: IntelligenceChargeV1;
  chargeEvidence: EvidenceRecordV1;
}

function id(prefix: string, original: string): string {
  return `${prefix}:${original}`;
}

export function createRouteStorageFixtureGraph(
  tenantId = validSwapIntentFixture.tenantId,
  prefix = 't51',
  walletAddress = validSwapIntentFixture.walletAddress,
): RouteStorageFixtureGraph {
  const intentDraft: RouteIntentV1 = {
    ...validSwapIntentFixture,
    id: id(prefix, validSwapIntentFixture.id),
    tenantId,
    walletAddress,
    intentHash: ZERO_HASH_V1,
  };
  const intent = RouteIntentV1Schema.parse({
    ...intentDraft,
    intentHash: hashRouteIntentV1(intentDraft),
  });

  const candidate = (template: RouteCandidateV1): RouteCandidateV1 => {
    const draft: RouteCandidateV1 = {
      ...template,
      id: id(prefix, template.id),
      tenantId,
      walletAddress,
      intentHash: intent.intentHash,
      candidateHash: ZERO_HASH_V1,
    };
    return RouteCandidateV1Schema.parse({
      ...draft,
      candidateHash: hashRouteCandidateV1(draft),
    });
  };
  const uniswapCandidate = candidate(validUniswapCandidateFixture);
  const kyberSwapCandidate = candidate(validKyberSwapCandidateFixture);

  const evidenceByOriginalId = new Map<string, EvidenceRecordV1>();
  const evidence = (template: EvidenceRecordV1): EvidenceRecordV1 => {
    const candidateHash =
      template.candidateHash === validKyberSwapCandidateFixture.candidateHash
        ? kyberSwapCandidate.candidateHash
        : uniswapCandidate.candidateHash;
    const draft: EvidenceRecordV1 = {
      ...template,
      id: id(prefix, template.id),
      tenantId,
      walletAddress,
      intentHash: intent.intentHash,
      candidateHash,
      evidenceHash: ZERO_HASH_V1,
    };
    const parsed = EvidenceRecordV1Schema.parse({
      ...draft,
      evidenceHash: hashEvidenceRecordV1(draft),
    });
    evidenceByOriginalId.set(template.id, parsed);
    return parsed;
  };

  const completeRecords = completeEvidenceSetFixture.records.map(evidence);
  const staleEvidence = evidence(staleEvidenceFixture);

  const evidenceSet = (template: EvidenceSetV1, records: EvidenceRecordV1[]): EvidenceSetV1 => {
    const draft: EvidenceSetV1 = {
      ...template,
      id: id(prefix, template.id),
      tenantId,
      walletAddress,
      intentHash: intent.intentHash,
      candidateHash: uniswapCandidate.candidateHash,
      evidenceSetHash: ZERO_HASH_V1,
      records: [...records].sort((left, right) =>
        left.evidenceHash.localeCompare(right.evidenceHash),
      ),
    };
    return EvidenceSetV1Schema.parse({
      ...draft,
      evidenceSetHash: hashEvidenceSetV1(draft),
    });
  };
  const completeEvidenceSet = evidenceSet(completeEvidenceSetFixture, completeRecords);
  const missingSafetyRecords = missingSafetyEvidenceSetFixture.records.map((record) => {
    const stored = evidenceByOriginalId.get(record.id);
    if (!stored) throw new Error(`Missing retargeted evidence fixture ${record.id}`);
    return stored;
  });
  const missingSafetyEvidenceSet = evidenceSet(
    missingSafetyEvidenceSetFixture,
    missingSafetyRecords,
  );

  const dimensions = pathScoreWithNotScoredFixture.dimensions.map((template) => {
    const draft: PathScoreDimensionV1 = {
      ...template,
      id: id(prefix, template.id),
      tenantId,
      walletAddress,
      intentHash: intent.intentHash,
      candidateHash: uniswapCandidate.candidateHash,
      evidenceSetHash: missingSafetyEvidenceSet.evidenceSetHash,
      dimensionHash: ZERO_HASH_V1,
      sources: [],
    };
    return PathScoreDimensionV1Schema.parse({
      ...draft,
      dimensionHash: hashPathScoreDimensionV1(draft),
    });
  });
  const pathScoreDraft: PathScoreV1 = {
    ...pathScoreWithNotScoredFixture,
    id: id(prefix, pathScoreWithNotScoredFixture.id),
    tenantId,
    walletAddress,
    intentHash: intent.intentHash,
    candidateHash: uniswapCandidate.candidateHash,
    evidenceSetHash: missingSafetyEvidenceSet.evidenceSetHash,
    pathScoreHash: ZERO_HASH_V1,
    dimensions,
  };
  const pathScore = PathScoreV1Schema.parse({
    ...pathScoreDraft,
    pathScoreHash: hashPathScoreV1(pathScoreDraft),
  });

  const routeCardDraft: RouteCardV1 = {
    ...validRouteCardFixture,
    id: id(prefix, validRouteCardFixture.id),
    tenantId,
    walletAddress,
    intentHash: intent.intentHash,
    selectedCandidateHash: uniswapCandidate.candidateHash,
    evidenceSetHash: missingSafetyEvidenceSet.evidenceSetHash,
    pathScoreHash: pathScore.pathScoreHash,
    routeCardHash: ZERO_HASH_V1,
    recommendedCandidate: uniswapCandidate,
    alternativeCandidates: [kyberSwapCandidate],
    pathScore,
  };
  const routeCard = RouteCardV1Schema.parse({
    ...routeCardDraft,
    routeCardHash: hashRouteCardV1(routeCardDraft),
  });

  const blueprintDraft: ExecutionBlueprintV1 = {
    ...validBlueprintFixture,
    id: id(prefix, validBlueprintFixture.id),
    tenantId,
    walletAddress,
    intentHash: intent.intentHash,
    selectedCandidateHash: uniswapCandidate.candidateHash,
    evidenceSetHash: completeEvidenceSet.evidenceSetHash,
    blueprintHash: ZERO_HASH_V1,
  };
  const blueprint = ExecutionBlueprintV1Schema.parse({
    ...blueprintDraft,
    blueprintHash: hashExecutionBlueprintV1(blueprintDraft),
  });

  const proof = (template: RouteProofV1): RouteProofV1 => {
    const draft: RouteProofV1 = {
      ...template,
      id: id(prefix, template.id),
      tenantId,
      walletAddress,
      intentHash: intent.intentHash,
      selectedCandidateHash: uniswapCandidate.candidateHash,
      evidenceSetHash: completeEvidenceSet.evidenceSetHash,
      blueprintHash: blueprint.blueprintHash,
      proofHash: ZERO_HASH_V1,
    };
    return RouteProofV1Schema.parse({
      ...draft,
      proofHash: hashRouteProofV1(draft),
    });
  };
  const completedProof = proof(completedRouteProofFixture);
  const partialFailureProof = proof(partialFailureRouteProofFixture);

  const firstPayload = { blueprintHash: blueprint.blueprintHash };
  const firstEventDraft: RouteProofEventV1 = {
    ...routeProofEventHistoryFixture[0],
    id: id(prefix, routeProofEventHistoryFixture[0].id),
    tenantId,
    walletAddress,
    intentHash: intent.intentHash,
    candidateHash: uniswapCandidate.candidateHash,
    evidenceSetHash: completeEvidenceSet.evidenceSetHash,
    blueprintHash: blueprint.blueprintHash,
    approvedCallsHash: completedProof.approvedCallsHash,
    routeProofId: completedProof.id,
    payload: firstPayload,
    payloadHash: hashRouteProofEventPayloadV1(firstPayload),
    eventHash: ZERO_HASH_V1,
  };
  const firstEvent = RouteProofEventV1Schema.parse({
    ...firstEventDraft,
    eventHash: hashRouteProofEventV1(firstEventDraft),
  });
  const secondPayload = {
    proofHash: completedProof.proofHash,
    transactionHash: completedProof.transactionHashes[0]!,
  };
  const secondEventDraft: RouteProofEventV1 = {
    ...routeProofEventHistoryFixture[1],
    id: id(prefix, routeProofEventHistoryFixture[1].id),
    tenantId,
    walletAddress,
    intentHash: intent.intentHash,
    candidateHash: uniswapCandidate.candidateHash,
    evidenceSetHash: completeEvidenceSet.evidenceSetHash,
    blueprintHash: blueprint.blueprintHash,
    approvedCallsHash: completedProof.approvedCallsHash,
    routeProofId: completedProof.id,
    previousEventHash: firstEvent.eventHash,
    payload: secondPayload,
    payloadHash: hashRouteProofEventPayloadV1(secondPayload),
    eventHash: ZERO_HASH_V1,
  };
  const secondEvent = RouteProofEventV1Schema.parse({
    ...secondEventDraft,
    eventHash: hashRouteProofEventV1(secondEventDraft),
  });

  const chargeEvidence = completeEvidenceSet.records.find(
    (record) => record.evidenceType === 'contract_risk',
  );
  if (!chargeEvidence) throw new Error('Contract-risk evidence fixture is required');
  const chargeDraft: IntelligenceChargeV1 = {
    ...settledIntelligenceChargeFixture,
    id: id(prefix, settledIntelligenceChargeFixture.id),
    tenantId,
    walletAddress,
    intentHash: intent.intentHash,
    candidateHash: uniswapCandidate.candidateHash,
    evidenceSetHash: completeEvidenceSet.evidenceSetHash,
    evidenceHash: chargeEvidence.evidenceHash,
    chargeHash: ZERO_HASH_V1,
    spendPermissionId: id(prefix, 'spend-permission'),
    intelligenceBudgetId: id(prefix, 'intelligence-budget-placeholder'),
    reservationId: id(prefix, 'reservation-placeholder'),
    idempotencyKey: id(prefix, 'charge-idempotency'),
  };
  const intelligenceCharge = IntelligenceChargeV1Schema.parse({
    ...chargeDraft,
    chargeHash: hashIntelligenceChargeV1(chargeDraft),
  });

  return {
    intent,
    uniswapCandidate,
    kyberSwapCandidate,
    staleEvidence,
    completeEvidenceSet,
    missingSafetyEvidenceSet,
    pathScore,
    routeCard,
    blueprint,
    completedProof,
    partialFailureProof,
    proofEvents: [firstEvent, secondEvent],
    intelligenceCharge,
    chargeEvidence,
  };
}
