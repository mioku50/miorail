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
