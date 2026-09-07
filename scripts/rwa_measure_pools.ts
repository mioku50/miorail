/**
 * What is actually IN the pools that hold each reviewed representation.
 *
 * Use & access could only answer a LENDING question — Moonwell, Morpho, Aave
 * v3, Compound v3, three of them `not_listed` — so a token whose largest
 * onchain use by a wide margin is an Aerodrome concentrated-liquidity pool read
 * as a token with almost no DeFi presence. The pools were already discovered:
 * `market_venues` knew thirty-nine of them for NVDAc alone. Nothing measured
 * what was in them, so nothing could be said.
 *
 * A COUNT would have been worse than silence. Twenty-four of those thirty-nine
 * are Uniswap v3 pairs against memecoins — 71 NVDAc against 212 million KUMA —
 * and "39 pools" is true arithmetic about a market that does not exist. So this
 * stores the measured balance of both sides and the screen ranks by it.
 *
 * Every venue is decided by reading the chain: the pool's own `factory()`, and
 * for Aerodrome that factory's `voter()`. Not a list of addresses — the
 * published Aerodrome CL factory is NOT the one the pool holding nearly all the
 * money sits in, and a list would have mislabelled exactly that pool.
 *
 * Read-only: no signer, no key, no wallet, no transaction, no allowance.
 *
 *   pnpm tsx scripts/rwa_measure_pools.ts --dry
 *   pnpm tsx scripts/rwa_measure_pools.ts
 *   pnpm tsx scripts/rwa_measure_pools.ts --gap-ms 2000 --max-tokens 20
 */
import {
  callManyV1,
  createB20ReaderV1,
  decodeUint8V1,
  encodeNoArgsV1,
} from '@mioagent/b20-control';
import { client, closeDb } from '@mioagent/db';
import {
  createDatabaseMarketPoolReadingRepository,
  createDatabaseMarketTailRepository,
  createDatabaseUnderlyingAssetRepository,
} from '@mioagent/route-storage';
import {
  POOL_SELECTORS_V1,
  measurePoolsV1,
  poolVenueFromIdentityV1,
  readFactoryIdentityV1,
  readPoolShapesV1,
} from '@mioagent/rwa-issuer';

import { loadRootEnvFileV1, reportLoadedEnvFileV1 } from './loadEnvFile.js';

const CHAIN_ID_V1 = 8453 as const;
/** Paced like every other measurement worker: these reads share one endpoint
 * with the market tail and the ratio reader. */
const DEFAULT_GAP_MS_V1 = 1_200;
/** The store caps a venue page at a thousand; a hundred and twenty-eight
 * paired pools exist today, so one page is the whole corpus. */
const VENUE_PAGE_V1 = 1_000;

