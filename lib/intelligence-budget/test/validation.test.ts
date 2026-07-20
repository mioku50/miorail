import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkSpendPermissionBindingV1, checkSpendPermissionV1, validateBudgetForSimulationV1 } from '../src/validation.js';
import { budgetDomainFixture, permissionFixture, TENANT_ID, WALLET_ADDRESS } from './fixtures.js';

const NOW = new Date('2026-07-20T12:00:00.000Z');
const USDC_ADDRESS = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';

describe('validateBudgetForSimulationV1', () => {
  const baseInput = {
    tenantId: TENANT_ID,
    walletAddress: WALLET_ADDRESS,
    chainId: 8453 as const,
    category: 'simulation' as const,
    costAtomic: '10000',
    now: NOW,
  };

  it('passes for a well-formed, active, in-window, in-limit budget', () => {
    const budget = budgetDomainFixture();
    const result = validateBudgetForSimulationV1({ budget, ...baseInput });
    assert.deepEqual(result, { ok: true });
  });

  it('blocks on tenant mismatch', () => {
    const budget = budgetDomainFixture({ tenantId: 'tenant-someone-else' });
    const result = validateBudgetForSimulationV1({ budget, ...baseInput });
    assert.equal(result.ok, false);
    if (result.ok) throw new Error('unreachable');
    assert.equal(result.outcome, 'blocked');
    assert.equal(result.reason, 'budget_tenant_mismatch');
  });

  it('blocks on wallet mismatch', () => {
    const budget = budgetDomainFixture({ walletAddress: '0x2222222222222222222222222222222222222222' });
    const result = validateBudgetForSimulationV1({ budget, ...baseInput });
    assert.equal(result.ok, false);
    if (result.ok) throw new Error('unreachable');
    assert.equal(result.reason, 'budget_wallet_mismatch');
  });

  it('does not treat a same-address different-case wallet as a mismatch', () => {
    // AddressV1Schema always lowercases on parse, so the STORED budget wallet
    // is lowercase regardless of what case is passed in — the request-side
    // wallet (e.g. a checksummed address from the client) may still arrive
    // mixed-case, and the guard's own .toLowerCase() compare must still pass.
    const mixedCaseWallet = '0xAbCdEf0123456789aBcDeF0123456789aBcDeF01' as `0x${string}`;
    const budget = budgetDomainFixture({ walletAddress: mixedCaseWallet });
    assert.equal(budget.walletAddress, mixedCaseWallet.toLowerCase());
    const result = validateBudgetForSimulationV1({ budget, ...baseInput, walletAddress: mixedCaseWallet });
    assert.deepEqual(result, { ok: true });
  });

  it('blocks on chain mismatch', () => {
    const budget = { ...budgetDomainFixture(), chainId: 84532 as const };
    const result = validateBudgetForSimulationV1({ budget, ...baseInput });
    assert.equal(result.ok, false);
    if (result.ok) throw new Error('unreachable');
    assert.equal(result.reason, 'budget_chain_mismatch');
  });

  it('blocks a revoked budget even if status somehow was not also flipped', () => {
    const budget = { ...budgetDomainFixture(), revokedAt: NOW.toISOString() };
    const result = validateBudgetForSimulationV1({ budget, ...baseInput });
    assert.equal(result.ok, false);
    if (result.ok) throw new Error('unreachable');
    assert.equal(result.reason, 'budget_revoked');
  });

  it('blocks a paused budget with a status-specific reason', () => {
    const budget = budgetDomainFixture({ status: 'paused' });
    const result = validateBudgetForSimulationV1({ budget, ...baseInput });
    assert.equal(result.ok, false);
    if (result.ok) throw new Error('unreachable');
    assert.equal(result.reason, 'budget_paused');
  });

  it('blocks once the period has ended', () => {
    const budget = budgetDomainFixture({ periodEndsAt: '2026-07-01T00:00:00.000Z' });
    const result = validateBudgetForSimulationV1({ budget, ...baseInput });
    assert.equal(result.ok, false);
    if (result.ok) throw new Error('unreachable');
    assert.equal(result.reason, 'budget_period_expired');
  });

  it('blocks a category outside allowedCategories', () => {
    const budget = budgetDomainFixture({ allowedCategories: ['route_quote'] });
    const result = validateBudgetForSimulationV1({ budget, ...baseInput });
    assert.equal(result.ok, false);
    if (result.ok) throw new Error('unreachable');
    assert.equal(result.reason, 'category_not_allowed');
  });

  it('limit_exceeded when the cost exceeds the per-call maximum', () => {
    const budget = budgetDomainFixture({ maxPerCallAtomic: '9999' });
    const result = validateBudgetForSimulationV1({ budget, ...baseInput, costAtomic: '10000' });
    assert.equal(result.ok, false);
    if (result.ok) throw new Error('unreachable');
    assert.equal(result.outcome, 'limit_exceeded');
    assert.equal(result.reason, 'per_call_limit_exceeded');
  });

  it('limit_exceeded when periodSpent + reserved + cost would exceed the monthly limit', () => {
    const budget = {
      ...budgetDomainFixture({ periodLimitAtomic: '15000', maxPerCallAtomic: '15000' }),
      periodSpentAtomic: '5000',
      reservedAtomic: '1000',
    };
    // 5000 + 1000 + 10000 = 16000 > 15000
    const result = validateBudgetForSimulationV1({ budget, ...baseInput, costAtomic: '10000' });
    assert.equal(result.ok, false);
    if (result.ok) throw new Error('unreachable');
    assert.equal(result.outcome, 'limit_exceeded');
    assert.equal(result.reason, 'monthly_limit_exceeded');
  });

  it('a periodEndsAt of null means no expiry gate', () => {
    const budget = budgetDomainFixture({ periodEndsAt: null });
    const result = validateBudgetForSimulationV1({ budget, ...baseInput });
    assert.deepEqual(result, { ok: true });
  });
});

