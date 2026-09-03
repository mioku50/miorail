/**
 * The public cash-exit ladder, measured for the whole REVIEWED universe.
 *
 * Phase 4 shipped this as an operator command over four named tickers, which
 * is what put the first four runs on file. Phase 6 needs the other nine, and
 * for the same reason the tab exists: the Official Assets screen says four of
 * thirteen Coinbase equities have a cash route and nine do not. Until
 * something measures all thirteen and stores what it found, the only truthful
 * thing that screen can say about the other nine is "not measured" -- a fact
 * about Miorail, not about the assets.
 *
 * So the default is now the corpus rather than a list, the pass paces itself,
 * an unreadable asset is skipped instead of ending the run, and each asset's
 * result is compared with the one before it to emit a market transition.
 * `--tickers` still narrows it to exactly what an operator asked for.
 *
 * Read-only against the chain and the router: no signer, no key, no wallet, no
 * transaction, no allowance. `to` on a quote is a recipient the router needs in
 * order to price a route; it is a documented dead address that holds nothing
 * and can sign nothing, so no measurement here can name a person.
 *
 * Phase 13.3 widened the corpus again, for the third time and the same reason.
 * The pass read `official_assets` -- one issuer's thirteen listings -- while the
 * cards a reader opens come from `representation_underlying`, which holds a
 * hundred and thirty addresses across four issuers. Ninety-six of them had
 * therefore never been quoted, and every one of those cards said "not measured":
 * a sentence about this script, printed where a reader reads it as a sentence
 * about the asset.
 *
 * So the corpus is now every reviewed representation with tokens outstanding,
 * the registry included. Zero-supply contracts are left out on purpose -- they
 * have no market by construction and their cards can say so -- and an
 * `official_asset_*` signal is still only emitted for a registry member.
 *
 *   pnpm rwa:measure-cash-exit --dry
 *   pnpm rwa:measure-cash-exit
 *   pnpm rwa:measure-cash-exit --corpus official
 *   pnpm rwa:measure-cash-exit --tickers AAPLc,NVDAc --gap-ms 3000
 */
import { callManyV1, createB20ReaderV1, decodeStringV1 } from '@mioagent/b20-control';
import { client, closeDb } from '@mioagent/db';
import {
  createDatabaseOfficialAssetRepository,
  createDatabaseOfficialCashExitRepository,
  createDatabaseRepresentationRatioRepository,
  createDatabaseRepresentationSupplyRepository,
  createDatabaseUnderlyingAssetRepository,
  createDatabaseRwaSignalRepository,
  isOfficialV1,
} from '@mioagent/route-storage';
import { measureOfficialCashExitV1 } from '@mioagent/rwa-cash-exit';
import {
  cashExitSignalsV1,
  previewLadderFromRunV1,
  routeStatusFromPreviewV1,
} from '@mioagent/rwa-dossier';
import { KyberSwapRouteAdapter } from '@mioagent/swap-adapters';
import {
  createMarketRealityEvidenceCaptureV1,
  createReviewedMarketRealityReferenceAdapterV1,
} from '@mioagent/rwa-market-reality';

import {
  budgetedRpcConfigFromEnvV1,
  createBudgetedReaderV1,
} from '../artifacts/api-server/lib/budgetedRpc.js';

import { loadRootEnvFileV1, reportLoadedEnvFileV1 } from './loadEnvFile.js';
import {
  corpusV1,
  mergeTargetsV1,
  registryTargetsV1,
  reviewedRepresentationTargetsV1,
  type MeasurementTargetV1,
} from './rwaCashExitCorpus.js';

const CHAIN_ID_V1 = 8453 as const;

/**
 * The quote recipient.
 *
 * A router prices a route to somebody. This measurement is not for anybody, so
 * it names an address that provably cannot act: the canonical dead address has
 * no key, and nothing measured under it can be mistaken for a user's position.
 */
const MEASUREMENT_RECIPIENT_V1 = '0x000000000000000000000000000000000000dead' as const;

/** The tenant a public ladder is stored under. `public_ladder` rows carry a
 * null tenant in the database; this only names the run's origin. */
const MEASUREMENT_TENANT_V1 = 'rwa-public-ladder';

/**
 * Between assets.
 *
 * The aggregator is a third party we do not pay and the chain read is base.org
 * at roughly half a call a second. Eight quotes per asset arriving as fast as
 * the event loop can issue them is the shape of a client that gets throttled
 * and then reports the throttle as a market finding.
 */
const DEFAULT_GAP_MS_V1 = 2_500;

/** `decimals()`. A raw selector rather than an ABI encoder: this package has
 * no viem dependency, and one word in is one word out. */
const DECIMALS_SELECTOR_V1 = '0x313ce567';

