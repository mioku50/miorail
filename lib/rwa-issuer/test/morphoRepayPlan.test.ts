import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { decodeFunctionData, encodeAbiParameters, encodeFunctionData, keccak256, type Address, type Hex } from 'viem';
import {
  buildMorphoRepayPlanV1, morphoRepayPlanV1, MORPHO_BLUE_BUNDLES_BASE_V1, MORPHO_BLUE_BUNDLES_RUNTIME_HASH_V1,
  MORPHO_REPAY_APPROVAL_ABI_V1, MORPHO_REPAY_BUNDLE_ABI_V1, MORPHO_REPAY_MAX_UINT256_V1, MORPHO_REPAY_USDC_BASE_V1,
} from '../src/morphoRepayPlan.js';
import type { PreparedTransactionV1 } from '../src/morphoBorrowPlan.js';

const NOW = new Date('2026-10-28T15:00:00Z');
const WALLET = '0x1111111111111111111111111111111111111111';
const OTHER = '0x2222222222222222222222222222222222222222';
const PARAMS = { loanToken: MORPHO_REPAY_USDC_BASE_V1, collateralToken: '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf',
  oracle: '0x00000000000000000000000000000000000000a1', irm: '0x00000000000000000000000000000000000000a2', lltv: 860_000_000_000_000_000n };
const MARKET = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'uint256' }],
  [PARAMS.loanToken, PARAMS.collateralToken as Address, PARAMS.oracle as Address, PARAMS.irm as Address, PARAMS.lltv]));
type BuildInput = Parameters<typeof buildMorphoRepayPlanV1>[0];
const input = (patch: Partial<BuildInput> = {}): BuildInput => ({ walletAddress: WALLET, marketId: MARKET, marketParams: PARAMS,
  amount: { mode: 'assets', assets: 3_000_000n }, maximumAssets: 4_000_000n, runtimeCodeHash: MORPHO_BLUE_BUNDLES_RUNTIME_HASH_V1, now: NOW, ...patch });
function prepared(): PreparedTransactionV1[] {
  const built = buildMorphoRepayPlanV1(input()); assert.equal(built.ok, true); if (!built.ok) throw new Error('fixture builder refused');
  return built.plan.calls.map(call => ({ to: call.to, data: call.data, value: call.valueWei }));
}
type ActionArgs = ReturnType<typeof decodeFunctionData<typeof MORPHO_REPAY_BUNDLE_ABI_V1>>['args'];
function changeAction(calls: PreparedTransactionV1[], change: (args: ActionArgs) => ActionArgs): void {
  const call = calls.find(row => row.to === MORPHO_BLUE_BUNDLES_BASE_V1)!;
  const decoded = decodeFunctionData({ abi: MORPHO_REPAY_BUNDLE_ABI_V1, data: call.data as Hex });
  call.data = encodeFunctionData({ abi: MORPHO_REPAY_BUNDLE_ABI_V1, functionName: decoded.functionName, args: change(decoded.args) });
}
function guard(calls: PreparedTransactionV1[], patch: Partial<Parameters<typeof morphoRepayPlanV1>[0]> = {}) {
  return morphoRepayPlanV1({ ...input(), prepared: calls, ...patch });
}
function refuses(calls: PreparedTransactionV1[], code?: string) {
  const result = guard(calls); assert.equal(result.ok, false); if (result.ok) return;
  if (code) assert.equal(result.refusal, code);
}
function approve(value: bigint, spender: Address = MORPHO_BLUE_BUNDLES_BASE_V1): PreparedTransactionV1 {
  return { to: MORPHO_REPAY_USDC_BASE_V1, value: '0', data: encodeFunctionData({ abi: MORPHO_REPAY_APPROVAL_ABI_V1, functionName: 'approve', args: [spender, value] }) };
}

