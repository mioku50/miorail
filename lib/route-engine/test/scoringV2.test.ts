import assert from 'node:assert/strict';
import { test, describe } from 'node:test';

import {
  ProviderReliabilityAssessmentV1Schema,
  ProviderReliabilitySnapshotV1Schema,
  hashProviderReliabilitySnapshotV1,
  type ProviderReliabilityAssessmentV1,
  type ProviderReliabilitySnapshotV1,
} from '@mioagent/route-outcomes';

import { calibrateMetricV1, rankingNetOutputAtomicV1 } from '../src/scoring.js';
import { SWAP_PATH_SCORE_VERSION_V1, SWAP_PATH_SCORE_VERSION_V2 } from '../src/policy.js';
import type { NetResultMetricV1 } from '../src/contracts.js';

// T67C.1 Part 2 §3/§4 — what calibration does to a metric, and what ranking
// then compares. The snapshot arithmetic itself is pinned in
// @mioagent/route-outcomes; this is about the engine's use of it.

const CUTOFF = '2026-07-27T12:00:00.000Z';

function snapshot(overrides: Partial<ProviderReliabilitySnapshotV1> = {}): ProviderReliabilitySnapshotV1 {
  const draft = {
    schemaVersion: 'provider-reliability-snapshot/v1' as const,
    id: 'provider-reliability-snapshot:test',
    status: 'sealed' as const,
    createdAt: CUTOFF,
    scope: 'personal' as const,
    tenantId: 'tenant-1',
    walletAddress: '0x1111111111111111111111111111111111111111',
    providerId: 'uniswap' as const,
    chainId: 8453 as const,
    fromAsset: 'eip155:8453/erc20:0xfrom',
    toAsset: 'eip155:8453/erc20:0xto',
    windowDays: 90,
    cutoffAt: CUTOFF,
    sampleSize: 12,
    uniqueWalletCount: 1,
    completedCount: 12,
    failedCount: 0,
    partialFailureCount: 0,
    successRateBps: 10_000,
    medianAdverseShortfallBps: 100,
    p90AdverseShortfallBps: 200,
    floorBreachRateBps: 0,
    medianGasErrorBps: null,
    p90ConfirmationMs: 5_000,
    outcomeSetHash: `0x${'a'.repeat(64)}` as `0x${string}`,
    snapshotHash: `0x${'0'.repeat(64)}` as `0x${string}`,
    aggregationVersion: 'provider-reliability/v1:w90:p10:n30:u3',
    ...overrides,
  };
  return ProviderReliabilitySnapshotV1Schema.parse({
    ...draft,
    snapshotHash: hashProviderReliabilitySnapshotV1(draft as ProviderReliabilitySnapshotV1),
  });
}

function eligible(overrides: Partial<ProviderReliabilitySnapshotV1> = {}): ProviderReliabilityAssessmentV1 {
  const value = snapshot(overrides);
  return ProviderReliabilityAssessmentV1Schema.parse({
    schemaVersion: 'provider-reliability-assessment/v1',
    providerId: value.providerId,
    fromAsset: value.fromAsset,
    toAsset: value.toAsset,
    status: 'eligible',
    scope: value.scope,
    snapshot: value,
    notScoredReason: null,
    observedSamples: value.sampleSize,
    requiredSamples: 10,
  });
}

function notScored(): ProviderReliabilityAssessmentV1 {
  return ProviderReliabilityAssessmentV1Schema.parse({
    schemaVersion: 'provider-reliability-assessment/v1',
    providerId: 'uniswap',
    fromAsset: 'eip155:8453/erc20:0xfrom',
    toAsset: 'eip155:8453/erc20:0xto',
    status: 'not_scored',
    scope: null,
    snapshot: null,
    notScoredReason: 'insufficient_history',
    observedSamples: 8,
    requiredSamples: 10,
  });
}

function metric(expected: string, cost: string): NetResultMetricV1 {
  return {
    candidateHash: `0x${'1'.repeat(64)}`,
    status: 'computed',
    valuation: 'output_usdc',
    expectedOutputAtomic: expected,
    gasCostUsdMicros: cost,
    intelligenceCostUsdMicros: '0',
    gasCostOutputAtomic: cost,
    intelligenceCostOutputAtomic: '0',
    netOutputAtomic: (BigInt(expected) - BigInt(cost)).toString(),
    reason: null,
  };
}

