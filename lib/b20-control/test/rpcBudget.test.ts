import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  RPC_CU_DEFAULT_V1,
  RPC_MONTHLY_CU_BUDGET_V1,
  chooseRpcEndpointV1,
  cuForBatchV1,
  cuForMethodV1,
  rpcBudgetMonthV1,
  rpcBudgetReportV1,
} from '../src/rpcBudget.js';

describe('compute units are the unit, not calls', () => {
  test('the published costs are per method, and they differ', () => {
    assert.equal(cuForMethodV1('eth_call'), 26);
    assert.equal(cuForMethodV1('eth_getLogs'), 75);
    assert.equal(cuForMethodV1('eth_blockNumber'), 10);
    assert.notEqual(cuForMethodV1('eth_call'), cuForMethodV1('eth_getLogs'));
  });

  test('an unpriced method costs the expensive default, never the cheap one', () => {
    // An unpriced method that billed as zero would let a month's spend
    // under-report itself, which is the one failure a budget cannot have.
    assert.equal(cuForMethodV1('eth_someMethodNobodyPriced'), RPC_CU_DEFAULT_V1);
    assert.ok(RPC_CU_DEFAULT_V1 >= cuForMethodV1('eth_call'));
  });

  test('a batch costs the sum of its calls — batching saves round trips, not CU', () => {
    assert.equal(cuForBatchV1(['eth_call', 'eth_call', 'eth_blockNumber']), 26 + 26 + 10);
    assert.equal(cuForBatchV1([]), 0);
  });

  test('the Use & access page and the hundred-contract sweep, priced', () => {
    // Three rounds for one address: 5 + up to 8 + 1 eth_calls, plus an anchor.
    const oneAddress = cuForBatchV1(['eth_blockNumber', ...Array(14).fill('eth_call')]);
    assert.equal(oneAddress, 10 + 14 * 26);
    // 100 contracts × 3 reads, which measured 7,800 CU against the real plan.
    assert.equal(cuForBatchV1(Array(300).fill('eth_call')), 7_800);
  });
});

describe('which endpoint a batch goes to', () => {
  const configured = { spentCu: 0, alchemyConfigured: true };

  test('an unconfigured Alchemy is not a budget decision', () => {
    const choice = chooseRpcEndpointV1({ spentCu: 0, alchemyConfigured: false }, ['eth_call']);
    assert.deepEqual(choice, { provider: 'fallback', reason: 'no_alchemy_endpoint' });
  });

  test('inside the budget, the metered endpoint', () => {
    assert.deepEqual(chooseRpcEndpointV1(configured, ['eth_call']), {
      provider: 'alchemy',
      reason: 'within_budget',
    });
  });

  test('a reserve is held back, so the fallback is a decision and not a cliff', () => {
    // 90% spent is still inside the plan and already past the spendable line.
    const nearlyGone = { spentCu: RPC_MONTHLY_CU_BUDGET_V1 * 0.9, alchemyConfigured: true };
    assert.deepEqual(chooseRpcEndpointV1(nearlyGone, ['eth_call']), {
      provider: 'fallback',
      reason: 'budget_exhausted',
    });
  });

  test('a batch that would cross the line goes to the fallback WHOLE', () => {
    // Half-served and half-refused is the shape this repository keeps
    // mistaking for a finding.
    const almost = { spentCu: RPC_MONTHLY_CU_BUDGET_V1 * 0.9 - 30, alchemyConfigured: true };
    assert.equal(chooseRpcEndpointV1(almost, ['eth_call']).provider, 'alchemy');
    assert.deepEqual(chooseRpcEndpointV1(almost, ['eth_call', 'eth_call']), {
      provider: 'fallback',
      reason: 'batch_exceeds_remaining',
    });
  });

  test('a caller may set its own budget, and zero means never', () => {
    const choice = chooseRpcEndpointV1(
      { spentCu: 0, alchemyConfigured: true, budgetCu: 0 },
      ['eth_call'],
    );
    assert.equal(choice.provider, 'fallback');
  });
});

describe('what the month has cost, in words an operator can act on', () => {
  const now = new Date('2026-09-03T12:00:00.000Z');

  test('the window is the calendar month a monthly plan resets on', () => {
    assert.equal(rpcBudgetMonthV1(now), '2026-09');
    assert.equal(rpcBudgetMonthV1(new Date('2026-12-31T23:59:59.000Z')), '2026-12');
    assert.equal(rpcBudgetMonthV1(new Date('2027-01-01T00:00:00.000Z')), '2027-01');
  });

  test('the report says what is left in the read this surface actually issues', () => {
    const report = rpcBudgetReportV1({ now, spentCu: 7_800 });
    assert.equal(report.spentCu, 7_800);
    assert.equal(report.budgetCu, RPC_MONTHLY_CU_BUDGET_V1);
    assert.equal(report.spendableCu, 270_000_000);
    assert.equal(report.remainingCu, 270_000_000 - 7_800);
    // ~10.4 million eth_calls left. The number that makes "is this affordable"
    // answerable without arithmetic.
    assert.equal(report.remainingEthCalls, Math.floor((270_000_000 - 7_800) / 26));
    assert.equal(report.exhausted, false);
    assert.ok(report.usedFraction < 0.0001);
  });

  test('past the line is exhausted, and a negative spend is not a credit', () => {
    assert.equal(rpcBudgetReportV1({ now, spentCu: 300_000_000 }).exhausted, true);
    assert.equal(rpcBudgetReportV1({ now, spentCu: -5 }).spentCu, 0);
  });
});
