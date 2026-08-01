import assert from 'node:assert/strict';
import test from 'node:test';
import { poolProtocolLabelV1, routeGraphFromRouteV1 } from '../src/console/consoleAdapters.js';
import {
  canReviewTransaction,
  defaultSelectedCandidateHash,
  isRoutePlanExpired,
  selectableSwapCandidates,
  swapPrepareErrorMessage,
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

test('swapPrepareErrorMessage maps mutation errors to an honest, non-silent message', () => {
  // Server guard codes surfaced by the api-client fetch wrapper.
  assert.equal(
    swapPrepareErrorMessage(new Error('wallet_mismatch')),
    'Transaction preparation failed (wallet_mismatch). No transaction was prepared.',
  );
  assert.equal(
    swapPrepareErrorMessage(new Error('API error: 503 Service Unavailable')),
    'Transaction preparation failed (API error: 503 Service Unavailable). No transaction was prepared.',
  );
  // Plain string and empty/unknown errors still yield an honest failure notice.
  assert.equal(
    swapPrepareErrorMessage('swap_prepare_failed'),
    'Transaction preparation failed (swap_prepare_failed). No transaction was prepared.',
  );
  assert.equal(
    swapPrepareErrorMessage(undefined),
    'Transaction preparation failed (request_failed). No transaction was prepared.',
  );
  assert.equal(
    swapPrepareErrorMessage(new Error('   ')),
    'Transaction preparation failed (request_failed). No transaction was prepared.',
  );
  // Overlong messages are truncated, never dropped.
  const long = swapPrepareErrorMessage(new Error('x'.repeat(500)));
  assert.ok(long.includes('...'));
  assert.ok(long.startsWith('Transaction preparation failed ('));
  assert.ok(long.endsWith('No transaction was prepared.'));
});

test('isRoutePlanExpired stays consistent with canReviewTransaction expiry handling', () => {
  const expired = { expiresAt: new Date(NOW.getTime() - 1_000).toISOString() };
  const fresh = { expiresAt: new Date(NOW.getTime() + 1_000).toISOString() };
  assert.equal(isRoutePlanExpired(expired, NOW), true);
  assert.equal(isRoutePlanExpired(fresh, NOW), false);
});

test('T67B.1 an Aerodrome hop names its curve, because the pair does not identify the pool', () => {
  const route = {
    evidence: {
      liquiditySources: [
        { protocol: 'aerodrome-volatile' },
        { protocol: 'aerodrome-stable' },
      ],
    },
    expectedOutput: { amountDecimal: '0.038', asset: { symbol: 'ETH', address: null } },
  } as never;
  const graph = routeGraphFromRouteV1(route, { amountLabel: '100 USDC', walletLabel: 'wallet' });
  assert.deepEqual(
    graph?.pools.map((pool) => pool.title),
    ['Aerodrome · volatile pool', 'Aerodrome · stable pool'],
  );
  // Aerodrome reports no share or depth, and the graph says so rather than
  // inventing a split.
  assert.equal(graph?.pools[0]?.subtitle, 'share not reported');
  // Every other protocol is passed straight through.
  assert.equal(poolProtocolLabelV1('uniswap-v3'), 'uniswap-v3');
  assert.equal(poolProtocolLabelV1(undefined), undefined);
});
