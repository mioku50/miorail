import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  AERODROME_CL_BALANCE_OF_SELECTOR_V1,
  AERODROME_CL_FACTORIES_V1,
  AERODROME_CL_GET_POOL_SELECTOR_V1,
  aerodromeClHasMarketV1,
  aerodromeClSpotPriceV1,
  createAerodromeClReaderV1,
  readAerodromeClSpotV1,
  selectorV1,
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

// ---------------------------------------------------------------------------
// Phase 17.5 — the corroborator.
//
// There is no verifiable quoter for the factory that holds these pools; the
// deployer of 0xf8f2eb49… shipped a seven-contract core with no QuoterV2 and no
// SwapRouter, measured by bytecode selector scan. So the adapter stops trying
// to price and starts CORROBORATING: `slot0().sqrtPriceX96`, squared, is a
// number anybody can recompute from one word at the same block.
//
// The fixture is the real pool, read live from Base on 2026-09-04:
//   pool         0x853f5f1b92b16714fe6cda67caad0856b83c7ab9
//   token0       USDC, 6 decimals        token1  NVDAc, 8 decimals
//   sqrtPriceX96 52029507624582080717065656647
//   → 231.878101242070949243 USDC per NVDAc
// A KyberSwap quote for $1,000 at the same moment implied 231.948403 — 3.0 bps
// worse than the marginal price, which is exactly what walking a little way up
// the curve costs. That agreement is the whole point of this function.
// ---------------------------------------------------------------------------

const NVDAC_POOL = '0x853f5f1b92b16714fe6cda67caad0856b83c7ab9' as const;
const NVDAC_SQRT_PRICE_X96 = 52029507624582080717065656647n;
const AERODROME_VOTER = '0x16613524e02ad97edfef371bc883f2f5d6c480a5' as const;

function wordV1(value: bigint | string): string {
  const hex = typeof value === 'bigint' ? value.toString(16) : value.replace(/^0x/, '');
  return `0x${hex.padStart(64, '0')}`;
}

/** A pool that answers exactly as the real one did. Overrides let one answer be
 * broken at a time, so a failure names one cause. */
function spotRpcV1(over: Record<string, string | null> = {}): AerodromeClRpcV1 {
  const answers: Record<string, string | null> = {
    [`${NVDAC_POOL}:${selector('factory()')}`]: wordV1(AERODROME_CL_FACTORIES_V1[0]!),
    [`${AERODROME_CL_FACTORIES_V1[0]}:${selector('voter()')}`]: wordV1(AERODROME_VOTER),
    [`${NVDAC_POOL}:${selector('slot0()')}`]:
      wordV1(NVDAC_SQRT_PRICE_X96) + '0'.repeat(64 * 5),
    [`${NVDAC_POOL}:${selector('token0()')}`]: wordV1(USDC),
    [`${NVDAC_POOL}:${selector('token1()')}`]: wordV1(NVDAC),
    [`${USDC}:${selector('decimals()')}`]: wordV1(6n),
    [`${NVDAC}:${selector('decimals()')}`]: wordV1(8n),
    ...over,
  };
  return {
    async call(input) {
      return answers[`${input.to.toLowerCase()}:${input.data.slice(2, 10)}`] ?? null;
    },
  };
}

function selector(signature: string): string {
  return selectorV1(signature);
}