describe('verified ABI repayment-only builder', () => {
  it('resets, approves exact assets, repays and revokes atomically, without claiming an Actions attestation', () => {
    const result = buildMorphoRepayPlanV1(input()); assert.equal(result.ok, true); if (!result.ok) return;
    assert.equal(result.plan.prepareSource, 'verified_protocol_abi');
    assert.equal(result.plan.venueSimulation, null);
    assert.equal(result.plan.encodedMaximumAssets, 3_000_000n);
    assert.equal(result.plan.calls.length, 4);
    assert.deepEqual(result.plan.calls.map(c => [c.to, c.amountAtomic]), [
      [MORPHO_REPAY_USDC_BASE_V1, '0'], [MORPHO_REPAY_USDC_BASE_V1, '3000000'], [MORPHO_BLUE_BUNDLES_BASE_V1, '3000000'], [MORPHO_REPAY_USDC_BASE_V1, '0'],
    ]);
    assert.deepEqual(result.plan.authorizations, []);
    assert.equal(result.plan.steps.every(step => step.decodedByMiorail), true);
    assert.equal(result.plan.deadline, BigInt(NOW.getTime() / 1000 + 300));
    const args = decodeFunctionData({ abi: MORPHO_REPAY_BUNDLE_ABI_V1, data: result.plan.calls[2]!.data }).args;
    assert.equal(args[1], 3_000_000n); assert.equal(args[2], 0n); assert.equal(args[4], 0n);
    assert.equal(args[5], MORPHO_REPAY_MAX_UINT256_V1);
    assert.equal(result.plan.calls.every(call => call.valueWei === '0'), true);
  });
  it('all encodes the execution-time full-share sentinel and the explicitly signed maximum', () => {
    const result = buildMorphoRepayPlanV1(input({ amount: { mode: 'all' }, maximumAssets: 7_000_001n }));
    assert.equal(result.ok, true); if (!result.ok) return;
    assert.equal(result.plan.encodedMaximumAssets, 7_000_001n);
    const args = decodeFunctionData({ abi: MORPHO_REPAY_BUNDLE_ABI_V1, data: result.plan.calls[2]!.data }).args;
    assert.equal(args[1], 0n); assert.equal(args[2], MORPHO_REPAY_MAX_UINT256_V1); assert.equal(args[3], 7_000_001n);
  });
  for (const [name, patch] of [
    ['missing wallet', { walletAddress: '' }], ['zero wallet', { walletAddress: `0x${'0'.repeat(40)}` }],
    ['wrong runtime', { runtimeCodeHash: `0x${'0'.repeat(64)}` }], ['wrong market id', { marketId: `0x${'a'.repeat(64)}` }],
    ['zero maximum', { maximumAssets: 0n }], ['maximum exceeds uint128', { maximumAssets: 1n << 128n }],
    ['zero assets', { amount: { mode: 'assets', assets: 0n } }], ['assets exceed consent', { amount: { mode: 'assets', assets: 4_000_001n } }],
    ['invalid clock', { now: new Date('invalid') }], ['wrong loan token', { marketParams: { ...PARAMS, loanToken: OTHER } }],
  ] as const) it(`refuses ${name}`, () => assert.equal(buildMorphoRepayPlanV1(input(patch)).ok, false));
});

