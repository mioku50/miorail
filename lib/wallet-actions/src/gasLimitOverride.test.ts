import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { decodeFunctionData, parseAbi, type Hex } from 'viem';

import {
  GAS_LIMIT_CALL_EXTRA_V1,
  GAS_LIMIT_MARGIN_PERCENT_V1,
  accountCodeMeasurableV1,
  batchPrefixDataV1,
  gasLimitOverrideSupportV1,
  gasLimitedCallsV1,
  intrinsicGasV1,
  measuredCallGasLimitsV1,
  paddedGasV1,
  walletSendCallsIdV1,
  walletSendCallsRequestV1,
  withGasLimitOverridesV1,
} from './gasLimitOverride';

const here = path.dirname(url.fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');

// ---------------------------------------------------------------------------
// 2026-11-12: a Base Account sale of AAPLc through KyberSwap reverted twice
// with "Call failed". The wallet gave the operation's calls 625,592 gas; the
// least they ran with one block earlier was 625,049 to 626,049; the swap
// needed more in the block it landed in. These tests hold the measurement that
// now gives such a batch its gas, and the one way it is sent.
// ---------------------------------------------------------------------------

const ACCOUNT = '0x1111111111111111111111111111111111111111' as const;
const TOKEN = '0xb200000000000000000000000000000000000001';
const ROUTER = '0x6131b5fae19ea4f9d964eac0408e4408b66337b5';
const SALE = [
  { to: TOKEN, data: `0x095ea7b3${'00'.repeat(12)}${ROUTER.slice(2)}${'0'.repeat(56)}2aa0ef`, value: '0x0' },
  { to: ROUTER, data: `0xe21fd0e9${'ab'.repeat(3200)}`, value: '0x0' },
];
const BATCH_ABI = parseAbi(['function executeBatch((address target, uint256 value, bytes data)[] calls)']);

/** An estimator that answers what a node would: the prefix's run plus that transaction's intrinsic gas. */
function nodeV1(runs: readonly bigint[], seen: { from: Hex; to: Hex; count: number }[] = []) {
  return async (tx: { from: Hex; to: Hex; data: Hex }) => {
    const decoded = decodeFunctionData({ abi: BATCH_ABI, data: tx.data });
    const count = (decoded.args[0] as readonly unknown[]).length;
    seen.push({ from: tx.from, to: tx.to, count });
    return runs[count - 1]! + intrinsicGasV1(tx.data);
  };
}

test('Base Account announces the capability for every chain; this chain’s own answer wins', () => {
  assert.equal(gasLimitOverrideSupportV1({ 0: { gasLimitOverride: { supported: true } } }), true);
  assert.equal(gasLimitOverrideSupportV1({ '0x0': { gasLimitOverride: { supported: true } } }), true);
  assert.equal(gasLimitOverrideSupportV1({ 8453: { gasLimitOverride: { supported: true } } }), true);
  assert.equal(gasLimitOverrideSupportV1({ '0x2105': { gasLimitOverride: { supported: true } } }), true);
  assert.equal(
    gasLimitOverrideSupportV1({ 0: { gasLimitOverride: { supported: true } }, 8453: { gasLimitOverride: { supported: false } } }),
    false,
  );
  // Not said is not yes: MetaMask, Rabby, a wallet that answered nothing.
  assert.equal(gasLimitOverrideSupportV1({ 8453: { atomic: { status: 'supported' } } }), false);
  assert.equal(gasLimitOverrideSupportV1(undefined), false);
  assert.equal(gasLimitOverrideSupportV1({ 1: { gasLimitOverride: { supported: true } } }), false);
});

test('intrinsic gas is 21,000 and the data: 16 a non-zero byte, 4 a zero one', () => {
  assert.equal(intrinsicGasV1('0x'), BigInt(21_000));
  assert.equal(intrinsicGasV1('0x00ff'), BigInt(21_000 + 4 + 16));
});

test('each call gets what its prefix adds, with the margin and the extra', async () => {
  const seen: { from: Hex; to: Hex; count: number }[] = [];
  // What the failed sale measured: the approval with the account's own overhead, then the whole batch.
  const limits = await measuredCallGasLimitsV1({ from: ACCOUNT, calls: SALE, estimate: nodeV1([BigInt(38_000), BigInt(632_688)], seen) });
  assert.ok(limits);
  assert.deepEqual(limits, [paddedGasV1(BigInt(38_000)), paddedGasV1(BigInt(632_688 - 38_000))]);
  assert.equal(paddedGasV1(BigInt(100_000)), BigInt(100_000) + (BigInt(100_000) * GAS_LIMIT_MARGIN_PERCENT_V1) / BigInt(100) + GAS_LIMIT_CALL_EXTRA_V1);
  // The account runs its own batch, as the wallet will: from itself, to itself, one prefix per call.
  assert.deepEqual(seen.map((entry) => entry.count).sort(), [1, 2]);
  for (const entry of seen) {
    assert.equal(entry.from, ACCOUNT);
    assert.equal(entry.to, ACCOUNT);
  }
  // Their sum is well above the least the sale ran with, and above what the wallet gave it.
  const total = limits.reduce((sum, limit) => sum + limit, BigInt(0));
  assert.ok(total >= (BigInt(626_049) * BigInt(125)) / BigInt(100), String(total));
  assert.ok(total > BigInt(625_592));
});

test('a prefix is the batch’s first calls, exactly as approved', () => {
  const decoded = decodeFunctionData({ abi: BATCH_ABI, data: batchPrefixDataV1(SALE, 1) });
  const calls = decoded.args[0] as readonly { target: string; value: bigint; data: string }[];
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.target.toLowerCase(), TOKEN);
  assert.equal(calls[0]!.data, SALE[0]!.data);
  assert.equal(calls[0]!.value, BigInt(0));
});

