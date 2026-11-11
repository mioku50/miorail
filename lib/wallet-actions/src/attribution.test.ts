import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { decodeAbiParameters, decodeFunctionData, encodeAbiParameters, encodeFunctionData, parseAbi, type Hex } from 'viem';
import { attributedCallsV1, builderCodeToDataSuffix, resetAttributionWarningForTest } from './attribution';
import { sponsoredGasPlanV1 } from './sponsoredGas';

test('builderCodeToDataSuffix handles valid codes', () => {
  resetAttributionWarningForTest();
  const suffix = builderCodeToDataSuffix('bc_12345678');
  assert.ok(suffix);
  assert.equal(typeof suffix, 'string');
  assert.ok(suffix.startsWith('0x'));
});

test('builderCodeToDataSuffix returns undefined for missing, empty, or placeholder codes', () => {
  resetAttributionWarningForTest();
  assert.equal(builderCodeToDataSuffix(undefined), undefined);
  assert.equal(builderCodeToDataSuffix(''), undefined);
  assert.equal(builderCodeToDataSuffix('placeholder'), undefined);
  assert.equal(builderCodeToDataSuffix('miorail-placeholder'), undefined);
  assert.equal(builderCodeToDataSuffix('TODO'), undefined);
  assert.equal(builderCodeToDataSuffix('YOUR_BUILDER_CODE'), undefined);
});

test('builderCodeToDataSuffix returns undefined and never throws when Attribution.toDataSuffix throws', () => {
  resetAttributionWarningForTest();
  const res = builderCodeToDataSuffix('bc_bad_code', () => {
    throw new Error('Simulated ERC-8021 format error');
  });
  assert.equal(res, undefined);
});