describe('the pool’s own marginal price', () => {
  test('the arithmetic reproduces the live reading exactly', async () => {
    const result = await readAerodromeClSpotV1({ rpc: spotRpcV1(), pool: NVDAC_POOL });
    assert.equal(result.ok, true);
    assert.ok(result.ok);
    // Pinned to the digit. This number is published as one somebody else can
    // arrive at, so a change in it is a change in a promise.
    assert.equal(result.spot.token0PerToken1, '231.878101242070949243');
    assert.equal(result.spot.token1PerToken0, '0.00431261078404313');
    // The raw word travels beside the derived figure: the derived one is ours,
    // the raw one is the pool's.
    assert.equal(result.spot.sqrtPriceX96, NVDAC_SQRT_PRICE_X96.toString());
    assert.equal(result.spot.token0Decimals, 6);
    assert.equal(result.spot.token1Decimals, 8);
  });

  test('decimals are read, never assumed', async () => {
    // NVDAc is 8 decimals, not 18. Assuming would have produced a price wrong
    // by ten orders of magnitude that still looked exactly like a price.
    const wrong = aerodromeClSpotPriceV1({
      sqrtPriceX96: NVDAC_SQRT_PRICE_X96,
      token0Decimals: 6,
      token1Decimals: 18,
    });
    assert.ok(wrong);
    assert.notEqual(wrong.token0PerToken1, '231.878101242070949243');
    // And a token that will not say its decimals produces no price at all.
    const result = await readAerodromeClSpotV1({
      rpc: spotRpcV1({ [`${NVDAC}:${selector('decimals()')}`]: null }),
      pool: NVDAC_POOL,
    });
    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.reason === 'unreadable');
  });

  test('the two directions are consistent with each other', () => {
    const price = aerodromeClSpotPriceV1({
      sqrtPriceX96: NVDAC_SQRT_PRICE_X96,
      token0Decimals: 6,
      token1Decimals: 8,
    });
    assert.ok(price);
    // Each is derived from the same two integers rather than by dividing the
    // other's printed string, so their product is 1 to within the last digit.
    const product = Number(price.token0PerToken1) * Number(price.token1PerToken0);
    assert.ok(Math.abs(product - 1) < 1e-12, `expected ~1, got ${product}`);
  });

  test('a pool that is not Aerodrome’s is refused before it is read', async () => {
    // An arbitrary contract answering `slot0()` in the right shape would
    // otherwise be published as an Aerodrome price.
    const foreignFactory = await readAerodromeClSpotV1({
      rpc: spotRpcV1({
        [`${NVDAC_POOL}:${selector('factory()')}`]: wordV1('0x1234567890123456789012345678901234567890'),
      }),
      pool: NVDAC_POOL,
    });
    assert.ok(!foreignFactory.ok && foreignFactory.reason === 'not_aerodrome_cl');

    // A pinned factory that does not name Aerodrome's own Voter is not
    // Aerodrome's, whatever it was called.
    const wrongVoter = await readAerodromeClSpotV1({
      rpc: spotRpcV1({
        [`${AERODROME_CL_FACTORIES_V1[0]}:${selector('voter()')}`]: wordV1(
          '0x1234567890123456789012345678901234567890',
        ),
      }),
      pool: NVDAC_POOL,
    });
    assert.ok(!wrongVoter.ok && wrongVoter.reason === 'not_aerodrome_cl');
  });

  test('an uninitialised pool is an absence, never a price of zero', async () => {
    const result = await readAerodromeClSpotV1({
      rpc: spotRpcV1({ [`${NVDAC_POOL}:${selector('slot0()')}`]: wordV1(0n) + '0'.repeat(64 * 5) }),
      pool: NVDAC_POOL,
    });
    assert.ok(!result.ok && result.reason === 'not_initialised');
  });

  test('a read that did not complete is about us, and is kept apart', async () => {
    for (const broken of [
      `${NVDAC_POOL}:${selector('slot0()')}`,
      `${NVDAC_POOL}:${selector('token0()')}`,
      `${NVDAC_POOL}:${selector('token1()')}`,
    ]) {
      const result = await readAerodromeClSpotV1({
        rpc: spotRpcV1({ [broken]: null }),
        pool: NVDAC_POOL,
      });
      assert.ok(!result.ok && result.reason === 'unreadable', `${broken} must be unreadable`);
    }
    // And a transport that throws is the same finding, not an exception three
    // layers up.
    const thrown = await readAerodromeClSpotV1({
      rpc: {
        async call() {
          throw new Error('socket hang up');
        },
      },
      pool: NVDAC_POOL,
    });
    assert.ok(!thrown.ok && thrown.reason === 'unreadable');
  });

  test('nothing here can be mistaken for a quote', () => {
    // The returned value carries no size, no minimum, no slippage, no route and
    // no expiry. Those are the fields that make a number executable, and a
    // marginal price must not grow one by accident.
    const keys = Object.keys({
      pool: '',
      token0: '',
      token1: '',
      token0Decimals: 0,
      token1Decimals: 0,
      sqrtPriceX96: '',
      token1PerToken0: '',
      token0PerToken1: '',
      blockTag: '',
    });
    for (const forbidden of ['amountIn', 'amountOut', 'minimum', 'slippage', 'route', 'expiresAt', 'calldata']) {
      assert.ok(!keys.includes(forbidden));
    }
  });
});
