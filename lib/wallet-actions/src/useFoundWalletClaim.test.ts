import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as mod from './useFoundWalletClaim';
import { callBuilderCodesV1 } from './attribution';

const WALLET = '0x1111111111111111111111111111111111111111';
const OTHER = '0x3333333333333333333333333333333333333333';
// collect(...) with the ERC-8021 schema-0 suffix for "bc_test", as the server writes it.
const SUFFIX = '62635f74657374070080218021802180218021802180218021';
const claim = (over: Partial<mod.FoundWalletClaimV1> = {}): mod.FoundWalletClaimV1 => ({
  receiptId: 'base-mcp-action:1', walletAddress: WALLET,
  calls: [{ to: '0x03a520b32c04bf3beef7beb72e919cf822ed34f1', value: '0', data: `0xfc6f7865${'00'.repeat(128)}${SUFFIX}` }], ...over,
});

test('the wallet opens only for the signed-in wallet, with claim-shaped calls', () => {
  assert.deepEqual(mod.foundWalletClaimPreflightV1({ claim: claim(), connectedAddress: WALLET.toUpperCase().replace('0X', '0x') }), { ok: true });
  const none = mod.foundWalletClaimPreflightV1({ claim: claim(), connectedAddress: undefined });
  assert.deepEqual(none, { ok: false, reason: mod.FOUND_WALLET_CLAIM_COPY_V1.noWallet });
  const other = mod.foundWalletClaimPreflightV1({ claim: claim(), connectedAddress: OTHER });
  assert.ok(!other.ok && /for 0x1111…1111, and the wallet connected here is 0x3333…3333/.test(other.reason));
  assert.equal(mod.foundWalletClaimPreflightV1({ claim: null, connectedAddress: WALLET }).ok, false);
  assert.equal(mod.foundWalletClaimPreflightV1({ claim: claim({ calls: [] }), connectedAddress: WALLET }).ok, false);
  // A call that moves value is not a claim, whatever the server said.
  const paying = claim({ calls: [{ to: OTHER, value: '1', data: `0x${SUFFIX}` }] });
  assert.equal(mod.foundWalletClaimPreflightV1({ claim: paying, connectedAddress: WALLET }).ok, false);
  // A call without the builder code in its data did not come from the server's prepare.
  const bare = mod.foundWalletClaimPreflightV1({ claim: claim({ calls: [{ to: OTHER, value: '0', data: '0xfc6f7865' }] }), connectedAddress: WALLET });
  assert.ok(!bare.ok && /not the ones Miorail prepared/.test(bare.reason));
});

test('the builder code is read from the end of a call’s own data', () => {
  assert.deepEqual(callBuilderCodesV1(`0xd294f093${SUFFIX}`), ['bc_test']);
  assert.deepEqual(callBuilderCodesV1('0xd294f093'), []);
  assert.deepEqual(callBuilderCodesV1('nonsense'), []);
});

test('a settled receipt reads as claimed, failed, or not yet', () => {
  const receipt = (status: string, errorCode: string | null = null) => ({ status, errorCode }) as never;
  assert.deepEqual(mod.foundWalletClaimOutcomeV1(receipt('completed')), { status: 'completed', error: null });
  assert.match(mod.foundWalletClaimOutcomeV1(receipt('failed', 'found_claim_reverted')).error!, /reverted on Base/);
  assert.match(mod.foundWalletClaimOutcomeV1(receipt('failed', 'uniswap_collect_events_mismatch')).error!, /did not match/);
  for (const status of ['pending', 'reconciling', 'approval_required']) {
    assert.deepEqual(mod.foundWalletClaimOutcomeV1(receipt(status)), { status: 'unsettled', error: null });
  }
});

test('the claim never forces an atomic batch, asks one transaction at a time where it must, and adds no suffix', () => {
  const source = mod.useFoundWalletClaim.toString();
  assert.match(source, /experimental_fallback:\s*true/);
  assert.ok(!source.includes('forceAtomic'), 'a Farcaster wallet sends a batch one call after another');
  assert.ok(!source.includes('dataSuffix'), 'the builder code is already in each call');
  assert.ok(source.includes('CallsStatusPoller'));
});

test('a claim the wallet answered with an error that proves nothing is said as unknown, and not offered again (audit WAL-4)', () => {
  // A closed connection or a lost answer may come after the wallet sent it: never "Cancelled", never "Nothing was claimed".
  for (const lost of [new Error('Connection closed'), Object.assign(new Error('Request timed out'), { code: -32000 }), new Error('wallet response lost')]) {
    assert.deepEqual(mod.foundWalletClaimSendOutcomeV1(lost, true), { status: 'unknown', error: mod.FOUND_WALLET_CLAIM_COPY_V1.unknown });
  }
  assert.doesNotMatch(mod.FOUND_WALLET_CLAIM_COPY_V1.unknown, /Nothing was (sent|claimed)/);
  // The person's own No, by its code.
  assert.deepEqual(mod.foundWalletClaimSendOutcomeV1(Object.assign(new Error('User rejected the request.'), { code: 4001 }), true),
    { status: 'cancelled', error: mod.FOUND_WALLET_CLAIM_COPY_V1.cancelled });
  // A wallet that cannot do this sent nothing.
  const cannot = Object.assign(new Error('The method "wallet_sendCalls" does not exist / is not available.'), { code: -32601 });
  assert.equal(mod.foundWalletClaimSendOutcomeV1(cannot, true).status, 'failed');
  // Refused before the wallet was asked: nothing went out, whatever the words.
  assert.deepEqual(mod.foundWalletClaimSendOutcomeV1(new Error('Connection closed'), false), { status: 'failed', error: 'Connection closed Nothing was claimed.' });
  // The hook reads the answer this way, and holds the claim while it is unknown.
  const source = mod.useFoundWalletClaim.toString();
  assert.match(source, /foundWalletClaimSendOutcomeV1\(cause,\s*asked\)/);
  assert.match(source, /asked\s*=\s*true;\s*const sent\s*=\s*await sendCalls\.mutateAsync/);
  assert.match(source, /status\s*===\s*["']unknown["']\)\s*return;/);
  assert.match(source, /busy:\s*status\s*===\s*["']sending["']\s*\|\|\s*status\s*===\s*["']sent["']\s*\|\|\s*status\s*===\s*["']checking["']\s*\|\|\s*status\s*===\s*["']unknown["']/);
  assert.ok(!source.includes('isWalletRejectionError'), 'the claim never reads the error by its words alone');
});
