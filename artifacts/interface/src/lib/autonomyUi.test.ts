import assert from 'node:assert/strict';
import test from 'node:test';
import { cockpitAutonomyPresentation, savedPolicyForm, visibleAutonomyBlockedReasons } from './autonomyUi.js';

test('saved database policy hydrates every Configure field', () => {
  const form = savedPolicyForm({
    sessionKey: {
      source: 'database',
      status: 'configured',
      dailyLimitUsdc: '1',
      maxPerActionUsdc: '0.2',
      ttlSeconds: 2_591_733,
      whitelist: ['0x1111111111111111111111111111111111111111'],
      mainnetOptIn: true,
      walletAddress: '0x9999999999999999999999999999999999999999',
      expiresAt: '2026-08-10T00:00:00.000Z',
    },
  });
  assert.ok(form);
  assert.equal(form.dailyLimit, '1');
  assert.equal(form.maxPerAction, '0.2');
  assert.equal(form.ttlHours, '719.93');
  assert.equal(form.whitelistAddr, '0x1111111111111111111111111111111111111111');
  assert.equal(form.mainnetOptIn, true);
  assert.equal(form.acknowledgeMainnetRisk, true);
});

test('configured database state suppresses stale autonomy_policy_missing banner', () => {
  const reasons = visibleAutonomyBlockedReasons({
    sessionKey: {
      source: 'database',
      status: 'configured',
      mainnetOptIn: true,
      blockedReasons: ['autonomy_policy_missing', 'mainnet_opt_in_required', 'mainnet_readonly'],
    },
  });
  assert.deepStrictEqual(reasons, ['mainnet_readonly']);
});

test('configured policy without execution readiness is labelled read-only active', () => {
  assert.deepStrictEqual(
    cockpitAutonomyPresentation({
      sessionKey: { source: 'database', status: 'configured', executionReady: false },
    }),
    { capability: 'limited', label: 'Read-only active', readOnlyActive: true },
  );
});
