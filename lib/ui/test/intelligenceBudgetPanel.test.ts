import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { IntelligenceBudgetPanel, type IntelligenceBudgetView } from '../src/IntelligenceBudgetPanel';

const here = path.dirname(url.fileURLToPath(import.meta.url));

function budget(overrides: Partial<IntelligenceBudgetView> = {}): IntelligenceBudgetView {
  return {
    budgetId: 'intelligence-budget:abc123def456',
    status: 'active',
    periodType: 'monthly',
    monthlyLimitUsdc: '10',
    spentUsdc: '2.5',
    reservedUsdc: '0.5',
    remainingUsdc: '7',
    maxPerRequestUsdc: '0.5',
    allowedCategories: ['simulation'],
    linkedSpendPermissionId: 'permission-xyz-0001',
    periodStartedAt: '2026-07-01T00:00:00.000Z',
    periodEndsAt: '2026-08-01T00:00:00.000Z',
    chainId: 8453,
    walletAddress: '0x1111111111111111111111111111111111111111',
    ...overrides,
  };
}

test('renders all 8 fields as decimal USDC strings for an active budget', () => {
  const element = IntelligenceBudgetPanel({ budget: budget() });
  const serialized = JSON.stringify(element);
  // Status
  assert.ok(serialized.includes('active'));
  // Monthly limit / Spent / Reserved / Remaining / Max per request — decimal USDC.
  assert.ok(serialized.includes('Monthly limit'));
  assert.ok(serialized.includes('10 USDC'));
  assert.ok(serialized.includes('Spent'));
  assert.ok(serialized.includes('2.5 USDC'));
  assert.ok(serialized.includes('Reserved'));
  assert.ok(serialized.includes('0.5 USDC'));
  assert.ok(serialized.includes('Remaining'));
  assert.ok(serialized.includes('7 USDC'));
  assert.ok(serialized.includes('Maximum per request'));
  // Period window
  assert.ok(serialized.includes('Period window'));
  assert.ok(serialized.includes('2026-07-01'));
  assert.ok(serialized.includes('2026-08-01'));
  // Allowed categories
  assert.ok(serialized.includes('Allowed categories'));
  assert.ok(serialized.includes('simulation'));
  // Linked Spend Permission
  assert.ok(serialized.includes('Spend Permission'));
});

test('null budget renders an honest empty state, not a fabricated zero budget', () => {
  const element = IntelligenceBudgetPanel({ budget: null });
  const serialized = JSON.stringify(element);
  assert.ok(serialized.includes('No Intelligence Budget is linked yet'));
  assert.ok(serialized.includes('none'));
});

test('paused / revoked / expired statuses each map to a StateBadge label', () => {
  for (const status of ['paused', 'revoked', 'expired'] as const) {
    const element = IntelligenceBudgetPanel({ budget: budget({ status }) });
    const serialized = JSON.stringify(element);
    assert.ok(serialized.includes(status), `panel must surface the ${status} status`);
    assert.ok(serialized.includes(`"data-budget-status":"${status}"`));
  }
});

test('an explicit status override wins over the status-derived default', () => {
  const element = IntelligenceBudgetPanel({ budget: budget({ status: 'active' }), status: 'stale' });
  const serialized = JSON.stringify(element);
  assert.ok(serialized.includes('stale'));
});

test('lib/ui IntelligenceBudgetPanel is wagmi-free and never imports api-zod/api-spec', () => {
  const source = readFileSync(path.join(here, '..', 'src', 'IntelligenceBudgetPanel.tsx'), 'utf8');
  // Match actual import statements, not the "wagmi-free" prose in the header.
  assert.equal(/from 'wagmi'|from "wagmi"/.test(source), false, 'must never import wagmi');
  assert.equal(/from '@mioagent\/api-zod'|from '@mioagent\/api-spec'/.test(source), false, 'must not import api-zod/api-spec');
  assert.equal(/signTypedData|useSendCalls|walletClient/i.test(source), false, 'must never sign or call a wallet');
  // Money is shown as the decimal strings already in the projection — never
  // re-derived via formatAtomicAmount.
  assert.equal(source.includes('formatAtomicAmount'), false);
});
