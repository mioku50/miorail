import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  AERODROME_CL_BALANCE_OF_SELECTOR_V1,
  AERODROME_CL_FACTORIES_V1,
  AERODROME_CL_GET_POOL_SELECTOR_V1,
  aerodromeClHasMarketV1,
  createAerodromeClReaderV1,
  providerFailure,
  type AerodromeClRpcV1,
} from '../src/index.js';

// ---------------------------------------------------------------------------
// Aerodrome concentrated liquidity.
//
// Measured on Base 2026-08-31: all four Coinbase representations have funded CL
// pools — NVDAc $814,421 + 3,697.71, AAPLc $644,518 + 1,957.23, GOOGLc $645,465
// + 1,934.94, METAc $527,315 + 838.08 — and `bNVDA` has none. The v2 Router the
// adapter reads sees none of them, which is how it came to quote NVDAc at
// $76,263 a token against a real market of about $219.
// ---------------------------------------------------------------------------

const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' as const;
const NVDAC = '0xb20000000000000000000078ee7ce2fe4908108c' as const;
const POOL = '0x853f5f1b92b16714fe6cda67caad0856b83c7ab9';
const STOCK_FACTORY = AERODROME_CL_FACTORIES_V1[0]!;

const ZERO_WORD = `0x${'0'.repeat(64)}`;
const word = (value: string) => `0x${value.replace(/^0x/, '').padStart(64, '0')}`;

/** An RPC that answers `getPool` from a table and `balanceOf` from another. */
function rpc(input: {
  pools?: Record<string, string>;
  balances?: Record<string, bigint>;
  fail?: (to: string) => boolean;
  onCall?: (to: string) => void;
}): AerodromeClRpcV1 {
  return {
    async call({ to, data }) {
      input.onCall?.(to);
      if (input.fail?.(to)) return null;
      if (data.startsWith(`0x${AERODROME_CL_GET_POOL_SELECTOR_V1}`)) {
        const tick = BigInt(`0x${data.slice(-64)}`).toString();
        return word(input.pools?.[`${to}:${tick}`] ?? ZERO_WORD);
      }
      if (data.startsWith(`0x${AERODROME_CL_BALANCE_OF_SELECTOR_V1}`)) {
        return word((input.balances?.[to] ?? 0n).toString(16));
      }
      return ZERO_WORD;
    },
  };
}

describe('Aerodrome concentrated liquidity', () => {
  test('a funded pool is found, and the search stops once it is proven', async () => {
    const asked: string[] = [];
    const reader = createAerodromeClReaderV1(
      rpc({
        pools: { [`${STOCK_FACTORY}:10`]: POOL },
        balances: { [USDC]: 814_421_000_000n, [NVDAC]: 369_771_000_000n },
        onCall: (to) => asked.push(to),
      }),
    );
    const found = await reader.findPools({ tokenA: USDC, tokenB: NVDAC });
    assert.equal(found.ok, true);
    assert.equal(found.ok && found.pools.length, 1);
    assert.equal(found.ok && found.pools[0]!.pool, POOL);
    assert.equal(found.ok && found.pools[0]!.tickSpacing, 10);
    // The second factory is never reached: one funded pool settles the question
    // the quote path is asking, and every further probe is a wasted RPC call.
    assert.equal(asked.includes(AERODROME_CL_FACTORIES_V1[1]!), false);
  });

  test('a read that does not complete is never rendered as an empty market', async () => {
    // The failure this guards is the one that made the whole audit necessary:
    // a partial scan reported as a complete one, so "Aerodrome has no CL pool"
    // gets said about a pool holding seven figures.
    const reader = createAerodromeClReaderV1(rpc({ fail: () => true }));
    assert.deepEqual(await reader.findPools({ tokenA: USDC, tokenB: NVDAC }), {
      ok: false,
      reason: 'unavailable',
    });
  });

  test('a balance read that fails fails the whole lookup, not just that pool', async () => {
    const reader = createAerodromeClReaderV1(
      rpc({ pools: { [`${STOCK_FACTORY}:10`]: POOL }, fail: (to) => to === NVDAC }),
    );
    const found = await reader.findPools({ tokenA: USDC, tokenB: NVDAC });
    assert.equal(found.ok, false);
  });

  test('no pool anywhere is a clean negative, distinct from a failed read', async () => {
    // bNVDA, measured. This must not be confusable with the case above.
    const reader = createAerodromeClReaderV1(rpc({}));
    const found = await reader.findPools({ tokenA: USDC, tokenB: NVDAC });
    assert.deepEqual(found, { ok: true, pools: [] });
    assert.equal(aerodromeClHasMarketV1(found.ok ? found.pools : []), false);
  });

  test('a pool holding only one side is not a market for the pair', async () => {
    // It cannot price a swap between them, and counting it would make the
    // adapter refuse on the evidence of nothing.
    assert.equal(
      aerodromeClHasMarketV1([
        {
          factory: STOCK_FACTORY,
          pool: POOL as `0x${string}`,
          tickSpacing: 10,
          tokenABalanceAtomic: '814421000000',
          tokenBBalanceAtomic: '0',
        },
      ]),
      false,
    );
  });

  test('our missing venue coverage is unsupported, never unavailable', async () => {
    const failure = providerFailure('aerodrome', 'provider_venue_not_covered');
    // `unavailable` is the word for the MARKET having no route. This is the
    // opposite: a route exists and our reach stops short of it. Reporting it as
    // unavailable would hand our coverage gap to the market as a finding.
    assert.equal(failure.outcome, 'unsupported');
    // Asking again reaches the same venue we still cannot read.
    assert.equal(failure.retryable, false);
  });
});
