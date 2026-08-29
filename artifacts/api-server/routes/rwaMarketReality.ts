import { Router, type Request } from 'express';
import { decodeFunctionResult, encodeFunctionData } from 'viem';
import { createB20ReaderV1 } from '@mioagent/b20-control';
import { client } from '@mioagent/db';
import { measureOfficialCashExitV1 } from '@mioagent/rwa-cash-exit';
import { KyberSwapRouteAdapter } from '@mioagent/swap-adapters';
import {
  createDatabaseOfficialAssetRepository,
  createDatabaseOfficialCashExitRepository,
  createDatabaseRepresentationRatioRepository,
  createDatabaseRepresentationSupplyRepository,
  createDatabaseUnderlyingAssetRepository,
  RouteStorageConflictError,
} from '@mioagent/route-storage';
import {
  MARKET_REALITY_WINDOWS_V1,
  MarketRealityHistoryV1Schema,
  MarketRealityIndexV1Schema,
  MarketRealityLiveResponseV2Schema,
  MarketRealityRadarResponseV1Schema,
  MarketRealityRadarWatchInputV1Schema,
  MarketRealityResponseV2Schema,
  assembleMarketRealityHistoryV1,
  assembleMarketRealityIndexV1,
  assembleMarketRealityV2,
  createMarketRealityEvidenceCaptureV1,
  createMarketRealityCoordinatorV1,
  createDatabaseMarketRealityRadarRepositoryV1,
  type MarketRealityWindowV1,
} from '@mioagent/rwa-market-reality';
import type { TenantUser } from '../middleware/tenantAuth.js';
import { getMiorailProductMigrationFlags } from '../lib/productMigrationConfig.js';
import { createLlmProvider, type LlmProvider } from '@mioagent/llm';
import { StocksAskResponseV1Schema } from '@mioagent/rwa-market-reality/narration-contract';
import { logger } from '@mioagent/utils';
import { B20_UNSUPPORTED_QUESTIONS_V1 } from '../lib/b20AnswerPlan.js';
import { stocksEvidenceBundleV1 } from '../lib/stocksEvidence.js';
import { narrateStocksAnswerV1 } from '../lib/stocksNarration.js';
import { createReviewedMarketRealityReferenceAdapterV1 } from '../lib/rwaReferenceSession.js';

export const rwaMarketRealityRouter = Router();

function sessionUserV1(req: Request): TenantUser | null {
  const user = req.session?.user;
  if (
    !user ||
    user.chainId !== 8453 ||
    !/^0x[0-9a-f]{40}$/.test(user.address) ||
    user.id !== `eip155:8453:${user.address}`
  )
    return null;
  return user;
}

