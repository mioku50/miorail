import assert from 'node:assert/strict';
import test from 'node:test';
import { encodeFunctionData, parseAbi, type Hex } from 'viem';

import {
  SPONSORED_GAS_ENTRY_POINT_V1,
  createSponsorshipLedgerV1,
  decideSponsoredGasV1,
  issueSponsorshipTokenV1,
  paymasterUpstreamUrlV1,
  sponsoredCallsDigestV1,
  sponsoredGasDailyLimitV1,
  sponsorshipKeyV1,
  stripErc8021SuffixV1,
  userOperationCallsV1,
  verifySponsorshipTokenV1,
  type SponsoredCallV1,
} from './sponsoredGas.js';

// ---------------------------------------------------------------------------
// Sponsored gas pays for ONE approved list of calls, from ONE wallet.
//
// Most of these tests are refusals, because that is the property that matters:
// a paymaster that sponsors whatever reaches it is a public tap on the
// operator's budget, and the URL behind it is exactly what a wallet sends to.
// ---------------------------------------------------------------------------

const WALLET = '0xf7dca789b08ed2f7995d9bc22c500a8ca715d0a8';
const OTHER_WALLET = '0x1111111111111111111111111111111111111111';
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const KYBER = '0x6131b5fae19ea4f9d964eac0408e4408b66337b5';
const NOW_MS = Date.parse('2026-09-23T10:00:00.000Z');
const KEY = sponsorshipKeyV1({ SESSION_SECRET: 'a-test-session-secret' } as NodeJS.ProcessEnv)!;
/** The real suffix for Miorail's Builder Code, as Base Account appends it. */
const BUILDER_SUFFIX = '62635f7a3275756f3464740b0080218021802180218021802180218021';

const erc20 = parseAbi(['function approve(address spender, uint256 amount)']);
const wallet = parseAbi([
  'function execute(address target, uint256 value, bytes data)',
  'function executeBatch((address target, uint256 value, bytes data)[] calls)',
]);

/** The two calls of a $10 USDC buy: approve the router, then swap. */
function buyCalls(amount = 10_000_000n): SponsoredCallV1[] {
  return [
    {
      to: USDC,
      value: '0x0',
      data: encodeFunctionData({ abi: erc20, functionName: 'approve', args: [KYBER, amount] }),
    },
    { to: KYBER, value: '0x0', data: '0xe21fd0e9deadbeef' },
  ];
}

function batchCallData(calls: readonly SponsoredCallV1[]): Hex {
  return encodeFunctionData({
    abi: wallet,
    functionName: 'executeBatch',
    args: [
      calls.map((call) => ({
        target: call.to as Hex,
        value: BigInt(call.value as string),
        data: call.data as Hex,
      })),
    ],
  });
}

function tokenFor(calls: readonly SponsoredCallV1[], over: Partial<{ wallet: string; expiresAt: number }> = {}) {
  return issueSponsorshipTokenV1(
    {
      v: 1,
      wallet: over.wallet ?? WALLET,
      blueprintId: 'blueprint-1',
      digest: sponsoredCallsDigestV1(calls),
      expiresAt: over.expiresAt ?? NOW_MS + 60_000,
    },
    KEY,
  );
}

function ledger(limit = 3, now = () => new Date(NOW_MS)) {
  return createSponsorshipLedgerV1({ limit: () => limit, now });
}

function decide(
  over: Partial<{
    method: string;
    chainId: string;
    entryPoint: string;
    sender: string;
    nonce: string;
    callData: string;
    context: unknown;
    ledger: ReturnType<typeof ledger>;
  }> = {},
) {
  const calls = buyCalls();
  return decideSponsoredGasV1({
    method: over.method ?? 'pm_getPaymasterData',
    params: [
      { sender: over.sender ?? WALLET, nonce: over.nonce ?? '0x1', callData: over.callData ?? batchCallData(calls) },
      over.entryPoint ?? SPONSORED_GAS_ENTRY_POINT_V1,
      over.chainId ?? '0x2105',
      over.context === undefined ? { sponsorship: tokenFor(calls) } : over.context,
    ],
    key: KEY,
    nowMs: NOW_MS,
    ledger: over.ledger ?? ledger(),
  });
}

test('the approved calls from the approved wallet are sponsored', () => {
  const decision = decide();
  assert.equal(decision.ok, true);
  assert.equal(decision.ok && decision.wallet, WALLET);
});

test('a wallet cannot spend another wallet’s sponsorship', () => {
  const decision = decide({ sender: OTHER_WALLET });
  assert.deepEqual(decision.ok ? null : decision.code, 'wrong_sender');
});

test('a changed amount is not the approved call', () => {
  // Same contracts, same order, one number different: exactly the edit an
  // abuser would make to ride a real approval.
  const decision = decide({ callData: batchCallData(buyCalls(10_000_000_000n)) });
  assert.deepEqual(decision.ok ? null : decision.code, 'calls_not_approved');
});

