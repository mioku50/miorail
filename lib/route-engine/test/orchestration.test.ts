import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalJsonV1, hashEvidenceRecordV1, ZERO_HASH_V1 } from '@mioagent/route-domain';
import { createSwapRouteEngine, RouteEngineInputError } from '../src/index.js';
import {
  NOW,
  WALLET,
  failingAdapter,
  makeCandidate,
  makeIntent,
  makeQuoteEvidence,
  quotedAdapter,
  rehashEvidence,
} from './fixtures.js';

const engine = createSwapRouteEngine();

test('both eligible providers are called concurrently and result order cannot change the hash', async () => {
  const intent = makeIntent();
  const uniswap = makeCandidate(intent, 'uniswap');
  const kyber = makeCandidate(intent, 'kyberswap');
  const first = await engine.evaluate({
    intent,
    walletAddress: WALLET,
    requestId: 'deterministic-order',
    now: NOW,
    adapters: [quotedAdapter('kyberswap', kyber, undefined, 15), quotedAdapter('uniswap', uniswap)],
  });
  const second = await engine.evaluate({
    intent,
    walletAddress: WALLET,
    requestId: 'deterministic-order',
    now: NOW,
    adapters: [quotedAdapter('uniswap', uniswap, undefined, 15), quotedAdapter('kyberswap', kyber)],
  });
  assert.equal(first.outcome, 'ready');
  assert.equal(first.evaluationHash, second.evaluationHash);
  assert.equal(canonicalJsonV1(first), canonicalJsonV1(second));
  assert.equal(first.candidates.length, 2);
});

for (const failed of ['uniswap', 'kyberswap'] as const) {
  test(`${failed} failure preserves the other candidate without a false recommendation`, async () => {
    const intent = makeIntent();
    const healthy = failed === 'uniswap' ? 'kyberswap' : 'uniswap';
    const candidate = makeCandidate(intent, healthy);
    const result = await engine.evaluate({
      intent,
      walletAddress: WALLET,
      requestId: `${failed}-fails`,
      now: NOW,
      adapters: [failingAdapter(failed), quotedAdapter(healthy, candidate)],
    });
    assert.equal(result.outcome, 'degraded');
    assert.equal(result.reason, 'single_provider_available');
    assert.equal(result.recommendedCandidateHash, null);
    assert.equal(result.candidates.length, 1);
    assert.equal(result.adapterFailures[0]?.provider, failed);
  });
}

test('both adapter failures produce an explicit failed evaluation and no fake candidates', async () => {
  const intent = makeIntent();
  const result = await engine.evaluate({
    intent,
    walletAddress: WALLET,
    requestId: 'both-fail',
    now: NOW,
    adapters: [failingAdapter('uniswap'), failingAdapter('kyberswap', 'timeout')],
  });
  assert.equal(result.outcome, 'failed');
  assert.equal(result.reason, 'all_providers_failed');
  assert.deepEqual(result.candidates, []);
  assert.equal(result.adapterFailures.length, 2);
});

test('include-only protocol produces a constrained selection', async () => {
  const intent = makeIntent({ protocolConstraint: { mode: 'include_only', protocols: ['uniswap'] } });
  const candidate = makeCandidate(intent, 'uniswap');
  const result = await engine.evaluate({
    intent,
    walletAddress: WALLET,
    requestId: 'include-only',
    now: NOW,
    adapters: [quotedAdapter('uniswap', candidate), failingAdapter('kyberswap')],
  });
  assert.equal(result.outcome, 'constrained');
  assert.equal(result.reason, 'user_protocol_constraint');
  assert.equal(result.recommendedCandidateHash, candidate.candidateHash);
  assert.equal(result.adapterFailures.length, 0);
});

test('wallet mismatch is rejected before any provider call', async () => {
  const intent = makeIntent();
  let calls = 0;
  const adapter = quotedAdapter('uniswap', makeCandidate(intent, 'uniswap'));
  const observing = { ...adapter, quote: async (input: Parameters<typeof adapter.quote>[0]) => { calls += 1; return adapter.quote(input); } };
  await assert.rejects(
    engine.evaluate({
      intent,
      walletAddress: '0x9999999999999999999999999999999999999999',
      requestId: 'wrong-wallet',
      now: NOW,
      adapters: [observing],
    }),
    RouteEngineInputError,
  );
  assert.equal(calls, 0);
});

test('invalid evidence linkage is rejected and never becomes a candidate', async () => {
  const intent = makeIntent();
  const candidate = makeCandidate(intent, 'uniswap');
  const quote = makeQuoteEvidence(candidate);
  const linkedElsewhere = rehashEvidence(quote, {
    candidateHash: `0x${'a'.repeat(64)}`,
  });
  const result = await engine.evaluate({
    intent,
    walletAddress: WALLET,
    requestId: 'bad-link',
    now: NOW,
    adapters: [quotedAdapter('uniswap', candidate, [linkedElsewhere])],
  });
  assert.equal(result.outcome, 'failed');
  assert.equal(result.reason, 'invalid_evidence');
  assert.deepEqual(result.candidates, []);
});

test('duplicate hashes are removed and conflicting evidence IDs fail closed', async () => {
  const intent = makeIntent({ protocolConstraint: { mode: 'include_only', protocols: ['uniswap'] } });
  const candidate = makeCandidate(intent, 'uniswap');
  const quote = makeQuoteEvidence(candidate);
  const deduped = await engine.evaluate({
    intent,
    walletAddress: WALLET,
    requestId: 'duplicate',
    now: NOW,
    adapters: [quotedAdapter('uniswap', candidate, [quote, quote])],
  });
  assert.equal(deduped.evidenceSets[0]?.records.filter((record) => record.evidenceType === 'quote').length, 1);

  const conflictDraft = {
    ...quote,
    responseHash: `0x${'b'.repeat(64)}` as `0x${string}`,
    evidenceHash: ZERO_HASH_V1,
  };
  const conflict = { ...conflictDraft, evidenceHash: hashEvidenceRecordV1(conflictDraft) };
  const rejected = await engine.evaluate({
    intent,
    walletAddress: WALLET,
    requestId: 'conflict',
    now: NOW,
    adapters: [quotedAdapter('uniswap', candidate, [quote, conflict])],
  });
  assert.equal(rejected.reason, 'invalid_evidence');
  assert.equal(rejected.adapterFailures[0]?.errorCode, 'engine_conflicting_evidence_id');
});

test('stale quote is preserved for diagnostics but never scored or ranked', async () => {
  const intent = makeIntent({ protocolConstraint: { mode: 'include_only', protocols: ['uniswap'] } });
  const candidate = makeCandidate(intent, 'uniswap', {
    observedAt: '2026-07-15T11:50:00.000Z',
    expiresAt: '2026-07-15T11:55:00.000Z',
  });
  const result = await engine.evaluate({
    intent,
    walletAddress: WALLET,
    requestId: 'stale',
    now: NOW,
    adapters: [quotedAdapter('uniswap', candidate)],
  });
  assert.equal(result.reason, 'all_quotes_expired');
  assert.equal(result.evidenceSets[0]?.status, 'stale');
  assert.ok(result.pathScores[0]?.dimensions.every((dimension) => dimension.score === null));
  assert.equal(result.recommendedCandidateHash, null);
});
