import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import type { RouteIntentV1 } from '@mioagent/route-domain';

import type { BaseNameResolutionV1 } from './baseNameResolver.js';
import {
  CANONICAL_BASE_USDC_V1,
  STOCK_GIFT_DAILY_LIMIT_V1,
  checkStockGiftV1,
  resolveGiftRecipientV1,
} from './stockGift.js';

// ---------------------------------------------------------------------------
// The gift policy: a reviewed Coinbase stock, bought with USDC, $0.10–$100, to
// somebody else, five a day — decided before anything is quoted or built.
// ---------------------------------------------------------------------------

const WALLET = '0x4de27ead5a3c9aeb58c7f812178ddde282670d70';
const FRIEND = '0x8e525bfce1c0ffee00000000000000000000beef';
const NVDA = '0xb20000000000000000000078ee7ce2fe4908108c';

function intent(amountAtomic: string, over: Partial<{ from: string; to: string }> = {}): RouteIntentV1 {
  const asset = (address: string, decimals: number) => ({
    assetId: `eip155:8453/erc20:${address}`,
    chainId: 8453 as const,
    kind: 'erc20' as const,
    address: address as `0x${string}`,
    symbol: 'X',
    decimals,
  });
  return {
    fromAsset: asset(over.from ?? CANONICAL_BASE_USDC_V1, 6),
    toAsset: asset(over.to ?? NVDA, 8),
    amount: { asset: asset(over.from ?? CANONICAL_BASE_USDC_V1, 6), amountAtomic, amountDecimal: '0' },
  } as unknown as RouteIntentV1;
}

const resolved = (name: string, address: string): BaseNameResolutionV1 => ({
  outcome: 'resolved',
  name,
  address: address as `0x${string}`,
});

function check(over: Partial<Parameters<typeof checkStockGiftV1>[0]> = {}) {
  return checkStockGiftV1({
    intent: intent('100000'),
    walletAddress: WALLET,
    gift: { recipient: FRIEND, recipientName: null },
    isGiftableStock: async (token) => token === NVDA,
    resolveName: async (name) => resolved(name, FRIEND),
    giftsApprovedToday: async () => 0,
    ...over,
  });
}

describe('what may be given', () => {
  test('0.1 to 100 USDC, both ends included', async () => {
    for (const amount of ['100000', '100000000', '5000000']) {
      assert.deepEqual(await check({ intent: intent(amount) }), { ok: true, recipient: FRIEND }, amount);
    }
    for (const amount of ['99999', '100000001', '0']) {
      const verdict = await check({ intent: intent(amount) });
      assert.deepEqual(verdict.ok ? null : verdict.code, 'gift_amount_out_of_range', amount);
    }
  });

  test('bought with USDC, and only a reviewed Coinbase stock', async () => {
    const weth = await check({ intent: intent('100000', { from: '0x4200000000000000000000000000000000000006' }) });
    assert.deepEqual(weth.ok ? null : weth.code, 'gift_input_not_usdc');
    const meme = await check({ intent: intent('100000', { to: '0x3333333333333333333333333333333333333333' }) });
    assert.deepEqual(meme.ok ? null : meme.code, 'gift_not_a_reviewed_stock');
  });

  test('to someone else, at a real address', async () => {
    const self = await check({ gift: { recipient: WALLET, recipientName: null } });
    assert.deepEqual(self.ok ? null : self.code, 'gift_recipient_is_you');
    for (const recipient of ['0x0000000000000000000000000000000000000000', NVDA, CANONICAL_BASE_USDC_V1, 'alice.base.eth']) {
      const verdict = await check({ gift: { recipient, recipientName: null } });
      assert.deepEqual(verdict.ok ? null : verdict.code, 'gift_recipient_invalid', recipient);
    }
  });

  test('a typed Basename must still name the address the review shows', async () => {
    const same = await check({ gift: { recipient: FRIEND, recipientName: 'alice.base.eth' } });
    assert.equal(same.ok, true);
    const moved = await check({
      gift: { recipient: FRIEND, recipientName: 'alice.base.eth' },
      resolveName: async (name) => resolved(name, '0x1111111111111111111111111111111111111111'),
    });
    assert.deepEqual(moved.ok ? null : moved.code, 'gift_name_changed');
    const gone = await check({
      gift: { recipient: FRIEND, recipientName: 'alice.base.eth' },
      resolveName: async (name) => ({ outcome: 'unresolved', name, errorCode: 'no_address' }),
    });
    assert.deepEqual(gone.ok ? null : gone.code, 'gift_name_changed');
  });

  test('five approved gifts a day, then the sixth is refused with the reset time', async () => {
    assert.equal((await check({ giftsApprovedToday: async () => STOCK_GIFT_DAILY_LIMIT_V1 - 1 })).ok, true);
    const sixth = await check({ giftsApprovedToday: async () => STOCK_GIFT_DAILY_LIMIT_V1 });
    assert.equal(sixth.ok, false);
    if (!sixth.ok) {
      assert.equal(sixth.code, 'gift_daily_limit_reached');
      assert.match(sixth.message, /00:00 UTC/);
    }
  });
});

describe('who the recipient is', () => {
  const resolve = (value: string, resolveName = async (name: string) => resolved(name, FRIEND)) =>
    resolveGiftRecipientV1({ value, walletAddress: WALLET, resolveName });

  test('an address is taken as typed, lowercased', async () => {
    assert.deepEqual(await resolve(FRIEND.toUpperCase().replace('0X', '0x')), { outcome: 'resolved', address: FRIEND, name: null });
  });

  test('a Basename is resolved and its name kept for the review', async () => {
    assert.deepEqual(await resolve('alice.base.eth'), { outcome: 'resolved', address: FRIEND, name: 'alice.base.eth' });
  });

  test('refuses what cannot receive a gift, and says why', async () => {
    const codes = async (value: string, resolveName?: (name: string) => Promise<BaseNameResolutionV1>) => {
      const result = await resolve(value, resolveName);
      return result.outcome === 'refused' ? result.code : null;
    };
    assert.equal(await codes('0x0000000000000000000000000000000000000000'), 'recipient_invalid');
    assert.equal(await codes(WALLET), 'recipient_is_you');
    assert.equal(await codes('alice.eth'), 'recipient_invalid');
    assert.equal(await codes('alice'), 'recipient_invalid');
    assert.equal(await codes('me.base.eth', async (name) => resolved(name, WALLET)), 'recipient_is_you');
    assert.equal(
      await codes('ghost.base.eth', async (name) => ({ outcome: 'unresolved', name, errorCode: 'no_address' })),
      'name_unresolved',
    );
    assert.equal(
      await codes('alice.base.eth', async (name) => ({ outcome: 'unavailable', name, errorCode: 'rpc_down' })),
      'resolver_unavailable',
    );
  });
});