describe('checkSpendPermissionV1', () => {
  const base = { tenantId: TENANT_ID, now: NOW, expectedAssetAddress: USDC_ADDRESS };

  it('passes for an active, unexpired, matching permission', () => {
    const result = checkSpendPermissionV1({ permission: permissionFixture(), ...base });
    assert.deepEqual(result, { ok: true });
  });

  it('fails closed when the permission is missing entirely', () => {
    const result = checkSpendPermissionV1({ permission: undefined, ...base });
    assert.deepEqual(result, { ok: false, reason: 'spend_permission_missing' });
  });

  it('rejects a permission belonging to another tenant', () => {
    const result = checkSpendPermissionV1({ permission: permissionFixture({ userId: 'someone-else' }), ...base });
    assert.deepEqual(result, { ok: false, reason: 'spend_permission_tenant_mismatch' });
  });

  it('rejects an inactive permission', () => {
    const result = checkSpendPermissionV1({ permission: permissionFixture({ isActive: false }), ...base });
    assert.deepEqual(result, { ok: false, reason: 'spend_permission_inactive' });
  });

  it('rejects an expired permission', () => {
    const result = checkSpendPermissionV1({
      permission: permissionFixture({ expiresAt: Date.parse('2026-01-01T00:00:00.000Z') }),
      ...base,
    });
    assert.deepEqual(result, { ok: false, reason: 'spend_permission_expired' });
  });

  it('rejects a chain mismatch', () => {
    const result = checkSpendPermissionV1({ permission: permissionFixture({ chainId: 84532 }), ...base });
    assert.deepEqual(result, { ok: false, reason: 'spend_permission_chain_mismatch' });
  });

  it('rejects an asset mismatch, case-insensitively matches when only case differs', () => {
    const mismatched = checkSpendPermissionV1({
      permission: permissionFixture({ asset: '0x000000000000000000000000000000000000ff' }),
      ...base,
    });
    assert.deepEqual(mismatched, { ok: false, reason: 'spend_permission_asset_mismatch' });

    const sameCaseInsensitive = checkSpendPermissionV1({
      permission: permissionFixture({ asset: USDC_ADDRESS.toUpperCase() }),
      ...base,
    });
    assert.deepEqual(sameCaseInsensitive, { ok: true });
  });
});

describe('checkSpendPermissionBindingV1', () => {
  it('passes when the permission id matches the budget spendPermissionId', () => {
    const result = checkSpendPermissionBindingV1({
      permission: permissionFixture({ id: 'permission-fixture' }),
      budget: { spendPermissionId: 'permission-fixture' },
    });
    assert.deepEqual(result, { ok: true });
  });

  it('fails closed when the permission id does not match a stale/tampered budget.spendPermissionId', () => {
    const result = checkSpendPermissionBindingV1({
      permission: permissionFixture({ id: 'permission-fixture' }),
      budget: { spendPermissionId: 'permission-different' },
    });
    assert.deepEqual(result, { ok: false, reason: 'spend_permission_binding_mismatch' });
  });
});
