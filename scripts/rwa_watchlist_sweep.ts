/**
 * The watchlist's freshness promise, kept.
 *
 * One measurement per ADDRESS however many people watch it, at an interval
 * derived from how many addresses there are rather than configured — see
 * `watchlistCapacityV1` for the arithmetic and why the reserve is subtracted
 * before the promise is made.
 *
 * Read-only against the chain and the router: no signer, no key, no wallet, no
 * transaction, no allowance. The quote recipient is a documented dead address
 * that holds nothing and can sign nothing.
 *
 * What a failed pass does: moves the clock so a broken address cannot
 * monopolise the queue, and NOTHING else. `lastCompletedAt` stays where it
 * was, so no surface can read freshness out of an outage, and no signal is
 * emitted — a provider failure is never a change about an asset.
 *
 *   pnpm rwa:watchlist-sweep --dry
 *   pnpm rwa:watchlist-sweep
 *   pnpm rwa:watchlist-sweep --limit 5 --gap-ms 3000
 */
import { createB20ReaderV1 } from '@mioagent/b20-control';
import { client, closeDb } from '@mioagent/db';
import {
  createDatabaseB20WatchlistRepository,
  createDatabaseOfficialCashExitRepository,
  createDatabaseOfficialAssetRepository,
  createDatabaseRepresentationRatioRepository,
  createDatabaseRepresentationSupplyRepository,
  createDatabaseUnderlyingAssetRepository,
  createDatabaseRwaSignalRepository,
  createDatabaseWatchScheduleRepository,
  type WatchCheckOutcomeV1,
} from '@mioagent/route-storage';
import { measureOfficialCashExitV1 } from '@mioagent/rwa-cash-exit';
import { cashExitSignalsV1, watchlistCapacityV1 } from '@mioagent/rwa-dossier';
import {
  createDatabaseMarketRealityRadarRepositoryV1,
  createMarketRealityEvidenceCaptureV1,
  createReviewedMarketRealityReferenceAdapterV1,
  evaluateMarketRealityRadarRunV1,
} from '@mioagent/rwa-market-reality';
import { KyberSwapRouteAdapter } from '@mioagent/swap-adapters';

import { loadRootEnvFileV1, reportLoadedEnvFileV1 } from './loadEnvFile.js';

const CHAIN_ID_V1 = 8453 as const;

/** The quote recipient. A router prices a route to somebody; this measurement
 * is not for anybody, so it names an address that provably cannot act. */
const MEASUREMENT_RECIPIENT_V1 = '0x000000000000000000000000000000000000dead' as const;
const MEASUREMENT_TENANT_V1 = 'rwa-watchlist-sweep';

/** Between addresses. Paced for the same reason the corpus worker is: eight
 * quotes arriving as fast as the event loop can issue them is the shape of a
 * client that gets throttled and then reports the throttle as a finding. */
const DEFAULT_GAP_MS_V1 = 2_500;

const DECIMALS_SELECTOR_V1 = '0x313ce567';

function decodeDecimalsV1(raw: string): number | null {
  if (!/^0x[0-9a-fA-F]{64}$/.test(raw)) return null;
  const value = Number(BigInt(raw));
  return Number.isInteger(value) && value >= 0 && value <= 36 ? value : null;
}

