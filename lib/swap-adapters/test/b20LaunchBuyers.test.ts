import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  B20_BUYER_WINDOW_BLOCKS_V1,
  ERC20_TRANSFER_TOPIC_V1,
  b20LaunchBuyersFromLogsV1,
  b20LaunchBuyersV1,
} from '../src/b20-launch-buyers.js';
import { UNISWAP_V4_POOL_MANAGER_V1 } from '../src/uniswap-v4-pinned.js';
import type { RawLogV1 } from '../src/uniswap-v4-pool.js';

// ---------------------------------------------------------------------------
// Shapes taken from real launches read on 2026-08-10. The first ten blocks of
// a B20 launch carry exactly three transfers — the mint, the hook and the pool
// seeding — and no buyer at all; buying, where it happens, shows up later as
// tokens leaving the PoolManager.
// ---------------------------------------------------------------------------

const TOKEN = '0xb200000000000000000000d89287a1e7c4456201';
const HOOK = '0x985c14baa2a18316ffda0aefb3a632fadfca2acc';
const CREATOR = '0x0fe0d90edefea84e8e6ccc1ff6c2b95e73a2d075';
const ZERO = '0x0000000000000000000000000000000000000000';

const asTopic = (address: string): string => `0x${'0'.repeat(24)}${address.slice(2)}`;
const asAmount = (value: bigint): string => `0x${value.toString(16).padStart(64, '0')}`;

function transfer(from: string, to: string, amount: bigint, address = TOKEN): RawLogV1 {
  return {
    address,
    topics: [ERC20_TRANSFER_TOPIC_V1, asTopic(from), asTopic(to)],
    data: asAmount(amount),
  } as RawLogV1;
}

const WINDOW = { token: TOKEN, fromBlock: 49_715_474, toBlock: 49_715_474 + B20_BUYER_WINDOW_BLOCKS_V1 };