const ERC20_METADATA_ABI_V1 = [
  {
    type: 'function',
    name: 'decimals',
    inputs: [],
    outputs: [{ type: 'uint8' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'symbol',
    inputs: [],
    outputs: [{ type: 'string' }],
    stateMutability: 'view',
  },
] as const;

function rpcUrlV1(): string {
  return (process.env.BASE_MAINNET_RPC_URL || process.env.BASE_RPC_URL || '').trim();
}

/**
 * One coordinator for the process, created once.
 *
 * Its whole value is the in-flight map: a coordinator built per request would
 * deduplicate nothing, because every caller would arrive holding its own empty
 * map and start its own measurement.
 */
const marketRealityCoordinatorV1 = createMarketRealityCoordinatorV1();

export const rwaMarketRealityRuntime = {
  enabled: (env: NodeJS.ProcessEnv): boolean =>
    getMiorailProductMigrationFlags(env).routeIntelligenceV1,
  underlyings: () => createDatabaseUnderlyingAssetRepository(client),
  cashExit: () => createDatabaseOfficialCashExitRepository(client),
  ratios: () => createDatabaseRepresentationRatioRepository(client),
  supplies: () => createDatabaseRepresentationSupplyRepository(client),
  now: () => new Date(),
  /**
   * The narrator, or null when none is configured.
   *
   * A seam rather than a direct call, so a test can hand in a provider that
   * says something wrong and assert the reader never sees it. Null is an
   * ordinary state: without a provider this surface answers with the
   * deterministic evidence exactly as it did before a model was involved.
   */
  narrator: (): LlmProvider | null => {
    try {
      return createLlmProvider();
    } catch {
      // A misconfigured provider is not a reason to fail a read-only answer.
      return null;
    }
  },
  assemble: assembleMarketRealityV2,
  assembleIndex: assembleMarketRealityIndexV1,
  assembleHistory: assembleMarketRealityHistoryV1,
  coordinator: () => marketRealityCoordinatorV1,
  quoteAdapters: () => [new KyberSwapRouteAdapter()],
  radar: () => createDatabaseMarketRealityRadarRepositoryV1(client),
  measureOne: measureOfficialCashExitV1,
  reader: () => createB20ReaderV1({ rpcUrl: rpcUrlV1() }),
  reference: () =>
    createReviewedMarketRealityReferenceAdapterV1({
      official: createDatabaseOfficialAssetRepository(client),
      reader: createB20ReaderV1({ rpcUrl: rpcUrlV1() }),
    }),
  capture: () =>
    createMarketRealityEvidenceCaptureV1({
      underlyings: createDatabaseUnderlyingAssetRepository(client),
      ratios: createDatabaseRepresentationRatioRepository(client),
      supplies: createDatabaseRepresentationSupplyRepository(client),
      now: () => new Date(),
      reference: createReviewedMarketRealityReferenceAdapterV1({
        official: createDatabaseOfficialAssetRepository(client),
        reader: createB20ReaderV1({ rpcUrl: rpcUrlV1() }),
      }),
    }),
  migrationAvailable: async (): Promise<boolean> => {
    const rows = await client`
      SELECT
        to_regclass('public.underlying_asset') AS underlying,
        to_regclass('public.representation_underlying') AS representations,
        to_regclass('public.official_asset_sources') AS official_sources,
        to_regclass('public.official_assets') AS official_assets,
        to_regclass('public.official_cash_exit_runs') AS cash_exit,
        to_regclass('public.representation_ratio') AS ratios,
        to_regclass('public.representation_supply') AS supplies,
        EXISTS (
          SELECT 1
          FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'official_cash_exit_runs'
            AND column_name = 'market_reality_snapshots'
        ) AS cash_exit_snapshots`;
    const row = rows[0];
    return Boolean(
      row?.underlying &&
      row.representations &&
      row.official_sources &&
      row.official_assets &&
      row.cash_exit &&
      row.cash_exit_snapshots &&
      row.ratios &&
      row.supplies,
    );
  },
  radarAvailable: async (): Promise<boolean> => {
    const rows = await client`
      SELECT
        to_regclass('public.market_reality_radar_watches') AS watches,
        to_regclass('public.market_reality_radar_state') AS state,
        to_regclass('public.market_reality_radar_events') AS events`;
    return Boolean(rows[0]?.watches && rows[0]?.state && rows[0]?.events);
  },
};

/**
 * The chooser: every reviewed underlying, most-represented first.
 *
 * Registered BEFORE the parameterised route so `/rwa/underlyings` can never be
 * read as an underlying key — Express matches in declaration order, and a
 * static path that sits behind a `:param` is a path nobody can reach.
 */
rwaMarketRealityRouter.get('/rwa/underlyings', async (req, res) => {
  if (!rwaMarketRealityRuntime.enabled(process.env)) {
    res
      .status(404)
      .json({ error: 'route_intelligence_disabled', code: 'route_intelligence_disabled' });
    return;
  }
  if (!sessionUserV1(req)) {
    res.status(401).json({ error: 'authentication_required', code: 'authentication_required' });
    return;
  }
  const limit = Number.parseInt(String(req.query.limit ?? '100'), 10);
  try {
    if (!(await rwaMarketRealityRuntime.migrationAvailable())) {
      res.status(503).json({
        error: 'market_reality_storage_unavailable',
        code: 'market_reality_storage_unavailable',
      });
      return;
    }
    const index = await rwaMarketRealityRuntime.assembleIndex(
      { underlyings: rwaMarketRealityRuntime.underlyings(), now: rwaMarketRealityRuntime.now },
      { limit: Number.isFinite(limit) && limit > 0 ? Math.min(500, limit) : 100 },
    );
    res.status(200).json(MarketRealityIndexV1Schema.parse(index));
  } catch {
    res.status(500).json({ error: 'market_reality_failed', code: 'market_reality_failed' });
  }
});

async function radarBodyV1(userId: string) {
  const radar = rwaMarketRealityRuntime.radar();
  const [watches, events] = await Promise.all([
    radar.watchesForUser({ userId }),
    radar.eventsForUser({ userId, limit: 100 }),
  ]);
  return MarketRealityRadarResponseV1Schema.parse({
    schemaVersion: 'market-reality-radar/v1',
    chainId: 8453,
    watches: watches.map(({ userId: _userId, ...watch }) => watch),
    events,
    assembledAt: rwaMarketRealityRuntime.now().toISOString(),
  });
}

/** The tenant's exact market watches and their deterministic transition feed. */
rwaMarketRealityRouter.get('/rwa/radar', async (req, res) => {
  if (!rwaMarketRealityRuntime.enabled(process.env)) {
    res
      .status(404)
      .json({ error: 'route_intelligence_disabled', code: 'route_intelligence_disabled' });
    return;
  }
  const user = sessionUserV1(req);
  if (!user) {
    res.status(401).json({ error: 'authentication_required', code: 'authentication_required' });
    return;
  }
  try {
    if (!(await rwaMarketRealityRuntime.radarAvailable())) {
      res.status(503).json({ error: 'radar_storage_unavailable', code: 'radar_storage_unavailable' });
      return;
    }
    res.status(200).json(await radarBodyV1(user.id));
  } catch {
    res.status(500).json({ error: 'radar_failed', code: 'radar_failed' });
  }
});

/**
 * Add one exact representation question. The server re-establishes the
 * reviewed binding and route policy instead of accepting presentation labels
 * as identity.
 */
rwaMarketRealityRouter.post('/rwa/radar/watches', async (req, res) => {
  if (!rwaMarketRealityRuntime.enabled(process.env)) {
    res
      .status(404)
      .json({ error: 'route_intelligence_disabled', code: 'route_intelligence_disabled' });
    return;
  }
  const user = sessionUserV1(req);
  if (!user) {
    res.status(401).json({ error: 'authentication_required', code: 'authentication_required' });
    return;
  }
  const parsed = MarketRealityRadarWatchInputV1Schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_radar_watch', code: 'invalid_radar_watch' });
    return;
  }
  try {
    if (!(await rwaMarketRealityRuntime.migrationAvailable()) || !(await rwaMarketRealityRuntime.radarAvailable())) {
      res.status(503).json({ error: 'radar_storage_unavailable', code: 'radar_storage_unavailable' });
      return;
    }
    const bindings = await rwaMarketRealityRuntime.underlyings().representationsOf({
      chainId: 8453,
      underlyingKey: parsed.data.underlyingKey,
    });
    const binding = bindings.find(
      (row) => row.tokenAddress === parsed.data.tokenAddress.toLowerCase(),
    );
    if (!binding?.issuerId || !binding.issuerInstrumentKey || !binding.representationKind) {
      res.status(409).json({
        error: 'radar_representation_not_reviewed',
        code: 'radar_representation_not_reviewed',
        detail: 'This exact Base address is not a complete reviewed representation of the selected underlying.',
      });
      return;
    }
    const current = await rwaMarketRealityRuntime.assemble(
      {
        underlyings: rwaMarketRealityRuntime.underlyings(),
        cashExit: rwaMarketRealityRuntime.cashExit(),
        ratios: rwaMarketRealityRuntime.ratios(),
        supplies: rwaMarketRealityRuntime.supplies(),
        now: rwaMarketRealityRuntime.now,
      },
      {
        underlyingKey: parsed.data.underlyingKey,
        direction: parsed.data.direction,
        requestedCashAtomic: parsed.data.requestedCashAtomic,
        destination: parsed.data.destination,
      },
    );
    const representation = current.representations.find(
      (row) => row.tokenAddress === parsed.data.tokenAddress.toLowerCase(),
    );
    const currentSources = representation
      ? [...new Set(representation.sources.map((row) => row.source))].sort()
      : [];
    const requestedSources = [...parsed.data.approvedSources].sort();
    if (
      !representation ||
      representation.supply.state !== 'positive_supply' ||
      representation.routePolicyKey !== parsed.data.routePolicyKey ||
      currentSources.join('\u0000') !== requestedSources.join('\u0000')
    ) {
      res.status(409).json({
        error: 'radar_question_not_watchable',
        code: 'radar_question_not_watchable',
        detail: 'A positive-supply exact representation and the current reviewed route policy are required. Refresh Market Reality and try again.',
      });
      return;
    }
    await rwaMarketRealityRuntime.radar().addWatch({
      userId: user.id,
      question: parsed.data,
      issuerId: binding.issuerId,
      representationKind: binding.representationKind,
      now: rwaMarketRealityRuntime.now().toISOString(),
    });
    res.status(201).json(await radarBodyV1(user.id));
  } catch (error) {
    if (error instanceof RouteStorageConflictError) {
      res.status(409).json({ error: 'radar_watch_full', code: 'radar_watch_full', detail: error.message });
      return;
    }
    res.status(500).json({ error: 'radar_failed', code: 'radar_failed' });
  }
});

rwaMarketRealityRouter.delete('/rwa/radar/watches/:watchId', async (req, res) => {
  if (!rwaMarketRealityRuntime.enabled(process.env)) {
    res
      .status(404)
      .json({ error: 'route_intelligence_disabled', code: 'route_intelligence_disabled' });
    return;
  }
  const user = sessionUserV1(req);
  if (!user) {
    res.status(401).json({ error: 'authentication_required', code: 'authentication_required' });
    return;
  }
  const watchId = String(req.params.watchId ?? '').toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(watchId)) {
    res.status(400).json({ error: 'invalid_radar_watch_id', code: 'invalid_radar_watch_id' });
    return;
  }
  try {
    if (!(await rwaMarketRealityRuntime.radarAvailable())) {
      res.status(503).json({ error: 'radar_storage_unavailable', code: 'radar_storage_unavailable' });
      return;
    }
    await rwaMarketRealityRuntime.radar().removeWatch({ userId: user.id, watchId });
    res.status(200).json(await radarBodyV1(user.id));
  } catch {
    res.status(500).json({ error: 'radar_failed', code: 'radar_failed' });
  }
});

