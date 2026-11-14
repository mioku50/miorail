import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import type { Hex } from 'viem';
import { B20EntryNotAskedErrorV1, b20EntryOtherAccountSentenceV1, sendB20EntryCallsV1, type SendB20EntryCallsInputV1 } from './b20EntrySend';
import { walletSendOutcomeV1 } from './useSubmitApprovedBlueprint';

const here = path.dirname(url.fileURLToPath(import.meta.url)), root = path.resolve(here, '../../..');
const PLANNED = '0x1111111111111111111111111111111111111111';
const OTHER = '0x2222222222222222222222222222222222222222';
const ROUTER = '0x3333333333333333333333333333333333333333';
// "bc_test" as an ERC-8021 schema-0 suffix.
const SUFFIX = '0x62635f74657374070080218021802180218021802180218021';
const PAYLOAD = { from: PLANNED, atomicRequired: true,
  calls: [{ to: ROUTER, value: '0x0', data: `0x095ea7b3${'00'.repeat(64)}` }, { to: ROUTER, value: '0x0', data: `0x12345678${'00'.repeat(32)}` }] };
const METAMASK = { 8453: { atomic: { status: 'supported' } } };
const BASE_ACCOUNT = { 8453: { atomic: { status: 'supported' }, dataSuffix: { supported: true } }, 0: { gasLimitOverride: { supported: true } } };

function harness(patch: Partial<SendB20EntryCallsInputV1> & { capabilities?: unknown } = {}) {
  const seen = { asked: 0, sent: [] as unknown[], kept: [] as unknown[], live: [] as string[], declined: 0 };
  const input: SendB20EntryCallsInputV1 = {
    config: {}, payload: PAYLOAD, connectedAddress: PLANNED, suffix: SUFFIX,
    readCapabilities: async () => patch.capabilities ?? METAMASK,
    sendCalls: async (request) => { seen.sent.push(request); return { id: 'batch-1' }; },
    sendKeepingCallCapabilities: async (_config, request) => { seen.kept.push(request); return { id: 'batch-kept' }; },
    requireLiveAccount: async (_config, account) => { seen.live.push(account); },
    meter: { estimate: async (tx: { data: Hex }) => BigInt(60_000 + tx.data.length * 10), code: async () => `0x363d3d373d3d363d7f${'00'.repeat(52)}` },
    gasLimitsDeclined: false, onGasLimitsDeclined: () => { seen.declined += 1; },
    onAsk: () => { seen.asked += 1; },
    ...patch,
  };
  return { input, seen };
}

test('a B20 entry is sent from the account its plan was made for, and that account only (audit WAL-5)', async () => {
  const { input, seen } = harness({ connectedAddress: PLANNED.toUpperCase().replace('0X', '0x') });
  assert.deepEqual(await sendB20EntryCallsV1(input), { batchId: 'batch-1', measured: false });
  assert.equal(seen.asked, 1);
  assert.deepEqual(seen.live, [PLANNED]);
  assert.equal((seen.sent[0] as { account: string }).account, PLANNED);
  // Another account connected on the page: the wallet is not asked, and the sentence names both.
  for (const connectedAddress of [OTHER, undefined]) {
    const other = harness({ connectedAddress });
    await assert.rejects(sendB20EntryCallsV1(other.input), (error: unknown) => error instanceof B20EntryNotAskedErrorV1);
    assert.deepEqual([other.seen.asked, other.seen.sent.length, other.seen.kept.length, other.seen.live.length], [0, 0, 0, 0]);
  }
  await assert.rejects(sendB20EntryCallsV1(harness({ connectedAddress: OTHER }).input), { message: b20EntryOtherAccountSentenceV1(PLANNED, OTHER) });
  assert.match(b20EntryOtherAccountSentenceV1(PLANNED, OTHER), /prepared for 0x1111…1111, and the wallet connected here is 0x2222…2222\. Your wallet was not asked and nothing was sent\./);
  // Refused before the wallet was asked: read as nothing sent, never as an answer that may have gone out.
  assert.equal(walletSendOutcomeV1(new B20EntryNotAskedErrorV1('x')), 'submitted_unknown', 'only the page knows it never asked');
});

test('a wallet that drops dataSuffix gets the Builder Code in each call, and the server’s bytes stay first (audit BASE-1)', async () => {
  const { input, seen } = harness();
  await sendB20EntryCallsV1(input);
  const sent = seen.sent[0] as { calls: { data: string }[]; capabilities: unknown; forceAtomic: boolean; chainId: number };
  assert.equal(sent.chainId, 8453);
  assert.equal(sent.forceAtomic, true);
  assert.deepEqual(sent.capabilities, { dataSuffix: { value: SUFFIX, optional: true } });
  for (const [index, call] of sent.calls.entries()) {
    assert.ok(call.data.startsWith(PAYLOAD.calls[index]!.data), 'the call’s own bytes are untouched');
    assert.ok(call.data.endsWith(SUFFIX.slice(2)), 'the code follows them');
  }
});

test('Base Account gets each call’s measured gas, by the request that keeps it, and not after a send with it failed (audit WAL-6)', async () => {
  const { input, seen } = harness({ capabilities: BASE_ACCOUNT });
  assert.deepEqual(await sendB20EntryCallsV1(input), { batchId: 'batch-kept', measured: true });
  assert.equal(seen.sent.length, 0);
  const kept = seen.kept[0] as { account: string; calls: { data: string; capabilities?: { gasLimitOverride?: { value: string } } }[] };
  assert.equal(kept.account, PLANNED);
  assert.ok(kept.calls.every((call) => typeof call.capabilities?.gasLimitOverride?.value === 'string'));
  // Base Account appends the code itself: the calls go as the server wrote them.
  assert.deepEqual(kept.calls.map((call) => call.data), PAYLOAD.calls.map((call) => call.data));
  // Declined before: the wallet's own estimate.
  const declined = harness({ capabilities: BASE_ACCOUNT, gasLimitsDeclined: true });
  assert.equal((await sendB20EntryCallsV1(declined.input)).measured, false);
  assert.equal(declined.seen.sent.length, 1);
  // A send that carried measured gas and failed, not by the person's No, is remembered; the No is not.
  const failing = harness({ capabilities: BASE_ACCOUNT, sendKeepingCallCapabilities: async () => { throw new Error('Call failed'); } });
  await assert.rejects(sendB20EntryCallsV1(failing.input), /Call failed/);
  assert.equal(failing.seen.declined, 1);
  const refused = harness({ capabilities: BASE_ACCOUNT, sendKeepingCallCapabilities: async () => { throw Object.assign(new Error('User rejected the request.'), { code: 4001 }); } });
  await assert.rejects(sendB20EntryCallsV1(refused.input));
  assert.equal(refused.seen.declined, 0);
});

test('both B20 entry pages send through it, from the plan’s payload, and say why a wallet was not asked', () => {
  for (const file of ['artifacts/interface/src/features/b20/B20WatchPage.tsx', 'artifacts/miniapp/app/components/MiniConsole.tsx']) {
    const source = readFileSync(path.join(root, file), 'utf8');
    assert.match(source, /sendB20EntryCallsV1\(\{[\s\S]{0,200}payload: begun\.payload,\s*connectedAddress: address,/, file);
    assert.match(source, /onAsk: \(\) => \{ asked = true; \}/, file);
    assert.match(source, /if \(!asked\) set\w*WalletError\(walletSubmissionFailureMessageV1\(error\)\);/, file);
    assert.doesNotMatch(source, /account: address,/, file);
  }
});
