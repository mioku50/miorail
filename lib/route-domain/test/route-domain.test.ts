import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canonicalJsonV1,
  findLiquidityOverlapsV1,
  hashExecutionBlueprintV1,
  hashPathScoreDimensionV1,
  hashRouteIntentV1,
  stableHashV1,
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
  type RouteIntentV1,
} from '../src/index.js';
import {
  completeEvidenceSetFixture,
  completedRouteProofFixture,
  kyberSwapLiquidityEvidenceFixture,
  missingSafetyEvidenceSetFixture,
  notScoredSafetyDimensionFixture,
  overlappingLiquidityProvenanceFixture,
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
} from './fixtures.js';

const PINNED_HASHES_V1 = {
  intent: '0x0e0f1003808e783d04d4d03450e82a73703fd0446ff55ec05e8a0c30ff253b2c',
  uniswapCandidate: '0x442aa727f9856623d6a396040d24aac88ab79cca0a21eb4e5f2a12728727f0b5',
  kyberSwapCandidate: '0xd17079c237e5731b268b47aaea1a09a5e1e313f78fb0276ed5afdc70a204b90a',
  staleEvidence: '0x02681fc701a81c9867b34e98a7c9502829e1d09dde2255867213f138dfc16c85',
  missingSafetyEvidenceSet: '0x412b8c4eba83883fc8768275e993e57ea6c0341c1f4039bbc77cc8e06a03bc05',
  completeEvidenceSet: '0xca236fa208a2a83dcac3bf390d707e100bf8851287241f84497796e3e3906bbe',
  notScoredSafety: '0xdb6d10df1276447c760ec192150fa6d1743ace6ad0c1a2c4aa0f690eee107819',
  pathScore: '0x1f8445ad1bdac189cda895b08c024cecddcd852dae21e2c1fe51cecad7e34ba6',
  routeCard: '0x13034369b4c91d345f198f2a1edc87cf4c268c5c12b8d3f2861b97b43b17ccc0',
  blueprint: '0x98627bb60d35ce16a7332d64901184b40b5087dcdc1455465c878afe96208d3f',
  approvedCalls: '0x47062abffe854ca7357cdba7452a4128a4b27ea73333a128a1a9e1907dcdb1f7',
  completedProof: '0xebaac4f6dfad5e5f59cac29cb67889db3a170862861898f5ef34c60daf9bad10',
  partialFailureProof: '0x77ae82bcf12779443d5b2de9d6fe00bb5918a340030f487eadb9ff5391f31d14',
  firstProofEvent: '0x4600f2dd02888218c19cef04eeecd5ce425e1fe53eba6e6045b77e0ba4068228',
  secondProofEvent: '0xc4aa742bad2256293806ad6db14438772522db287b9155561f1733a0becea65d',
  intelligenceCharge: '0x7b252d66a60644ccff84c411bea8d1fa82ef16a241ce0158a9149bb8417f7fc6',
} as const;

const FINANCIAL_FIELDS = [
  'schemaVersion',
  'id',
  'tenantId',
  'walletAddress',
  'chainId',
  'createdAt',
  'updatedAt',
  'status',
] as const;

test('all required T50 fixtures parse as their versioned contracts', () => {
  const cases = [
    [RouteIntentV1Schema, validSwapIntentFixture],
    [RouteCandidateV1Schema, validUniswapCandidateFixture],
    [RouteCandidateV1Schema, validKyberSwapCandidateFixture],
    [EvidenceRecordV1Schema, staleEvidenceFixture],
    [EvidenceSetV1Schema, missingSafetyEvidenceSetFixture],
    [EvidenceSetV1Schema, completeEvidenceSetFixture],
    [PathScoreDimensionV1Schema, notScoredSafetyDimensionFixture],
    [PathScoreV1Schema, pathScoreWithNotScoredFixture],
    [RouteCardV1Schema, validRouteCardFixture],
    [ExecutionBlueprintV1Schema, validBlueprintFixture],
    [RouteProofV1Schema, completedRouteProofFixture],
    [RouteProofV1Schema, partialFailureRouteProofFixture],
    [RouteProofEventV1Schema, routeProofEventHistoryFixture[0]],
    [RouteProofEventV1Schema, routeProofEventHistoryFixture[1]],
    [IntelligenceChargeV1Schema, settledIntelligenceChargeFixture],
  ] as const;

  for (const [schema, fixture] of cases) {
    const first = schema.parse(fixture);
    const reversedTopLevel = Object.fromEntries(Object.entries(fixture).reverse());
    const second = schema.parse(reversedTopLevel);
    assert.deepEqual(first, second);
    assert.equal(JSON.stringify(first), JSON.stringify(second));
    for (const field of FINANCIAL_FIELDS) assert.ok(field in first, `${field} is required`);
  }
});