/**
 * The exact question, parsed once for every route that takes it.
 *
 * Shared rather than repeated so the read, the measurement and the series
 * cannot drift into three slightly different ideas of what was asked — which
 * would show up as a measurement that never satisfies the read it was taken
 * for.
 */
type QuestionParseV1 =
  | {
      ok: true;
      underlyingKey: string;
      direction: 'buy' | 'sell';
      requestedCashAtomic: string;
      destination: 'USDC' | 'ETH';
    }
  | { ok: false; code: string; detail?: string };

function questionFromRequestV1(req: Request): QuestionParseV1 {
  const underlyingKey = String(req.params.underlyingKey ?? '');
  const direction = String(req.query.direction ?? '').toLowerCase();
  const requestedCashAtomic = String(req.query.requestedCashAtomic ?? '');
  const destination = String(req.query.destination ?? 'USDC').toUpperCase();
  if (!/^[a-z0-9_]+:[a-z0-9_]+:.+$/.test(underlyingKey)) {
    return { ok: false, code: 'invalid_underlying_key' };
  }
  if (!['buy', 'sell'].includes(direction) || !/^[1-9][0-9]*$/.test(requestedCashAtomic)) {
    return {
      ok: false,
      code: 'invalid_market_reality_question',
      detail: 'direction=buy|sell and an exact positive requestedCashAtomic are required.',
    };
  }
  if (!['USDC', 'ETH'].includes(destination)) return { ok: false, code: 'invalid_destination' };
  return {
    ok: true,
    underlyingKey,
    direction: direction as 'buy' | 'sell',
    requestedCashAtomic,
    destination: destination as 'USDC' | 'ETH',
  };
}

