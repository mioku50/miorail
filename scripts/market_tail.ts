/**
 * The shadow market tail: what actually moved, for the tracked assets.
 *
 * Reads the tokens' own Transfer logs, works out which counterparties are
 * venues by asking them, and stores the transfers that had a venue on exactly
 * one side. Nothing it writes reaches a screen — this is the 24-to-48-hour
 * shadow run the roadmap asks for before any UI depends on it.
 *
 * It stores movements, not trades. A pool moves the token for a swap and for a
 * liquidity change alike, and telling those apart costs a second read against
 * the venue's own event.
 *
 * WHY THE LEDGER AND NOT ONE VENUE'S EVENTS
 *
 * A Uniswap v4 singleton tail is the right instrument for the launch corpus
 * and the wrong one for this vertical: the official tokenized equities trade
 * mostly on Aerodrome, and a v4-only tail would report a quiet market on
 * assets doing hundreds of swaps an hour. A token's own ledger has no such
 * blind spot, because every venue moves the token.
 *
 * COST
 *
 * One `eth_getLogs` covers every tracked token for the whole range. Venue
 * identity costs two `eth_call`s once per address, then never again, and the
 * per-pass budget for those is bounded by `--max-identity`. Both counts
 * accumulate on the cursor, so the price of this reader is a stored number
 * rather than a claim.
 *
 * Read-only. No signer, no key, no wallet, no chain write. The RPC URL is read
 * from the environment and never printed.
 *
 *   pnpm rwa:market-tail --dry
 *   pnpm rwa:market-tail --passes 4
 */
import { client, closeDb } from '@mioagent/db';
import {
  MARKET_TAIL_MAX_SPAN_V1,
  OFFICIAL_ASSET_LEDGER_TAIL_KEY_V1,
  UNISWAP_V4_SINGLETON_V1,
  assetTransfersFromLogsV1,
  createMarketTailSourceV1,
  tailRangeV1,
  venueTransfersFromLedgerV1,
  venueCandidatesFromTransfersV1,
  venueFromPairReadsV1,
  type VenueV1,
} from '@mioagent/market-tail';
import {
  createDatabaseMarketTailRepository,
  createDatabaseOfficialAssetRepository,
  type MarketVenueTransferRowV1,
  type MarketVenueRowV1,
} from '@mioagent/route-storage';

import { loadRootEnvFileV1, reportLoadedEnvFileV1 } from './loadEnvFile.js';

const CHAIN_ID_V1 = 8453 as const;

interface ArgsV1 {
  passes: number;
  blocks: number;
  maxIdentity: number;
  /** Where a first-ever run starts, counted back from the head. */
  fromHead: number;
  dry: boolean;
}

