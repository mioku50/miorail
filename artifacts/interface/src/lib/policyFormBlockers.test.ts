import assert from 'node:assert/strict';
import test from 'node:test';
import { policyFormBlockers } from './policyFormBlockers.js';

const VALID = {
  address: '0x1234567890123456789012345678901234567890',
  dailyLimit: '100',
  maxPerAction: '20',
  ttlHours: '24',
  whitelist: ['0x1111111111111111111111111111111111111111'],
  mainnetOptIn: false,
  acknowledgeMainnetRisk: false,
};

test('a valid default form has no blockers', () => {
  assert.deepEqual(policyFormBlockers(VALID), []);
});

test('missing wallet is reported first', () => {
  assert.deepEqual(policyFormBlockers({ ...VALID, address: null }), ['Connect wallet first']);
});

test('non-positive and inconsistent limits produce specific reasons', () => {
  assert.deepEqual(policyFormBlockers({ ...VALID, dailyLimit: '0' }), ['Daily limit must be > 0']);
  assert.deepEqual(policyFormBlockers({ ...VALID, maxPerAction: '-1' }), ['Per-action limit must be > 0']);
  assert.deepEqual(policyFormBlockers({ ...VALID, maxPerAction: '200' }), ['Per-action limit must not exceed the daily limit']);
  assert.deepEqual(policyFormBlockers({ ...VALID, dailyLimit: 'abc' }), ['Daily limit must be > 0']);
});

test('a TTL below five minutes is blocked', () => {
  assert.deepEqual(policyFormBlockers({ ...VALID, ttlHours: '0.05' }), ['Session TTL must be at least 5 minutes']);
  assert.deepEqual(policyFormBlockers({ ...VALID, ttlHours: '' }), ['Session TTL must be at least 5 minutes']);
});

test('whitelist must contain only valid addresses', () => {
  assert.deepEqual(policyFormBlockers({ ...VALID, whitelist: [] }), ['Add at least one allowed recipient address']);
  assert.deepEqual(
    policyFormBlockers({ ...VALID, whitelist: ['0x1111111111111111111111111111111111111111', 'nope'] }),
    ['Every allowed recipient must be a valid 0x address'],
  );
});

test('mainnet opt-in requires the risk acknowledgement', () => {
  assert.deepEqual(
    policyFormBlockers({ ...VALID, mainnetOptIn: true, acknowledgeMainnetRisk: false }),
    ['Acknowledge the mainnet risk checkbox'],
  );
  assert.deepEqual(policyFormBlockers({ ...VALID, mainnetOptIn: true, acknowledgeMainnetRisk: true }), []);
});

test('multiple problems are all listed', () => {
  const blockers = policyFormBlockers({
    address: null,
    dailyLimit: '0',
    maxPerAction: '0',
    ttlHours: '0',
    whitelist: [],
    mainnetOptIn: true,
    acknowledgeMainnetRisk: false,
  });
  assert.deepEqual(blockers, [
    'Connect wallet first',
    'Daily limit must be > 0',
    'Per-action limit must be > 0',
    'Session TTL must be at least 5 minutes',
    'Add at least one allowed recipient address',
    'Acknowledge the mainnet risk checkbox',
  ]);
});
