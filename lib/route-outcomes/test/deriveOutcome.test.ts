import assert from 'node:assert/strict';
import { test, describe } from 'node:test';

import {
  adverseShortfallBpsV1,
  deriveRouteProviderOutcomeV1,
  hashRouteProviderOutcomeV1,
  quoteDeviationBpsV1,
  receiptVerificationV1,
  routeProviderOutcomeIdV1,
} from '../src/index.js';
import { candidateFixtureV1, proofFixtureV1 } from './fixtures.js';

function derive(input: {
  finalStatus?: Parameters<typeof proofFixtureV1>[0] extends undefined
    ? never
    : NonNullable<Parameters<typeof proofFixtureV1>[0]>['finalStatus'];
  actualOutputAtomic?: string | null;
  providerId?: string;
  liquidityProtocol?: string;
  routeType?: 'swap' | 'earn';
  noReceipts?: boolean;
  minimumOutputAtomic?: string;
} = {}) {
  const candidate = candidateFixtureV1({
    providerId: input.providerId,
    liquidityProtocol: input.liquidityProtocol,
    routeType: input.routeType,
    minimumOutputAtomic: input.minimumOutputAtomic,
  });
  const { proof, events } = proofFixtureV1({
    finalStatus: input.finalStatus,
    candidateHash: candidate.candidateHash,
    actualOutputAtomic: input.actualOutputAtomic,
    noReceipts: input.noReceipts,
  });
  return deriveRouteProviderOutcomeV1({
    proof,
    candidate,
    events,
    derivedAt: new Date('2026-07-27T12:00:00.000Z'),
  });
}

describe('a verified terminal swap proof becomes exactly one provider outcome', () => {
  test('a completed proof derives a settled outcome', () => {
    const result = derive();
    assert.equal(result.derived, true);
    if (!result.derived) return;
    assert.equal(result.outcome.proofFinalStatus, 'completed');
    assert.equal(result.outcome.receiptVerification, 'verified_success');
    assert.equal(result.outcome.actualOutputAtomic, '999000000000000000');
    // 999/1000 → 10 bps short.
    assert.equal(result.outcome.adverseShortfallBps, 10);
    assert.equal(result.outcome.quoteDeviationBps, -10);
    assert.equal(result.outcome.floorBreached, false);
  });

  test('a partial failure is kept as its own category, not folded into failed', () => {
    const result = derive({ finalStatus: 'partial_failure' });
    assert.equal(result.derived, true);
    if (!result.derived) return;
    assert.equal(result.outcome.proofFinalStatus, 'partial_failure');
    assert.equal(result.outcome.receiptVerification, 'verified_mixed');
  });

  test('a verified reverted proof becomes a failure with no invented shortfall', () => {
    const result = derive({ finalStatus: 'failed' });
    assert.equal(result.derived, true);
    if (!result.derived) return;
    assert.equal(result.outcome.receiptVerification, 'verified_reverted');
    // A revert already counts against the success rate. Recording it as a 100%
    // shortfall too would let one bad execution move two statistics.
    assert.equal(result.outcome.adverseShortfallBps, null);
    assert.equal(result.outcome.actualOutputAtomic, null);
    assert.equal(result.outcome.floorBreached, null);
  });

  test('the id is a pure function of the proof, so a backfill reproduces it', () => {
    const first = derive();
    const second = derive();
    assert.equal(first.derived && second.derived, true);
    if (!first.derived || !second.derived) return;
    assert.equal(first.outcome.id, routeProviderOutcomeIdV1(first.outcome.proofId));
    assert.equal(first.outcome.outcomeHash, second.outcome.outcomeHash);
  });

  test('derivedAt is outside the hash — a late backfill is byte-identical', () => {
    const candidate = candidateFixtureV1();
    const { proof, events } = proofFixtureV1({ candidateHash: candidate.candidateHash });
    const live = deriveRouteProviderOutcomeV1({
      proof,
      candidate,
      events,
      derivedAt: new Date('2026-07-27T11:00:01.000Z'),
    });
    const backfilled = deriveRouteProviderOutcomeV1({
      proof,
      candidate,
      events,
      derivedAt: new Date('2026-09-01T00:00:00.000Z'),
    });
    assert.equal(live.derived && backfilled.derived, true);
    if (!live.derived || !backfilled.derived) return;
    assert.notEqual(live.outcome.derivedAt, backfilled.outcome.derivedAt);
    assert.equal(live.outcome.outcomeHash, backfilled.outcome.outcomeHash);
  });

  test('confirmation time is measured from submission to the terminal event', () => {
    const result = derive();
    assert.equal(result.derived, true);
    if (!result.derived) return;
    assert.equal(result.outcome.confirmationMs, 9_000);
  });
});

