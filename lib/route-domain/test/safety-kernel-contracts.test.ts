import assert from 'node:assert/strict';
import test from 'node:test';
import { SafetyKernelResultV1Schema, type SafetyKernelCheckV1 } from '../src/index.js';

function check(overrides: Partial<SafetyKernelCheckV1> = {}): SafetyKernelCheckV1 {
  return {
    id: 'chain_pinned',
    description: 'Chain is pinned to Base mainnet',
    status: 'passed',
    detail: null,
    ...overrides,
  };
}

test('allowed Safety Kernel result requires a null blockedReason and no failed checks', () => {
  const allowed = SafetyKernelResultV1Schema.safeParse({
    schemaVersion: 'safety-kernel-result/v1',
    verdict: 'allowed',
    checks: [check()],
    blockedReason: null,
  });
  assert.equal(allowed.success, true);

  const allowedWithReason = SafetyKernelResultV1Schema.safeParse({
    schemaVersion: 'safety-kernel-result/v1',
    verdict: 'allowed',
    checks: [check()],
    blockedReason: 'should not be present',
  });
  assert.equal(allowedWithReason.success, false);

  const allowedWithFailedCheck = SafetyKernelResultV1Schema.safeParse({
    schemaVersion: 'safety-kernel-result/v1',
    verdict: 'allowed',
    checks: [check({ status: 'failed' })],
    blockedReason: null,
  });
  assert.equal(allowedWithFailedCheck.success, false);
});

test('blocked Safety Kernel result requires a non-null blockedReason', () => {
  const blocked = SafetyKernelResultV1Schema.safeParse({
    schemaVersion: 'safety-kernel-result/v1',
    verdict: 'blocked',
    checks: [check({ status: 'failed', detail: 'router mismatch' })],
    blockedReason: 'Router target is not pinned',
  });
  assert.equal(blocked.success, true);

  const blockedWithoutReason = SafetyKernelResultV1Schema.safeParse({
    schemaVersion: 'safety-kernel-result/v1',
    verdict: 'blocked',
    checks: [check({ status: 'failed' })],
    blockedReason: null,
  });
  assert.equal(blockedWithoutReason.success, false);
});

test('Safety Kernel result requires at least one check', () => {
  const empty = SafetyKernelResultV1Schema.safeParse({
    schemaVersion: 'safety-kernel-result/v1',
    verdict: 'allowed',
    checks: [],
    blockedReason: null,
  });
  assert.equal(empty.success, false);
});
