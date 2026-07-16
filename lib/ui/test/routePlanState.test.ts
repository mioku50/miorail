import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canReviewTransaction,
  defaultSelectedCandidateHash,
  isRoutePlanExpired,
  selectableSwapCandidates,
} from '../src/routePlanState.js';

const NOW = new Date('2026-07-16T12:00:00.000Z');

function route(candidateHash: string, providerId = 'uniswap') {
  return { candidateHash, provider: { id: providerId, displayName: providerId, kind: 'dex', operator: 'x' } } as never;
}

test('selectableSwapCandidates lists the recommended route first, then alternatives', () => {
  const projection = {
    recommendedRoute: route('0xrecommended'),
    alternatives: [route('0xalt1', 'kyberswap')],
  };
  const candidates = selectableSwapCandidates(projection as never);
  assert.deepEqual(
    candidates.map((c) => [c.candidateHash, c.isRecommended]),
    [
      ['0xrecommended', true],
      ['0xalt1', false],
    ],
  );
});

test('selectableSwapCandidates returns an empty list without a recommended route or alternatives', () => {
  assert.deepEqual(selectableSwapCandidates({ recommendedRoute: null, alternatives: [] } as never), []);
});

test('defaultSelectedCandidateHash prefers the recommended route, falling back to the first alternative', () => {
  assert.equal(
    defaultSelectedCandidateHash({ recommendedRoute: route('0xrecommended'), alternatives: [route('0xalt1')] } as never),
    '0xrecommended',
  );
  assert.equal(
    defaultSelectedCandidateHash({ recommendedRoute: null, alternatives: [route('0xalt1')] } as never),
    '0xalt1',
  );
  assert.equal(defaultSelectedCandidateHash({ recommendedRoute: null, alternatives: [] } as never), null);
});

test('canReviewTransaction requires a ready/constrained outcome, a Route Card hash, and an unexpired projection', () => {
  const base = {
    routeCardHash: '0xcard' as never,
    expiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
  };
  assert.equal(canReviewTransaction({ projection: { ...base, outcome: 'ready' } as never, now: NOW }), true);
  assert.equal(canReviewTransaction({ projection: { ...base, outcome: 'constrained' } as never, now: NOW }), true);
  assert.equal(canReviewTransaction({ projection: { ...base, outcome: 'degraded' } as never, now: NOW }), false);
  assert.equal(canReviewTransaction({ projection: { ...base, outcome: 'failed' } as never, now: NOW }), false);
  assert.equal(canReviewTransaction({ projection: { ...base, routeCardHash: null, outcome: 'ready' } as never, now: NOW }), false);
  assert.equal(
    canReviewTransaction({
      projection: { ...base, outcome: 'ready', expiresAt: new Date(NOW.getTime() - 1_000).toISOString() } as never,
      now: NOW,
    }),
    false,
  );
});

test('isRoutePlanExpired stays consistent with canReviewTransaction expiry handling', () => {
  const expired = { expiresAt: new Date(NOW.getTime() - 1_000).toISOString() };
  const fresh = { expiresAt: new Date(NOW.getTime() + 1_000).toISOString() };
  assert.equal(isRoutePlanExpired(expired, NOW), true);
  assert.equal(isRoutePlanExpired(fresh, NOW), false);
});