test('fixture hashes are pinned and stable across environments', () => {
  assert.deepEqual(
    {
      intent: validSwapIntentFixture.intentHash,
      uniswapCandidate: validUniswapCandidateFixture.candidateHash,
      kyberSwapCandidate: validKyberSwapCandidateFixture.candidateHash,
      staleEvidence: staleEvidenceFixture.evidenceHash,
      missingSafetyEvidenceSet: missingSafetyEvidenceSetFixture.evidenceSetHash,
      completeEvidenceSet: completeEvidenceSetFixture.evidenceSetHash,
      notScoredSafety: notScoredSafetyDimensionFixture.dimensionHash,
      pathScore: pathScoreWithNotScoredFixture.pathScoreHash,
      routeCard: validRouteCardFixture.routeCardHash,
      blueprint: validBlueprintFixture.blueprintHash,
      approvedCalls: validBlueprintFixture.callsHash,
      completedProof: completedRouteProofFixture.proofHash,
      partialFailureProof: partialFailureRouteProofFixture.proofHash,
      firstProofEvent: routeProofEventHistoryFixture[0].eventHash,
      secondProofEvent: routeProofEventHistoryFixture[1].eventHash,
      intelligenceCharge: settledIntelligenceChargeFixture.chargeHash,
    },
    PINNED_HASHES_V1,
  );
  assert.equal(
    stableHashV1('fixture-json-serialization/v1', JSON.stringify(validSwapIntentFixture)),
    '0x4420df978d28b3b23cb485a519fee2c34fd48562379f47b26a61c0c7e2d9b512',
  );
});

test('canonical JSON sorts object keys, preserves arrays, and domain-separates hashes', () => {
  const left = { b: 2, a: 1, nested: { z: true, a: null }, array: ['b', 'a'] };
  const right = { array: ['b', 'a'], nested: { a: null, z: true }, a: 1, b: 2 };

  assert.equal(canonicalJsonV1(left), canonicalJsonV1(right));
  assert.equal(
    canonicalJsonV1({ b: 2, a: 1, nested: { z: true, a: null } }),
    '{"a":1,"b":2,"nested":{"a":null,"z":true}}',
  );
  assert.equal(stableHashV1('test-object/v1', left), stableHashV1('test-object/v1', right));
  assert.notEqual(stableHashV1('test-object/v1', left), stableHashV1('other-object/v1', left));
  assert.throws(() => canonicalJsonV1([undefined]), /undefined array values/);
});

test('financial hashes exclude lifecycle metadata but include tenant ownership', () => {
  const lifecycleOnly: RouteIntentV1 = {
    ...validSwapIntentFixture,
    id: 'another-storage-id',
    status: 'draft',
    createdAt: '2026-07-15T10:00:00.000Z',
    updatedAt: '2026-07-15T10:01:00.000Z',
  };
  assert.equal(hashRouteIntentV1(lifecycleOnly), validSwapIntentFixture.intentHash);

  const anotherTenant: RouteIntentV1 = {
    ...validSwapIntentFixture,
    tenantId: 'another-tenant',
  };
  assert.notEqual(hashRouteIntentV1(anotherTenant), validSwapIntentFixture.intentHash);
});

test('validation issues are deterministic and pinned', () => {
  const invalid = { ...validSwapIntentFixture, executionRequested: 'yes' };
  const parseIssues = () => {
    const result = RouteIntentV1Schema.safeParse(invalid);
    assert.equal(result.success, false);
    return result.error.issues;
  };

  const first = parseIssues();
  const second = parseIssues();
  assert.deepEqual(first, second);
  assert.deepEqual(first, [
    {
      code: 'invalid_type',
      expected: 'boolean',
      received: 'string',
      path: ['executionRequested'],
      message: 'Expected boolean, received string',
    },
  ]);
});

test('Uniswap and KyberSwap provenance exposes their shared liquidity source', () => {
  const overlaps = findLiquidityOverlapsV1(overlappingLiquidityProvenanceFixture);
  assert.deepEqual(overlaps, [
    {
      sourceKey: 'eip155:8453/uniswap-v3:0x2222222222222222222222222222222222222222',
      evidenceIds: ['evidence-kyberswap-liquidity', 'evidence-uniswap-liquidity'],
      providerIds: ['kyberswap', 'uniswap'],
    },
  ]);
  assert.equal(
    kyberSwapLiquidityEvidenceFixture.liquiditySources[0]?.upstreamProvider,
    'uniswap-v3',
  );
});