test('nothing measured is nothing sent: a failed estimate, a run of nothing, no calls, too many', async () => {
  assert.equal(await measuredCallGasLimitsV1({ from: ACCOUNT, calls: SALE, estimate: async () => { throw new Error('execution reverted'); } }), null);
  // An estimate that is only the transaction's own intrinsic gas ran nothing.
  assert.equal(await measuredCallGasLimitsV1({ from: ACCOUNT, calls: SALE, estimate: nodeV1([BigInt(0), BigInt(0)]) }), null);
  assert.equal(await measuredCallGasLimitsV1({ from: ACCOUNT, calls: [], estimate: nodeV1([]) }), null);
  const many = Array.from({ length: 13 }, () => SALE[0]!);
  assert.equal(await measuredCallGasLimitsV1({ from: ACCOUNT, calls: many, estimate: nodeV1(many.map(() => BigInt(50_000))) }), null);
});

test('a prefix estimated a little lower than the one before gives its call the extra alone, never less', async () => {
  const limits = await measuredCallGasLimitsV1({ from: ACCOUNT, calls: SALE, estimate: nodeV1([BigInt(60_000), BigInt(59_000)]) });
  assert.deepEqual(limits, [paddedGasV1(BigInt(60_000)), GAS_LIMIT_CALL_EXTRA_V1]);
});

test('the calls carry their limit as a call capability, keeping any they had', () => {
  const sized = withGasLimitOverridesV1(
    [{ ...SALE[0]!, capabilities: { other: { value: 1 } } }, SALE[1]!],
    [BigInt(69_400), BigInt(793_094)],
  );
  assert.deepEqual(sized[0]!.capabilities, { other: { value: 1 }, gasLimitOverride: { value: '0x10f18' } });
  assert.deepEqual(sized[1]!.capabilities, { gasLimitOverride: { value: '0xc1a06' } });
  assert.equal(sized[1]!.data, SALE[1]!.data);
  // A count that does not match is not guessed at.
  assert.deepEqual(withGasLimitOverridesV1(SALE, [BigInt(1)]), SALE);
});

