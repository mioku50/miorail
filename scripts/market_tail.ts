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
  B20_CORPORATE_ACTION_TOPIC_LIST_V1,
  B20_TOKENIZED_STOCK_GENESIS_BLOCK_V1,
  b20CorporateActionBlocksV1,
  b20CorporateActionObservationsV1,
} from '@mioagent/b20-control';
import { corporateActionSignalsV1 } from '@mioagent/rwa-dossier';
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
  B20_CORPORATE_ACTION_TAIL_KEY_V1,
  createDatabaseB20CorporateActionRepository,
  createDatabaseMarketTailRepository,
  createDatabaseOfficialAssetRepository,
  createDatabaseRepresentationSupplyRepository,
  createDatabaseRwaSignalRepository,
  createDatabaseUnderlyingAssetRepository,
  RWA_ONCHAIN_SIGNAL_KINDS_V1,
  type B20CorporateActionRowV1,
  type MarketVenueTransferRowV1,
  type MarketVenueRowV1,
  type RwaOnchainSignalKindV1,
} from '@mioagent/route-storage';

import { loadRootEnvFileV1, reportLoadedEnvFileV1 } from './loadEnvFile.js';
import { reviewedRepresentationTargetsV1 } from './rwaCashExitCorpus.js';

const CHAIN_ID_V1 = 8453 as const;

