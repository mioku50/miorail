import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test, { describe } from 'node:test';

import { ERC20_TRANSFER_TOPIC_V1, UNISWAP_V4_SINGLETON_V1 } from '../src/constants.js';
import { assetTransfersFromLogsV1, type RawLogV1 } from '../src/ledger.js';
import { venueTransfersFromLedgerV1, venueTransferSideV1 } from '../src/events.js';
import { tailRangeV1 } from '../src/range.js';
import { createMarketTailSourceV1 } from '../src/source.js';
import {
  addressFromCallResultV1,
  venueCandidatesFromTransfersV1,
  venueFromPairReadsV1,
  type VenueV1,
} from '../src/venues.js';

const fixture = JSON.parse(
  readFileSync(resolve(import.meta.dirname, 'fixtures', 'aaplc-transfers.json'), 'utf8'),
) as { fromBlock: number; toBlock: number; logs: RawLogV1[] };

const AAPL = '0xb200000000000000000000c2e324d24d7eecd1fb';
const AERODROME_POOL = '0xa3b1e3f9747065e2073722ff4c9027d3ea4994f0';
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const WALLET = '0x1111111111111111111111111111111111111111';
const OTHER_WALLET = '0x2222222222222222222222222222222222222222';

function transferLogV1(from: string, to: string, index: number, amount = '0x0f4240'): RawLogV1 {
  return {
    address: AAPL,
    topics: [
      ERC20_TRANSFER_TOPIC_V1,
      `0x000000000000000000000000${from.slice(2)}`,
      `0x000000000000000000000000${to.slice(2)}`,
    ],
    data: amount,
    blockNumber: '0x3020304',
    transactionHash: `0x${'ab'.repeat(32)}`,
    logIndex: `0x${index.toString(16)}`,
  };
}

describe('the ledger', () => {
  test('reads what the chain actually emitted', () => {
    const transfers = assetTransfersFromLogsV1({ logs: fixture.logs, trackedTokens: [AAPL] });
    assert.equal(transfers.length, fixture.logs.length);
    for (const transfer of transfers) {
      assert.equal(transfer.tokenAddress, AAPL);
      assert.match(transfer.from, /^0x[0-9a-f]{40}$/);
      assert.match(transfer.amountAtomic, /^\d+$/);
      assert.ok(transfer.blockNumber >= fixture.fromBlock && transfer.blockNumber <= fixture.toBlock);
    }
    // The Aerodrome pool the aggregator routes AAPLc through is in this window.
    assert.ok(transfers.some((row) => row.from === AERODROME_POOL || row.to === AERODROME_POOL));
  });

  test('a token nobody asked about is not folded in', () => {
    const foreign: RawLogV1 = { ...transferLogV1(WALLET, OTHER_WALLET, 0), address: USDC };
    assert.deepEqual(assetTransfersFromLogsV1({ logs: [foreign], trackedTokens: [AAPL] }), []);
  });

  test('a log with no idempotency key is dropped, not written twice', () => {
    // Without block, transaction and index there is nothing to deduplicate on,
    // so the row would be re-inserted on every re-read of the range.
    const orphan = { ...transferLogV1(WALLET, OTHER_WALLET, 0), transactionHash: undefined };
    assert.deepEqual(assetTransfersFromLogsV1({ logs: [orphan], trackedTokens: [AAPL] }), []);
  });
});

describe('venue discovery', () => {
  const transfers = assetTransfersFromLogsV1({ logs: fixture.logs, trackedTokens: [AAPL] });

  test('an address on both sides is a candidate, one-way traffic is not', () => {
    const oneWay = [1, 2, 3, 4].map((index) => transferLogV1(WALLET, OTHER_WALLET, index));
    const both = [
      transferLogV1(WALLET, AERODROME_POOL, 5),
      transferLogV1(WALLET, AERODROME_POOL, 6),
      transferLogV1(WALLET, AERODROME_POOL, 7),
      transferLogV1(AERODROME_POOL, OTHER_WALLET, 8),
      transferLogV1(AERODROME_POOL, OTHER_WALLET, 9),
      transferLogV1(AERODROME_POOL, OTHER_WALLET, 10),
    ];
    const parsed = assetTransfersFromLogsV1({ logs: [...oneWay, ...both], trackedTokens: [AAPL] });
    assert.deepEqual(venueCandidatesFromTransfersV1({ transfers: parsed }), [AERODROME_POOL]);
  });

  test('an address already identified is not proposed again', () => {
    assert.deepEqual(
      venueCandidatesFromTransfersV1({
        transfers,
        minPerSide: 1,
        known: [...new Set(transfers.flatMap((row) => [row.from, row.to]))],
      }),
      [],
    );
  });

  test('minting is not trading', () => {
    const zero = '0x0000000000000000000000000000000000000000';
    const minted = [1, 2, 3].map((index) => transferLogV1(zero, WALLET, index));
    const burned = [4, 5, 6].map((index) => transferLogV1(WALLET, zero, index));
    const parsed = assetTransfersFromLogsV1({ logs: [...minted, ...burned], trackedTokens: [AAPL] });
    assert.deepEqual(venueCandidatesFromTransfersV1({ transfers: parsed, minPerSide: 1 }), []);
  });

  test('what an address answers decides what it is', () => {
    assert.deepEqual(
      venueFromPairReadsV1({ address: AERODROME_POOL, token0: USDC, token1: AAPL }),
      { address: AERODROME_POOL, kind: 'paired_pool', token0: USDC, token1: AAPL },
    );
    // A router answers nothing readable. That is a stored answer, and it is
    // what stops the same address being probed every hour forever.
    assert.equal(venueFromPairReadsV1({ address: WALLET, token0: null, token1: null }).kind, 'not_a_venue');
    // The v4 singleton holds every pool in one contract, so it has no pair to
    // answer with and is never asked for one.
    assert.equal(
      venueFromPairReadsV1({ address: UNISWAP_V4_SINGLETON_V1, token0: null, token1: null }).kind,
      'singleton',
    );
  });

  test('a call result becomes an address only when it is one', () => {
    assert.equal(addressFromCallResultV1(`0x${'0'.repeat(24)}${USDC.slice(2)}`), USDC);
    assert.equal(addressFromCallResultV1('0x'), null);
    assert.equal(addressFromCallResultV1(undefined), null);
  });
});