rwaMarketRealityRouter.get('/rwa/market-reality/:underlyingKey', async (req, res) => {
  if (!rwaMarketRealityRuntime.enabled(process.env)) {
    res
      .status(404)
      .json({ error: 'route_intelligence_disabled', code: 'route_intelligence_disabled' });
    return;
  }
  if (!sessionUserV1(req)) {
    res.status(401).json({ error: 'authentication_required', code: 'authentication_required' });
    return;
  }
  const question = questionFromRequestV1(req);
  if (!question.ok) {
    res.status(400).json({ error: question.code, code: question.code, detail: question.detail });
    return;
  }
  try {
    if (!(await rwaMarketRealityRuntime.migrationAvailable())) {
      res.status(503).json({
        error: 'market_reality_storage_unavailable',
        code: 'market_reality_storage_unavailable',
      });
      return;
    }
    const result = await rwaMarketRealityRuntime.assemble(
      {
        underlyings: rwaMarketRealityRuntime.underlyings(),
        cashExit: rwaMarketRealityRuntime.cashExit(),
        ratios: rwaMarketRealityRuntime.ratios(),
        supplies: rwaMarketRealityRuntime.supplies(),
        now: rwaMarketRealityRuntime.now,
        reference: rwaMarketRealityRuntime.reference(),
      },
      {
        underlyingKey: question.underlyingKey,
        direction: question.direction,
        requestedCashAtomic: question.requestedCashAtomic,
        destination: question.destination,
      },
    );
    res.status(200).json(MarketRealityResponseV2Schema.parse(result));
  } catch {
    res.status(500).json({ error: 'market_reality_failed', code: 'market_reality_failed' });
  }
});