function parseArgsV1(argv: readonly string[]): ArgsV1 {
  const number = (flag: string, fallback: number): number => {
    const index = argv.indexOf(flag);
    if (index < 0) return fallback;
    const parsed = Number.parseInt(argv[index + 1] ?? '', 10);
    if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${flag} takes a positive whole number`);
    return parsed;
  };
  return {
    passes: number('--passes', 1),
    blocks: number('--blocks', MARKET_TAIL_MAX_SPAN_V1),
    maxIdentity: number('--max-identity', 10),
    fromHead: number('--from-head', MARKET_TAIL_MAX_SPAN_V1),
    dry: argv.includes('--dry'),
  };
}

async function main(): Promise<void> {
  const args = parseArgsV1(process.argv);
  reportLoadedEnvFileV1(loadRootEnvFileV1());
  const rpcUrl = (process.env.BASE_MAINNET_RPC_URL ?? process.env.BASE_RPC_URL ?? '').trim();
  if (rpcUrl.length === 0) throw new Error('BASE_MAINNET_RPC_URL is not set');

  const source = createMarketTailSourceV1({ rpcUrl });
  const official = createDatabaseOfficialAssetRepository(client);
  const tail = createDatabaseMarketTailRepository(client);

  // The universe is what a reviewed source still lists. A background reader
  // whose universe is a hand-kept array is a budget with no owner.
  const assets = await official.officialAssets({ chainId: CHAIN_ID_V1, limit: 200 });
  const tokens = assets.map((asset) => asset.tokenAddress);
  if (tokens.length === 0) {
    throw new Error('no official asset is currently listed — run pnpm rwa:ingest-official first');
  }
  console.log(`tracking ${tokens.length} official asset(s)\n`);

  for (let pass = 0; pass < args.passes; pass += 1) {
    const head = await source.headBlock();
    if (!head.ok) {
      console.log(`pass ${pass + 1}: ${head.reason}`);
      break;
    }
    const cursor = await tail.readCursor({ tailKey: OFFICIAL_ASSET_LEDGER_TAIL_KEY_V1 });
    const lastBlock = cursor?.lastBlock ?? Math.max(1, head.value - args.fromHead);
    const range = tailRangeV1({ lastBlock, headBlock: head.value, maxSpan: args.blocks });
    if (!range.ok) {
      console.log(`pass ${pass + 1}: caught up at block ${lastBlock}`);
      break;
    }

    let logCalls = 0;
    let identityCalls = 0;
    const logs = await source.transferLogs({
      tokens,
      fromBlock: range.fromBlock,
      toBlock: range.toBlock,
    });
    logCalls += 1;
    if (!logs.ok) {
      // The cursor stays where it is. A range read half-way is a range not
      // read, because nothing here comes back to it.
      console.log(`pass ${pass + 1}: ${range.fromBlock}-${range.toBlock} — ${logs.reason}`);
      break;
    }

    const transfers = assetTransfersFromLogsV1({ logs: logs.value, trackedTokens: tokens });
    // Read by kind rather than as one page. Routers accumulate faster than
    // pools do, and a single bounded read would eventually push the identified
    // venues off the end -- which looks exactly like a market going quiet.
    const knownVenues = await tail.venues({
      chainId: CHAIN_ID_V1,
      kinds: ['paired_pool', 'singleton'],
      limit: 1_000,
    });
    const knownCandidates = await tail.venues({
      chainId: CHAIN_ID_V1,
      kinds: ['candidate'],
      limit: 1_000,
    });
    const knownNegatives = await tail.venues({
      chainId: CHAIN_ID_V1,
      kinds: ['not_a_venue'],
      limit: 1_000,
    });
    const stored = [...knownVenues, ...knownCandidates, ...knownNegatives];
    const storedByAddress = new Map(stored.map((row) => [row.address, row]));
    const fresh = venueCandidatesFromTransfersV1({
      transfers,
      known: stored.map((row) => row.address),
    });

    // Stored candidates first: an address has been waiting for its two calls
    // since the pass that met it.
    const queue = [...knownCandidates.map((row) => row.address), ...fresh].slice(0, args.maxIdentity);

    const observedAt = new Date().toISOString();
    const venueRows: MarketVenueRowV1[] = [];
    const identified: VenueV1[] = knownVenues.map((row) => ({
      address: row.address,
      kind: row.kind,
      token0: row.token0,
      token1: row.token1,
    }));

    for (const address of queue) {
      let venue: VenueV1;
      if (address === UNISWAP_V4_SINGLETON_V1) {
        // Every v4 pool lives in one contract, so it has no pair to answer
        // with and is never asked for one.
        venue = venueFromPairReadsV1({ address, token0: null, token1: null });
      } else {
        const reads = await source.pairReads(address);
        if (!reads.ok) {
          // Our failure, not the address's answer. It is written back as a
          // candidate so the next pass asks it FIRST rather than rediscovering
          // it, and it is never recorded as not-a-venue on a bad minute.
          identityCalls += 1;
          venueRows.push({
            chainId: CHAIN_ID_V1,
            address,
            kind: 'candidate',
            token0: null,
            token1: null,
            firstSeenAt: storedByAddress.get(address)?.firstSeenAt ?? observedAt,
            identifiedAt: null,
          });
          continue;
        }
        identityCalls += reads.value.calls;
        venue = venueFromPairReadsV1({ address, token0: reads.value.token0, token1: reads.value.token1 });
      }
      venueRows.push({
        chainId: CHAIN_ID_V1,
        address: venue.address,
        kind: venue.kind,
        token0: venue.token0,
        token1: venue.token1,
        firstSeenAt: storedByAddress.get(venue.address)?.firstSeenAt ?? observedAt,
        identifiedAt: observedAt,
      });
      if (venue.kind === 'paired_pool' || venue.kind === 'singleton') identified.push(venue);
    }

    // Candidates this pass met but could not afford to ask. Recorded so the
    // next pass starts from them rather than rediscovering them.
    const asked = new Set(queue);
    for (const address of fresh) {
      if (asked.has(address)) continue;
      venueRows.push({
        chainId: CHAIN_ID_V1,
        address,
        kind: 'candidate',
        token0: null,
        token1: null,
        firstSeenAt: observedAt,
        identifiedAt: null,
      });
    }

    const events: MarketVenueTransferRowV1[] = venueTransfersFromLedgerV1({
      transfers,
      venues: identified,
    }).map((event) => ({
      chainId: CHAIN_ID_V1,
      tokenAddress: event.tokenAddress,
      venueAddress: event.venueAddress,
      direction: event.direction,
      counterparty: event.counterparty,
      amountAtomic: event.amountAtomic,
      blockNumber: event.blockNumber,
      transactionHash: event.transactionHash,
      logIndex: event.logIndex,
      observedAt,
    }));

    const blocks = range.toBlock - range.fromBlock + 1;
    console.log(
      `pass ${pass + 1}: blocks ${range.fromBlock}-${range.toBlock} (${blocks})  ` +
        `transfers ${transfers.length}  candidates ${fresh.length}  ` +
        `asked ${queue.length} -> ${venueRows.filter((row) => row.kind === 'paired_pool' || row.kind === 'singleton').length} venue(s)  ` +
        `events ${events.length}  calls ${logCalls} log + ${identityCalls} identity`,
    );

    if (args.dry) continue;
    const outcome = await tail.recordPass({
      tailKey: OFFICIAL_ASSET_LEDGER_TAIL_KEY_V1,
      chainId: CHAIN_ID_V1,
      toBlock: range.toBlock,
      observedAt,
      logCalls,
      identityCalls,
      venues: venueRows,
      events,
    });
    console.log(
      `  stored ${outcome.inserted} new, ${outcome.duplicates} already seen; ` +
        `venues +${outcome.venuesAdded} new, ${outcome.venuesIdentified} answered; ` +
        `cursor at ${outcome.cursor.lastBlock} after ${outcome.cursor.passes} pass(es), ` +
        `${outcome.cursor.logCalls} log + ${outcome.cursor.identityCalls} identity calls total`,
    );
  }

  if (!args.dry) {
    const activity = await tail.venueActivity({
      chainId: CHAIN_ID_V1,
      tokenAddresses: tokens,
      sinceBlock: 0,
    });
    console.log('\nobserved so far:');
    for (const row of activity) {
      const asset = assets.find((entry) => entry.tokenAddress === row.tokenAddress);
      console.log(
        `  ${(asset?.listings[0].ticker ?? row.tokenAddress).padEnd(7)} ` +
          `${row.transfers} movement(s), ${row.acquired} acquired / ${row.disposed} disposed, ` +
          `blocks ${row.firstBlock}-${row.lastBlock}`,
      );
    }
    // A token with no row was not observed trading. That is different from a
    // measured zero, and it is printed as absence rather than as a count.
    const silent = tokens.filter((token) => !activity.some((row) => row.tokenAddress === token));
    if (silent.length > 0) console.log(`  ${silent.length} tracked asset(s) not observed at all`);
  }
}

main()
  .catch((error) => {
    console.error('market tail failed:', error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDb();
  });