// 2026-11-09: MetaMask drops the optional `dataSuffix`; its EIP-7702 batches carried no Builder Code at all.
const SUFFIX = '0x62635f7a3275756f3464740b0080218021802180218021802180218021';
const METAMASK = { '0x2105': { atomic: { status: 'supported' } } };
const CALLS = [
  { to: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', data: '0x095ea7b300000000000000000000000017905db0e4a3514467539956c084180616ae7b8d00000000000000000000000000000000000000000000000000000000001c3a90', value: '0x0' },
  { to: '0x17905db0e4a3514467539956c084180616ae7b8d', data: '0x12345678deadbeef', value: '0x0' },
];

test('a wallet that does not report dataSuffix gets the code in each call: the approved bytes, zeros to a word, then the code', () => {
  const sent = attributedCallsV1({ calls: CALLS, suffix: SUFFIX, capabilities: METAMASK });
  for (const [i, call] of sent.entries()) {
    const approved = CALLS[i]!.data;
    assert.ok(call.data!.startsWith(approved), 'the approved bytes come first, unchanged');
    assert.ok(call.data!.endsWith(SUFFIX.slice(2)), 'the code comes last');
    assert.equal((call.data!.length - 2) % 64, 0, 'the call ends on a 32-byte word');
    assert.match(call.data!.slice(approved.length, call.data!.length - (SUFFIX.length - 2)), /^(?:00)*$/, 'only zeros between');
    assert.equal(call.to, CALLS[i]!.to); assert.equal(call.value, CALLS[i]!.value);
  }
});

// Audit WAL-5: the Action Inbox sends ETH as a call with no data. With the code appended it would run the
// recipient's fallback, which a contract wallet may not have.
test('a plain transfer, with no data, is never given the code', () => {
  const plain: Array<{ to: string; data?: string; value: string }> = [{ to: CALLS[0]!.to, value: '0x3e8' }, { to: CALLS[0]!.to, data: '0x', value: '0x3e8' }, CALLS[1]!];
  const sent = attributedCallsV1({ calls: plain, suffix: SUFFIX, capabilities: METAMASK });
  assert.deepEqual(sent.slice(0, 2), plain.slice(0, 2));
  assert.ok(sent[2]!.data!.endsWith(SUFFIX.slice(2)));
});

test('in the ERC-7579 batch MetaMask’s delegate runs, the transaction’s input then ends with the code', () => {
  const sent = attributedCallsV1({ calls: CALLS, suffix: SUFFIX, capabilities: METAMASK });
  const executions = [{ type: 'tuple[]', components: [{ name: 'target', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'callData', type: 'bytes' }] }] as const;
  const input = encodeFunctionData({ abi: parseAbi(['function execute(bytes32 mode, bytes executionCalldata)']), functionName: 'execute',
    args: [`0x01${'0'.repeat(62)}`, encodeAbiParameters(executions, [sent.map(call => ({ target: call.to as Hex, value: 0n, callData: call.data as Hex }))])] });
  assert.ok(input.endsWith(SUFFIX.slice(2)), 'where indexers read it');
  // And the calls decode back exactly as sent.
  const decoded = decodeFunctionData({ abi: parseAbi(['function execute(bytes32 mode, bytes executionCalldata)']), data: input });
  const [back] = decodeAbiParameters(executions, decoded.args[1]);
  assert.deepEqual(back.map(call => call.callData), sent.map(call => call.data));
});

test('a wallet that adds the code itself, or has not answered yet, gets the calls exactly as approved', () => {
  for (const capabilities of [{ 8453: { dataSuffix: { supported: true } } }, { '0x2105': { dataSuffix: { supported: true } } }, undefined, null]) {
    assert.deepEqual(attributedCallsV1({ calls: CALLS, suffix: SUFFIX, capabilities }), CALLS, JSON.stringify(capabilities));
  }
  assert.deepEqual(attributedCallsV1({ calls: CALLS, suffix: undefined, capabilities: METAMASK }), CALLS);
  assert.deepEqual(attributedCallsV1({ calls: CALLS, suffix: '0xzz', capabilities: METAMASK }), CALLS);
  // A wallet that says it does not support it is given the code in its calls too.
  assert.notDeepEqual(attributedCallsV1({ calls: CALLS, suffix: SUFFIX, capabilities: { 8453: { dataSuffix: { supported: false } } } }), CALLS);
});

test('MetaMask, offered the sponsor it ignores, still gets the code in its calls', () => {
  // 2026-11-09: a267483f treated any attached sponsor as a sponsored batch, and MetaMask's offered loan
  // and stock swap went out with no code at all. Only a wallet that names paymasterService counts.
  const offer = { paymasterUrl: 'https://miorail.xyz/api/paymaster/sponsorship/t', context: { sponsorship: 't' } };
  const metamask = sponsoredGasPlanV1({ offer, capabilities: METAMASK, declinedBefore: false });
  assert.notEqual(metamask.capability, null);
  assert.equal(metamask.state, 'offered');
  assert.notDeepEqual(attributedCallsV1({ calls: CALLS, suffix: SUFFIX, capabilities: METAMASK, sponsored: metamask.state === 'sponsored' }), CALLS);
  const smart = { 8453: { atomic: { status: 'supported' }, paymasterService: { supported: true } } };
  const account = sponsoredGasPlanV1({ offer, capabilities: smart, declinedBefore: false });
  assert.equal(account.state, 'sponsored');
  assert.deepEqual(attributedCallsV1({ calls: CALLS, suffix: SUFFIX, capabilities: smart, sponsored: account.state === 'sponsored' }), CALLS);
});

test('a batch the fee sponsor pays for goes as approved, whatever the wallet says about dataSuffix', () => {
  // The sponsor checks the calls byte for byte, and only smart accounts, which add the code to the
  // user operation themselves, take it. Base Account's own answer about dataSuffix was never read.
  for (const capabilities of [METAMASK, { 8453: { atomic: { status: 'supported' }, paymasterService: { supported: true } } }, { 8453: { dataSuffix: { supported: false } } }]) {
    assert.deepEqual(attributedCallsV1({ calls: CALLS, suffix: SUFFIX, capabilities, sponsored: true }), CALLS, JSON.stringify(capabilities));
    assert.notDeepEqual(attributedCallsV1({ calls: CALLS, suffix: SUFFIX, capabilities, sponsored: false }), CALLS, JSON.stringify(capabilities));
  }
});

test('the swap, both loan pages and the Spend payment send their calls through the helper', () => {
  const here = path.dirname(url.fileURLToPath(import.meta.url)), root = path.resolve(here, '../../..');
  assert.match(readFileSync(path.join(here, 'useSubmitApprovedBlueprint.ts'), 'utf8'), /calls: attributedCallsV1\(\{ calls: payload\.calls\.map\(normalizeCall\), suffix, capabilities, chainId: base\.id, sponsored: gas\.state === 'sponsored' \}\)/);
  for (const page of ['artifacts/interface/src/features/rwa/LendingReviewPage.tsx', 'artifacts/miniapp/app/lending/[draft]/page.tsx', 'artifacts/interface/src/features/still/StillSpendWalletPage.tsx']) {
    assert.match(readFileSync(path.join(root, page), 'utf8'), /calls: attributedCallsV1\(\{ calls: /, page);
  }
  // Audit WAL-5 (2026-11-10): four more ways to the wallet sent only the capability, which MetaMask drops:
  // a stock action an assistant drafted, a B20 entry, the Action Inbox and the card in a chat.
  for (const page of ['artifacts/interface/src/features/rwa/StockActionReviewPage.tsx', 'artifacts/interface/src/features/b20/B20WatchPage.tsx',
    'lib/wallet-actions/src/useWalletConfirmAction.ts', 'artifacts/interface/src/mcp-app/stillCardWallet.ts']) {
    assert.match(readFileSync(path.join(root, page), 'utf8'), /calls: attributedCallsV1\(\{ calls/, page);
  }
  // Every wallet_sendCalls in the product sends its calls through the helper: a new one cannot forget it.
  const sources = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? (['node_modules', '.next', 'dist', 'e2e', 'test'].includes(entry.name) ? [] : sources(path.join(dir, entry.name)))
      : /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path.join(dir, entry.name)] : []);
  const senders = ['artifacts/interface/src', 'artifacts/miniapp/app', 'lib/wallet-actions/src'].flatMap((dir) => sources(path.join(root, dir)))
    .filter((file) => /sendCalls\.mutateAsync\(|method: 'wallet_sendCalls'/.test(readFileSync(file, 'utf8')));
  assert.ok(senders.length >= 9, `found ${senders.length} senders`);
  // Found's claim is the one sender with no Builder Code at all: it collects a gift, and is not counted as Still's activity.
  for (const file of senders.filter((file) => !file.endsWith('useFoundWalletClaim.ts'))) {
    assert.match(readFileSync(file, 'utf8'), /attributedCallsV1\(\{ calls/, path.relative(root, file));
  }
  // Both loan pages send a sponsored batch as approved; Spend has no sponsor.
  for (const page of ['artifacts/interface/src/features/rwa/LendingReviewPage.tsx', 'artifacts/miniapp/app/lending/[draft]/page.tsx']) {
    assert.match(readFileSync(path.join(root, page), 'utf8'), /suffix: LENDING_BUILDER_SUFFIX_V1, capabilities: [\w.]+, sponsored: gas\.state === 'sponsored' \}\)/, page);
  }
});