describe('trade events', () => {
  const pool: VenueV1 = { address: AERODROME_POOL, kind: 'paired_pool', token0: USDC, token1: AAPL };
  const singleton: VenueV1 = { address: UNISWAP_V4_SINGLETON_V1, kind: 'singleton', token0: null, token1: null };

  test('the asset leaving a venue is somebody acquiring it', () => {
    const parsed = assetTransfersFromLogsV1({
      logs: [transferLogV1(AERODROME_POOL, WALLET, 1)],
      trackedTokens: [AAPL],
    });
    const [event] = venueTransfersFromLedgerV1({ transfers: parsed, venues: [pool] });
    assert.equal(event.direction, 'out_of_venue');
    assert.equal(event.venueAddress, AERODROME_POOL);
    assert.equal(event.counterparty, WALLET);
    assert.equal(venueTransferSideV1(event.direction), 'acquired');
  });

  test('a wallet paying a wallet is not a trade', () => {
    const parsed = assetTransfersFromLogsV1({
      logs: [transferLogV1(WALLET, OTHER_WALLET, 1)],
      trackedTokens: [AAPL],
    });
    assert.deepEqual(venueTransfersFromLedgerV1({ transfers: parsed, venues: [pool] }), []);
  });

  test('pool to pool is one trade seen twice, and is dropped', () => {
    // A multi-hop swap moves the asset between venues inside a single
    // transaction. Counting the hop would double the trade and invent a
    // counterparty that is a pool.
    const parsed = assetTransfersFromLogsV1({
      logs: [transferLogV1(AERODROME_POOL, UNISWAP_V4_SINGLETON_V1, 1)],
      trackedTokens: [AAPL],
    });
    assert.deepEqual(venueTransfersFromLedgerV1({ transfers: parsed, venues: [pool, singleton] }), []);
  });

  test('seeding a pool is not buying from it', () => {
    const zero = '0x0000000000000000000000000000000000000000';
    const parsed = assetTransfersFromLogsV1({
      logs: [transferLogV1(zero, AERODROME_POOL, 1)],
      trackedTokens: [AAPL],
    });
    assert.deepEqual(venueTransfersFromLedgerV1({ transfers: parsed, venues: [pool] }), []);
  });

  test('a candidate is not evidence', () => {
    const unasked: VenueV1 = { address: AERODROME_POOL, kind: 'candidate', token0: null, token1: null };
    const parsed = assetTransfersFromLogsV1({
      logs: [transferLogV1(AERODROME_POOL, WALLET, 1)],
      trackedTokens: [AAPL],
    });
    assert.deepEqual(venueTransfersFromLedgerV1({ transfers: parsed, venues: [unasked] }), []);
  });
});

describe('the range a pass may read', () => {
  test('a pass stops short of the head by the confirmation depth', () => {
    const range = tailRangeV1({ lastBlock: 1_000, headBlock: 1_100, confirmations: 12 });
    assert.deepEqual(range, { ok: true, fromBlock: 1_001, toBlock: 1_088 });
  });

  test('the span is bounded even when the tail is far behind', () => {
    const range = tailRangeV1({ lastBlock: 0, headBlock: 1_000_000, maxSpan: 2_000, confirmations: 12 });
    assert.deepEqual(range, { ok: true, fromBlock: 1, toBlock: 2_000 });
  });

  test('inside the confirmation window there is nothing to read yet', () => {
    assert.deepEqual(tailRangeV1({ lastBlock: 1_095, headBlock: 1_100, confirmations: 12 }), {
      ok: false,
      reason: 'caught_up',
    });
  });
});

