import assert from 'node:assert/strict';
import test from 'node:test';
import { isMoonwellActionType, validateMoonwellAction } from './moonwellGuard.js';
import { evaluateExecutableAction } from './executionGuard.js';

const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const M_USDC = '0x2222222222222222222222222222222222222222';
const COMPTROLLER = '0x3333333333333333333333333333333333333333';

function erc20Calldata(selector: string, account: string, amount: bigint): string {
  return `${selector}${account.slice(2).toLowerCase().padStart(64, '0')}${amount.toString(16).padStart(64, '0')}`;
}

function approveStep(spender = M_USDC, usdc = 100): { to: string; data: string; value: string } {
  return { to: USDC, data: erc20Calldata('0x095ea7b3', spender, BigInt(usdc) * 1_000_000n), value: '0x0' };
}

function enterMarketStep(): { to: string; data: string; value: string } {
  return { to: COMPTROLLER, data: `0xc2998238${'0'.repeat(128)}`, value: '0x0' };
}

function verbStep(to = M_USDC): { to: string; data: string; value: string } {
  // mint(uint256) style protocol call — opaque to the validator by design.
  return { to, data: `0xa0712d68${(100_000_000n).toString(16).padStart(64, '0')}`, value: '0x0' };
}

test('isMoonwellActionType covers exactly the four verbs', () => {
  for (const verb of ['moonwell_supply', 'moonwell_withdraw', 'moonwell_borrow', 'moonwell_repay']) {
    assert.equal(isMoonwellActionType(verb), true);
  }
  assert.equal(isMoonwellActionType('limited_transfer'), false);
  assert.equal(isMoonwellActionType('moonwell_prepare_supply'), false);
});

test('accepts a valid approve + enter-market + supply batch', () => {
  const result = validateMoonwellAction({
    chain: 'eip155:8453',
    actionType: 'moonwell_supply',
    calls: [approveStep(), enterMarketStep(), verbStep()],
    amountDecimal: '100',
  });
  assert.equal(result.success, true, result.reason);
  assert.equal(result.code, 'allowed');
  assert.deepEqual(result.semantics?.tokenAddresses, [USDC.toLowerCase()]);
  assert.deepEqual(result.semantics?.recipients, []);
  assert.deepEqual(result.semantics?.spenders.map((s) => s.toLowerCase()), [M_USDC.toLowerCase()]);
  assert.equal(result.semantics?.spendAmountUsdc, 100);
  assert.equal(result.semantics?.spendAmountRaw, '100000000');
});

test('accepts a single-step repay batch (verb only)', () => {
  const result = validateMoonwellAction({
    chain: 'eip155:8453',
    actionType: 'moonwell_repay',
    calls: [verbStep()],
    amountDecimal: '5.5',
  });
  assert.equal(result.success, true, result.reason);
  assert.equal(result.semantics?.spendAmountUsdc, 5.5);
});

test('rejects a non-Moonwell action type and non-mainnet chain', () => {
  assert.equal(validateMoonwellAction({
    chain: 'eip155:8453',
    actionType: 'limited_transfer' as never,
    calls: [verbStep()],
    amountDecimal: '1',
  }).code, 'moonwell_action_type_invalid');

  assert.equal(validateMoonwellAction({
    chain: 'eip155:84532',
    actionType: 'moonwell_supply',
    calls: [verbStep()],
    amountDecimal: '1',
  }).code, 'moonwell_mainnet_only');
});

test('rejects a step with a non-Base chainId', () => {
  const result = validateMoonwellAction({
    chain: 'eip155:8453',
    actionType: 'moonwell_supply',
    calls: [{ ...verbStep(), chainId: 10 }],
    amountDecimal: '1',
  });
  assert.equal(result.code, 'moonwell_step_wrong_chain');
});

test('rejects native value on any step', () => {
  const result = validateMoonwellAction({
    chain: 'eip155:8453',
    actionType: 'moonwell_supply',
    calls: [{ ...verbStep(), value: '0x1' }],
    amountDecimal: '1',
  });
  assert.equal(result.code, 'moonwell_native_value_blocked');
});

