import {
  UNISWAP_V4_INITIALIZE_TOPIC_V1,
  UNISWAP_V4_POOL_MANAGER_V1,
  b20PoolFromInitializeLogV1,
  quoteV4ExactInputV1,
} from '@mioagent/swap-adapters';

// ---------------------------------------------------------------------------
// Read-only diagnostic: what does it cost to get OUT of a tokenized equity?
//
// Base publishes thirteen Coinbase tokenized stocks as B20 tokens; four of them
// trade. Measured 2026-08-25, those four have 2,208 Uniswap v4 pools between
// them, and 94% of the pools quote them against another B20 token or some other
// long-tail ERC-20 — an exit into something the holder would then have to exit
// from again. Nine pools quote them in money AND carried a swap in the sampled
// hour. This measures the round trip through exactly those nine.
//
// A round trip is quoted, not assumed: buy the position with the quote asset,
// then sell every token the buy returned. The difference is what the venue
// costs, hook and pool fee included, because the v4 Quoter simulates the real
// swap rather than reading reserves.
//
// The pool fee alone bounds the answer from below — a 5% pool cannot return a
// round trip under 10% — but the bound is not the answer, and printing the
// quote is the difference between arithmetic and a measurement.
//
// WHAT THIS PROBE DOES NOT MEASURE, corrected 2026-08-25
//
// One venue. Its readings below are accurate about Uniswap v4 and were
// published as if they were facts about the assets, which they are not: the
// same $1,000 AAPLc position that sells back at no size in ANY of these pools
// round-trips for 11 basis points through an Aerodrome concentrated-liquidity
// pool. The market was never here.
//
// Keep this probe for what it is good at -- reading one pool exactly, hook
// included, with the size ladder that separates "the position reverts" from
// "nothing sells". For whether a holder can get out at all, use
// probe_official_cash_exit.ts, which asks every venue an aggregator reaches.
//
// Signs nothing, sends nothing, prints no endpoint.
// ---------------------------------------------------------------------------

const RPC_V1 = process.env.BASE_MAINNET_RPC_URL ?? process.env.BASE_RPC_URL ?? 'https://mainnet.base.org';
/** mainnet.base.org sustains about 0.5 eth_call/s from one IP. */
const GAP_MS_V1 = Number.parseInt(process.env.B20_PROBE_GAP_MS ?? '2500', 10);

const USDC_V1 = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const NATIVE_V1 = '0x0000000000000000000000000000000000000000';

/** The nine money pools, from the 2026-08-25 inventory. Block is where the pool
 * was initialised — the log there carries the whole PoolKey. */
const AAPL_V1 = '0xb200000000000000000000c2e324d24d7eecd1fb';

/** Every AAPLc pool quoted in money, not just the one that traded in the
 * sampled hour. A headline saying "you cannot get out of tokenized Apple" has
 * to survive its own token's whole venue list first. */
const AAPL_ALL_MONEY_POOLS_V1: ReadonlyArray<{ symbol: string; token: string; block: number; note: string }> = [
  50069886, 50099170, 50131100, 50131304, 50134274, 50135241, 50135827, 50136361,
  50136639, 50136724, 50137033, 50169093, 50169104, 50169528, 50223285, 50401407, 50401621,
].map((block) => ({ symbol: 'AAPLc', token: AAPL_V1, block, note: `pool@${block}` }));

const POOLS_V1: ReadonlyArray<{ symbol: string; token: string; block: number; note: string }> = [
  { symbol: 'AAPLc', token: '0xb200000000000000000000c2e324d24d7eecd1fb', block: 50136361, note: 'USDC 5%' },
  { symbol: 'METAc', token: '0xb2000000000000000000008bc8786b856e61707c', block: 50137453, note: 'USDC 10%' },
  { symbol: 'GOOGLc', token: '0xb2000000000000000000002d0ba3164cc74f58b7', block: 50346397, note: 'USDC 0.3%' },
  { symbol: 'GOOGLc', token: '0xb2000000000000000000002d0ba3164cc74f58b7', block: 50097703, note: 'ETH 5%' },
  { symbol: 'NVDAc', token: '0xb20000000000000000000078ee7ce2fe4908108c', block: 50401511, note: 'USDC 1.1%' },
  { symbol: 'NVDAc', token: '0xb20000000000000000000078ee7ce2fe4908108c', block: 50352039, note: 'USDC 0.9%' },
  { symbol: 'NVDAc', token: '0xb20000000000000000000078ee7ce2fe4908108c', block: 50167757, note: 'USDC 3%' },
  { symbol: 'NVDAc', token: '0xb20000000000000000000078ee7ce2fe4908108c', block: 50399454, note: 'ETH dynamic' },
  { symbol: 'NVDAc', token: '0xb20000000000000000000078ee7ce2fe4908108c', block: 50137627, note: 'ETH 10%' },
];

/** One thousand dollars, and a quarter of an ether. Sizes a person might hold,
 * not the profile default — the point of this probe is a real position. */
const POSITION_USDC_V1 = 1_000_000_000n;
const POSITION_NATIVE_V1 = 250_000_000_000_000_000n;

let lastCallAt = 0;