/**
 * Measure the exact question, now.
 *
 * POST because it spends router calls and writes evidence. The body is empty:
 * the question is the URL and the query string, exactly as on the read, so a
 * measurement and the read that follows it cannot drift apart.
 *
 * Read-only outside Miorail's own evidence tables: no signer, no wallet call,
 * no allowance, no transaction. A quote is not execution and never becomes it.
 */
rwaMarketRealityRouter.post('/rwa/market-reality/:underlyingKey/measure', async (req, res) => {
  if (!rwaMarketRealityRuntime.enabled(process.env)) {
    res
      .status(404)
      .json({ error: 'route_intelligence_disabled', code: 'route_intelligence_disabled' });
    return;
  }
  const user = sessionUserV1(req);
  if (!user) {
    res.status(401).json({ error: 'authentication_required', code: 'authentication_required' });
    return;
  }
  const question = questionFromRequestV1(req);
  if (!question.ok) {
    res.status(400).json({ error: question.code, code: question.code, detail: question.detail });
    return;
  }
  if (!rpcUrlV1()) {
    res.status(503).json({
      error: 'market_reality_chain_unavailable',
      code: 'market_reality_chain_unavailable',
    });
    return;
  }
  try {
    if (!(await rwaMarketRealityRuntime.migrationAvailable())) {
      res.status(503).json({
        error: 'market_reality_storage_unavailable',
        code: 'market_reality_storage_unavailable',
      });
      return;
    }
    const cashExit = rwaMarketRealityRuntime.cashExit();
    const adapters = rwaMarketRealityRuntime.quoteAdapters();

    // The anchor is read on FIRST USE, not up front. A call where every
    // representation already holds an open quote must touch nothing: the point
    // of this path is to spend router calls only when they buy something, and
    // an eager anchor spends an RPC call to discover it had nothing to do.
    let anchorOnce: ReturnType<
      ReturnType<typeof rwaMarketRealityRuntime.reader>['readBlockAnchor']
    > | null = null;
    let readerOnce: ReturnType<typeof rwaMarketRealityRuntime.reader> | null = null;
    const chainAnchor = async () => {
      readerOnce ??= rwaMarketRealityRuntime.reader();
      anchorOnce ??= readerOnce.readBlockAnchor();
      return { reader: readerOnce, anchor: await anchorOnce };
    };

    const result = await rwaMarketRealityRuntime.coordinator().measure(
      {
        underlyings: rwaMarketRealityRuntime.underlyings(),
        cashExit,
        ratios: rwaMarketRealityRuntime.ratios(),
        supplies: rwaMarketRealityRuntime.supplies(),
        now: rwaMarketRealityRuntime.now,
        reference: rwaMarketRealityRuntime.reference(),
        approvedSources: adapters.map((adapter) => adapter.id),
        // `decimals` and `symbol` come off the chain because a representation
        // binding does not carry them, and a wrong decimals turns an exact size
        // into a different size entirely.
        resolveToken: async (tokenAddress) => {
          const { reader, anchor } = await chainAnchor();
          if (!anchor.ok) return { ok: false, reason: `chain_anchor_${anchor.reason}` };
          const reads = await Promise.all(
            (['decimals', 'symbol'] as const).map((functionName) =>
              reader.call({
                to: tokenAddress,
                data: encodeFunctionData({ abi: ERC20_METADATA_ABI_V1, functionName }),
                blockTag: anchor.value.blockTag,
              }),
            ),
          );
          if (!reads[0]?.ok) return { ok: false, reason: 'token_decimals_unavailable' };
          const decimals = Number(
            decodeFunctionResult({
              abi: ERC20_METADATA_ABI_V1,
              functionName: 'decimals',
              data: reads[0].value as `0x${string}`,
            }),
          );
          if (!Number.isInteger(decimals) || decimals < 6 || decimals > 18) {
            return { ok: false, reason: 'token_decimals_unusable' };
          }
          // A symbol that will not read is cosmetic here — the quote is keyed
          // by address — so it falls back rather than refusing the measurement.
          let symbol = 'TOKEN';
          if (reads[1]?.ok) {
            try {
              symbol = String(
                decodeFunctionResult({
                  abi: ERC20_METADATA_ABI_V1,
                  functionName: 'symbol',
                  data: reads[1].value as `0x${string}`,
                }),
              ).slice(0, 32);
            } catch {
              symbol = 'TOKEN';
            }
          }
          return {
            ok: true,
            token: { tokenAddress, symbol: symbol.length > 0 ? symbol : 'TOKEN', decimals },
          };
        },
        measureOne: async ({ token, requestedCashAtomic, destination }) =>
          rwaMarketRealityRuntime.measureOne({
            repository: cashExit,
            adapters,
            token: {
              address: token.tokenAddress as `0x${string}`,
              symbol: token.symbol,
              decimals: token.decimals,
            },
            walletAddress: user.address as `0x${string}`,
            tenantId: user.id,
            // A public-ladder run with one rung. The scope is what the evidence
            // IS — a public size, no tenant position — not how it was started.
            scope: 'public_ladder',
            cashSizesAtomic: [requestedCashAtomic],
            destinations: [destination],
            now: rwaMarketRealityRuntime.now,
            captureMarketRealitySnapshots: rwaMarketRealityRuntime.capture(),
          }),
      },
      {
        underlyingKey: question.underlyingKey,
        direction: question.direction,
        requestedCashAtomic: question.requestedCashAtomic,
        destination: question.destination,
      },
    );

    // Parsed on the way out, envelope included: the measurement counts are the
    // only thing telling a reader whether the button did anything, so a shape
    // change there must fail here rather than render as an empty sentence.
    res.status(200).json(
      MarketRealityLiveResponseV2Schema.parse({
        ...result.answer,
        measurement: {
          measured: result.measured,
          reusedOpen: result.reusedOpen,
          reusedCooldown: result.reusedCooldown,
          excludedZeroSupply: result.excludedZeroSupply,
          unresolved: result.unresolved,
          joinedInFlight: result.joinedInFlight,
        },
      }),
    );
  } catch (error) {
    // Named apart from a measurement failure. A response this build cannot
    // serialize is OUR contract drifting, and reporting it as
    // `market_reality_failed` sends whoever is debugging to look at routers.
    const code =
      error instanceof Error && error.name === 'ZodError'
        ? 'market_reality_response_invalid'
        : 'market_reality_failed';
    res.status(500).json({ error: code, code });
  }
});

