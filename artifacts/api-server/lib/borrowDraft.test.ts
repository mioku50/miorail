import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  BORROW_DRAFT_PREFIX_V1,
  borrowDraftTtlMsV1,
  issueBorrowDraftV1,
  verifyBorrowDraftV1,
} from './borrowDraft.js';

const WALLET = '0xfb132f4c6d9dcf4f80483ea7d96c5a5dccfcfe83';
const NVDAC = '0xb20000000000000000000078ee7ce2fe4908108c';
const MARKET = '0xb4b42dd66cef25614b94510a910d54b2c148e7621d22b4271566724beda63d13';
const SECRET = 'a-session-secret-that-is-only-ever-a-test-value';
const NOW = new Date('2026-09-19T16:00:00.000Z');

function issue(over: Record<string, unknown> = {}) {
  return issueBorrowDraftV1({
    tenantId: `eip155:8453:${WALLET}`,
    walletAddress: WALLET,
    collateralTokenAddress: NVDAC,
    marketId: MARKET,
    borrowAssets: 10_000_000n,
    secret: SECRET,
    now: NOW,
    ...over,
  });
}

describe('a draft carries the question and none of the answer', () => {
  test('the claims name the wallet, the market and the amount — and nothing financial', () => {
    const issued = issue();
    const verified = verifyBorrowDraftV1({ draft: issued.draft, secret: SECRET, now: NOW });
    assert.equal(verified.ok, true);
    if (!verified.ok) return;
    assert.equal(verified.claims.walletAddress, WALLET);
    assert.equal(verified.claims.marketId, MARKET);
    assert.equal(verified.claims.borrowAssets, '10000000');
    // The numbers a reader would act on are absent by construction, so a draft
    // opened later cannot show a stale one as current.
    const everything = JSON.stringify(verified.claims);
    for (const forbidden of ['healthFactor', 'liquidationPrice', 'apy', 'rate', 'capacity', 'price']) {
      assert.doesNotMatch(everything, new RegExp(forbidden, 'i'));
    }
  });

  test('a tampered body does not verify', () => {
    const issued = issue();
    const [prefix, body, signature] = issued.draft.split('.');
    const claims = JSON.parse(Buffer.from(body!, 'base64url').toString('utf8'));
    claims.borrowAssets = '100000000000';
    const forged = `${prefix}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.${signature}`;
    const verified = verifyBorrowDraftV1({ draft: forged, secret: SECRET, now: NOW });
    assert.equal(verified.ok, false);
    if (verified.ok) return;
    assert.equal(verified.reason, 'borrow_draft_signature_invalid');
  });

  test('a draft signed with another key does not verify', () => {
    const issued = issue();
    const verified = verifyBorrowDraftV1({ draft: issued.draft, secret: `${SECRET}x`, now: NOW });
    assert.equal(verified.ok, false);
  });

  test('a stock draft can never verify here, whatever it was signed with', () => {
    const notOurs = `miorail-stock-action-v1.${Buffer.from('{}').toString('base64url')}.sig`;
    const verified = verifyBorrowDraftV1({ draft: notOurs, secret: SECRET, now: NOW });
    assert.equal(verified.ok, false);
    if (verified.ok) return;
    assert.equal(verified.reason, 'borrow_draft_malformed');
    assert.match(BORROW_DRAFT_PREFIX_V1, /^miorail-borrow-v1$/);
  });
});

describe('a draft is bound to one wallet and one short moment', () => {
  test('it expires, and the caller’s clock is what decides', () => {
    const issued = issue();
    const late = new Date(NOW.getTime() + 6 * 60 * 1000);
    const verified = verifyBorrowDraftV1({ draft: issued.draft, secret: SECRET, now: late });
    assert.equal(verified.ok, false);
    if (verified.ok) return;
    assert.equal(verified.reason, 'borrow_draft_expired');
  });

  test('another wallet is refused by its own name, not as a forgery', () => {
    const issued = issue();
    const verified = verifyBorrowDraftV1({
      draft: issued.draft,
      secret: SECRET,
      now: NOW,
      walletAddress: '0x0000000000000000000000000000000000000001',
    });
    assert.equal(verified.ok, false);
    if (verified.ok) return;
    assert.equal(verified.reason, 'borrow_draft_wrong_wallet');
  });

  test('the lifetime is a property of this file, not of the environment', () => {
    assert.equal(borrowDraftTtlMsV1(undefined), 5 * 60 * 1000);
    assert.equal(borrowDraftTtlMsV1('1'), 60 * 1000);
    assert.equal(borrowDraftTtlMsV1('99999999'), 15 * 60 * 1000);
    assert.equal(borrowDraftTtlMsV1('not a number'), 5 * 60 * 1000);
  });
});

describe('what cannot be put into a draft at all', () => {
  test('a tenant that does not match the wallet it claims', () => {
    assert.throws(() => issue({ tenantId: 'eip155:8453:0x0000000000000000000000000000000000000002' }));
  });

  test('a market id that is not exact, and an amount that is not positive', () => {
    assert.throws(() => issue({ marketId: '0xdeadbeef' }));
    assert.throws(() => issue({ borrowAssets: 0n }));
    assert.throws(() => issue({ collateralTokenAddress: 'NVDAc' }));
  });
});