async function rpcV1(method: string, params: unknown[]): Promise<unknown> {
  const wait = lastCallAt + GAP_MS_V1 - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastCallAt = Date.now();
  const response = await fetch(RPC_V1, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': 'miorail-diagnostic/1' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!response.ok) throw new Error(`http ${response.status}`);
  const body = (await response.json()) as { result?: unknown; error?: { message?: string } };
  if (body.error) throw new Error(body.error.message ?? 'rpc error');
  return body.result;
}

const call = async (request: { to: string; data: string }): Promise<string> => {
  const result = await rpcV1('eth_call', [{ to: request.to, data: request.data }, 'latest']);
  return typeof result === 'string' ? result : '';
};

function pct(bps: bigint): string {
  const sign = bps < 0n ? '-' : '';
  const absolute = bps < 0n ? -bps : bps;
  return `${sign}${(Number(absolute) / 100).toFixed(2)}%`;
}

async function main(): Promise<void> {
  const targets = process.argv.includes('--aapl-all') ? AAPL_ALL_MONEY_POOLS_V1 : POOLS_V1;
  console.log('round trip through the money pools of Base tokenized equities\n');
  for (const entry of targets) {
    const tokenTopic = `0x000000000000000000000000${entry.token.slice(2)}`;
    let logs: Array<{ address?: string; topics?: string[]; data?: string; blockNumber?: string }> = [];
    for (const topics of [
      [UNISWAP_V4_INITIALIZE_TOPIC_V1, null, null, tokenTopic],
      [UNISWAP_V4_INITIALIZE_TOPIC_V1, null, tokenTopic, null],
    ]) {
      const found = (await rpcV1('eth_getLogs', [
        {
          address: UNISWAP_V4_POOL_MANAGER_V1,
          fromBlock: `0x${entry.block.toString(16)}`,
          toBlock: `0x${entry.block.toString(16)}`,
          topics,
        },
      ])) as typeof logs;
      logs = logs.concat(found);
    }

    const decoded = logs
      .map((log) => b20PoolFromInitializeLogV1(log, entry.token))
      .find((result) => result.ok);
    if (!decoded || !decoded.ok) {
      console.log(`${entry.symbol.padEnd(7)} ${entry.note.padEnd(12)} pool key unreadable at block ${entry.block}`);
      continue;
    }

    const { key, tokenIsCurrency0, quoteAsset } = decoded.pool;
    const position = quoteAsset === USDC_V1 ? POSITION_USDC_V1 : POSITION_NATIVE_V1;
    const label = quoteAsset === USDC_V1 ? '1,000 USDC' : quoteAsset === NATIVE_V1 ? '0.25 ETH' : '0.25 WETH';

    // Buying the token means spending the quote asset, so the direction is
    // whichever side the quote asset sits on.
    const buy = await quoteV4ExactInputV1({
      key,
      zeroForOne: !tokenIsCurrency0,
      exactAmountAtomic: position,
      call,
    });
    if (!buy.ok) {
      console.log(`${entry.symbol.padEnd(7)} ${entry.note.padEnd(12)} buy refused: ${buy.refusal}`);
      continue;
    }

    // A ladder, not a single sell. "The whole position reverts" and "nothing
    // sells at any size" are different facts about a token, and only the
    // second one means there is no way out. Descending, because the first
    // rung that prices is the largest exit this pool can actually absorb.
    const bought = BigInt(buy.amountOutAtomic);
    const bought8 = (Number(bought) / 1e8).toFixed(4);
    let sold: { fraction: string; returned: bigint } | null = null;
    let lastRefusal = '';
    for (const [numerator, denominator, fraction] of [
      [1n, 1n, '100%'],
      [1n, 2n, '50%'],
      [1n, 10n, '10%'],
      [1n, 100n, '1%'],
    ] as const) {
      const size = (bought * numerator) / denominator;
      if (size === 0n) continue;
      const sell = await quoteV4ExactInputV1({
        key,
        zeroForOne: tokenIsCurrency0,
        exactAmountAtomic: size,
        call,
      });
      if (sell.ok) {
        sold = { fraction, returned: BigInt(sell.amountOutAtomic) };
        break;
      }
      lastRefusal = sell.refusal;
    }

    if (!sold) {
      console.log(
        `${entry.symbol.padEnd(7)} ${entry.note.padEnd(12)} ${label} buys ${bought8} tokens — NOTHING SELLS, down to 1% (${lastRefusal})`,
      );
      continue;
    }

    // The round trip is only comparable when the whole position came back. A
    // partial sale is reported as what it is: the size that priced.
    if (sold.fraction === '100%') {
      const costBps = ((position - sold.returned) * 10_000n) / position;
      console.log(
        `${entry.symbol.padEnd(7)} ${entry.note.padEnd(12)} ${label} -> ${bought8} tokens -> back   round trip ${pct(costBps)}`,
      );
    } else {
      const scaled = (sold.returned * 10_000n) / position;
      console.log(
        `${entry.symbol.padEnd(7)} ${entry.note.padEnd(12)} ${label} buys ${bought8} tokens — only ${sold.fraction} of it sells, returning ${pct(scaled)} of the position`,
      );
    }
  }
}

main().catch((error) => {
  console.error('probe failed:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