describe('the endpoint seam', () => {
  const RPC = 'https://rpc.example.invalid/with-a-key';
  const respond = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  test('a revert identifies the address; a busy endpoint does not', async () => {
    const reverted = createMarketTailSourceV1({
      rpcUrl: RPC,
      fetchImpl: async () => respond({ jsonrpc: '2.0', id: 1, error: { code: 3, message: 'execution reverted' } }),
    });
    assert.deepEqual(await reverted.pairReads(WALLET), {
      ok: true,
      // One call is enough to rule an address out; the second is not spent.
      value: { token0: null, token1: null, calls: 1 },
    });

    // The recurring bug class: our own bad minute wearing the shape of a
    // finding. A rate-limited read must leave the address a candidate, not
    // brand a real venue a router forever.
    const throttled = createMarketTailSourceV1({
      rpcUrl: RPC,
      fetchImpl: async () => respond({ error: 'too many requests' }, 429),
    });
    const result = await throttled.pairReads(AERODROME_POOL);
    assert.equal(result.ok, false);
  });

  test('nothing that leaves this seam carries the endpoint', async () => {
    const source = createMarketTailSourceV1({
      rpcUrl: RPC,
      fetchImpl: async () =>
        respond({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: `check ${RPC} for details` } }),
    });
    const head = await source.headBlock();
    assert.equal(head.ok, false);
    assert.equal(head.ok === false && head.reason.includes('example.invalid'), false);
  });

  test('requests are paced, so a throttled probe is not repeated for free', async () => {
    const slept: number[] = [];
    const source = createMarketTailSourceV1({
      rpcUrl: RPC,
      callGapMs: 2_200,
      sleepImpl: async (ms) => {
        slept.push(ms);
      },
      fetchImpl: async () => respond({ jsonrpc: '2.0', id: 1, result: `0x${'0'.repeat(24)}${USDC.slice(2)}` }),
    });
    await source.pairReads(AERODROME_POOL);
    // token0() and token1() are two calls, and the second waits. Without this
    // the endpoint throttles the burst, every address stays a candidate, and
    // the next pass spends the same calls on the same addresses.
    assert.equal(slept.length, 1);
    assert.ok(slept[0] > 2_000 && slept[0] <= 2_200);
  });

  test('an oversized answer is split rather than abandoned, and the range is covered', async () => {
    // Measured on mainnet.base.org: thirteen official assets over 1,987 blocks
    // came back HTTP 500 with `-32020 backend response too large`, while 999
    // blocks succeeded. The bound is on the RESPONSE, so it moves with how
    // busy the assets are — and a pass that gives up here leaves the cursor
    // where it was and re-reads the same oversized range forever.
    const asked: [number, number][] = [];
    const source = createMarketTailSourceV1({
      rpcUrl: RPC,
      callGapMs: 0,
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String((init as RequestInit).body)) as {
          params: [{ fromBlock: string; toBlock: string }];
        };
        const from = Number(BigInt(body.params[0].fromBlock));
        const to = Number(BigInt(body.params[0].toBlock));
        asked.push([from, to]);
        // Anything wider than two blocks is refused, exactly as the endpoint
        // refuses: a JSON-RPC error carried on an HTTP 500.
        if (to - from > 1) {
          return respond(
            { jsonrpc: '2.0', id: 1, error: { code: -32020, message: 'backend response too large' } },
            500,
          );
        }
        return respond({ jsonrpc: '2.0', id: 1, result: [{ blockNumber: `0x${from.toString(16)}` }] });
      },
    });
    const logs = await source.transferLogs({ tokens: [AAPL], fromBlock: 100, toBlock: 103 });
    assert.equal(logs.ok, true);
    // Every block in the requested range is covered exactly once. The caller
    // advances the cursor to `toBlock`, so a partial read reported as success
    // would skip blocks the cursor can never come back for.
    const covered = asked.filter(([from, to]) => to - from <= 1).flatMap(([from, to]) => [from, to]);
    assert.deepEqual([...new Set(covered)].sort((a, b) => a - b), [100, 101, 102, 103]);
  });

  test('a refusal that is not about size is not retried by splitting', async () => {
    let calls = 0;
    const source = createMarketTailSourceV1({
      rpcUrl: RPC,
      callGapMs: 0,
      fetchImpl: async () => {
        calls += 1;
        return respond({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'busy' } }, 500);
      },
    });
    const logs = await source.transferLogs({ tokens: [AAPL], fromBlock: 100, toBlock: 200 });
    assert.equal(logs.ok, false);
    // One attempt. Halving a range because the endpoint was busy just spends
    // the same failure twice.
    assert.equal(calls, 1);
  });

  test('a partly readable range is not reported as a clean one', async () => {
    const source = createMarketTailSourceV1({
      rpcUrl: RPC,
      fetchImpl: async () => respond({ jsonrpc: '2.0', id: 1, result: [null] }),
    });
    const logs = await source.transferLogs({ tokens: [AAPL], fromBlock: 1, toBlock: 2 });
    // Advancing the cursor past a range we could only half read would lose
    // those blocks for good: the cursor never rewinds.
    assert.equal(logs.ok, false);
  });
});
