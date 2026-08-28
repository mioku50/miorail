import assert from 'node:assert/strict';
import test from 'node:test';

import { representationUtilityMapV1 } from '../src/utilityMap.js';

const TOKEN = '0xb20000000000000000000078ee7ce2fe4908108c';
const NOW = '2026-08-28T07:30:00.000Z';

function map(
  state: 'observed' | 'stale' | 'not_established' = 'observed',
) {
  return representationUtilityMapV1({
    tokenAddress: TOKEN,
    issuerId: 'coinbase',
    evaluatedAt: NOW,
    marketTrade: {
      state,
      providerId: state === 'not_established' ? null : 'kyberswap',
      checkedAt: '2026-08-28T07:29:50.000Z',
      evidenceRef: state === 'not_established' ? null : `router_quote:0x${'11'.repeat(32)}`,
      note: 'A router quote reached this exact address and size.',
    },
  });
}

test('every edge is keyed to the exact CAIP-10 representation and carries no ranking', () => {
  const result = map();
  assert.equal(result.caip10, `eip155:8453:${TOKEN}`);
  assert.equal(result.ranking, 'none');
  assert.equal(result.marketDefi.length, 7);
  assert.equal(result.issuer.length, 5);
  for (const edge of [...result.marketDefi, ...result.issuer]) {
    assert.equal(edge.tokenAddress, TOKEN);
    assert.equal(edge.caip10, result.caip10);
    assert.ok(edge.checkedAt);
  }
});

test('a router quote is OBSERVED evidence and never AVAILABLE execution', () => {
  const trade = map().marketDefi[0]!;
  assert.equal(trade.edgeId, 'market_trade');
  assert.equal(trade.state, 'observed');
  assert.equal(trade.nextStep.kind, 'read_only');
  assert.equal(trade.nextStep.href, null);
  assert.equal(trade.evidence[0]?.targetAddress, TOKEN);
  assert.equal(trade.evidence[0]?.providerId, 'kyberswap');
});

test('untested DeFi integrations remain explicitly not established', () => {
  const result = map();
  for (const edge of result.marketDefi.slice(1)) {
    assert.equal(edge.state, 'not_established');
    assert.deepEqual(edge.evidence, []);
    assert.equal(edge.nextStep.href, null);
  }
});

test('issuer processes are documented without becoming personal eligibility verdicts', () => {
  const result = map();
  const redemption = result.issuer.find((edge) => edge.edgeId === 'issuer_redeem_sell')!;
  assert.equal(redemption.state, 'documented');
  assert.match(redemption.eligibilityNote, /eligible|KYC|outside/i);
  assert.ok(redemption.evidence.length > 0);
  assert.equal(redemption.nextStep.kind, 'external_ui');
  assert.match(redemption.nextStep.href ?? '', /^https:\/\//);
});

test('unknown issuer bridge remains not established rather than unavailable', () => {
  const bridge = map().issuer.find((edge) => edge.edgeId === 'issuer_bridge')!;
  assert.equal(bridge.state, 'not_established');
  assert.equal(bridge.nextStep.href, null);
});

test('the map cannot carry approvals, calldata, transactions or recommendation scores', () => {
  const json = JSON.stringify(map()).toLowerCase();
  for (const forbidden of ['approval', 'calldata', 'transaction', 'score', 'best', 'worst']) {
    assert.equal(json.includes(forbidden), false, forbidden);
  }
});