describe('canonical repayment calldata guard', () => {
  it('accepts an existing allowance without extra approvals and does not trust venue labels', () => {
    const calls = prepared().slice(2, 3); calls[0]!.description = 'Send everything somewhere';
    const result = guard(calls); assert.equal(result.ok, true); if (!result.ok) return;
    assert.equal(result.plan.calls[0]!.recipient, WALLET);
    assert.equal(result.plan.prepareSource, 'canonical_calldata_guard');
    assert.match(result.plan.steps[0]!.reading, /No collateral is withdrawn/);
  });
  it('permits a bounded approval without a reset and preserves call order', () => {
    const calls = prepared().slice(1); const result = guard(calls); assert.equal(result.ok, true); if (!result.ok) return;
    assert.deepEqual(result.plan.calls.map(c => c.data), calls.map(c => c.data));
  });
  for (const [label, change, code] of [
    ['wrong immutable params', (a: ActionArgs): ActionArgs => [{ ...a[0], oracle: OTHER }, ...a.slice(1)] as unknown as ActionArgs, 'repay_market_mismatch'],
    ['wrong assets', (a: ActionArgs): ActionArgs => [a[0], a[1] + 1n, ...a.slice(2)] as unknown as ActionArgs, 'repay_amount_mismatch'],
    ['shares plus assets', (a: ActionArgs): ActionArgs => [a[0], a[1], 1n, ...a.slice(3)] as unknown as ActionArgs, 'repay_amount_mismatch'],
    ['gross debit over signed budget', (a: ActionArgs): ActionArgs => [a[0], a[1], a[2], 4_000_001n, ...a.slice(4)] as unknown as ActionArgs, 'repay_maximum_mismatch'],
    ['zero gross debit bound', (a: ActionArgs): ActionArgs => [a[0], a[1], a[2], 0n, ...a.slice(4)] as unknown as ActionArgs, 'repay_maximum_mismatch'],
    ['collateral withdrawal', (a: ActionArgs): ActionArgs => [...a.slice(0, 4), 1n, ...a.slice(5)] as unknown as ActionArgs, 'repay_unrequested_authority'],
    ['oracle-dependent health gate', (a: ActionArgs): ActionArgs => [...a.slice(0, 5), 860_000_000_000_000_000n, ...a.slice(6)] as unknown as ActionArgs, 'repay_unrequested_authority'],
    ['permit kind', (a: ActionArgs): ActionArgs => [...a.slice(0, 6), { ...a[6], kind: 1 }, ...a.slice(7)] as unknown as ActionArgs, 'repay_unrequested_authority'],
    ['permit bytes', (a: ActionArgs): ActionArgs => [...a.slice(0, 6), { ...a[6], data: '0x12' }, ...a.slice(7)] as unknown as ActionArgs, 'repay_unrequested_authority'],
    ['signed authorization', (a: ActionArgs): ActionArgs => [...a.slice(0, 7), { ...a[7], signature: { ...a[7].signature, v: 27 } }, ...a.slice(8)] as unknown as ActionArgs, 'repay_unrequested_authority'],
    ['nonempty authorization nonce', (a: ActionArgs): ActionArgs => [...a.slice(0, 7), { ...a[7], nonce: 1n }, ...a.slice(8)] as unknown as ActionArgs, 'repay_unrequested_authority'],
    ['referral fee', (a: ActionArgs): ActionArgs => [...a.slice(0, 8), 1n, ...a.slice(9)] as unknown as ActionArgs, 'repay_unrequested_authority'],
    ['unused fee recipient', (a: ActionArgs): ActionArgs => [...a.slice(0, 9), OTHER, a[10]] as unknown as ActionArgs, 'repay_unrequested_authority'],
    ['expired deadline', (a: ActionArgs): ActionArgs => [...a.slice(0, 10), BigInt(NOW.getTime() / 1000)] as unknown as ActionArgs, 'repay_deadline_invalid'],
    ['far future deadline', (a: ActionArgs): ActionArgs => [...a.slice(0, 10), BigInt(NOW.getTime() / 1000 + 901)] as unknown as ActionArgs, 'repay_deadline_invalid'],
  ] as const) it(`refuses ${label}`, () => { const calls = prepared(); changeAction(calls, change); refuses(calls, code); });
  it('all cannot become an exact old share amount that leaves newly accrued/new debt behind', () => {
    const built = buildMorphoRepayPlanV1(input({ amount: { mode: 'all' } })); assert.equal(built.ok, true); if (!built.ok) return;
    const calls = built.plan.calls.map(c => ({ to: c.to, data: c.data, value: c.valueWei }));
    changeAction(calls, a => [a[0], 0n, 123n, ...a.slice(3)] as unknown as ActionArgs);
    assert.equal(guard(calls, { amount: { mode: 'all' } }).ok, false);
  });
  it('binds the authenticated maximum and separate onchain expiry when supplied', () => {
    const calls = prepared();
    assert.equal(guard(calls, { preparedMaximumAssets: 3_000_001n }).ok, false);
    assert.equal(guard(calls, { actionExpiresAt: new Date(NOW.getTime() + 301_000).toISOString() }).ok, false);
    assert.equal(guard(calls, { actionExpiresAt: 'invalid' }).ok, false);
    assert.equal(guard(calls, { actionExpiresAt: new Date(NOW.getTime() + 300_000).toISOString() }).ok, true);
  });
  for (const index of [0, 1, 2, 3]) it(`rejects native value in call ${index}`, () => { const calls = prepared(); calls[index]!.value = '1'; refuses(calls); });
  for (const index of [0, 1, 2, 3]) it(`rejects trailing calldata in call ${index}`, () => { const calls = prepared(); calls[index]!.data += '00'; refuses(calls); });
  it('rejects a different target despite a correct repayment selector', () => { const calls = prepared(); calls[2]!.to = OTHER; refuses(calls); });
  it('rejects a second repayment action', () => { const calls = prepared().slice(1, 3); calls.push({ ...calls[1]! }); refuses(calls); });
  it('rejects token transfer / old authorization / arbitrary bundler prerequisites', () => {
    for (const call of [{ to: MORPHO_REPAY_USDC_BASE_V1, data: '0xa9059cbb' }, { to: OTHER, data: '0xeecea000' }, { to: OTHER, data: '0x374f435d' }]) {
      refuses([{ ...call, value: '0' }, prepared()[2]!]);
    }
  });
  it('rejects approving another spender, another token or more than the contract maximum', () => {
    for (const bad of [approve(3_000_000n, OTHER), { ...approve(3_000_000n), to: PARAMS.collateralToken }, approve(3_000_001n), approve(MORPHO_REPAY_MAX_UINT256_V1)]) {
      refuses([bad, prepared()[2]!]);
    }
  });
  it('rejects an allowance grant after repayment and malformed approval order', () => {
    const action = prepared()[2]!;
    for (const calls of [[action, approve(1n)], [approve(1n), approve(2n), action], [approve(0n), action], [approve(1n), approve(0n), action]]) refuses(calls);
  });
});