describe('launch-window buying', () => {
  test('the launch mechanics are not buyers', () => {
    // Exactly the three transfers a launch emits before anyone trades.
    const result = b20LaunchBuyersFromLogsV1({
      ...WINDOW,
      logs: [
        transfer(ZERO, CREATOR, 1_000_000n),
        transfer(CREATOR, HOOK, 900_000n),
        transfer(HOOK, UNISWAP_V4_POOL_MANAGER_V1, 900_000n),
      ],
    });
    assert.equal(result.buyerCount, 0);
    assert.equal(result.totalBoughtAtomic, '0');
    // Not 0% — a concentration among nobody is not a number.
    assert.equal(result.topBuyerShareBps, null);
    assert.equal(result.topThreeShareBps, null);
  });

  test('one wallet taking everything reads as 100%', () => {
    const result = b20LaunchBuyersFromLogsV1({
      ...WINDOW,
      logs: [transfer(UNISWAP_V4_POOL_MANAGER_V1, CREATOR, 500n)],
    });
    assert.equal(result.buyerCount, 1);
    assert.equal(result.topBuyerShareBps, 10_000);
    assert.equal(result.buyers[0]?.address, CREATOR);
    assert.equal(result.buyers[0]?.boughtAtomic, '500');
  });

  test('shares are of what was bought, largest first', () => {
    const a = '0x1111111111111111111111111111111111111111';
    const b = '0x2222222222222222222222222222222222222222';
    const c = '0x3333333333333333333333333333333333333333';
    const result = b20LaunchBuyersFromLogsV1({
      ...WINDOW,
      logs: [
        transfer(UNISWAP_V4_POOL_MANAGER_V1, a, 100n),
        transfer(UNISWAP_V4_POOL_MANAGER_V1, b, 700n),
        transfer(UNISWAP_V4_POOL_MANAGER_V1, c, 200n),
      ],
    });
    assert.deepEqual(result.buyers.map((buyer) => buyer.address), [b, c, a]);
    assert.equal(result.totalBoughtAtomic, '1000');
    assert.equal(result.topBuyerShareBps, 7_000);
    assert.equal(result.topThreeShareBps, 10_000);
  });

  test('one wallet buying twice is one buyer, not two', () => {
    const result = b20LaunchBuyersFromLogsV1({
      ...WINDOW,
      logs: [
        transfer(UNISWAP_V4_POOL_MANAGER_V1, CREATOR, 300n),
        transfer(UNISWAP_V4_POOL_MANAGER_V1, CREATOR, 200n),
      ],
    });
    assert.equal(result.buyerCount, 1);
    assert.equal(result.buyers[0]?.boughtAtomic, '500');
  });

  test('a sale back into the pool does not cancel the buy', () => {
    // GROSS buying in the window. Netting would quietly turn this into a
    // holdings claim, which a Transfer log cannot support.
    const result = b20LaunchBuyersFromLogsV1({
      ...WINDOW,
      logs: [
        transfer(UNISWAP_V4_POOL_MANAGER_V1, CREATOR, 500n),
        transfer(CREATOR, UNISWAP_V4_POOL_MANAGER_V1, 500n),
      ],
    });
    assert.equal(result.buyerCount, 1);
    assert.equal(result.totalBoughtAtomic, '500');
  });

  test("another token's transfers are ignored", () => {
    const other = '0xb200000000000000000000ffffffffffffffff01';
    const result = b20LaunchBuyersFromLogsV1({
      ...WINDOW,
      logs: [transfer(UNISWAP_V4_POOL_MANAGER_V1, CREATOR, 900n, other)],
    });
    assert.equal(result.buyerCount, 0);
  });

  test('a non-Transfer log in the same range is ignored', () => {
    const result = b20LaunchBuyersFromLogsV1({
      ...WINDOW,
      logs: [{
        address: TOKEN,
        topics: [`0x${'f'.repeat(64)}`, asTopic(UNISWAP_V4_POOL_MANAGER_V1), asTopic(CREATOR)],
        data: asAmount(900n),
      } as RawLogV1],
    });
    assert.equal(result.buyerCount, 0);
  });

  test('a zero-value transfer is not a buy', () => {
    const result = b20LaunchBuyersFromLogsV1({
      ...WINDOW,
      logs: [transfer(UNISWAP_V4_POOL_MANAGER_V1, CREATOR, 0n)],
    });
    assert.equal(result.buyerCount, 0);
  });

  test('an unreadable amount is skipped, not counted as zero', () => {
    // Counting it as zero would deflate nobody; counting it as a buyer with no
    // size would inflate the buyer count with something unmeasured.
    const broken = {
      address: TOKEN,
      topics: [ERC20_TRANSFER_TOPIC_V1, asTopic(UNISWAP_V4_POOL_MANAGER_V1), asTopic(CREATOR)],
      data: '0xnot-a-number',
    } as RawLogV1;
    const result = b20LaunchBuyersFromLogsV1({ ...WINDOW, logs: [broken] });
    assert.equal(result.buyerCount, 0);
  });

  test('the window is carried on the result, because concentration without one is not a measurement', () => {
    const result = b20LaunchBuyersFromLogsV1({ ...WINDOW, logs: [] });
    assert.equal(result.fromBlock, 49_715_474);
    assert.equal(result.toBlock, 49_715_474 + 10_000);
  });

  test('the listed rows are capped but the claims are not', () => {
    const logs = Array.from({ length: 12 }, (_, index) => transfer(
      UNISWAP_V4_POOL_MANAGER_V1,
      `0x${String(index + 1).padStart(2, '0').repeat(20)}`,
      BigInt(index + 1),
    ));
    const result = b20LaunchBuyersFromLogsV1({ ...WINDOW, logs, limit: 3 });
    assert.equal(result.buyers.length, 3);
    // Counted over all twelve, not over the three that are shown.
    assert.equal(result.buyerCount, 12);
    assert.equal(result.totalBoughtAtomic, '78');
  });

  test('an endpoint that refused is never an empty distribution', async () => {
    // The bug class this exists to prevent: an endpoint failure shaped like a
    // finding about the token. It is especially dangerous here, because "no
    // buyers" is also the common TRUE answer, so a silent zero would be
    // indistinguishable from the real thing.
    const result = await b20LaunchBuyersV1({
      token: TOKEN,
      launchBlock: 49_715_474,
      getLogs: async () => { throw new Error('429'); },
    });
    assert.deepEqual(result, { ok: false, refusal: 'endpoint_unavailable' });
  });

  test('an answered window with nothing in it IS an empty distribution', async () => {
    const result = await b20LaunchBuyersV1({
      token: TOKEN,
      launchBlock: 49_715_474,
      getLogs: async () => [],
    });
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.distribution.buyerCount, 0);
    assert.equal(result.ok && result.distribution.topBuyerShareBps, null);
  });

  test('the fetch asks for exactly the launch window, filtered to Transfers', async () => {
    const seen: { fromBlock: number; toBlock: number; topics: (string | null)[]; address: string }[] = [];
    await b20LaunchBuyersV1({
      token: TOKEN,
      launchBlock: 1_000,
      windowBlocks: 50,
      getLogs: async (query) => { seen.push(query); return []; },
    });
    assert.equal(seen.length, 1, 'one request covers the whole window');
    assert.equal(seen[0]?.fromBlock, 1_000);
    assert.equal(seen[0]?.toBlock, 1_050);
    assert.equal(seen[0]?.address, TOKEN);
    assert.deepEqual(seen[0]?.topics, [ERC20_TRANSFER_TOPIC_V1]);
  });

  test('address casing does not split one buyer in two', () => {
    const result = b20LaunchBuyersFromLogsV1({
      ...WINDOW,
      logs: [
        transfer(UNISWAP_V4_POOL_MANAGER_V1.toUpperCase().replace('0X', '0x'), CREATOR, 300n),
        transfer(UNISWAP_V4_POOL_MANAGER_V1, CREATOR.toUpperCase().replace('0X', '0x'), 200n),
      ],
    });
    assert.equal(result.buyerCount, 1);
    assert.equal(result.buyers[0]?.boughtAtomic, '500');
  });
});