function numericArgV1(flag: string, fallback: number): number {
  const index = process.argv.indexOf(flag);
  if (index < 0) return fallback;
  const value = Number.parseInt(String(process.argv[index + 1] ?? ''), 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  const dry = process.argv.includes('--dry');
  const limit = numericArgV1('--limit', 25);
  const gapMs = numericArgV1('--gap-ms', DEFAULT_GAP_MS_V1);
  reportLoadedEnvFileV1(loadRootEnvFileV1());

  const rpcUrl = (process.env.BASE_MAINNET_RPC_URL || process.env.BASE_RPC_URL || '').trim();
  if (!rpcUrl) throw new Error('BASE_MAINNET_RPC_URL is required to read token decimals');

  const watchlist = createDatabaseB20WatchlistRepository(client);
  const schedule = createDatabaseWatchScheduleRepository(client);
  const cashExit = createDatabaseOfficialCashExitRepository(client);
  const signals = createDatabaseRwaSignalRepository(client);
  const radar = createDatabaseMarketRealityRadarRepositoryV1(client);
  const reader = createB20ReaderV1({ rpcUrl });
  const adapters = [new KyberSwapRouteAdapter()];
  const captureMarketRealitySnapshots = createMarketRealityEvidenceCaptureV1({
    underlyings: createDatabaseUnderlyingAssetRepository(client),
    ratios: createDatabaseRepresentationRatioRepository(client),
    supplies: createDatabaseRepresentationSupplyRepository(client),
    now: () => new Date(),
    reference: createReviewedMarketRealityReferenceAdapterV1({
      official: createDatabaseOfficialAssetRepository(client),
      reader,
    }),
  });

  const now = new Date();
  const [controlWatched, radarWatched] = await Promise.all([
    watchlist.distinctWatchedAddresses({ chainId: CHAIN_ID_V1, limit: 1_000 }),
    radar.distinctWatchedAddresses({ chainId: CHAIN_ID_V1, limit: 1_000 }),
  ]);
  // One address, one schedule and one measurement, even when it appears in
  // both Control Watch and several tenants' exact market watches.
  const watched = [...new Set([...controlWatched, ...radarWatched])].sort();
  // The interval is derived from the SET, so it is computed before anything is
  // scheduled and re-promised onto every row: one more address changes what
  // every other address can be promised.
  const capacity = watchlistCapacityV1({ distinctAddresses: watched.length });
  // Seconds below a minute, minutes above it. Rounding 13 seconds to "0m"
  // reads as "the budget supports nothing", which is the opposite of true.
  const spanV1 = (seconds: number) =>
    seconds < 60 ? `${Math.round(seconds)}s` : `${Math.round(seconds / 60)}m`;
  console.log(
    `${watched.length} distinct address(es) under watch · advertising ${spanV1(
      capacity.advertisedIntervalSeconds,
    )} (budget supports ${spanV1(capacity.achievableIntervalSeconds)}, limited by ${
      capacity.limitedBy
    }, utilisation ${(capacity.utilisation * 100).toFixed(0)}%)`,
  );
  if (capacity.beyondSlowestTier) {
    console.log(
      '  the watchlist has outgrown the slowest interval this product publishes — the promise is not keepable at this size',
    );
  }
  if (watched.length === 0) {
    // Still runs the reconciliation below, so a list emptied since the last
    // pass stops costing anything.
    console.log('  nothing is watched');
  }

  if (dry) {
    console.log('  --dry: nothing scheduled, nothing measured');
    return;
  }

  const reconciled = await schedule.ensureScheduled({
    chainId: CHAIN_ID_V1,
    tokenAddresses: watched,
    intervalSeconds: capacity.advertisedIntervalSeconds,
    now: now.toISOString(),
  });
  if (reconciled.created.length > 0) console.log(`  scheduled ${reconciled.created.length} new`);
  if (reconciled.retired.length > 0)
    console.log(`  retired ${reconciled.retired.length} unwatched`);

  // Opened before anything is measured. The pass that opens a watch reports
  // nothing: an address measured for the first time has not changed, it has
  // been looked at for the first time.
  const watch = await signals.openSignalWatch({
    chainId: CHAIN_ID_V1,
    kinds: [
      'official_asset_market_became_active',
      'official_asset_market_became_unreachable',
      'official_asset_cash_exit_changed',
    ],
    at: now.toISOString(),
  });
  const watchOpenedNow = watch.some((row) => row.openedNow);

  const due = await schedule.dueForCheck({
    chainId: CHAIN_ID_V1,
    now: now.toISOString(),
    limit,
  });
  console.log(`  ${due.length} due this pass\n`);

  let measured = 0;
  let failed = 0;
  let emitted = 0;
  let radarEvents = 0;
  let radarFailures = 0;

  for (const [index, row] of due.entries()) {
    const short = `${row.tokenAddress.slice(0, 8)}…${row.tokenAddress.slice(-4)}`;
    const anchor = await reader.readBlockAnchor();
    let outcome: WatchCheckOutcomeV1 = 'unreadable';

    if (anchor.ok) {
      const decimalsRead = await reader.call({
        to: row.tokenAddress,
        data: DECIMALS_SELECTOR_V1,
        blockTag: anchor.value.blockTag,
      });
      const decimals = decimalsRead.ok ? decodeDecimalsV1(decimalsRead.value) : null;
      if (decimals === null) {
        console.log(`${short}  decimals unreadable — clock moves, nothing claimed`);
      } else {
        // Read BEFORE the new run is written, or the comparison is with itself.
        const previous = await cashExit.latestCompletedRun({
          chainId: CHAIN_ID_V1,
          tokenAddress: row.tokenAddress,
          scope: 'public_ladder',
        });
        try {
          const next = await measureOfficialCashExitV1({
            repository: cashExit,
            adapters,
            token: { address: row.tokenAddress as `0x${string}`, symbol: short, decimals },
            walletAddress: MEASUREMENT_RECIPIENT_V1,
            tenantId: MEASUREMENT_TENANT_V1,
            scope: 'public_ladder',
            captureMarketRealitySnapshots,
          });
          outcome = 'measured';
          measured += 1;
          console.log(`${short}  measured`);

          if (!watchOpenedNow) {
            const transitions = cashExitSignalsV1({ previous, next, ticker: short });
            if (transitions.length > 0) {
              const recorded = await signals.recordSignals({
                chainId: CHAIN_ID_V1,
                recordedAt: new Date().toISOString(),
                signals: transitions,
              });
              emitted += recorded.recorded.length;
              for (const key of recorded.recorded)
                console.log(`         signal ${key.split(':')[0]}`);
            }
          }
          try {
            const evaluated = await evaluateMarketRealityRadarRunV1({
              repository: radar,
              run: next,
              evaluatedAt: new Date().toISOString(),
            });
            radarEvents += evaluated.events;
            if (evaluated.evaluated > 0) {
              console.log(
                `         radar ${evaluated.evaluated} evaluated · ${evaluated.events} event(s) · ${evaluated.gaps} gap(s)`,
              );
            }
          } catch (error) {
            // The market measurement completed and stays completed. A Radar
            // persistence failure is ours; it neither rewrites the schedule as
            // a provider failure nor creates an asset event.
            radarFailures += 1;
            console.log(
              `         radar evaluation failed (${error instanceof Error ? error.message : 'unknown'})`,
            );
          }
        } catch (error) {
          // Our call, not the market. The clock moves and nothing is claimed.
          outcome = 'measurement_failed';
          console.log(
            `${short}  measurement failed (${error instanceof Error ? error.message : 'unknown'})`,
          );
        }
      }
    } else {
      console.log(
        `${short}  block anchor unavailable (${anchor.reason}) — clock moves, nothing claimed`,
      );
    }

    if (outcome !== 'measured') failed += 1;
    await schedule.recordCheck({
      chainId: CHAIN_ID_V1,
      tokenAddress: row.tokenAddress,
      at: new Date().toISOString(),
      outcome,
      intervalSeconds: capacity.advertisedIntervalSeconds,
    });
    if (index < due.length - 1) await sleep(gapMs);
  }

  console.log(`\nchecked ${due.length}: ${measured} measured, ${failed} not completed`);
  console.log(`signals recorded: ${emitted}`);
  console.log(`radar events recorded: ${radarEvents} · radar evaluation failures: ${radarFailures}`);
  if (radarFailures > 0) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error(
      'watchlist sweep failed:',
      error instanceof Error ? error.message : String(error),
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDb();
  });