test('rejects an approve on a non-canonical token', () => {
  const result = validateMoonwellAction({
    chain: 'eip155:8453',
    actionType: 'moonwell_supply',
    calls: [{ ...approveStep(), to: '0x4444444444444444444444444444444444444444' }, verbStep()],
    amountDecimal: '100',
  });
  assert.equal(result.code, 'moonwell_approve_noncanonical_token');
});

test('rejects an approve whose spender is not a later step target', () => {
  const result = validateMoonwellAction({
    chain: 'eip155:8453',
    actionType: 'moonwell_supply',
    calls: [approveStep('0x5555555555555555555555555555555555555555'), verbStep(M_USDC)],
    amountDecimal: '100',
  });
  assert.equal(result.code, 'moonwell_approve_spender_outside_batch');
});

test('rejects an approve amount that differs from the prepared amount', () => {
  const over = validateMoonwellAction({
    chain: 'eip155:8453',
    actionType: 'moonwell_supply',
    calls: [approveStep(M_USDC, 101), verbStep()],
    amountDecimal: '100',
  });
  assert.equal(over.code, 'moonwell_approve_amount_mismatch');
});

test('rejects batches with more than four steps or a non-final verb step', () => {
  const tooMany = validateMoonwellAction({
    chain: 'eip155:8453',
    actionType: 'moonwell_supply',
    calls: [approveStep(), enterMarketStep(), enterMarketStep(), enterMarketStep(), verbStep()],
    amountDecimal: '100',
  });
  assert.equal(tooMany.code, 'moonwell_step_count_invalid');

  const verbNotLast = validateMoonwellAction({
    chain: 'eip155:8453',
    actionType: 'moonwell_supply',
    calls: [verbStep(), approveStep()],
    amountDecimal: '100',
  });
  assert.equal(verbNotLast.code, 'moonwell_batch_shape_invalid');
});

test('rejects a final step that is raw ERC-20 transfer calldata', () => {
  const result = validateMoonwellAction({
    chain: 'eip155:8453',
    actionType: 'moonwell_supply',
    calls: [{ to: USDC, data: erc20Calldata('0xa9059cbb', M_USDC, 1_000_000n), value: '0x0' }],
    amountDecimal: '1',
  });
  assert.equal(result.code, 'moonwell_final_step_erc20');
});

test('rejects a missing or non-positive prepared amount', () => {
  assert.equal(validateMoonwellAction({
    chain: 'eip155:8453',
    actionType: 'moonwell_supply',
    calls: [verbStep()],
  }).code, 'moonwell_amount_invalid');
  assert.equal(validateMoonwellAction({
    chain: 'eip155:8453',
    actionType: 'moonwell_supply',
    calls: [verbStep()],
    amountDecimal: '0',
  }).code, 'moonwell_amount_invalid');
});

test('evaluateExecutableAction routes moonwell types through the strict validator with GoPlus required', async () => {
  const base = {
    chain: 'eip155:8453',
    actionType: 'moonwell_supply' as const,
    calls: [approveStep(), verbStep()],
    instruction: 'supply 100 USDC to moonwell',
    moonwell: { amountDecimal: '100' },
  };

  const noSecurity = await evaluateExecutableAction(base);
  assert.equal(noSecurity.allowed, false);
  assert.equal(noSecurity.code, 'security_screening_blocked');

  const withSecurity = await evaluateExecutableAction({
    ...base,
    providerContext: { risk: 'connected', riskProvider: 'goplus', securityProvider: 'goplus' },
    tokenSecurity: [{ address: USDC, provider: 'goplus', status: 'ok' }],
  });
  assert.equal(withSecurity.allowed, true, withSecurity.reason);
  assert.equal(withSecurity.simulation?.success, true);
  assert.equal(withSecurity.simulation?.method, 'preflight-validation');
  assert.equal(withSecurity.semantics?.spendAmountUsdc, 100);
  assert.equal(withSecurity.contractSecurity.required, true);
  assert.equal(withSecurity.contractSecurity.status, 'passed');

  const badBatch = await evaluateExecutableAction({
    ...base,
    calls: [approveStep(M_USDC, 999), verbStep()],
    providerContext: { risk: 'connected', riskProvider: 'goplus', securityProvider: 'goplus' },
    tokenSecurity: [{ address: USDC, provider: 'goplus', status: 'ok' }],
  });
  assert.equal(badBatch.allowed, false);
  assert.equal(badBatch.code, 'moonwell_approve_amount_mismatch');
});