test('stale and missing-safety evidence remain explicit domain states', () => {
  assert.equal(staleEvidenceFixture.validationStatus, 'stale');
  assert.equal(staleEvidenceFixture.status, 'expired');
  assert.deepEqual(missingSafetyEvidenceSetFixture.missingEvidence, [
    'contract_risk',
    'simulation',
  ]);
  assert.equal(missingSafetyEvidenceSetFixture.status, 'partial');
  assert.deepEqual(completeEvidenceSetFixture.missingEvidence, []);
});

test('Not scored cannot contain invented score, confidence, freshness, or sources', () => {
  assert.equal(notScoredSafetyDimensionFixture.score, null);
  assert.equal(notScoredSafetyDimensionFixture.confidence, null);
  assert.equal(notScoredSafetyDimensionFixture.freshness, null);
  assert.deepEqual(notScoredSafetyDimensionFixture.sources, []);
  assert.equal(notScoredSafetyDimensionFixture.notScoredReason, 'insufficient_evidence');
  assert.ok(
    pathScoreWithNotScoredFixture.dimensions.every((dimension) => dimension.score === null),
  );
  assert.equal(pathScoreWithNotScoredFixture.status, 'not_scored');

  const tampered = {
    ...notScoredSafetyDimensionFixture,
    score: 50,
  };
  const withMatchingHash = {
    ...tampered,
    dimensionHash: hashPathScoreDimensionV1(tampered),
  };
  const result = PathScoreDimensionV1Schema.safeParse(withMatchingHash);
  assert.equal(result.success, false);
  assert.ok(result.error.issues.some((issue) => issue.path.join('.') === 'score'));
});

test('Blueprint binds mock calls and fails closed after call tampering', () => {
  assert.equal(validBlueprintFixture.approvedCallsHash, null);
  assert.equal(validBlueprintFixture.simulationState.status, 'passed');
  assert.equal(validBlueprintFixture.requiredApprovals.length, 0);

  const tamperedCalls = validBlueprintFixture.calls.map((call, index) =>
    index === 1 ? { ...call, data: '0xdeadbeef' as `0x${string}` } : call,
  );
  const tampered = { ...validBlueprintFixture, calls: tamperedCalls };
  const result = ExecutionBlueprintV1Schema.safeParse({
    ...tampered,
    blueprintHash: hashExecutionBlueprintV1(tampered),
  });
  assert.equal(result.success, false);
  assert.ok(result.error.issues.some((issue) => issue.path.join('.') === 'callsHash'));
});

test('Route Proof captures completed and EIP-5792-style partial-failure outcomes', () => {
  assert.equal(completedRouteProofFixture.finalStatus, 'completed');
  assert.ok(completedRouteProofFixture.receipts.every((receipt) => receipt.status === 'success'));
  assert.equal(partialFailureRouteProofFixture.finalStatus, 'partial_failure');
  assert.ok(
    partialFailureRouteProofFixture.receipts.some((receipt) => receipt.status === 'success'),
  );
  assert.ok(
    partialFailureRouteProofFixture.receipts.some((receipt) => receipt.status === 'reverted'),
  );
  assert.equal(completedRouteProofFixture.approvedCallsHash, validBlueprintFixture.callsHash);
});

test('Route Proof events form a deterministic append-only hash chain', () => {
  const [first, second] = routeProofEventHistoryFixture;
  assert.equal(first.eventIndex, 0);
  assert.equal(first.previousEventHash, null);
  assert.equal(second.eventIndex, 1);
  assert.equal(second.previousEventHash, first.eventHash);

  const broken = { ...second, previousEventHash: null };
  const result = RouteProofEventV1Schema.safeParse(broken);
  assert.equal(result.success, false);
  assert.ok(result.error.issues.some((issue) => issue.path.join('.') === 'previousEventHash'));
});

test('Intelligence Charge keeps provider cost, budget, and Spend Permission references explicit', () => {
  assert.equal(settledIntelligenceChargeFixture.status, 'settled');
  assert.equal(settledIntelligenceChargeFixture.fundingMode, 'spend_permission');
  assert.ok(settledIntelligenceChargeFixture.spendPermissionId);
  assert.ok(settledIntelligenceChargeFixture.intelligenceBudgetId);
  assert.ok(settledIntelligenceChargeFixture.reservationId);
  assert.equal(settledIntelligenceChargeFixture.paymentState, 'settled');
  assert.equal(settledIntelligenceChargeFixture.serviceState, 'delivered');
});