function numericArgV1(flag: string, fallback: number): number {
  const index = process.argv.indexOf(flag);
  if (index < 0) return fallback;
  const value = Number.parseInt(String(process.argv[index + 1] ?? ''), 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  const dry = process.argv.includes('--dry');
  const gapMs = numericArgV1('--gap-ms', DEFAULT_GAP_MS_V1);
  const maxTokens = numericArgV1('--max-tokens', 100);
  reportLoadedEnvFileV1(loadRootEnvFileV1());

  // A lane of its own, when the operator gives it one.
  //
  // This worker makes four reads per pool and there are a hundred and
  // twenty-eight of them, which is a different shape of load from the one-read
  // evidence workers that share the API's endpoint. Measured on 2026-09-07: the
  // same pass answered 121 complete readings against one endpoint and 64 with a
  // third of the pairs unread against another, purely on rate limits. The
  // endpoint is a deployment decision, so it is an env var rather than a choice
  // made here.
  const rpcUrl = (
    process.env.MIORAIL_POOLS_RPC_URL ||
    process.env.BASE_MAINNET_RPC_URL ||
    process.env.BASE_RPC_URL ||
    ''
  ).trim();
  if (!rpcUrl) throw new Error('a Base RPC endpoint is required to read a pool balance');

  const tail = createDatabaseMarketTailRepository(client);
  const underlyings = createDatabaseUnderlyingAssetRepository(client);
  const readings = createDatabaseMarketPoolReadingRepository(client);
  // Retries are the difference between "the other side was not read" and a
  // complete row: every failure this worker saw in production was a rate-limit
  // response, which the next attempt answers.
  const reader = createB20ReaderV1({ rpcUrl, maxRetries: 5, timeoutMs: 15_000 });

  // The corpus is the REVIEWED representations, never every token that ever
  // appeared in a pool. A pool holding a token nobody reviewed has nothing to
  // be rendered under.
  const underlyingRows = await underlyings.listUnderlyings({ chainId: CHAIN_ID_V1, limit: 500 });
  const reviewed = new Set<string>();
  for (const row of underlyingRows) {
    const bound = await underlyings.representationsOf({
      chainId: CHAIN_ID_V1,
      underlyingKey: row.underlying.underlyingKey,
    });
    for (const representation of bound) reviewed.add(representation.tokenAddress.toLowerCase());
  }

  const venues = await tail.venues({
    chainId: CHAIN_ID_V1,
    kinds: ['paired_pool'],
    limit: VENUE_PAGE_V1,
  });

  // One token, every pool that holds it. A pool appears under BOTH of its
  // sides when both are reviewed, because "3,740 NVDAc against $1.61m USDC"
  // and its mirror are the same pool and different answers.
  const poolsByToken = new Map<string, string[]>();
  for (const venue of venues) {
    for (const side of [venue.token0, venue.token1]) {
      if (!side) continue;
      const token = side.toLowerCase();
      if (!reviewed.has(token)) continue;
      const list = poolsByToken.get(token) ?? [];
      list.push(venue.address.toLowerCase());
      poolsByToken.set(token, list);
    }
  }

  console.log(
    `${reviewed.size} reviewed representation(s), ${venues.length} paired pool(s), ` +
      `${poolsByToken.size} token(s) with at least one pool`,
  );
  if (poolsByToken.size === 0) return;

  const anchorRead = await reader.readBlockAnchor();
  if (!anchorRead.ok) {
    // Every balance is pinned to one block, so a pool and its pair describe one
    // moment. Without an anchor there is nothing to pin them to, and a mixed
    // set is worse than none — the difference shows up exactly when the market
    // is moving, which is when somebody is reading.
    console.log(`  no block anchor (${anchorRead.reason}) — nothing read, nothing stored`);
    return;
  }
  const anchor = anchorRead.value;
  // The anchor carries its block as a decimal STRING, and the reading stores a
  // number: converting here rather than at the store keeps the store strict.
  const blockNumber = Number.parseInt(anchor.blockNumber, 10);
  if (!Number.isSafeInteger(blockNumber) || blockNumber < 0) {
    console.log(`  block anchor is not a number (${anchor.blockNumber}) — nothing stored`);
    return;
  }
  console.log(`  anchored at block ${blockNumber}`);
  if (dry) {
    console.log('  --dry: nothing read, nothing stored');
    return;
  }

  // Every factory, asked once. A factory serves many pools and paying for the
  // same answer thirty times is how a paced worker stops fitting in its window.
  const allPools = [...new Set([...poolsByToken.values()].flat())];
  const factoryReads = await callManyV1(
    reader,
    allPools.map((pool) => ({
      to: pool,
      data: encodeNoArgsV1(POOL_SELECTORS_V1.factory),
      blockTag: anchor.blockTag,
    })),
  );
  const factories = new Set<string>();
  for (const result of factoryReads) {
    if (!result.ok) continue;
    const word = result.value.replace(/^0x/, '');
    if (word.length !== 64 || !/^0{24}/.test(word)) continue;
    factories.add(`0x${word.slice(24)}`.toLowerCase());
  }
  const factoryIdentity = await readFactoryIdentityV1({
    reader,
    factories: [...factories],
    blockTag: anchor.blockTag,
  });
  console.log(
    `  ${factories.size} factory/factories, ` +
      `${[...factoryIdentity.values()].filter((identity) => identity.voter).length} answering an Aerodrome voter`,
  );

  // The pools their factory could not place, asked about their own shape. A
  // factory answer covers every pool it made, so this is the remainder — three
  // pools today, minimal-proxy clones behind a factory with no public ABI.
  const unplaced = new Map<string, string>();
  for (const [index, pool] of allPools.entries()) {
    const result = factoryReads[index];
    if (!result?.ok) continue;
    const word = result.value.replace(/^0x/, '');
    if (word.length !== 64 || !/^0{24}/.test(word)) continue;
    const identity = factoryIdentity.get(`0x${word.slice(24)}`.toLowerCase());
    if (identity && poolVenueFromIdentityV1(identity) === null) unplaced.set(pool.toLowerCase(), pool);
  }
  const poolShapes = await readPoolShapesV1({
    reader,
    pools: [...unplaced.values()],
    blockTag: anchor.blockTag,
  });
  console.log(
    `  ${unplaced.size} pool(s) their factory could not place, ` +
      `${[...poolShapes.values()].filter((shape) => shape.concentrated || shape.pair).length} answered a shape`,
  );

  const readAt = new Date().toISOString();
  let tokensMeasured = 0;
  let rowsWritten = 0;
  let notPools = 0;
  let unread = 0;

  for (const [token, pools] of [...poolsByToken.entries()].slice(0, maxTokens)) {
    const decimalsRead = await callManyV1(reader, [
      { to: token, data: encodeNoArgsV1(POOL_SELECTORS_V1.decimals), blockTag: anchor.blockTag },
    ]);
    const first = decimalsRead[0];
    const decimals = first?.ok ? decodeUint8V1(first.value) : null;
    if (decimals === null) {
      // Without decimals every balance is an unlabelled integer. Skipping the
      // token is the honest outcome: a reading whose units are unknown cannot
      // be rendered, and defaulting to 18 would silently misstate every row.
      console.log(`  ${token}  decimals unread — skipped`);
      continue;
    }

    const outcome = await measurePoolsV1({
      reader,
      chainId: CHAIN_ID_V1,
      tokenAddress: token,
      tokenDecimals: decimals,
      pools,
      blockNumber,
      blockTag: anchor.blockTag,
      readAt,
      factoryIdentity,
      poolShapes,
    });
    const written = await readings.recordReadings({ readings: outcome.readings });
    tokensMeasured += 1;
    rowsWritten += written.written;
    notPools += outcome.notPools.length;
    unread += outcome.unread.length;
    console.log(
      `  ${token}  ${outcome.readings.length} reading(s), ` +
        `${outcome.notPools.length} not a pool, ${outcome.unread.length} unread`,
    );
    await sleep(gapMs);
  }

  console.log(
    `measured ${tokensMeasured} token(s), wrote ${rowsWritten} reading(s); ` +
      `${notPools} address(es) answered no factory, ${unread} balance(s) unread`,
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDb();
  });