test('an extra call is not the approved call list', () => {
  const extra = [...buyCalls(), { to: OTHER_WALLET, value: '0xde0b6b3a7640000', data: '0x' }];
  const decision = decide({ callData: batchCallData(extra) });
  assert.deepEqual(decision.ok ? null : decision.code, 'calls_not_approved');
});

test('the order of the calls is part of what was approved', () => {
  const decision = decide({ callData: batchCallData([...buyCalls()].reverse()) });
  assert.deepEqual(decision.ok ? null : decision.code, 'calls_not_approved');
});

test('a request with no Miorail sponsorship is refused, not forwarded', () => {
  // The portal's own sample — 1 ETH to an unrelated address — sent bare. The
  // upstream paymaster quoted it; this proxy does not.
  const sample =
    '0xb61d27f6000000000000000000000000d8da6bf26964af9d7eed9e03e53415d37aa960450000000000000000000000000000000000000000000000000de0b6b3a764000000000000000000000000000000000000000000000000000000000000000000600000000000000000000000000000000000000000000000000000000000000000';
  const decision = decide({ callData: sample, context: {} });
  assert.deepEqual(decision.ok ? null : decision.code, 'no_sponsorship');
});

test('a forged or tampered token is refused', () => {
  const genuine = tokenFor(buyCalls());
  const [payload, signature] = genuine.split('.');
  const forgedPayload = Buffer.from(
    JSON.stringify({ v: 1, wallet: OTHER_WALLET, blueprintId: 'x', digest: '0x00', expiresAt: NOW_MS + 1 }),
  ).toString('base64url');
  for (const token of [`${forgedPayload}.${signature}`, `${payload}.${'A'.repeat(signature!.length)}`, 'nonsense', 42]) {
    const decision = decide({ context: { sponsorship: token } });
    assert.deepEqual(decision.ok ? null : decision.code, 'sponsorship_invalid', String(token));
  }
});

test('a token signed with another secret is not ours', () => {
  const otherKey = sponsorshipKeyV1({ SESSION_SECRET: 'someone-else' } as NodeJS.ProcessEnv)!;
  const token = issueSponsorshipTokenV1(
    { v: 1, wallet: WALLET, blueprintId: 'b', digest: sponsoredCallsDigestV1(buyCalls()), expiresAt: NOW_MS + 60_000 },
    otherKey,
  );
  const decision = decide({ context: { sponsorship: token } });
  assert.deepEqual(decision.ok ? null : decision.code, 'sponsorship_invalid');
});

test('an expired sponsorship says so', () => {
  const decision = decide({ context: { sponsorship: tokenFor(buyCalls(), { expiresAt: NOW_MS - 1 }) } });
  assert.deepEqual(decision.ok ? null : decision.code, 'sponsorship_expired');
});

test('only Base mainnet, only EntryPoint v0.6, only the two ERC-7677 methods', () => {
  const sepolia = decide({ chainId: '0x14a34' });
  assert.deepEqual(sepolia.ok ? null : sepolia.code, 'wrong_chain');
  const v07 = decide({ entryPoint: '0x0000000071727de22e5e9d8baf0edac6f37da032' });
  assert.deepEqual(v07.ok ? null : v07.code, 'wrong_entry_point');
  const other = decide({ method: 'eth_sendUserOperation' });
  assert.deepEqual(other.ok ? null : other.code, 'method_not_supported');
});

test('the daily limit counts operations, not requests', () => {
  const book = ledger(2);
  for (const nonce of ['0x1', '0x2']) {
    assert.equal(decide({ nonce, ledger: book }).ok, true);
    book.record(WALLET, nonce);
  }
  // The wallet asking again for an operation already counted is a retry.
  assert.equal(decide({ nonce: '0x2', ledger: book }).ok, true);
  const third = decide({ nonce: '0x3', ledger: book });
  assert.deepEqual(third.ok ? null : third.code, 'daily_limit_reached');
  // Another wallet has its own count.
  book.record(OTHER_WALLET, '0x9');
  assert.equal(book.allows(OTHER_WALLET, '0xa'), true);
});

test('the daily limit resets at UTC midnight', () => {
  let now = new Date('2026-09-23T23:59:00.000Z');
  const book = createSponsorshipLedgerV1({ limit: () => 1, now: () => now });
  book.record(WALLET, '0x1');
  assert.equal(book.allows(WALLET, '0x2'), false);
  now = new Date('2026-09-24T00:00:01.000Z');
  assert.equal(book.allows(WALLET, '0x2'), true);
});