interface ArgsV1 {
  passes: number;
  blocks: number;
  maxIdentity: number;
  /** Where a first-ever run starts, counted back from the head. */
  fromHead: number;
  /** Passes of the corporate-action stage. Separate from the ledger's, because
   * a backfill over a year of blocks is ordinary for a topic filter that
   * matches almost nothing and ruinous for the transfer tail. */
  actionPasses: number;
  actionBlocks: number;
  /** Overrides where a first-ever corporate-action run starts. The default is
   * the block before the first tokenized stock existed, which is what makes
   * the empty record a measured range rather than an assumption. */
  actionFrom: number | null;
  actionsOnly: boolean;
  skipActions: boolean;
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
  const optional = (flag: string): number | null => {
    const index = argv.indexOf(flag);
    if (index < 0) return null;
    const parsed = Number.parseInt(argv[index + 1] ?? '', 10);
    if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${flag} takes a positive whole number`);
    return parsed;
  };
  return {
    passes: number('--passes', 1),
    blocks: number('--blocks', MARKET_TAIL_MAX_SPAN_V1),
    maxIdentity: number('--max-identity', 10),
    fromHead: number('--from-head', MARKET_TAIL_MAX_SPAN_V1),
    actionPasses: number('--actions-passes', 1),
    // Ten thousand rather than two: mainnet.base.org serves that span, and a
    // filter on four topic0s over a market where none has ever fired returns
    // an empty list. The response bound that shapes the transfer tail does not
    // apply to a read that matches nothing.
    actionBlocks: number('--actions-blocks', 10_000),
    actionFrom: optional('--actions-from'),
    actionsOnly: argv.includes('--actions-only'),
    skipActions: argv.includes('--skip-actions'),
    dry: argv.includes('--dry'),
  };
}

// ---------------------------------------------------------------------------
// The corporate-action tail.
//
// A second `eth_getLogs` per pass, filtered to the four events Base publishes
// on `IB20Asset`: `Announcement`, `EndAnnouncement` and the two multiplier
// setters. Its own cursor, so a read that fails here leaves the ledger tail
// where it was and the other way round -- sharing one would make each the
// other's outage.
//
// WHY IT IS WORTH RUNNING WITH NOTHING TO FIND
//
// Nothing has fired. Every Coinbase tokenized stock still reads a multiplier
// of exactly 1.0 and no announcement has been emitted on any of them. A feed
// started on the day of the first dividend can report that dividend and cannot
// say whether it was the first; this one can, because the silence before it is
// a stored range rather than an assumption. `--actions-from` is how that range
// is established: point it at a block before any of these tokens existed and
// let it walk forward.
//
// The address list is every reviewed representation, not just the B20 ones.
// The topics are B20's, so a Dinari or Backed contract simply never matches --
// and an issuer we did not expect emitting one is exactly the thing worth
// catching rather than filtering out in advance.
// ---------------------------------------------------------------------------
async function corporateActionStageV1(input: {
  args: ArgsV1;
  source: ReturnType<typeof createMarketTailSourceV1>;
  tail: ReturnType<typeof createDatabaseMarketTailRepository>;
  tokens: readonly string[];
}): Promise<void> {
  const { args, source, tail, tokens } = input;
  const actions = createDatabaseB20CorporateActionRepository(client);
  const signals = createDatabaseRwaSignalRepository(client);

  // Opened BEFORE the first read, and the pass that opens it reports nothing.
  // An announcement found in a backfilled range is history: it is stored, and
  // the feed says the watch did not cover it rather than announcing a dividend
  // from last month as news.
  const watch = args.dry
    ? []
    : await signals.openSignalWatch({
        chainId: CHAIN_ID_V1,
        kinds: [...RWA_ONCHAIN_SIGNAL_KINDS_V1],
        at: new Date().toISOString(),
      });
  const watching = new Map<RwaOnchainSignalKindV1, string>();
  for (const row of watch) {
    // A watch this pass opened covers nothing this pass can find: every block
    // it reads is older than the moment the watch opened.
    if (row.openedNow) continue;
    watching.set(row.kind as RwaOnchainSignalKindV1, row.watchingSince);
  }
  if (watch.some((row) => row.openedNow)) {
    console.log('\ncorporate actions: watch opened — this pass records history and reports no news');
  }

  for (let pass = 0; pass < args.actionPasses; pass += 1) {
    const head = await source.headBlock();
    if (!head.ok) {
      console.log(`corporate actions pass ${pass + 1}: ${head.reason}`);
      return;
    }
    const cursor = await tail.readCursor({ tailKey: B20_CORPORATE_ACTION_TAIL_KEY_V1 });
    // A first-ever run starts before the first tokenized stock existed, not at
    // the head. The cursor cannot rewind, so starting at the head would make
    // the history behind it permanently unreadable — and "nothing has ever been
    // announced" would stay an assumption. Backfilling it is one run of a few
    // hundred passes over a filter that matches nothing; after that the hourly
    // timer keeps up in one pass.
    const lastBlock =
      cursor?.lastBlock ?? args.actionFrom ?? B20_TOKENIZED_STOCK_GENESIS_BLOCK_V1;
    if (cursor === null) {
      // Printed rather than implied. An empty feed is evidence of quiet only
      // across a range somebody can name, and this is where the range opens.
      console.log(`corporate actions: record opens at block ${lastBlock}`);
    }
    const range = tailRangeV1({ lastBlock, headBlock: head.value, maxSpan: args.actionBlocks });
    if (!range.ok) {
      console.log(`corporate actions pass ${pass + 1}: caught up at block ${lastBlock}`);
      return;
    }

    const logs = await source.eventLogs({
      tokens,
      topics: B20_CORPORATE_ACTION_TOPIC_LIST_V1,
      fromBlock: range.fromBlock,
      toBlock: range.toBlock,
    });
    if (!logs.ok) {
      console.log(
        `corporate actions pass ${pass + 1}: ${range.fromBlock}-${range.toBlock} — ${logs.reason}`,
      );
      return;
    }

    // Dated from the chain, never from our clock, and only for blocks that
    // carried something. An empty range costs nothing beyond the one log read.
    const blocks = b20CorporateActionBlocksV1(logs.value);
    const times = blocks.length === 0
      ? ({ ok: true, value: new Map<number, string>() } as const)
      : await source.blockTimes(blocks);
    if (!times.ok) {
      console.log(`corporate actions pass ${pass + 1}: ${times.reason}`);
      return;
    }
    const reading = b20CorporateActionObservationsV1({
      logs: logs.value,
      blockTimes: times.value,
      tokens,
    });
    if (reading.undated > 0) {
      // The cursor stays put. An action we could not date would otherwise be
      // dropped AND passed over, which is the one outcome worse than stopping.
      console.log(
        `corporate actions pass ${pass + 1}: ${reading.undated} log(s) could not be dated — cursor held at ${lastBlock}`,
      );
      return;
    }

    const observedAt = new Date().toISOString();
    const rows: B20CorporateActionRowV1[] = reading.observations.map((observation) => ({
      chainId: CHAIN_ID_V1,
      tokenAddress: observation.tokenAddress,
      event: observation.action.event,
      payloadState: observation.action.payload,
      announcementId: observation.action.announcementId,
      caller: observation.action.caller,
      description: observation.action.description,
      uri: observation.action.uri,
      multiplierWad: observation.action.multiplierWad,
      topics: observation.topics,
      data: observation.data,
      blockNumber: observation.blockNumber,
      blockTime: observation.blockTime,
      transactionHash: observation.transactionHash,
      logIndex: observation.logIndex,
      observedAt,
    }));

    const span = range.toBlock - range.fromBlock + 1;
    console.log(
      `corporate actions pass ${pass + 1}: blocks ${range.fromBlock}-${range.toBlock} (${span})  ` +
        `events ${rows.length}${reading.foreign > 0 ? `  foreign ${reading.foreign}` : ''}  ` +
        `calls 1 log + ${blocks.length} block`,
    );
    if (args.dry) continue;

    const outcome = await actions.recordPass({
      chainId: CHAIN_ID_V1,
      fromBlock: range.fromBlock,
      toBlock: range.toBlock,
      observedAt,
      logCalls: 1 + blocks.length,
      rows,
    });
    if (rows.length > 0) {
      console.log(
        `  stored ${outcome.inserted} new, ${outcome.duplicates} already seen; cursor at ${outcome.lastBlock}`,
      );
    }


    const transitions = corporateActionSignalsV1({
      observations: reading.observations,
      watchingSince: watching,
    });
    if (transitions.length > 0) {
      const recorded = await signals.recordSignals({
        chainId: CHAIN_ID_V1,
        recordedAt: observedAt,
        signals: transitions,
      });
      for (const key of recorded.recorded) console.log(`  signal ${key.split(':')[0]}`);
    }
  }
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
  //
  // It was ONE issuer's registry until Phase 13.3 — the same corpus mistake the
  // cash-exit pass had, in the worker that answers the question the cash-exit
  // pass cannot. Fifty Dinari dShares hold real supply and KyberSwap answers
  // `token not found` for a dozen of them, so the aggregator can say nothing
  // about whether they move. The ledger can: every venue moves the token, so one
  // `eth_getLogs` over the whole corpus finds the venues by behaviour instead of
  // asking a router that has never heard of the asset.
  //
  // Widening the address list does not widen the block span, so this costs the
  // same one log read per pass it always did.
  const assets = await official.officialAssets({ chainId: CHAIN_ID_V1, limit: 200 });
  const reviewed = await reviewedRepresentationTargetsV1({
    underlyings: createDatabaseUnderlyingAssetRepository(client),
    supplies: createDatabaseRepresentationSupplyRepository(client),
    limit: 300,
  });
  const registryTokens = assets.map((asset) => asset.tokenAddress.toLowerCase());
  const claimed = new Set(registryTokens);
  const tokens = [
    ...registryTokens,
    ...reviewed.map((target) => target.tokenAddress).filter((address) => !claimed.has(address)),
  ];
  if (tokens.length === 0) {
    throw new Error('no official asset is currently listed — run pnpm rwa:ingest-official first');
  }
  console.log(
    `tracking ${tokens.length} token(s) — ${registryTokens.length} from the official registry, ` +
      `${tokens.length - registryTokens.length} reviewed with tokens outstanding\n`,
  );

  for (let pass = 0; args.actionsOnly ? false : pass < args.passes; pass += 1) {
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

  if (!args.skipActions) await corporateActionStageV1({ args, source, tail, tokens });

  if (!args.dry && !args.actionsOnly) {
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