/**
 * The comparable series: the same exact question, over a bounded window.
 *
 * This is where the background sampler's work finally has a home. Every pass it
 * has ever run is a real measurement of a real size; on a time axis they are a
 * record, and the only thing that was ever wrong was calling them current.
 */
rwaMarketRealityRouter.get('/rwa/market-reality/:underlyingKey/history', async (req, res) => {
  if (!rwaMarketRealityRuntime.enabled(process.env)) {
    res
      .status(404)
      .json({ error: 'route_intelligence_disabled', code: 'route_intelligence_disabled' });
    return;
  }
  if (!sessionUserV1(req)) {
    res.status(401).json({ error: 'authentication_required', code: 'authentication_required' });
    return;
  }
  const question = questionFromRequestV1(req);
  if (!question.ok) {
    res.status(400).json({ error: question.code, code: question.code, detail: question.detail });
    return;
  }
  const window = String(req.query.window ?? '24h');
  if (!Object.keys(MARKET_REALITY_WINDOWS_V1).includes(window)) {
    res.status(400).json({
      error: 'invalid_history_window',
      code: 'invalid_history_window',
      detail: `window must be one of ${Object.keys(MARKET_REALITY_WINDOWS_V1).join(', ')}.`,
    });
    return;
  }
  try {
    if (!(await rwaMarketRealityRuntime.migrationAvailable())) {
      res.status(503).json({
        error: 'market_reality_storage_unavailable',
        code: 'market_reality_storage_unavailable',
      });
      return;
    }
    const history = await rwaMarketRealityRuntime.assembleHistory(
      {
        underlyings: rwaMarketRealityRuntime.underlyings(),
        cashExit: rwaMarketRealityRuntime.cashExit(),
        now: rwaMarketRealityRuntime.now,
      },
      {
        underlyingKey: question.underlyingKey,
        direction: question.direction,
        requestedCashAtomic: question.requestedCashAtomic,
        destination: question.destination,
        window: window as MarketRealityWindowV1,
      },
    );
    res.status(200).json(MarketRealityHistoryV1Schema.parse(history));
  } catch {
    res.status(500).json({ error: 'market_reality_failed', code: 'market_reality_failed' });
  }
});

