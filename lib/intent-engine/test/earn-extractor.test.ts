import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mapEarnOptimizationModeV1,
  mapEarnProtocolConstraintV1,
  resolveEarnIntentV1,
} from '../src/earn-extractor.js';

const WALLET = '0x1111111111111111111111111111111111111111';
const NOW = new Date('2026-07-21T12:00:00.000Z');

function resolve(message: string) {
  return resolveEarnIntentV1({ message, tenantId: 'tenant-1', walletAddress: WALLET, now: NOW });
}

test('EN: "Deposit 500 USDC for yield" grounds to a ready earn intent', () => {
  const r = resolve('Deposit 500 USDC for yield.');
  assert.equal(r.status, 'ready');
  if (r.status !== 'ready') return;
  assert.equal(r.intent.goal, 'earn');
  assert.equal(r.intent.amount.amountDecimal, '500');
  assert.equal(r.intent.amount.amountAtomic, '500000000');
  assert.equal(r.intent.asset.symbol, 'USDC');
  assert.equal(r.intent.optimizationMode, 'best_net_yield');
});

test('RU: "Размести 500 USDC под доходность" grounds to a ready earn intent', () => {
  const r = resolve('Размести 500 USDC под доходность.');
  assert.equal(r.status, 'ready');
  if (r.status !== 'ready') return;
  assert.equal(r.intent.goal, 'earn');
  assert.equal(r.intent.amount.amountDecimal, '500');
  assert.equal(r.extraction.locale, 'ru');
});

test('"Find the best net yield" maps to best_net_yield', () => {
  assert.equal(mapEarnOptimizationModeV1('Find the best net yield').value, 'best_net_yield');
  assert.equal(mapEarnOptimizationModeV1('Prefer easier withdrawals').value, 'simplest_route');
  assert.equal(mapEarnOptimizationModeV1('use the lowest risk option').value, 'lowest_risk');
  assert.equal(mapEarnOptimizationModeV1('give me the highest liquidity').value, 'highest_liquidity');
});

test('"Use Moonwell only" and "Do not use Morpho" map to protocol constraints', () => {
  assert.deepEqual(mapEarnProtocolConstraintV1('Use Moonwell only').value, { mode: 'include_only', protocols: ['moonwell'] });
  assert.deepEqual(mapEarnProtocolConstraintV1('Do not use Morpho').value, { mode: 'exclude', protocols: ['morpho'] });
  assert.deepEqual(mapEarnProtocolConstraintV1('не используй morpho').value, { mode: 'exclude', protocols: ['morpho'] });
});

test('YO enters the released Earn route family without falling back to another protocol', () => {
  assert.deepEqual(mapEarnProtocolConstraintV1('Show YO Protocol vaults on Base').value, {
    mode: 'include_only',
    protocols: ['yo'],
  });
  const result = resolve('Deposit 100 USDC into a YO vault on Base.');
  assert.equal(result.status, 'ready');
  if (result.status === 'ready') {
    assert.deepEqual(result.intent.protocolConstraint, { mode: 'include_only', protocols: ['yo'] });
  }
});

test('Balancer and Hydrex yield requests never substitute a different Earn provider', () => {
  const balancer = resolve('Show the best Balancer pool for 100 USDC yield on Base.');
  assert.equal(balancer.status, 'unsupported');
  assert.deepEqual(balancer.issues, ['balancer_earn_adapter_not_released']);

  const hydrex = resolve('Earn yield with 100 USDC on Hydrex.');
  assert.equal(hydrex.status, 'unsupported');
  assert.deepEqual(hydrex.issues, ['hydrex_earn_adapter_not_released']);
});

test('constraint is carried into the resolved intent', () => {
  const r = resolve('Deposit 500 USDC for yield, use Moonwell only.');
  assert.equal(r.status, 'ready');
  if (r.status !== 'ready') return;
  assert.deepEqual(r.intent.protocolConstraint, { mode: 'include_only', protocols: ['moonwell'] });
});

test('missing amount => needs_clarification, never an invented amount', () => {
  const r = resolve('Deposit USDC for yield.');
  assert.equal(r.status, 'needs_clarification');
  assert.equal(r.intent, null);
  assert.ok(r.issues.includes('amount_required'));
});

test('a non-earn request is unsupported (does not fabricate an earn intent)', () => {
  const r = resolve('Swap 1 ETH to USDC.');
  assert.equal(r.status, 'unsupported');
  assert.equal(r.intent, null);
});

test('conflicting amounts => needs_clarification', () => {
  const r = resolve('Deposit 500 USDC and 250 USDC for yield.');
  assert.equal(r.status, 'needs_clarification');
  assert.ok(r.issues.includes('conflicting_amounts'));
});

test('resolved intent hash is stable and re-parses', () => {
  const a = resolve('Размести 500 USDC под доходность, только moonwell.');
  const b = resolve('Размести 500 USDC под доходность, только moonwell.');
  assert.equal(a.status === 'ready' && b.status === 'ready', true);
  if (a.status === 'ready' && b.status === 'ready') {
    assert.equal(a.intent.intentHash, b.intent.intentHash);
    assert.deepEqual(a.intent.protocolConstraint, { mode: 'include_only', protocols: ['moonwell'] });
  }
});
