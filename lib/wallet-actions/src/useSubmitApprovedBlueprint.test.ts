import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import * as mod from './useSubmitApprovedBlueprint';
import { blueprintSubmitDisabledReason, blueprintSubmitLabel } from './BlueprintSubmitButton';

const here = path.dirname(url.fileURLToPath(import.meta.url));

const PAYLOAD = {
  from: '0x1111111111111111111111111111111111111111' as const,
  chainId: '0x2105' as const,
  atomicRequired: true as const,
};

test('exports the hook and its pure helpers', () => {
  assert.equal(typeof mod.useSubmitApprovedBlueprint, 'function');
  assert.equal(typeof mod.isWalletRejectionError, 'function');
  assert.equal(typeof mod.blueprintSubmitPreflight, 'function');
  assert.equal(typeof mod.transactionHashesFromReceipts, 'function');
});

test('sendCalls is invoked in exactly one place, guarded by a single-flight ref', () => {
  const source = mod.useSubmitApprovedBlueprint.toString();
  const sendCallsInvocations = source.match(/sendCalls\.mutateAsync\(/g) ?? [];
  assert.equal(sendCallsInvocations.length, 1, 'the wallet batch must be sent from exactly one call site');
  assert.ok(/inFlightRef/.test(source), 'a single-flight ref must guard against double submits');
  assert.ok(/if\s*\(\s*inFlightRef\.current\s*\)\s*return/.test(source), 'a repeat call while in flight must be a no-op');
});

test('the hook never polls wallet status itself; polling stays in CallsStatusPoller', () => {
  const source = mod.useSubmitApprovedBlueprint.toString();
  assert.ok(!source.includes('useCallsStatus('), 'the hook must not call useCallsStatus directly');
  assert.ok(source.includes('CallsStatusPoller'), 'the hook must delegate polling to CallsStatusPoller');
});

test('dataSuffix is attached only as an optional capability derived from the builder code', () => {
  const source = mod.useSubmitApprovedBlueprint.toString();
  assert.ok(/builderCodeToDataSuffix/.test(source), 'attribution must come from builderCodeToDataSuffix');
  assert.ok(/optional:\s*(true|!0)/.test(source), 'the dataSuffix capability must be optional');
  assert.ok(/capabilities:\s*suffix\s*\?/.test(source), 'no capability may be attached without a suffix');
});

test('preflight fails closed on a from-address mismatch without opening the wallet', () => {
  const result = mod.blueprintSubmitPreflight({
    payload: PAYLOAD,
    connectedAddress: '0x2222222222222222222222222222222222222222',
    connectedChainId: 8453,
  });
  assert.equal(result.ok, false);
});

test('preflight fails closed on a non-Base chain', () => {
  const result = mod.blueprintSubmitPreflight({
    payload: PAYLOAD,
    connectedAddress: PAYLOAD.from,
    connectedChainId: 1,
  });
  assert.equal(result.ok, false);
});

test('preflight fails closed on a non-Base payload chain and a non-atomic payload', () => {
  assert.equal(
    mod.blueprintSubmitPreflight({
      payload: { ...PAYLOAD, chainId: '0x1' as never },
      connectedAddress: PAYLOAD.from,
      connectedChainId: 8453,
    }).ok,
    false,
  );
  assert.equal(
    mod.blueprintSubmitPreflight({
      payload: { ...PAYLOAD, atomicRequired: false as never },
      connectedAddress: PAYLOAD.from,
      connectedChainId: 8453,
    }).ok,
    false,
  );
  assert.equal(
    mod.blueprintSubmitPreflight({
      payload: PAYLOAD,
      connectedAddress: undefined,
      connectedChainId: 8453,
    }).ok,
    false,
  );
});

test('preflight passes for the exact approved binding (case-insensitive address)', () => {
  const result = mod.blueprintSubmitPreflight({
    payload: PAYLOAD,
    connectedAddress: PAYLOAD.from.toUpperCase().replace('0X', '0x'),
    connectedChainId: 8453,
  });
  assert.equal(result.ok, true);
});

test('wallet rejection detector matches message, code 4001, and shortMessage forms', () => {
  assert.equal(mod.isWalletRejectionError(new Error('User rejected the request')), true);
  assert.equal(mod.isWalletRejectionError(new Error('Popup closed by user')), true);
  assert.equal(mod.isWalletRejectionError(new Error('Request denied')), true);
  assert.equal(mod.isWalletRejectionError(Object.assign(new Error('boom'), { code: 4001 })), true);
  assert.equal(
    mod.isWalletRejectionError(Object.assign(new Error('boom'), { shortMessage: 'User rejected tx' })),
    true,
  );
  assert.equal(mod.isWalletRejectionError(new Error('network timeout')), false);
});

test('transactionHashesFromReceipts keeps only valid 32-byte hashes, lowercased and deduped', () => {
  const hash = `0x${'AB'.repeat(32)}`;
  assert.deepEqual(
    mod.transactionHashesFromReceipts([
      { transactionHash: hash },
      { transactionHash: hash.toLowerCase() },
      { transactionHash: '0x123' },
      {},
    ]),
    [hash.toLowerCase()],
  );
  assert.deepEqual(mod.transactionHashesFromReceipts(undefined), []);
});

test('normalizeWalletReceipts maps wagmi hex receipts into strict TransactionReceiptV1 status', () => {
  const hash = `0x${'AB'.repeat(32)}`;
  const receipts = mod.normalizeWalletReceipts([
    { transactionHash: hash, status: '0x1', blockNumber: '0x1f', gasUsed: '0x2d2', logs: [], blockHash: '0xabc' },
    { transactionHash: `0x${'cd'.repeat(32)}`, status: '0x0', blockNumber: 33n, gasUsed: 100 },
    { transactionHash: `0x${'ef'.repeat(32)}`, status: '0x7', blockNumber: null, gasUsed: undefined },
    { transactionHash: '0x123' },
  ]);
  // '0x1' -> success (hex block/gas decoded to base-10), '0x0' -> reverted,
  // unrecognized status -> unknown, malformed hash dropped.
  assert.equal(receipts.length, 3);
  assert.deepEqual(receipts[0], { transactionHash: hash.toLowerCase(), status: 'success', blockNumber: '31', gasUsed: '722' });
  assert.deepEqual(receipts[1], { transactionHash: `0x${'cd'.repeat(32)}`, status: 'reverted', blockNumber: '33', gasUsed: '100' });
  assert.equal(receipts[2]!.status, 'unknown');
  assert.equal(receipts[2]!.blockNumber, null);
  assert.deepEqual(mod.normalizeWalletReceipts(undefined), []);
  // A wallet must never let a normalizer fabricate success from a bare hash.
  assert.equal(mod.walletQuantityToAtomic('not-a-number'), null);
  assert.equal(mod.walletQuantityToAtomic('0x0'), '0');
});

test('button disabled reasons: wallet, chain, and review expiry are honest', () => {
  const now = new Date('2026-07-16T12:00:00.000Z');
  const fresh = new Date(now.getTime() + 60_000).toISOString();
  const stale = new Date(now.getTime() - 1_000).toISOString();
  assert.ok(blueprintSubmitDisabledReason({ address: undefined, chainId: 8453, quoteExpiry: fresh, now }));
  assert.ok(blueprintSubmitDisabledReason({ address: PAYLOAD.from, chainId: 1, quoteExpiry: fresh, now }));
  assert.ok(blueprintSubmitDisabledReason({ address: PAYLOAD.from, chainId: 8453, quoteExpiry: stale, now }));
  assert.equal(blueprintSubmitDisabledReason({ address: PAYLOAD.from, chainId: 8453, quoteExpiry: fresh, now }), null);
});

test('button label says the wallet will open and never claims server execution', () => {
  assert.equal(blueprintSubmitLabel('idle', null), 'Confirm in Base Account');
  assert.equal(blueprintSubmitLabel('submitting', null), 'Opening Base Account wallet…');
  assert.equal(blueprintSubmitLabel('confirmed', null), 'Confirmed onchain');
  assert.equal(blueprintSubmitLabel('idle', 'Connect a wallet to confirm'), 'Connect a wallet to confirm');
});

test('T58: recordSafely captures proofId/finalStatus from the record response, and the result exposes them', () => {
  const source = mod.useSubmitApprovedBlueprint.toString();
  // The record response is no longer thrown away — proofId/finalStatus are
  // captured into state from record.mutateAsync's response.
  assert.ok(/setProofId\(\s*response\.proofId\s*\)/.test(source), 'proofId must be captured from the record response');
  assert.ok(
    /setRecordedFinalStatus\(\s*response\.finalStatus\s*\)/.test(source),
    'recordedFinalStatus must be captured from the record response',
  );
  // A failed record must never fabricate a proof id (capture only in the try).
  assert.ok(/catch\s*(\(\w*\))?\s*\{\s*return\s+(false|!1)/.test(source), 'record failures still return false');
  // The hook result exposes both fields.
  assert.ok(/proofId,\s*recordedFinalStatus/.test(source), 'the hook result must expose proofId and recordedFinalStatus');
  // A fresh submit resets them before any new record.
  assert.ok(/setProofId\(\s*null\s*\)/.test(source), 'a new submit must reset proofId');
});

test('T58: the wallet hook still sends exactly one batch and never reconciles itself', () => {
  const source = mod.useSubmitApprovedBlueprint.toString();
  const sendCallsInvocations = source.match(/sendCalls\.mutateAsync\(/g) ?? [];
  assert.equal(sendCallsInvocations.length, 1, 'sendCalls must still be invoked from exactly one call site');
  assert.ok(!/reconcile/i.test(source), 'the wallet hook must never trigger reconciliation');
  assert.ok(!source.includes('useBoundedProofReconciliation'), 'reconciliation stays in api-client-react surfaces');
  const buttonSource = readFileSync(path.join(here, 'BlueprintSubmitButton.tsx'), 'utf8');
  assert.ok(!/useBoundedProofReconciliation|useReconcileRouteProof/.test(buttonSource), 'the button must not reconcile');
  assert.ok(/proofId,\s*recordedFinalStatus/.test(buttonSource), 'the button must forward proofId to onStateChange');
});

test('T62.1: the wallet submission is goal-aware but keeps ONE wallet implementation', () => {
  const source = mod.useSubmitApprovedBlueprint.toString();
  // Both goals' server hooks are wired…
  assert.ok(/approveEarn/.test(source) && /approveSwap/.test(source), 'both swap and earn approve hooks must be instantiated');
  assert.ok(/recordEarn/.test(source) && /recordSwap/.test(source), 'both swap and earn record hooks must be instantiated');
  // …selected by goal…
  assert.ok(/goal\s*===\s*['"]earn['"]\s*\?\s*approveEarn/.test(source), 'the approve hook is selected by goal');
  assert.ok(/goal\s*===\s*['"]earn['"]\s*\?\s*recordEarn/.test(source), 'the record hook is selected by goal');
  // …but the wallet batch is STILL sent from exactly one place (no second impl).
  const sendCallsInvocations = source.match(/sendCalls\.mutateAsync\(/g) ?? [];
  assert.equal(sendCallsInvocations.length, 1, 'there must be exactly ONE wallet submission implementation');
});

test('T62.1: wallet rejection is a single shared code path for both goals', () => {
  const source = mod.useSubmitApprovedBlueprint.toString();
  // The catch around sendCalls handles rejection once (isWalletRejectionError),
  // not per-goal — the earn path reuses the exact same cancelled-record logic.
  assert.ok(/isWalletRejectionError\(cause\)/.test(source), 'a single rejection detector guards the one sendCalls call');
  const rejectionBranches = source.match(/isWalletRejectionError\(/g) ?? [];
  assert.equal(rejectionBranches.length, 1, 'rejection handling must not be duplicated per goal');
  assert.ok(/status:\s*['"]cancelled['"]/.test(source), 'a rejected batch records a cancelled submission');
});

test('T62.1: the goal defaults to swap so every existing swap caller is unchanged', () => {
  const source = mod.useSubmitApprovedBlueprint.toString();
  assert.ok(/goal\s*=\s*['"]swap['"]/.test(source), "goal must default to 'swap'");
});

test('T57 wallet-actions sources never reference Base MCP send_calls, x402, or Action Inbox', () => {
  // `wallet_sendCalls` (the EIP-5792 wallet RPC via wagmi useSendCalls) is the
  // sanctioned path; the ban is on the Base MCP `send_calls` tool, x402, and
  // the legacy Action Inbox.
  const forbidden = /(?<!wallet_)send_calls|x402|actioninbox/i;
  for (const file of ['useSubmitApprovedBlueprint.ts', 'BlueprintSubmitButton.tsx']) {
    const content = readFileSync(path.join(here, file), 'utf8');
    assert.equal(forbidden.test(content), false, `${file} must not reference forbidden surfaces`);
  }
});