function decodeDecimalsV1(raw: string): number | null {
  if (!/^0x[0-9a-fA-F]{64}$/.test(raw)) return null;
  const value = Number(BigInt(raw));
  // A B20 asset outside this range is not something this measurement
  // understands, and guessing 18 would size every quote wrong.
  return Number.isInteger(value) && value >= 6 && value <= 18 ? value : null;
}

/**
 * `symbol()`.
 *
 * Read for every representation the registry does not name, because two Dinari
 * addresses can stand for the SAME security -- the dShare and its wrapped form
 * -- and only the token's own symbol tells them apart. The underlying's display
 * symbol would put "ADBE" on both.
 */
const SYMBOL_SELECTOR_V1 = '0x95d89b41';

/** `--tickers AAPLc,NVDAc` narrows the pass. Absent, the pass is the corpus.
 * An unknown ticker is refused rather than skipped: an operator who asked for
 * four assets and got three measured would read the summary as four. */
function tickersV1(argv: readonly string[]): ReadonlySet<string> | null {
  const index = argv.indexOf('--tickers');
  if (index < 0) return null;
  const values = (argv[index + 1] ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (values.length === 0) throw new Error('--tickers takes a comma-separated list');
  return new Set(values);
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
  const requested = tickersV1(process.argv);
  // Naming tickers is naming registry members, so it selects the registry.
  const corpus = requested === null ? corpusV1(process.argv) : 'official';
  const limit = numericArgV1('--limit', 64);
  const underlyingLimit = numericArgV1('--underlying-limit', 300);
  const gapMs = numericArgV1('--gap-ms', DEFAULT_GAP_MS_V1);
  reportLoadedEnvFileV1(loadRootEnvFileV1());

  const rpcUrl = (process.env.BASE_MAINNET_RPC_URL || process.env.BASE_RPC_URL || '').trim();
  if (!rpcUrl) throw new Error('BASE_MAINNET_RPC_URL is required to read token decimals');

  const official = createDatabaseOfficialAssetRepository(client);
  const cashExit = createDatabaseOfficialCashExitRepository(client);
  const signals = createDatabaseRwaSignalRepository(client);
  const underlyings = createDatabaseUnderlyingAssetRepository(client);
  const supplies = createDatabaseRepresentationSupplyRepository(client);
  // Metered while the month's compute units allow it, public endpoint after
  // that. The public one caps a JSON-RPC batch at ten calls and throttles under
  // a sustained sweep, which is how a pass over the whole corpus turns its own
  // transport into `decimals unreadable` on somebody's card.
  const budget = budgetedRpcConfigFromEnvV1();
  const reader = budget
    ? (createBudgetedReaderV1(budget) as ReturnType<typeof createB20ReaderV1>)
    : createB20ReaderV1({ rpcUrl });
  const adapters = [new KyberSwapRouteAdapter()];
  const captureMarketRealitySnapshots = createMarketRealityEvidenceCaptureV1({
    underlyings,
    ratios: createDatabaseRepresentationRatioRepository(client),
    supplies,
    now: () => new Date(),
    reference: createReviewedMarketRealityReferenceAdapterV1({ official, reader }),
  });

  const listed = (await official.officialAssets({ chainId: CHAIN_ID_V1, limit })).filter(
    (identity) => isOfficialV1(identity),
  );
  if (listed.length === 0) {
    throw new Error('no official asset is currently listed — run pnpm rwa:ingest-official first');
  }
  const selected =
    requested === null
      ? listed
      : listed.filter((identity) =>
          identity.listings.some((row) => row.currentlyListed && requested.has(row.ticker)),
        );
  if (requested !== null) {
    const found = new Set(
      selected.flatMap((identity) =>
        identity.listings.filter((row) => row.currentlyListed).map((row) => row.ticker),
      ),
    );
    const missing = [...requested].filter((ticker) => !found.has(ticker));
    if (missing.length > 0) {
      throw new Error(`reviewed corpus does not currently list: ${missing.join(', ')}`);
    }
  }
  const registryTargets = registryTargetsV1(selected);
  const targets: MeasurementTargetV1[] =
    corpus === 'official'
      ? registryTargets
      : mergeTargetsV1(
          registryTargets,
          await reviewedRepresentationTargetsV1({
            underlyings,
            supplies,
            limit: underlyingLimit,
          }),
        );

  const anchor = await reader.readBlockAnchor();
  if (!anchor.ok) throw new Error(`block anchor unavailable: ${anchor.reason}`);

  // Decimals for everything and a symbol for everything, at ONE block, in one
  // batched pass the reader chunks and retries for us.
  //
  // Measured on the first production pass over thirteen assets: three came back
  // `rate_limited` and were skipped, so three tokenized equities went unmeasured
  // because the sweep issued them one at a time against an endpoint that serves
  // about half a call a second. Sixty-three assets read that way would not
  // finish. A throttle is our problem and it passes; a revert does not, and the
  // reader already tells those apart.
  const metadata = await callManyV1(
    reader,
    targets.flatMap((target) => [
      { to: target.tokenAddress, data: DECIMALS_SELECTOR_V1, blockTag: anchor.value.blockTag },
      { to: target.tokenAddress, data: SYMBOL_SELECTOR_V1, blockTag: anchor.value.blockTag },
    ]),
  );
  const universe: { target: MeasurementTargetV1; symbol: string; decimals: number }[] = [];
  for (const [index, target] of targets.entries()) {
    const label = (target.symbol ?? target.tokenAddress).padEnd(10);
    const decimalsRead = metadata[index * 2]!;
    const symbolRead = metadata[index * 2 + 1]!;
    // Our read failed. Nothing is written and nothing is claimed: an asset whose
    // decimals we could not read is not an asset without a market, and one
    // unreadable token does not end the pass for the rest.
    if (!decimalsRead.ok) {
      console.log(`${label} decimals unreadable (${decimalsRead.reason}) — skipped`);
      continue;
    }
    const decimals = decodeDecimalsV1(decimalsRead.value);
    if (decimals === null) {
      console.log(`${label} decimals outside 6..18 — skipped`);
      continue;
    }
    const symbol =
      target.symbol ?? (symbolRead.ok ? decodeStringV1(symbolRead.value) : null) ?? null;
    if (!symbol) {
      console.log(`${label} symbol unreadable — skipped`);
      continue;
    }
    universe.push({ target, symbol, decimals });
  }

  // Opened before the first measurement. The pass that opens it reports
  // nothing: an asset measured for the first time has not "become active", it
  // has been looked at for the first time, and those are different sentences.
  const watch = dry
    ? []
    : await signals.openSignalWatch({
        chainId: CHAIN_ID_V1,
        kinds: [
          'official_asset_market_became_active',
          'official_asset_market_became_unreachable',
          'official_asset_cash_exit_changed',
        ],
        at: new Date().toISOString(),
      });
  const watchOpenedNow = watch.some((row) => row.openedNow);
  if (watchOpenedNow) {
    console.log('signals: watch opened — this pass measures and reports no transitions\n');
  }

  const fromRegistry = universe.filter(
    (entry) => entry.target.origin === 'official_registry',
  ).length;
  console.log(
    `${universe.length} representation(s) to measure — ${fromRegistry} from the official registry, ` +
      `${universe.length - fromRegistry} reviewed with tokens outstanding, ${gapMs}ms between assets\n`,
  );
  let measured = 0;
  let established = 0;
  let noRoute = 0;
  let failed = 0;
  const emitted: string[] = [];

  for (const [index, entry] of universe.entries()) {
    const { target, symbol, decimals } = entry;
    const tokenAddress = target.tokenAddress;
    const label = symbol.padEnd(10);

    if (dry) {
      console.log(`${label} ${tokenAddress} decimals ${decimals} — would measure`);
      continue;
    }

    // Read BEFORE the new run is written. `latestCompletedRun` would otherwise
    // return the run we just stored and every comparison would be with itself.
    const previous = await cashExit.latestCompletedRun({
      chainId: CHAIN_ID_V1,
      tokenAddress,
      scope: 'public_ladder',
    });
    const next = await measureOfficialCashExitV1({
      repository: cashExit,
      adapters,
      token: { address: tokenAddress as `0x${string}`, symbol, decimals },
      walletAddress: MEASUREMENT_RECIPIENT_V1,
      tenantId: MEASUREMENT_TENANT_V1,
      scope: 'public_ladder',
      captureMarketRealitySnapshots,
    });
    measured += 1;
    const now = new Date();
    const status = routeStatusFromPreviewV1(previewLadderFromRunV1(next));
    if (status === 'cash_route_established') established += 1;
    else if (status === 'no_route_at_measured_sizes') noRoute += 1;
    else failed += 1;
    console.log(`${label} ${status}`);

    // Signals stay inside the vocabulary that owns them: an
    // `official_asset_*` transition may only name a member of the official
    // registry. Everything else is measured and stored, and says what it found
    // on its own card rather than in a feed about somebody else's corpus.
    if (!watchOpenedNow && target.signalTicker !== null) {
      const transitions = cashExitSignalsV1({ previous, next, ticker: target.signalTicker });
      if (transitions.length > 0) {
        const recorded = await signals.recordSignals({
          chainId: CHAIN_ID_V1,
          recordedAt: now.toISOString(),
          signals: transitions,
        });
        for (const key of recorded.recorded) {
          emitted.push(key);
          console.log(`           signal ${key.split(':')[0]}`);
        }
      }
    }

    if (index < universe.length - 1) await sleep(gapMs);
  }

  console.log(
    `\nmeasured ${measured}: ${established} with a cash route, ${noRoute} with no route at the measured sizes, ${failed} unfinished`,
  );
  console.log(`signals recorded: ${emitted.length}`);
}

main()
  .catch((error) => {
    console.error(
      'cash-exit measurement failed:',
      error instanceof Error ? error.message : String(error),
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDb();
  });