test('an account with no code yet, or an EOA’s 7702 delegation, is not measured', () => {
  assert.equal(accountCodeMeasurableV1(undefined), false);
  assert.equal(accountCodeMeasurableV1('0x'), false);
  assert.equal(accountCodeMeasurableV1(`0xef0100${'22'.repeat(20)}`), false);
  // Base Account: a 61-byte proxy.
  assert.equal(accountCodeMeasurableV1(`0x363d3d373d3d363d7f${'00'.repeat(52)}`), true);
});

test('the calls go unchanged unless the wallet takes the capability and the account was measured in time', async () => {
  let asked = 0;
  const counting = nodeV1([BigInt(38_000), BigInt(632_688)]);
  const estimate = async (tx: { from: Hex; to: Hex; data: Hex }) => { asked += 1; return counting(tx); };
  const code = async () => `0x363d3d373d3d363d7f${'00'.repeat(52)}`;
  const takes = { 0: { gasLimitOverride: { supported: true } } };

  const metamask = await gasLimitedCallsV1({ from: ACCOUNT, calls: SALE, capabilities: { 8453: { atomic: { status: 'supported' } } }, estimate, code });
  assert.equal(metamask.limits, null);
  assert.deepEqual(metamask.calls, SALE);
  assert.equal(asked, 0, 'a wallet that does not take the capability costs no estimate');

  const fresh = await gasLimitedCallsV1({ from: ACCOUNT, calls: SALE, capabilities: takes, estimate, code: async () => '0x' });
  assert.equal(fresh.limits, null, 'an account its first operation deploys is left to the wallet');
  assert.equal(asked, 0);

  const slow = await gasLimitedCallsV1({ from: ACCOUNT, calls: SALE, capabilities: takes, code, timeoutMs: 20, estimate: () => new Promise(() => {}) });
  assert.equal(slow.limits, null, 'a measurement that does not answer in time is no measurement');
  assert.deepEqual(slow.calls, SALE);

  const failing = await gasLimitedCallsV1({ from: ACCOUNT, calls: SALE, capabilities: takes, estimate, code: async () => { throw new Error('rpc down'); } });
  assert.equal(failing.limits, null);

  const measured = await gasLimitedCallsV1({ from: ACCOUNT.toUpperCase().replace('0X', '0x'), calls: SALE, capabilities: takes, estimate, code });
  assert.ok(measured.limits);
  assert.equal(measured.calls.length, 2);
  assert.ok(measured.calls.every((call) => typeof (call.capabilities?.gasLimitOverride as { value?: string })?.value === 'string'));
});

test('the request is the one viem sends, with each call’s capabilities kept', () => {
  const request = walletSendCallsRequestV1({
    account: ACCOUNT,
    chainId: 8453,
    forceAtomic: true,
    calls: withGasLimitOverridesV1(SALE, [BigInt(69_400), BigInt(793_094)]),
    capabilities: { dataSuffix: { value: '0x07', optional: true } },
  });
  assert.equal(request.method, 'wallet_sendCalls');
  const [params] = request.params;
  assert.equal(params.version, '2.0.0');
  assert.equal(params.chainId, '0x2105');
  assert.equal(params.from, ACCOUNT);
  assert.equal(params.atomicRequired, true);
  assert.deepEqual(params.capabilities, { dataSuffix: { value: '0x07', optional: true } });
  // A zero value is left out, as viem leaves it.
  assert.equal(params.calls[0]!.value, undefined);
  assert.deepEqual(params.calls[1]!.capabilities, { gasLimitOverride: { value: '0xc1a06' } });
  assert.equal(walletSendCallsRequestV1({ account: ACCOUNT, chainId: 8453, forceAtomic: false, calls: [{ to: TOKEN, value: '1000' }] }).params[0].calls[0]!.value, '0x3e8');
});