test('the Builder Code suffix is attribution, wherever the wallet puts it', () => {
  const calls = buyCalls();
  // On the outer calldata…
  const outer = `${batchCallData(calls)}${BUILDER_SUFFIX}`;
  assert.equal(decide({ callData: outer }).ok, true);
  // …or on a call inside the batch.
  const inner = batchCallData([calls[0]!, { ...calls[1]!, data: `${calls[1]!.data}${BUILDER_SUFFIX}` }]);
  assert.equal(decide({ callData: inner }).ok, true);
});

test('only a well-formed ERC-8021 suffix is removed', () => {
  assert.equal(stripErc8021SuffixV1(`0xabcdef${BUILDER_SUFFIX}`), '0xabcdef');
  assert.equal(stripErc8021SuffixV1('0xabcdef'), '0xabcdef');
  // The marker with a schema id this code does not know: left alone.
  assert.equal(
    stripErc8021SuffixV1('0xabcd0b0180218021802180218021802180218021'),
    '0xabcd0b0180218021802180218021802180218021',
  );
  // A length that points before the start of the data: left alone.
  assert.equal(stripErc8021SuffixV1('0xff0080218021802180218021802180218021'), '0xff0080218021802180218021802180218021');
});

test('a single call arrives as execute and decodes to one call', () => {
  const sample =
    '0xb61d27f6000000000000000000000000d8da6bf26964af9d7eed9e03e53415d37aa960450000000000000000000000000000000000000000000000000de0b6b3a764000000000000000000000000000000000000000000000000000000000000000000600000000000000000000000000000000000000000000000000000000000000000';
  const calls = userOperationCallsV1(sample)!;
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.to, '0xd8da6bf26964af9d7eed9e03e53415d37aa96045');
  assert.equal(calls[0]!.value, 10n ** 18n);
  assert.equal(userOperationCallsV1('0xdeadbeef'), null);
  assert.equal(userOperationCallsV1('not hex'), null);
});

test('the digest does not care how a value or an address is spelled', () => {
  const calls = buyCalls();
  const respelled = calls.map((call) => ({ ...call, to: call.to.toUpperCase().replace('0X', '0x'), value: 0n }));
  assert.equal(sponsoredCallsDigestV1(respelled), sponsoredCallsDigestV1(calls));
});

test('a token survives its round trip and nothing else', () => {
  const token = tokenFor(buyCalls());
  const checked = verifySponsorshipTokenV1(token, KEY, NOW_MS);
  assert.equal(checked.ok && checked.claim.wallet, WALLET);
  assert.deepEqual(verifySponsorshipTokenV1(token, KEY, NOW_MS + 120_000), { ok: false, reason: 'expired' });
});

test('no session secret means no sponsorship, not tokens signed with nothing', () => {
  assert.equal(sponsorshipKeyV1({} as NodeJS.ProcessEnv), null);
  assert.equal(sponsorshipKeyV1({ SESSION_SECRET: '  ' } as NodeJS.ProcessEnv), null);
});

test('the upstream is Coinbase’s Base endpoint under either name, and nothing else', () => {
  const url = 'https://api.developer.coinbase.com/rpc/v1/base/abcDEF123';
  assert.equal(paymasterUpstreamUrlV1({ CDP_PAYMASTER_URL: url } as NodeJS.ProcessEnv), url);
  assert.equal(paymasterUpstreamUrlV1({ Paymaster_endpoint: url } as NodeJS.ProcessEnv), url);
  assert.equal(paymasterUpstreamUrlV1({ Paymaster_endpoint: `"${url}"` } as NodeJS.ProcessEnv), url);
  for (const wrong of [
    'http://api.developer.coinbase.com/rpc/v1/base/abc',
    'https://evil.example/rpc/v1/base/abc',
    'https://api.developer.coinbase.com/rpc/v1/base-sepolia/abc',
    '',
  ]) {
    assert.equal(paymasterUpstreamUrlV1({ CDP_PAYMASTER_URL: wrong } as NodeJS.ProcessEnv), null, wrong);
  }
  assert.equal(paymasterUpstreamUrlV1({} as NodeJS.ProcessEnv), null);
});

test('the daily limit is configurable and bounded', () => {
  assert.equal(sponsoredGasDailyLimitV1({} as NodeJS.ProcessEnv), 3);
  assert.equal(sponsoredGasDailyLimitV1({ SPONSORED_GAS_DAILY_LIMIT_PER_WALLET: '5' } as NodeJS.ProcessEnv), 5);
  assert.equal(sponsoredGasDailyLimitV1({ SPONSORED_GAS_DAILY_LIMIT_PER_WALLET: '0' } as NodeJS.ProcessEnv), 0);
  assert.equal(sponsoredGasDailyLimitV1({ SPONSORED_GAS_DAILY_LIMIT_PER_WALLET: 'lots' } as NodeJS.ProcessEnv), 3);
  assert.equal(sponsoredGasDailyLimitV1({ SPONSORED_GAS_DAILY_LIMIT_PER_WALLET: '1000' } as NodeJS.ProcessEnv), 3);
});
