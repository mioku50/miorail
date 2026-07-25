import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  extractCommerceIntentV1,
  mapCommerceKindV1,
  mapCommerceOptimizationModeV1,
  resolveCommerceIntentV1,
} from '../src/commerce-extractor.js';

const WALLET = '0x1111111111111111111111111111111111111111' as const;
const NOW = new Date('2026-07-25T12:00:00.000Z');

function resolve(message: string) {
  return resolveCommerceIntentV1({ message, tenantId: 'tenant', walletAddress: WALLET, now: NOW });
}

test('a Russian gift-card request grounds into a commerce intent', () => {
  const extraction = extractCommerceIntentV1('Купи Steam gift card на $25');
  assert.equal(extraction.goal, 'commerce');
  assert.equal(extraction.kind, 'gift_card');
  assert.equal(extraction.amountDecimal, '25');
  assert.equal(extraction.currency, 'USD');
  assert.match(extraction.query ?? '', /steam/i);
});

test('an English request grounds the same way', () => {
  const resolution = resolve('buy a US Steam gift card for $25');
  assert.equal(resolution.status, 'ready');
  assert.ok(resolution.intent);
  assert.equal(resolution.intent.goal, 'commerce');
  assert.equal(resolution.intent.country, 'US');
  assert.equal(resolution.intent.requestedValue.amountDecimal, '25');
  assert.equal(resolution.intent.requestedValue.currency, 'USD');
  assert.match(resolution.intent.query, /steam/i);
});

test('an inferred market is disclosed rather than assumed silently', () => {
  const inferred = extractCommerceIntentV1('buy a Steam gift card for $25');
  assert.equal(inferred.country, 'US');
  assert.equal(inferred.countryInferred, true);

  const explicit = extractCommerceIntentV1('buy a US Steam gift card for $25');
  assert.equal(explicit.country, 'US');
  assert.equal(explicit.countryInferred, false);
});

test('the spend ceiling carries disclosed headroom above the requested value', () => {
  const resolution = resolve('buy a US Steam gift card for $25');
  assert.ok(resolution.intent);
  // $25 plus the default 15% headroom, in USDC base units.
  assert.equal(resolution.intent.maxSpendAtomic, '28750000');
});

test('a missing price is asked about, never invented', () => {
  const resolution = resolve('buy me a Steam gift card');
  assert.equal(resolution.status, 'needs_clarification');
  assert.ok(resolution.issues.includes('amount_required'));
  assert.equal(resolution.intent, null);
});

test('two different prices in one message are a clarification, not a guess', () => {
  const resolution = resolve('buy a Steam gift card for $25 or $50');
  assert.equal(resolution.status, 'needs_clarification');
  assert.ok(resolution.issues.includes('conflicting_amounts'));
});

test('a top-up with no phone number is a clarification', () => {
  const resolution = resolve('top up my phone with $20');
  assert.equal(resolution.status, 'needs_clarification');
  assert.ok(resolution.issues.includes('recipient_required'));
});

test('a swap request is not routed to commerce', () => {
  const resolution = resolve('swap 100 USDC to ETH');
  assert.equal(resolution.status, 'unsupported');
  assert.ok(resolution.issues.includes('not_commerce_goal'));
});

test('an earn request is not routed to commerce', () => {
  const resolution = resolve('earn yield on 500 USDC');
  assert.equal(resolution.status, 'unsupported');
  assert.ok(resolution.issues.includes('not_commerce_goal'));
});

test('the product kind comes from the words used', () => {
  assert.equal(mapCommerceKindV1('buy an eSIM for 1GB').value, 'esim');
  assert.equal(mapCommerceKindV1('top up my phone').value, 'topup');
  assert.equal(mapCommerceKindV1('buy a Steam gift card').value, 'gift_card');
});

test('the optimization mode comes from the words used', () => {
  assert.equal(mapCommerceOptimizationModeV1('the cheapest Steam card'), 'lowest_total_cost');
  assert.equal(mapCommerceOptimizationModeV1('I need it fastest'), 'fastest_delivery');
  assert.equal(mapCommerceOptimizationModeV1('buy a Steam card for $25'), 'exact_denomination');
});

test('a resolved intent is deterministic', () => {
  const first = resolve('buy a US Steam gift card for $25');
  const second = resolve('buy a US Steam gift card for $25');
  assert.ok(first.intent && second.intent);
  assert.equal(first.intent.intentHash, second.intent.intentHash);
});