// ---------------------------------------------------------------------------
// Phase 13.2 — Ask Miorail, about exactly what is on the screen.
//
// The whole design is one sentence: THE AI ESTABLISHES NOTHING. It does not
// choose what to read, it does not widen the question, and it cannot reach
// past the answer the reader is already looking at.
//
// So there is no planner here, unlike the B20 console. The evidence bundle is
// built from the SAME assembled market-reality answer the page renders, for
// the same exact question in the same query string — which means the strongest
// possible version of the guarantee: a narration cannot cite a row that was
// not on screen, because no other row was ever assembled.
//
// What the model does is turn that bundle into a structured answer, and a
// verifier decides whether the reader sees it. Every failure — no provider, a
// timeout, a refusal, an unverifiable claim — lands on the deterministic
// answer built from the same rows, and `answerSource` says which one arrived.
//
// Read-only in the strongest sense this codebase has: the narrator's whole
// import closure is a provider interface and two sets of contracts. No signer,
// no wallet, no calldata, no repository. The request that reaches the provider
// carries messages, a model and a temperature, and nothing else.
// ---------------------------------------------------------------------------

/** Longest question this surface accepts. A reader asking more than this is
 * writing a brief, and the bundle is one exact market question wide. */
const STOCKS_ASK_MAX_QUESTION_V1 = 1_000;

/**
 * Questions this surface will not answer, matched before any evidence is read.
 *
 * Not a safety filter — a scope one, and the same list the B20 console is held
 * to. Miorail measures what it cost to enter and exit one exact position at
 * one block. It does not measure price, intent, identity or the future, and
 * saying so costs nothing here rather than a metered call after the fact.
 */
function stocksAskRefusalV1(asked: string): string | null {
  for (const rule of B20_UNSUPPORTED_QUESTIONS_V1) {
    if (rule.patterns.some((pattern) => pattern.test(asked))) return rule.refusal;
  }
  return null;
}

