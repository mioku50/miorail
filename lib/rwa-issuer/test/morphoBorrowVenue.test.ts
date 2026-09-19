import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  MORPHO_PREPARE_BORROW_TOOL_V1,
  atomicToDecimalStringV1,
  prepareMorphoBorrowV1,
} from '../src/morphoBorrowVenue.js';

// ---------------------------------------------------------------------------
// The payload Morpho actually returned for a 10 USDC borrow on the curated
// NVDAc market, 2026-09-19, trimmed to the fields this client reads and
// otherwise verbatim — including the shapes that are easy to assume wrong:
// `value` is the STRING "0", the bundler's description is the venue's own
// label, and the answer arrives as a single SSE `data:` line.
// ---------------------------------------------------------------------------

const MARKET = '0xb4b42dd66cef25614b94510a910d54b2c148e7621d22b4271566724beda63d13';
const WALLET = '0xFb132f4C6d9DCF4f80483Ea7D96C5A5dccfcFE83';
const MORPHO_BLUE = '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb';
const BUNDLER = '0x6BFd8137e702540E7A42B74178A4a49Ba43920C4';
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

function payloadV1(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    operation: 'borrow',
    chain: 'base',
    summary: 'Borrow 10 USDC from market 0xb4b42dd6…',
    requirements: [],
    transactions: [
      {
        to: MORPHO_BLUE,
        data: `0xeecea000000000000000000000000000b98c948cfa24072e58935bc004a8a7b376ae746a${'0'.repeat(63)}1`,
        value: '0',
        chainId: 8453,
        description: 'Authorize Morpho GeneralAdapter1',
      },
      {
        to: BUNDLER,
        data: `0x374f435d${'0'.repeat(62)}20`,
        value: '0',
        chainId: 8453,
        description: 'Borrow 10 USDC',
      },
    ],
    outcome: {
      market: {
        borrowed: 7_173_511_021,
        collateral: 6_441_519_897,
        healthFactor: '1.247994858416207624',
        isHealthy: true,
        maxBorrowable: 1_778_993_850,
      },
    },
    simulation: {
      transfers: [
        {
          token: { address: USDC, symbol: 'USDC' },
          from: MORPHO_BLUE,
          to: WALLET,
          amount: { symbol: 'USDC', value: '10' },
        },
      ],
      postState: { market: { marketId: MARKET, borrowBefore: 7_163_511_021, borrowAfter: 7_173_511_021 } },
    },
    warnings: [{ level: 'info', message: 'Estimated health factor after borrow: 1.2480' }],
    ...over,
  };
}

function sseV1(payload: unknown): string {
  return `event: message\ndata: ${JSON.stringify({
    jsonrpc: '2.0',
    id: 'miorail',
    result: { content: [{ type: 'text', text: JSON.stringify(payload) }] },
  })}\n\n`;
}

function venueV1(body: string, status = 200): { fetchImpl: typeof fetch; sent: Record<string, any>[] } {
  const sent: Record<string, any>[] = [];
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body ?? '{}')));
    return new Response(body, { status, headers: { 'content-type': 'text/event-stream' } });
  }) as unknown as typeof fetch;
  return { fetchImpl, sent };
}

const ASK = { marketId: MARKET, walletAddress: WALLET, borrowAssets: 10_000_000n, loanDecimals: 6 };

describe('an amount crosses to the venue without ever being a float', () => {
  test('atomic units become the exact decimal string the venue asks for', () => {
    assert.equal(atomicToDecimalStringV1(10_000_000n, 6), '10');
    assert.equal(atomicToDecimalStringV1(7_163_446_680n, 6), '7163.44668');
    assert.equal(atomicToDecimalStringV1(1n, 6), '0.000001');
    assert.equal(atomicToDecimalStringV1(0n, 6), '0');
    // 8-decimal collateral, and an 18-decimal amount no double can hold.
    assert.equal(atomicToDecimalStringV1(6_441_519_897n, 8), '64.41519897');
    assert.equal(atomicToDecimalStringV1(123_456_789_012_345_678_901n, 18), '123.456789012345678901');
    assert.equal(atomicToDecimalStringV1(42n, 0), '42');
  });
});