describe('states that are not answers are never recorded', () => {
  for (const finalStatus of ['pending', 'reconciliation_required'] as const) {
    test(`${finalStatus} produces no outcome`, () => {
      const result = derive({ finalStatus });
      assert.equal(result.derived, false);
      if (result.derived) return;
      assert.equal(result.reason, 'proof_not_terminal');
    });
  }

  test('cancelled is not a provider failure', () => {
    // A user who changed their mind said nothing about the provider.
    const result = derive({ finalStatus: 'cancelled' });
    assert.equal(result.derived, false);
    if (result.derived) return;
    assert.equal(result.reason, 'cancelled_by_user');
  });

  test('a failure no receipt attests to is not counted against the provider', () => {
    // The schema permits a `failed` proof with no receipts. Counting it would
    // let a submission that was never observed onchain damage a provider.
    const result = derive({ finalStatus: 'failed', noReceipts: true });
    assert.equal(result.derived, false);
    if (result.derived) return;
    assert.equal(result.reason, 'receipts_not_verified');
  });

  test('an unknown receipt is refused by the verification guard', () => {
    // submitted_unknown is exactly this shape: a hash nobody could resolve.
    // The guard is checked directly because the proof schema will not build
    // such a terminal proof — which is the point. Guessing here would create a
    // second, quieter source of truth about a transaction the reconciler
    // declined to judge.
    const { proof } = proofFixtureV1();
    const unresolved = {
      ...proof,
      receipts: [{ transactionHash: proof.receipts[0]!.transactionHash, status: 'unknown' as const, blockNumber: null, gasUsed: null }],
    };
    assert.equal(receiptVerificationV1(unresolved, 'completed'), null);
    assert.equal(receiptVerificationV1({ ...proof, receipts: [] }, 'failed'), null);
  });

  test('a completed proof whose receipts do not all succeed is refused', () => {
    const { proof } = proofFixtureV1({ finalStatus: 'partial_failure' });
    // Claiming `verified_success` here would disagree with the receipts.
    assert.equal(receiptVerificationV1(proof, 'completed'), null);
    assert.equal(receiptVerificationV1(proof, 'partial_failure'), 'verified_mixed');
  });

  test('a settled proof with no reconstructed output is skipped, not zeroed', () => {
    const result = derive({ actualOutputAtomic: null });
    assert.equal(result.derived, false);
    if (result.derived) return;
    assert.equal(result.reason, 'missing_delivered_amount');
  });
});

describe('provider identity comes from the persisted candidate', () => {
  test('an aggregator route through another venue is ONE outcome, under the aggregator', () => {
    // Kyber filling on a Uniswap pool tells us how Kyber routes. Crediting
    // Uniswap would count one trade twice and attribute it to a provider that
    // was never asked to quote.
    const result = derive({ providerId: 'kyberswap', liquidityProtocol: 'uniswap' });
    assert.equal(result.derived, true);
    if (!result.derived) return;
    assert.equal(result.outcome.providerId, 'kyberswap');
  });

  test('a provider outside the V1 swap set is refused rather than mislabelled', () => {
    const result = derive({ providerId: 'moonwell' });
    assert.equal(result.derived, false);
    if (result.derived) return;
    assert.equal(result.reason, 'unsupported_provider');
  });

  test('a non-swap candidate is out of scope', () => {
    const result = derive({ routeType: 'earn', providerId: 'uniswap' });
    assert.equal(result.derived, false);
    if (result.derived) return;
    assert.equal(result.reason, 'not_a_swap');
  });

  test('a candidate that is not the one the proof selected is refused', () => {
    const candidate = candidateFixtureV1();
    const { proof, events } = proofFixtureV1({ candidateHash: '0x'.padEnd(66, 'f') as `0x${string}` });
    const result = deriveRouteProviderOutcomeV1({
      proof,
      candidate,
      events,
      derivedAt: new Date('2026-07-27T12:00:00.000Z'),
    });
    assert.equal(result.derived, false);
    if (result.derived) return;
    assert.equal(result.reason, 'candidate_mismatch');
  });
});

describe('the derived arithmetic', () => {
  test('overdelivery is zero adverse shortfall, never a credit', () => {
    // Otherwise a provider could earn calibration headroom by quoting low,
    // which is a different behaviour from executing well.
    assert.equal(adverseShortfallBpsV1(1_000n, 1_100n), 0);
    assert.equal(quoteDeviationBpsV1(1_000n, 1_100n), 1_000);

    const result = derive({ actualOutputAtomic: '1100000000000000000' });
    assert.equal(result.derived, true);
    if (!result.derived) return;
    assert.equal(result.outcome.adverseShortfallBps, 0);
    assert.equal(result.outcome.quoteDeviationBps, 1_000);
  });

  test('the floor verdict is exact at the boundary', () => {
    const atFloor = derive({ actualOutputAtomic: '990000000000000000' });
    assert.equal(atFloor.derived, true);
    if (!atFloor.derived) return;
    assert.equal(atFloor.outcome.floorBreached, false, 'exactly the minimum is not a breach');

    const belowFloor = derive({ actualOutputAtomic: '989999999999999999' });
    assert.equal(belowFloor.derived, true);
    if (!belowFloor.derived) return;
    assert.equal(belowFloor.outcome.floorBreached, true, 'one atomic unit below is a breach');
  });

  test('a tampered outcome no longer matches its own hash', () => {
    const result = derive();
    assert.equal(result.derived, true);
    if (!result.derived) return;
    const tampered = { ...result.outcome, adverseShortfallBps: 0 };
    assert.notEqual(hashRouteProviderOutcomeV1(tampered), result.outcome.outcomeHash);
  });
});