test('the batch id is read from either answer a wallet gives, and never invented', () => {
  assert.deepEqual(walletSendCallsIdV1('0xabc'), { id: '0xabc' });
  assert.deepEqual(walletSendCallsIdV1({ id: '0xdef', capabilities: {} }), { id: '0xdef' });
  assert.throws(() => walletSendCallsIdV1({}), /no id/);
  assert.throws(() => walletSendCallsIdV1(''), /no id/);
});

test('every batch to Base Account is measured, and calls carrying gas go only by the direct request', () => {
  const hook = readFileSync(path.join(here, 'useSubmitApprovedBlueprint.ts'), 'utf8');
  // Measured while the attempt is opened, so the wallet is not asked any later than before.
  const sizingAt = hook.indexOf('gasLimitedCallsV1({');
  const openAt = hook.indexOf('openAttempt(payload, storage)', sizingAt);
  assert.ok(sizingAt > 0 && openAt > sizingAt);
  assert.ok(hook.indexOf('const sized = await sizing;', openAt) > openAt);
  assert.match(hook, /capabilities: gasLimitsDeclinedRef\.current \? undefined : capabilities,/);
  // Dropped after a send that carried them failed, never after the person's own No.
  assert.match(hook, /const rejected = isWalletRejectionError\(cause\);\s*if \(sized\.limits && !rejected\) gasLimitsDeclinedRef\.current = true;/);
  for (const file of [
    'lib/wallet-actions/src/useSubmitApprovedBlueprint.ts',
    'artifacts/interface/src/features/rwa/LendingReviewPage.tsx',
    'artifacts/miniapp/app/lending/[draft]/page.tsx',
    'artifacts/interface/src/features/rwa/StockActionReviewPage.tsx',
  ]) {
    const source = readFileSync(path.join(root, file), 'utf8');
    assert.match(source, /gasLimitedCallsV1\(\{/, file);
    // The calls that are measured are the calls that are sent: attributed first, then sized.
    assert.match(source, /gasLimitedCallsV1\(\{[\s\S]{0,300}calls: attributedCallsV1\(\{ calls/, file);
    assert.match(source, /sized\.limits\s*(\/\/[^\n]*\n\s*)*\?\s*(await )?sendCallsKeepingCallCapabilitiesV1\(config, \{/, file);
    assert.match(source, /calls: sized\.calls/, file);
  }
});

test('a swap sent in steps is read from Base by its hashes; a batch waits for the wallet', async () => {
  const { submissionReconcilableV1 } = await import('./proofReconciliation');
  const terminal = ['confirmed', 'failed', 'submitted_unknown'] as const;
  const steps = { status: 'submitted' as const, proofId: 'route-proof:1', txHashes: ['0xaa', '0xbb'] };
  assert.equal(submissionReconcilableV1(steps, terminal), true);
  // A batch the wallet has not answered for yet has an id and no hash: nothing on Base to read.
  assert.equal(submissionReconcilableV1({ ...steps, txHashes: [] }, terminal), false);
  assert.equal(submissionReconcilableV1({ ...steps, proofId: null }, terminal), false);
  assert.equal(submissionReconcilableV1({ status: 'confirmed', proofId: 'route-proof:1', txHashes: [] }, terminal), true);
  assert.equal(submissionReconcilableV1({ status: 'submitting', proofId: 'route-proof:1', txHashes: ['0xaa'] }, terminal), false);
  assert.equal(submissionReconcilableV1(null, terminal), false);
  for (const file of [
    'artifacts/interface/src/features/console/RouteIntelligenceConsole.tsx',
    'artifacts/miniapp/app/components/MiniConsole.tsx',
    'artifacts/miniapp/app/components/RoutePlanHome.tsx',
  ]) {
    assert.match(readFileSync(path.join(root, file), 'utf8'), /submission && submission\.proofId && submissionReconcilableV1\(submission, RECONCILABLE/, file);
  }
});