describe('what the venue prepared, read for what it is', () => {
  test('the request names one tool, one chain and the wallet under review', async () => {
    const venue = venueV1(sseV1(payloadV1()));
    const result = await prepareMorphoBorrowV1({ ...ASK, deps: { fetchImpl: venue.fetchImpl } });
    assert.equal(result.ok, true);
    const params = venue.sent[0]!.params;
    assert.equal(params.name, MORPHO_PREPARE_BORROW_TOOL_V1);
    assert.equal(params.arguments.chain, 'base');
    assert.equal(params.arguments.marketId, MARKET.toLowerCase());
    assert.equal(params.arguments.userAddress, WALLET);
    assert.equal(params.arguments.borrowAmount, '10');
  });

  test('both transactions come out in the venue’s own order, with its own labels', async () => {
    const venue = venueV1(sseV1(payloadV1()));
    const result = await prepareMorphoBorrowV1({ ...ASK, deps: { fetchImpl: venue.fetchImpl } });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.prepared.transactions.length, 2);
    assert.equal(result.prepared.transactions[0]!.to, MORPHO_BLUE);
    assert.equal(result.prepared.transactions[0]!.description, 'Authorize Morpho GeneralAdapter1');
    assert.equal(result.prepared.transactions[1]!.to, BUNDLER);
    assert.equal(result.prepared.transactions[1]!.value, '0');
  });

  test('the venue’s headroom travels as the venue’s number, not as a capacity', async () => {
    // 1,778.99 USDC on a market that held 823. It is the collateral constraint
    // alone, and this client only carries it so a review can print both.
    const venue = venueV1(sseV1(payloadV1()));
    const result = await prepareMorphoBorrowV1({ ...ASK, deps: { fetchImpl: venue.fetchImpl } });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.prepared.maxBorrowableAssets, 1_778_993_850n);
  });

  test('an info-level warning is not a refusal, and the venue is recorded as having simulated', async () => {
    const venue = venueV1(sseV1(payloadV1()));
    const result = await prepareMorphoBorrowV1({ ...ASK, deps: { fetchImpl: venue.fetchImpl } });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.prepared.venueSimulation, { reverted: false, reason: null });
    assert.deepEqual(result.prepared.claimedTransfers, [
      { tokenAddress: USDC.toLowerCase(), tokenSymbol: 'USDC', to: WALLET.toLowerCase(), amount: '10' },
    ]);
  });

  test('an error-level warning is carried out as the venue refusing — beside the transactions it still returned', async () => {
    // Measured: 1,200 USDC on a market holding 823 produced SIMULATION_REVERTED
    // and TWO SIGNABLE TRANSACTIONS in the same answer.
    const venue = venueV1(
      sseV1(
        payloadV1({
          warnings: [
            { level: 'error', code: 'SIMULATION_REVERTED', message: 'Simulation reverted: insufficient liquidity' },
          ],
        }),
      ),
    );
    const result = await prepareMorphoBorrowV1({ ...ASK, deps: { fetchImpl: venue.fetchImpl } });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.prepared.transactions.length, 2);
    assert.deepEqual(result.prepared.venueSimulation, {
      reverted: true,
      reason: 'Simulation reverted: insufficient liquidity',
    });
  });

  test('a venue that published no simulation leaves it unread, not passed', async () => {
    const venue = venueV1(sseV1(payloadV1({ simulation: undefined, warnings: [] })));
    const result = await prepareMorphoBorrowV1({ ...ASK, deps: { fetchImpl: venue.fetchImpl } });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.prepared.venueSimulation, null);
  });
});

describe('what this client refuses to hand onward', () => {
  test('a call prepared for another chain, however right the rest of it looks', async () => {
    const venue = venueV1(
      sseV1(payloadV1({ transactions: [{ to: MORPHO_BLUE, data: '0xeecea000', value: '0', chainId: 1 }] })),
    );
    const result = await prepareMorphoBorrowV1({ ...ASK, deps: { fetchImpl: venue.fetchImpl } });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.refusal, 'venue_prepared_another_chain');
  });

  test('an answer with no transactions in it', async () => {
    const venue = venueV1(sseV1(payloadV1({ transactions: [] })));
    const result = await prepareMorphoBorrowV1({ ...ASK, deps: { fetchImpl: venue.fetchImpl } });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.refusal, 'venue_prepared_nothing');
  });

  test('a JSON-RPC error, an unreadable body, and an HTTP failure are three different sentences', async () => {
    const rpcError = await prepareMorphoBorrowV1({
      ...ASK,
      deps: { fetchImpl: venueV1(`data: ${JSON.stringify({ jsonrpc: '2.0', id: 'x', error: { message: 'no such market' } })}`).fetchImpl },
    });
    assert.equal(rpcError.ok, false);
    if (rpcError.ok) return;
    assert.equal(rpcError.refusal, 'venue_refused');
    assert.equal(rpcError.detail, 'no such market');

    const garbage = await prepareMorphoBorrowV1({ ...ASK, deps: { fetchImpl: venueV1('not json at all').fetchImpl } });
    assert.equal(garbage.ok, false);
    if (garbage.ok) return;
    assert.equal(garbage.refusal, 'venue_answer_unreadable');

    const down = await prepareMorphoBorrowV1({ ...ASK, deps: { fetchImpl: venueV1('', 503).fetchImpl } });
    assert.equal(down.ok, false);
    if (down.ok) return;
    assert.equal(down.refusal, 'venue_unreachable');
    assert.match(down.detail!, /HTTP 503/);
  });

  test('an ask that names nothing exact never reaches the venue at all', async () => {
    const venue = venueV1(sseV1(payloadV1()));
    for (const bad of [
      { ...ASK, marketId: '0xdeadbeef' },
      { ...ASK, walletAddress: 'nvidia' },
      { ...ASK, borrowAssets: 0n },
    ]) {
      const result = await prepareMorphoBorrowV1({ ...bad, deps: { fetchImpl: venue.fetchImpl } });
      assert.equal(result.ok, false);
    }
    assert.equal(venue.sent.length, 0);
  });
});
