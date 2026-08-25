/**
 * How much of a position in an official tokenized equity converts back into
 * money right now, at four sizes, through whatever venue actually carries it.
 *
 * WHY THIS EXISTS BESIDE probe_official_exit.ts
 *
 * That probe asks one venue -- Uniswap v4 -- and answers precisely. Measured
 * on 2026-08-25 it reported that a $1,000 AAPLc position sells back at no size
 * across all seventeen of its v4 money pools, which is true and was published
 * as if it were a fact about the asset. It is not. The same $1,000 round-trips
 * for 11 basis points through an Aerodrome concentrated-liquidity pool. The
 * market was never in the venue we were measuring.
 *
 * So the universe here is every venue an aggregator can reach, and the
 * instrument is a routing quote rather than a pool read. One HTTP call answers
 * what ten to twelve eth_calls could not, because the aggregator has already
 * done the pool discovery -- which is also why this is the affordable shape
 * for a size ladder.
 *
 * WHAT A QUOTE IS AND IS NOT
 *
 * A routing quote is a claim about reachability and price, not a proof of
 * execution. It is enough to say a market exists and roughly what leaving
 * costs; it is not enough to sign anything. Nothing here may become an
 * approval: simulation before signature is unchanged.
 *
 * The asset universe is read live from the reviewed technical corpus, so this
 * cannot drift onto a hand-maintained list of tickers.
 *
 * Read-only. No signer, no key, no wallet, no chain write.
 *
 *   pnpm rwa:probe-cash-exit
 *   pnpm rwa:probe-cash-exit --sizes 100,1000
 */
import {
  OFFICIAL_SOURCES_V1,
  fetchOfficialSourceV1,
  parseBaseDocsCorpusV1,
} from '@mioagent/rwa-official';

const USDC_V1 = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const AGGREGATOR_V1 = 'https://aggregator-api.kyberswap.com/base/api/v1/routes';
/** Decade ladder. The interesting boundary is between rungs, not inside one. */
const DEFAULT_SIZES_USD_V1 = [100, 1_000, 10_000, 100_000] as const;
// Coinbase tokenized equities carry eight decimals, not eighteen -- which is
// why the token amount is never printed here. The round trip is measured in
// USDC on both ends, so no decimal assumption can reach the answer.
const GAP_MS_V1 = 700;

interface QuoteV1 {
  amountOutAtomic: bigint;
  venues: string[];
}

let lastCallAt = 0;

async function quoteV1(input: {
  tokenIn: string;
  tokenOut: string;
  amountInAtomic: bigint;
}): Promise<QuoteV1 | null> {
  const wait = lastCallAt + GAP_MS_V1 - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastCallAt = Date.now();
  const url = `${AGGREGATOR_V1}?tokenIn=${input.tokenIn}&tokenOut=${input.tokenOut}&amountIn=${input.amountInAtomic}`;
  const response = await fetch(url, { headers: { accept: 'application/json' } });
  if (!response.ok) return null;
  const body = (await response.json()) as {
    data?: { routeSummary?: { amountOut?: string; route?: { exchange?: string }[][] } };
  };
  const summary = body.data?.routeSummary;
  const amountOut = summary?.amountOut;
  if (!amountOut || amountOut === '0') return null;
  const venues = new Set<string>();
  for (const hop of summary?.route ?? []) {
    for (const leg of hop) if (leg.exchange) venues.add(leg.exchange);
  }
  return { amountOutAtomic: BigInt(amountOut), venues: [...venues].sort() };
}

function parseSizesV1(argv: readonly string[]): number[] {
  const index = argv.indexOf('--sizes');
  if (index < 0) return [...DEFAULT_SIZES_USD_V1];
  const parsed = (argv[index + 1] ?? '')
    .split(',')
    .map((value) => Number.parseInt(value.trim(), 10))
    .filter((value) => Number.isFinite(value) && value > 0);
  if (parsed.length === 0) throw new Error('--sizes takes a comma-separated list of whole dollar amounts');
  return parsed;
}

async function main(): Promise<void> {
  const sizes = parseSizesV1(process.argv);
  const source = OFFICIAL_SOURCES_V1.base_docs_technical;
  const fetched = await fetchOfficialSourceV1({ url: source.url });
  if (!fetched.ok) throw new Error(`the reviewed corpus could not be read: ${fetched.detail}`);
  const parsed = parseBaseDocsCorpusV1(fetched.body);
  if (!parsed.ok) throw new Error(`the reviewed corpus could not be parsed: ${parsed.refusal}`);

  console.log(`cash exit for ${parsed.assets.length} officially issued assets, ${sizes.length} sizes each`);
  console.log('a routing quote, not a simulation: this says a market is reachable, never that a trade is safe\n');

  for (const asset of parsed.assets) {
    const rungs: string[] = [];
    let venues: string[] = [];
    for (const size of sizes) {
      const positionAtomic = BigInt(size) * 1_000_000n;
      const buy = await quoteV1({
        tokenIn: USDC_V1,
        tokenOut: asset.tokenAddress,
        amountInAtomic: positionAtomic,
      });
      if (!buy) {
        rungs.push(`$${size.toLocaleString('en-US')} unavailable`);
        continue;
      }
      venues = buy.venues;
      const sell = await quoteV1({
        tokenIn: asset.tokenAddress,
        tokenOut: USDC_V1,
        amountInAtomic: buy.amountOutAtomic,
      });
      if (!sell) {
        // Bought and cannot be sold is a state of its own, and the one worth
        // saying out loud. It is not "no market".
        rungs.push(`$${size.toLocaleString('en-US')} BUY ONLY`);
        continue;
      }
      const costBps = ((positionAtomic - sell.amountOutAtomic) * 10_000n) / positionAtomic;
      rungs.push(`$${size.toLocaleString('en-US')} ${(Number(costBps) / 100).toFixed(2)}%`);
    }
    console.log(
      `${asset.ticker.padEnd(7)} ${asset.tokenAddress}  ${rungs.join('   ')}${
        venues.length > 0 ? `   via ${venues.join('+')}` : ''
      }`,
    );
  }
  console.log(`\nreference feeds are published for ${parsed.assets.filter((a) => a.referenceFeedAddress).length} of them; this probe reads none of them`);
}

main().catch((error) => {
  console.error('probe failed:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