rwaMarketRealityRouter.post('/rwa/market-reality/:underlyingKey/ask', async (req, res) => {
  if (!rwaMarketRealityRuntime.enabled(process.env)) {
    res
      .status(404)
      .json({ error: 'route_intelligence_disabled', code: 'route_intelligence_disabled' });
    return;
  }
  if (!sessionUserV1(req)) {
    res.status(401).json({ error: 'authentication_required', code: 'authentication_required' });
    return;
  }
  const question = questionFromRequestV1(req);
  if (!question.ok) {
    res.status(400).json({ error: question.code, code: question.code, detail: question.detail });
    return;
  }
  const asked = String((req.body as { question?: unknown } | undefined)?.question ?? '').trim();
  if (asked.length === 0 || asked.length > STOCKS_ASK_MAX_QUESTION_V1) {
    res.status(400).json({
      error: 'invalid_question',
      code: 'invalid_question',
      detail: `A question of 1 to ${STOCKS_ASK_MAX_QUESTION_V1} characters is required.`,
    });
    return;
  }

  const now = rwaMarketRealityRuntime.now();
  const echo = {
    underlyingKey: question.underlyingKey,
    direction: question.direction,
    requestedCashAtomic: question.requestedCashAtomic,
    destination: question.destination,
    asked,
  };

  // Scope, refused BEFORE any read. Miorail measures what it cost to get in
  // and out at one block; it does not measure price, intent or the future, and
  // a surface that assembled evidence first and then declined would have spent
  // a metered call to say so. The same boundary the B20 console is held to,
  // Russian included — this console is used in it.
  const refusal = stocksAskRefusalV1(asked);
  if (refusal) {
    res.status(200).json(
      StocksAskResponseV1Schema.parse({
        schemaVersion: 'stocks-ask/v1',
        question: echo,
        answer: {
          subjects: [question.underlyingKey],
          established: [],
          notEstablished: [refusal],
          explanation: refusal,
          sources: [],
        },
        answerSource: 'deterministic_evidence',
        evidence: [],
        refused: true,
        quoteOnly: true,
        executionEvidenceIncluded: false,
        assembledAt: now.toISOString(),
      }),
    );
    return;
  }

  try {
    if (!(await rwaMarketRealityRuntime.migrationAvailable())) {
      res.status(503).json({
        error: 'market_reality_storage_unavailable',
        code: 'market_reality_storage_unavailable',
      });
      return;
    }
    // The same call the GET makes, with the same arguments. Ask and read
    // cannot drift apart, because there is only one way to build the answer.
    const assembled = await rwaMarketRealityRuntime.assemble(
      {
        underlyings: rwaMarketRealityRuntime.underlyings(),
        cashExit: rwaMarketRealityRuntime.cashExit(),
        ratios: rwaMarketRealityRuntime.ratios(),
        supplies: rwaMarketRealityRuntime.supplies(),
        now: rwaMarketRealityRuntime.now,
        reference: rwaMarketRealityRuntime.reference(),
      },
      {
        underlyingKey: question.underlyingKey,
        direction: question.direction,
        requestedCashAtomic: question.requestedCashAtomic,
        destination: question.destination,
      },
    );
    const reality = MarketRealityResponseV2Schema.parse(assembled);
    const bundle = stocksEvidenceBundleV1({ question: asked, reality, now });

    const narrated = await narrateStocksAnswerV1({
      bundle,
      provider: rwaMarketRealityRuntime.narrator(),
    });
    if (narrated.rejectedBecause || narrated.providerError) {
      // Operator-facing only. A reader is never shown why a sentence they
      // cannot see was discarded, and the provider error is a NAME, never a
      // cause: a provider message carries a base URL and a base URL carries a
      // key.
      logger.info('stocks narration not used', {
        underlyingKey: question.underlyingKey,
        because: narrated.rejectedBecause?.map((violation) => violation.code) ?? null,
        providerError: narrated.providerError ? 'provider_did_not_answer' : null,
      });
    }

    res.status(200).json(
      StocksAskResponseV1Schema.parse({
        schemaVersion: 'stocks-ask/v1',
        question: echo,
        answer: narrated.answer,
        answerSource: narrated.answerSource,
        evidence: bundle.items,
        refused: false,
        quoteOnly: true,
        executionEvidenceIncluded: false,
        assembledAt: now.toISOString(),
      }),
    );
  } catch {
    res.status(500).json({ error: 'market_reality_failed', code: 'market_reality_failed' });
  }
});