describe('calibration on a net-result metric', () => {
  test('an eligible snapshot discounts the expectation and names its source', () => {
    const calibrated = calibrateMetricV1(metric('1000000', '10000'), eligible());
    assert.equal(calibrated.calibrationApplied, true);
    assert.equal(calibrated.appliedShortfallBps, 100);
    assert.equal(calibrated.calibratedExpectedOutputAtomic, '990000');
    assert.equal(calibrated.historyAdjustedNetOutputAtomic, '980000');
    // The raw figure is untouched, so both travel to the card.
    assert.equal(calibrated.netOutputAtomic, '990000');
    assert.equal(calibrated.reliabilityScope, 'personal');
    assert.equal(calibrated.reliabilityCutoffAt, CUTOFF);
    assert.match(calibrated.reliabilitySnapshotHash!, /^0x[0-9a-f]{64}$/);
  });

  test('Not scored leaves the figures equal and applies nothing', () => {
    const calibrated = calibrateMetricV1(metric('1000000', '10000'), notScored());
    assert.equal(calibrated.calibrationApplied, false);
    assert.equal(calibrated.appliedShortfallBps, 0);
    assert.equal(calibrated.historyAdjustedNetOutputAtomic, calibrated.netOutputAtomic);
    assert.equal(calibrated.reliabilitySnapshotHash, null);
  });

  test('no assessment at all leaves the metric byte-identical to v1', () => {
    // This is what the feature being off looks like from in here: not a
    // calibration of zero, but no calibration fields at all.
    const raw = metric('1000000', '10000');
    assert.deepEqual(calibrateMetricV1(raw, undefined), raw);
    assert.equal(calibrateMetricV1(raw, undefined).calibrationApplied, undefined);
  });

  test('overdelivery in the history creates no calibration credit', () => {
    // A provider that has historically overdelivered has a median adverse
    // shortfall of zero, not a negative one — so the expectation equals the
    // quote and never exceeds it.
    const calibrated = calibrateMetricV1(
      metric('1000000', '0'),
      eligible({ medianAdverseShortfallBps: 0, p90AdverseShortfallBps: 0 }),
    );
    assert.equal(calibrated.calibratedExpectedOutputAtomic, '1000000');
    assert.equal(calibrated.historyAdjustedNetOutputAtomic, '1000000');
  });

  test('a confirmed revert moves the success rate, not the shortfall discount', () => {
    // Two snapshots identical except for their outcome mix. The discount is a
    // function of the median shortfall alone, so a revert cannot deepen it.
    const clean = calibrateMetricV1(metric('1000000', '0'), eligible());
    const withReverts = calibrateMetricV1(
      metric('1000000', '0'),
      eligible({ completedCount: 10, failedCount: 2, successRateBps: 8_333 }),
    );
    assert.equal(
      withReverts.calibratedExpectedOutputAtomic,
      clean.calibratedExpectedOutputAtomic,
    );
    assert.equal(withReverts.reliabilityScope, 'personal');
  });
});

describe('what best_net_result compares', () => {
  test('the adjusted figure when calibrated, the raw one otherwise', () => {
    const calibrated = calibrateMetricV1(metric('1000000', '0'), eligible({ medianAdverseShortfallBps: 1_000, p90AdverseShortfallBps: 1_000 }));
    assert.equal(rankingNetOutputAtomicV1(calibrated), 900_000n);

    const uncalibrated = calibrateMetricV1(metric('950000', '0'), notScored());
    assert.equal(rankingNetOutputAtomicV1(uncalibrated), 950_000n);

    // History changes the winner: the larger quote wins because the other
    // provider historically does not deliver what it says.
    assert.equal(rankingNetOutputAtomicV1(uncalibrated)! > rankingNetOutputAtomicV1(calibrated)!, true);
  });

  test('a v1 metric ranks on exactly the figure it always did', () => {
    const raw = metric('1000000', '10000');
    assert.equal(rankingNetOutputAtomicV1(raw), BigInt(raw.netOutputAtomic!));
  });
});

describe('the two policy versions are distinct strings', () => {
  test('v1 is frozen and v2 is a different policy, not a revision', () => {
    assert.equal(SWAP_PATH_SCORE_VERSION_V1, 'swap-path-score/v1');
    assert.equal(SWAP_PATH_SCORE_VERSION_V2, 'swap-path-score/v2');
    assert.notEqual(SWAP_PATH_SCORE_VERSION_V1, SWAP_PATH_SCORE_VERSION_V2);
  });
});
