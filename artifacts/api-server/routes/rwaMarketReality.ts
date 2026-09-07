import { Router, type Request } from 'express';
import { decodeFunctionResult, encodeFunctionData } from 'viem';
import {
  b20TransferGateRefusesV1,
  b20TransferGateV1,
  callManyV1,
  createB20ReaderV1,
  readB20TransferEligibilityV1,
} from '@mioagent/b20-control';
import { budgetedRpcConfigFromEnvV1, createBudgetedReaderV1 } from '../lib/budgetedRpc.js';
import { client } from '@mioagent/db';
import { measureOfficialCashExitV1 } from '@mioagent/rwa-cash-exit';
import { KyberSwapRouteAdapter, readAerodromeClSpotV1 } from '@mioagent/swap-adapters';
import {
  POOL_VENUE_NAMES_V1,
  createDatabaseMarketPoolReadingRepository,
  createDatabaseOfficialAssetRepository,
  createDatabaseOfficialCashExitRepository,
  createDatabaseRepresentationRatioRepository,
  createDatabaseRepresentationSupplyRepository,
  createDatabaseUnderlyingAssetRepository,
  RouteStorageConflictError,
} from '@mioagent/route-storage';
import {
  MARKET_REALITY_INDEX_SCOPES_V1,
  MARKET_REALITY_WINDOWS_V1,
  MarketRealityHistoryV1Schema,
  MarketRealityIndexV1Schema,
  MarketRealityLiveResponseV2Schema,
  type MarketRealityLiveResponseV2,
  MarketRealityRadarResponseV1Schema,
  MarketRealityRadarWatchInputV1Schema,
  MarketRealityResponseV2Schema,
  assembleMarketRealityHistoryV1,
  assembleMarketRealityIndexV1,
  assembleMarketRealityV2,
  createMarketRealityEvidenceCaptureV1,
  createMarketRealityCoordinatorV1,
  createDatabaseMarketRealityRadarRepositoryV1,
  type MarketRealityIndexScopeV1,
  type MarketRealityWindowV1,
} from '@mioagent/rwa-market-reality';
import type { TenantUser } from '../middleware/tenantAuth.js';
import { getMiorailProductMigrationFlags } from '../lib/productMigrationConfig.js';
import { createLlmProvider, type LlmProvider } from '@mioagent/llm';
import { StocksAskResponseV1Schema } from '@mioagent/rwa-market-reality/narration-contract';
import { InMemoryRateLimiter, logger } from '@mioagent/utils';
import { B20_UNSUPPORTED_QUESTIONS_V1 } from '../lib/b20AnswerPlan.js';
import { stocksEvidenceBundleV1 } from '../lib/stocksEvidence.js';
import { narrateStocksAnswerV1 } from '../lib/stocksNarration.js';
import { createReviewedMarketRealityReferenceAdapterV1 } from '../lib/rwaReferenceSession.js';
import {
  STOCK_ACTION_DRAFT_REFUSAL_COPY_V1,
  verifyStockActionDraftV1,
} from '../lib/stockActionDraft.js';
import { issueStockActionClearanceV1 } from '../lib/stockActionClearance.js';
import {
  establishStockSellTermsV1,
  stockSellTermsWireV1,
  type StockSellTermsV1,
} from '../lib/stockSellTerms.js';
import {
  STOCK_ISSUER_NOTICE_V1 as STOCK_ISSUER_NOTICE_COPY_V1,
  stockExecutionHandoffV1,
} from '@mioagent/rwa-market-reality/execution-handoff';
import {
  assembleUseAccessV1,
  reviewedDefiSourcesV1,
  type UseAccessReaderV1,
} from '@mioagent/rwa-issuer';

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
  // Phase 17.8 — a SELL is sized in tokens, so the holding is the ceiling.
  {
    type: 'function',
    name: 'balanceOf',
    inputs: [{ type: 'address' }],
    outputs: [{ type: 'uint256' }],
    stateMutability: 'view',
  },
] as const;

export type StockSellSizeReadV1 =
  | { ok: true; decimals: number; symbol: string; balanceAtomic: string; blockTag: string }
  | { ok: false; code: string };

/**
 * What the wallet actually holds, at one block, for a SELL confirmation.
 *
 * Both reads are pinned to the same anchor. A balance read at one block and
 * decimals read at another would be two facts about two moments, and the
 * comparison between the confirmed amount and the holding would be nonsense
 * in exactly the case that matters — a position changing while somebody is
 * confirming how much of it to sell.
 *
 * Decimals are read, never assumed: a wrong decimals turns an exact size into
 * a different size entirely, and this is the one number a person typed.
 */
export async function readStockSellSizeV1(input: {
  tokenAddress: string;
  walletAddress: string;
}): Promise<StockSellSizeReadV1> {
  if (!rpcUrlV1()) return { ok: false, code: 'market_reality_chain_unavailable' };
  const reader = rwaMarketRealityRuntime.useAccessReader();
  const anchor = await reader.readBlockAnchor();
  if (!anchor.ok) return { ok: false, code: 'stock_action_balance_unread' };
  const blockTag = anchor.value.blockTag;
  const [decimalsRead, balanceRead, symbolRead] = await Promise.all([
    reader.call({
      to: input.tokenAddress,
      data: encodeFunctionData({ abi: ERC20_METADATA_ABI_V1, functionName: 'decimals' }),
      blockTag,
    }),
    reader.call({
      to: input.tokenAddress,
      data: encodeFunctionData({
        abi: ERC20_METADATA_ABI_V1,
        functionName: 'balanceOf',
        args: [input.walletAddress as `0x${string}`],
      }),
      blockTag,
    }),
    // Read at the SAME anchor as the other two, and allowed to fail on its own.
    // A symbol is a label — it names nothing the size depends on — so a token
    // whose `symbol()` reverts must still be sellable. Decimals are the
    // opposite and are never treated this way.
    reader
      .call({
        to: input.tokenAddress,
        data: encodeFunctionData({ abi: ERC20_METADATA_ABI_V1, functionName: 'symbol' }),
        blockTag,
      })
      .catch(() => ({ ok: false as const })),
  ]);
  if (!decimalsRead.ok) return { ok: false, code: 'stock_action_token_decimals_unread' };
  if (!balanceRead.ok) return { ok: false, code: 'stock_action_balance_unread' };
  let decimals: number;
  let balanceAtomic: string;
  try {
    decimals = Number(
      decodeFunctionResult({
        abi: ERC20_METADATA_ABI_V1,
        functionName: 'decimals',
        data: decimalsRead.value as `0x${string}`,
      }),
    );
    balanceAtomic = String(
      decodeFunctionResult({
        abi: ERC20_METADATA_ABI_V1,
        functionName: 'balanceOf',
        data: balanceRead.value as `0x${string}`,
      }),
    );
  } catch {
    return { ok: false, code: 'stock_action_balance_unread' };
  }
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    return { ok: false, code: 'stock_action_token_decimals_unread' };
  }
  if (!/^[0-9]+$/.test(balanceAtomic)) return { ok: false, code: 'stock_action_balance_unread' };
  let symbol = 'TOKEN';
  if (symbolRead.ok) {
    try {
      const decoded = decodeFunctionResult({
        abi: ERC20_METADATA_ABI_V1,
        functionName: 'symbol',
        data: (symbolRead as { value: unknown }).value as `0x${string}`,
      });
      if (typeof decoded === 'string' && decoded.trim().length > 0) {
        symbol = decoded.trim().slice(0, 32);
      }
    } catch {
      // Cosmetic. The quote is keyed by address.
    }
  }
  return { ok: true, decimals, symbol, balanceAtomic, blockTag };
}

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
  poolReadings: () => createDatabaseMarketPoolReadingRepository(client),
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
  /**
   * The token's own transfer rules for one wallet, or null.
   *
   * Null rather than a reassuring shape when the chain cannot be reached: a
   * surface with no verdict must render nothing, because "no restriction found"
   * and "we did not look" are the two states this product exists to separate.
   */
  eligibility: async (input: {
    tokenAddress: string;
    wallet: string;
    /** The contract that would call `transferFrom`, where a caller knows it. */
    executor?: string | null;
  }) => {
    if (!rpcUrlV1()) return null;
    try {
      const reader = createB20ReaderV1({ rpcUrl: rpcUrlV1() });
      const anchor = await reader.readBlockAnchor();
      if (!anchor.ok) return null;
      return await readB20TransferEligibilityV1({
        reader,
        tokenAddress: input.tokenAddress,
        wallet: input.wallet,
        executor: input.executor ?? null,
        blockTag: anchor.value.blockTag,
        blockNumber:
          anchor.value.blockNumber === undefined ? null : String(anchor.value.blockNumber),
      });
    } catch {
      // This read is an ADDITION to the review, never a precondition for it.
      // It sits inside the route's own try, so a thrown socket error here would
      // turn a working review into a 500 — losing the market answer, the
      // evidence state and the whole board over a question the reader could
      // simply have gone without.
      return null;
    }
  },
  measureOne: measureOfficialCashExitV1,
  /**
   * The terms for selling one exact token amount — a seam, so a test can hand
   * in routers that refuse and assert what the reader is told.
   */
  sellTerms: establishStockSellTermsV1,
  // Alchemy while the month's compute units allow it, the public endpoint when
  // they do not. The public one caps a batch at ten calls and throttles under
  // load; the same hundred-contract sweep read 8 of 100 there and 100 of 100
  // through Alchemy.
  reader: (): ReturnType<typeof createB20ReaderV1> => {
    const config = budgetedRpcConfigFromEnvV1();
    return config
      ? (createBudgetedReaderV1(config) as ReturnType<typeof createB20ReaderV1>)
      : createB20ReaderV1({ rpcUrl: rpcUrlV1() });
  },
  /** The same reader, narrowed to what Use & access needs: an anchor and a
   * pinned `eth_call`. Nothing on that surface may reach a wider seam. */
  useAccessReader: (): UseAccessReaderV1 => {
    const config = budgetedRpcConfigFromEnvV1();
    const reader = config
      ? createBudgetedReaderV1(config)
      : createB20ReaderV1({ rpcUrl: rpcUrlV1() });
    return {
      async readBlockAnchor() {
        const anchor = await reader.readBlockAnchor();
        return anchor.ok
          ? { ok: true, value: { blockTag: anchor.value.blockTag } }
          : { ok: false, reason: anchor.reason };
      },
      async call(input) {
        const result = await reader.call(input);
        return result.ok ? { ok: true, value: result.value } : { ok: false, reason: result.reason };
      },
      // Batched, because the assembly is written in rounds for exactly this:
      // eight sequential reads against a rate-limited endpoint produce
      // `unread` and `not_confirmed` that look like findings.
      async callMany(inputs) {
        const results = await callManyV1(reader, [...inputs]);
        return results.map((result) =>
          result.ok
            ? { ok: true as const, value: result.value }
            : { ok: false as const, reason: result.reason },
        );
      },
    };
  },
  /**
   * The same paced reader, for one pool's own state.
   *
   * Not a second transport. The Base public endpoint serves roughly half a
   * call per second, this read issues seven, and the reader already carries
   * the adaptive pacing that survives that. Null when no RPC is configured, so
   * a server that cannot look offers no reading rather than a false one.
   */
  clSpotReader: (): UseAccessReaderV1 | null =>
    rpcUrlV1() ? rwaMarketRealityRuntime.useAccessReader() : null,
  // The chain reader is passed so Aave and Compound are checked too. Both
  // answer from Base itself, so the negative on a card names four venues a
  // reader recognises rather than two.
  defiSources: () => reviewedDefiSourcesV1(rwaMarketRealityRuntime.useAccessReader()),
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
  // An unrecognised scope is the default rather than a 400: this is a read, the
  // default is the safe corpus, and a typo in a query string should not be able
  // to blank a consumer screen.
  const requested = String(req.query.scope ?? '');
  const scope = (MARKET_REALITY_INDEX_SCOPES_V1 as readonly string[]).includes(requested)
    ? (requested as MarketRealityIndexScopeV1)
    : undefined;
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
      { limit: Number.isFinite(limit) && limit > 0 ? Math.min(500, limit) : 100, scope },
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

// ---------------------------------------------------------------------------
// Use & access, for ONE exact address.
//
// Its own route rather than a field on the comparison: these are chain reads
// and two HTTP calls, and paying for them on every size or direction press
// would make the board slower to answer the question it exists for. The tab
// asks when it is opened.
//
// The wallet is taken from the SESSION and never from a request field. A route
// that accepted an address would answer for a wallet nobody proved, and the
// answer is about permission.
// ---------------------------------------------------------------------------
rwaMarketRealityRouter.get('/rwa/use-access/:tokenAddress', async (req, res) => {
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
  const tokenAddress = String(req.params.tokenAddress ?? '').toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(tokenAddress)) {
    res.status(400).json({ error: 'exact_address_required', code: 'exact_address_required' });
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
    // Stored, and read BEFORE the chain calls. The balances were measured by a
    // paced worker at a block of their own, so a chain outage here must leave
    // them on the screen rather than blank a good measurement to report a bad
    // one — which is exactly what the unread path does with them.
    const stored = await rwaMarketRealityRuntime
      .poolReadings()
      .readingsForToken({ chainId: 8453, tokenAddress, limit: 60 });
    const pools = {
      state: (stored.length > 0 ? 'measured' : 'not_measured') as 'measured' | 'not_measured',
      blockNumber: stored[0]?.blockNumber ?? null,
      readAt: stored[0]?.readAt ?? null,
      rows: stored.map((row) => ({
        poolAddress: row.poolAddress,
        venueId: row.venueId,
        // The NAME is ours, from a code-owned map, and null when the venue is
        // one we cannot name. A prettified factory address would let an
        // unknown protocol label itself on our screen.
        venueName: row.venueId ? (POOL_VENUE_NAMES_V1[row.venueId] ?? null) : null,
        factoryAddress: row.factoryAddress,
        tokenBalanceAtomic: row.tokenBalanceAtomic,
        tokenDecimals: row.tokenDecimals,
        pairedTokenAddress: row.pairedTokenAddress,
        pairedBalanceAtomic: row.pairedBalanceAtomic,
        pairedDecimals: row.pairedDecimals,
        pairedSymbol: row.pairedSymbol,
      })),
    };

    const use = await assembleUseAccessV1({
      tokenAddress,
      pools,
      reader: rwaMarketRealityRuntime.useAccessReader(),
      now: rwaMarketRealityRuntime.now(),
      // Read per venue row. The four venue reads are sequential and two of them
      // are network fetches, so one instant across all four would be a smaller
      // version of the overclaim this provenance exists to end.
      clock: rwaMarketRealityRuntime.now,
      defiSources: rwaMarketRealityRuntime.defiSources(),
      walletAddress: user.address,
    });
    res.json(use);
  } catch (error) {
    // Named, not swallowed: 23 bare catches once meant a production 500
    // recorded nothing at all.
    res.status(502).json({
      error: 'use_access_unavailable',
      code: 'use_access_unavailable',
      detail: error instanceof Error ? error.message.slice(0, 200) : 'unknown',
    });
  }
});

/**
 * The sentence that must travel with every marginal price.
 *
 * A number with no size attached, sitting beside quotes, will be read as a
 * quote unless it says otherwise every single time. So it says otherwise every
 * single time, in the payload rather than only in a stylesheet.
 */
const AERODROME_SPOT_NOTE_V1 =
  'This is the pool’s own marginal price at its current tick — the price of an infinitesimally small trade — computed from one onchain word. It is not a quote: no size, no slippage, no route, and no statement that a trade would succeed. A real trade walks ticks this read does not look at, so it will differ, and it will differ more the larger it is.';

const AERODROME_SPOT_REFUSAL_COPY_V1: Readonly<Record<string, string>> = {
  not_aerodrome_cl:
    'That address does not answer as an Aerodrome concentrated-liquidity pool: either its factory is not one of Aerodrome’s two, or that factory does not name Aerodrome’s own Voter. Nothing was read from it, and no price is claimed for it.',
  not_initialised:
    'This pool exists and has never been initialised with a price, so it has no marginal price to read. That is a fact about the pool, not a price of zero.',
  below_published_precision:
    'This pool has a price and it is smaller than eighteen decimal places can show. Its own state is fine — this figure is what ran out.',
  unreadable:
    'The pool did not answer this read, so nothing was established. That is about Miorail’s read, never about the pool or the market.',
};

// ---------------------------------------------------------------------------
// Phase 17.6 — the last mile, for a browser.
//
// The chain an assistant starts ended in the air. `miorail_prepare_stock_action`
// produces a review, a person confirms it, and the confirmed clearance becomes
// unsigned calls through `miorail_get_stock_base_mcp_action` — which hands them
// to Base MCP, in the ASSISTANT's environment. A person whose assistant has no
// Base MCP had nowhere to sign: the review page deliberately creates nothing
// executable, and no screen in this console could pick up a blueprint minted
// through the MCP path.
//
// So the headline promise — "your Base Account is the only signer" — had no
// screen where that signing happened for this path. Found 2026-09-04, by an
// owner who reached a valid clearance and asked the obvious question.
//
// This route is the SAME function the MCP tool calls, under a browser session
// instead of an OAuth grant. Not a reimplementation: a second implementation of
// a release path is how two callers come to disagree about what a confirmed
// clearance may become, and this evening was spent on smaller versions of that
// bug.
//
// It creates nothing the MCP tool does not create, it re-runs every check
// including the Safety Kernel, and the calls it returns still have to be
// approved by the wallet that owns the session.
// ---------------------------------------------------------------------------
rwaMarketRealityRouter.post('/rwa/stock-action/release', async (req, res) => {
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
  const clearance = String((req.body as { clearance?: unknown } | undefined)?.clearance ?? '');
  const requestId = String((req.body as { requestId?: unknown } | undefined)?.requestId ?? '');
  if (clearance.length === 0 || clearance.length > 4000 || requestId.length === 0) {
    res.status(400).json({
      error: 'stock_action_release_arguments',
      code: 'stock_action_release_arguments',
      detail: 'A confirmed clearance and an idempotency handle are both required.',
    });
    return;
  }
  try {
    const { miorailGetStockBaseMcpActionV1 } = await import('./mcpPrivate/tools.js');
    const released = await miorailGetStockBaseMcpActionV1(
      {
        tenantId: user.id,
        walletAddress: user.address as `0x${string}`,
        chainId: 8453,
        // Named for what it is. The audit line must not claim an OAuth grant
        // released these bytes when a cookie did.
        tokenId: 'session',
        source: 'browser_session',
      },
      { clearance, requestId },
    );
    res.status(200).json(released);
  } catch (error) {
    // The tool's own refusals are already public sentences — a code and a
    // detail written for a reader. Anything else becomes one sentence and no
    // internals.
    const refusal = error as { code?: unknown; message?: unknown };
    const code = typeof refusal?.code === 'string' ? refusal.code : null;
    if (code) {
      res.status(409).json({
        error: code,
        code,
        detail: typeof refusal.message === 'string' ? refusal.message : undefined,
        confirmed: true,
        executableActionAvailable: false,
      });
      return;
    }
    res.status(500).json({ error: 'stock_action_release_failed', code: 'stock_action_release_failed' });
  }
});

// ---------------------------------------------------------------------------
// Phase 17.5 — a second, independent reading of the price.
//
// Every `full` observation in the entire tokenized-stock corpus comes from ONE
// source. That is not a criticism of the source; it is a structural weakness of
// the evidence, and it has never had a cross-check. Base publicly says these
// assets have deep liquidity on Aerodrome, our own adapter walks the v2 Router
// where these pairs hold dust, and there is no verifiable quoter for the CL
// factory that actually holds them — measured, and it has not changed.
//
// What CAN be had is the pool's own current price: `slot0().sqrtPriceX96`, one
// word, squared and shifted. It is not a quote and this route never calls it
// one — no size, no slippage, no tick walking, no executability. It is a number
// computed from a single onchain word that anybody can recompute at the same
// block, standing next to a number an aggregator reported.
//
// Verified live before shipping, against the exact pool KyberSwap named for
// NVDAc (0x853f5f1b…7ab9): the pool's own state said $231.878101 per NVDAc and
// a $1,000 KyberSwap quote said $231.948403 — 3.0 bps apart, with the quote
// worse than the marginal price, which is exactly what walking a little way up
// the curve costs. The decimals read caught NVDAc at 8, not 18; assuming would
// have produced a price wrong by ten orders of magnitude that still looked like
// a price.
//
// Public in the sense the rest of the reviewed surface is: the session gate
// stays, because this shares the RPC seam with everything else here.
// ---------------------------------------------------------------------------
rwaMarketRealityRouter.get('/rwa/pool-spot/:pool', async (req, res) => {
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
  const pool = String(req.params.pool ?? '').toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(pool)) {
    res.status(400).json({ error: 'exact_address_required', code: 'exact_address_required' });
    return;
  }
  const reader = rwaMarketRealityRuntime.clSpotReader();
  if (!reader) {
    res.status(503).json({
      error: 'market_reality_chain_unavailable',
      code: 'market_reality_chain_unavailable',
    });
    return;
  }
  try {
    const anchor = await reader.readBlockAnchor();
    const result = await readAerodromeClSpotV1({
      rpc: {
        async call(input) {
          const read = await reader.call({ ...input, blockTag: anchor.ok ? anchor.value.blockTag : 'latest' });
          return read.ok ? read.value : null;
        },
      },
      pool: pool as `0x${string}`,
      blockTag: anchor.ok ? anchor.value.blockTag : null,
    });
    if (!result.ok) {
      // Four different findings, kept apart. `not_aerodrome_cl` is about the
      // address somebody handed us; `unreadable` is about us.
      res.status(200).json({
        schemaVersion: 'aerodrome-cl-spot/v1',
        pool,
        outcome: 'unavailable',
        reason: result.reason,
        detail: AERODROME_SPOT_REFUSAL_COPY_V1[result.reason],
      });
      return;
    }
    res.status(200).json({
      schemaVersion: 'aerodrome-cl-spot/v1',
      outcome: 'read',
      ...result.spot,
      /** Said in the payload, not only in the UI. A consumer of this route that
       * renders the number without the sentence is rendering a quote. */
      isQuote: false,
      note: AERODROME_SPOT_NOTE_V1,
    });
  } catch (error) {
    res.status(502).json({
      error: 'pool_spot_unavailable',
      code: 'pool_spot_unavailable',
      detail: error instanceof Error ? error.message.slice(0, 200) : 'unknown',
    });
  }
});

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
/**
 * The measurement, as one function, so there is exactly one of it.
 *
 * The web button and the connected MCP tool are two ways to ask the same
 * question, and a second implementation of "measure now" would be a second
 * single-flight map, a second cooldown and a second definition of what a run
 * costs. There is one. Callers differ only in how they proved who they are.
 *
 * Read-only outside Miorail's own evidence tables: no signer, no wallet call,
 * no allowance, no transaction. A quote is not execution and never becomes it.
 */
export type MarketRealityMeasureQuestionV1 = {
  underlyingKey: string;
  direction: 'buy' | 'sell';
  requestedCashAtomic: string;
  destination: 'USDC' | 'ETH';
};

export type MarketRealityMeasureResultV1 =
  | { ok: true; payload: MarketRealityLiveResponseV2 }
  | { ok: false; status: number; code: string };

export async function measureMarketRealityV1(input: {
  question: MarketRealityMeasureQuestionV1;
  /** Proved by the caller's own surface. Never taken from a request field. */
  walletAddress: string;
  tenantId: string;
}): Promise<MarketRealityMeasureResultV1> {
  if (!rwaMarketRealityRuntime.enabled(process.env)) {
    return { ok: false, status: 404, code: 'route_intelligence_disabled' };
  }
  if (!rpcUrlV1()) {
    return { ok: false, status: 503, code: 'market_reality_chain_unavailable' };
  }
  try {
    if (!(await rwaMarketRealityRuntime.migrationAvailable())) {
      return { ok: false, status: 503, code: 'market_reality_storage_unavailable' };
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
            walletAddress: input.walletAddress as `0x${string}`,
            tenantId: input.tenantId,
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
        underlyingKey: input.question.underlyingKey,
        direction: input.question.direction,
        requestedCashAtomic: input.question.requestedCashAtomic,
        destination: input.question.destination,
      },
    );

    // Parsed on the way out, envelope included: the measurement counts are the
    // only thing telling a reader whether the button did anything, so a shape
    // change there must fail here rather than render as an empty sentence.
    return {
      ok: true,
      payload: MarketRealityLiveResponseV2Schema.parse({
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
    };
  } catch (error) {
    // Named apart from a measurement failure. A response this build cannot
    // serialize is OUR contract drifting, and reporting it as
    // `market_reality_failed` sends whoever is debugging to look at routers.
    return {
      ok: false,
      status: 500,
      code:
        error instanceof Error && error.name === 'ZodError'
          ? 'market_reality_response_invalid'
          : 'market_reality_failed',
    };
  }
}

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
  const result = await measureMarketRealityV1({
    question: {
      underlyingKey: question.underlyingKey,
      direction: question.direction,
      requestedCashAtomic: question.requestedCashAtomic,
      destination: question.destination,
    },
    walletAddress: user.address,
    tenantId: user.id,
  });
  if (!result.ok) {
    res.status(result.status).json({ error: result.code, code: result.code });
    return;
  }
  res.status(200).json(result.payload);
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

// ---------------------------------------------------------------------------
// Connected Intelligence 1 — the review a draft points at.
//
// The authority for live terms. An assistant established WHICH representation
// and WHICH question; it was told nothing about what that costs, and this is
// where the cost is established — under the session of the wallet the draft is
// bound to, from canonical evidence read now.
//
// Nothing conversational survives into this answer. The draft carries no
// figure, so there is no old number to preserve, and the state reported here is
// whatever the evidence says at this moment — including "the route policy
// changed" and "there is no route now", both of which stop the review.
// ---------------------------------------------------------------------------

rwaMarketRealityRouter.get('/rwa/stock-action/:draft', async (req, res) => {
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

  const secret = (process.env.SESSION_SECRET ?? '').trim();
  if (secret.length === 0) {
    res.status(503).json({
      error: 'stock_action_secret_unavailable',
      code: 'stock_action_secret_unavailable',
    });
    return;
  }

  // The SESSION's tenant, never the URL's. A draft opened under another account
  // is refused rather than resolved.
  const verified = verifyStockActionDraftV1({
    draft: String(req.params.draft ?? ''),
    secret,
    now: rwaMarketRealityRuntime.now(),
    expectTenantId: user.id,
  });
  if (!verified.ok) {
    res.status(verified.reason === 'stock_action_draft_wrong_wallet' ? 403 : 400).json({
      error: verified.reason,
      code: verified.reason,
      detail: STOCK_ACTION_DRAFT_REFUSAL_COPY_V1[verified.reason],
    });
    return;
  }
  const claims = verified.claims;

  try {
    if (!(await rwaMarketRealityRuntime.migrationAvailable())) {
      res.status(503).json({
        error: 'market_reality_storage_unavailable',
        code: 'market_reality_storage_unavailable',
      });
      return;
    }

    // Re-assembled, not remembered.
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
        underlyingKey: claims.underlyingKey,
        direction: claims.direction,
        requestedCashAtomic: claims.requestedCashAtomic,
        destination: 'USDC',
      },
    );
    const reality = MarketRealityResponseV2Schema.parse(assembled);
    const now = rwaMarketRealityRuntime.now();

    // The same rule the web page and the MCP tool use. A representation that has
    // since gone to zero supply, or lost its reviewed route policy, refuses here
    // exactly as it would have refused at prepare time.
    const rebuilt = stockExecutionHandoffV1({
      response: reality as never,
      tokenAddress: claims.tokenAddress,
      now,
    });
    if (rebuilt.status === 'refused') {
      res.status(200).json({
        schemaVersion: 'stock-action-review/v1',
        actionDraftId: claims.actionDraftId,
        representation: {
          chainId: 8453,
          tokenAddress: claims.tokenAddress,
          caip10: claims.caip10,
          underlyingKey: claims.underlyingKey,
          issuerId: claims.issuerId,
          issuerInstrumentKey: claims.issuerInstrumentKey,
          representationKind: claims.representationKind,
        },
        question: {
          direction: claims.direction,
          requestedCashAtomic: claims.requestedCashAtomic,
          destination: 'USDC',
          sizeBasis: claims.sizeBasis,
        },
        outcome: 'refused',
        reason: rebuilt.reason,
        detail: rebuilt.detail,
        confirmed: false,
        executableActionAvailable: false,
        assembledAt: now.toISOString(),
      });
      return;
    }

    // The reviewed measurement basis changed under the draft. The question the
    // conversation was about is not the question this would now answer, and
    // silently answering the new one is how a reader approves a comparison they
    // never saw.
    if (rebuilt.handoff.routePolicyKey.toLowerCase() !== claims.routePolicyKey.toLowerCase()) {
      res.status(200).json({
        schemaVersion: 'stock-action-review/v1',
        actionDraftId: claims.actionDraftId,
        outcome: 'refused',
        reason: 'route_policy_changed',
        detail:
          'Miorail’s reviewed router policy for this representation changed after this draft was prepared, so the measurement basis is no longer the one it was prepared under. Ask again for a current answer.',
        confirmed: false,
        executableActionAvailable: false,
        assembledAt: now.toISOString(),
      });
      return;
    }

    // Read ONCE, above the response, because two things now depend on it: the
    // sentences the reader sees and the precondition `confirm` enforces. Two
    // calls would be two blocks, and a page that showed one verdict while the
    // next step acted on another is exactly the disagreement Phase 17.4 spent
    // a whole card fixing.
    const transferEligibility = await rwaMarketRealityRuntime
      .eligibility({
        tokenAddress: claims.tokenAddress,
        wallet: claims.walletAddress,
        executor: null,
      })
      // Guarded HERE and not only inside the default implementation: this read
      // is an ADDITION to the review, never a precondition for it, and the
      // whole handler runs inside one try/catch. An unguarded throw would
      // return a 500 and cost the reader the market answer, the evidence state
      // and the entire board — over a question they could have gone without.
      // Whatever implementation is installed, this stays true.
      .catch(() => null);

    // Phase 17.8 — for a SELL, the size the reader is about to confirm is in
    // TOKENS, and the ceiling is what they hold. Read here so the screen can
    // show the number rather than invite one, and guarded the same way the
    // eligibility read is: a holding this server could not read costs the
    // reader an input, never the whole review.
    const holding =
      rebuilt.handoff.direction === 'sell'
        ? await readStockSellSizeV1({
            tokenAddress: claims.tokenAddress,
            walletAddress: claims.walletAddress,
          }).catch(() => null)
        : null;

    res.status(200).json({
      schemaVersion: 'stock-action-review/v1',
      actionDraftId: claims.actionDraftId,
      /**
       * What this wallet holds of this exact token, for a SELL, at one block.
       *
       * Null on a BUY, and null when the read failed — and those two are not
       * the same sentence to a reader, so the screen says which. A failed read
       * is never rendered as a zero balance: "you hold none" and "we could not
       * look" would refuse the same way and mean opposite things.
       */
      holding:
        holding === null
          ? null
          : holding.ok
            ? {
                state: 'read' as const,
                balanceAtomic: holding.balanceAtomic,
                decimals: holding.decimals,
                blockTag: holding.blockTag,
              }
            : { state: 'unread' as const, reason: holding.code },
      representation: {
        chainId: 8453,
        tokenAddress: rebuilt.handoff.tokenAddress,
        caip10: rebuilt.handoff.caip10,
        underlyingKey: rebuilt.handoff.underlyingKey,
        issuerId: rebuilt.handoff.issuerId,
        issuerInstrumentKey: rebuilt.handoff.issuerInstrumentKey,
        representationKind: rebuilt.handoff.representationKind,
      },
      question: {
        direction: rebuilt.handoff.direction,
        requestedCashAtomic: rebuilt.handoff.requestedCashAtomic,
        destination: 'USDC',
        sizeBasis: rebuilt.handoff.sizeBasis,
        routePolicyKey: rebuilt.handoff.routePolicyKey,
        approvedSources: rebuilt.handoff.approvedSources,
      },
      outcome: 'review',
      /**
       * The token's own transfer rules for THIS wallet, read on chain at one
       * block — sending, receiving, and the contract that would do the moving.
       *
       * The third axis, and the one this surface most needed: everything else
       * on this page is about the market, and a regulated asset can carry a
       * transfer policy that denies one address while the market is perfectly
       * healthy. Every reviewed Coinbase representation points all three
       * transfer scopes at a live blocklist, so this is not hypothetical.
       *
       * `executor` is null here on purpose, and the read reports it as not
       * established rather than assuming it. A sell moves the token through a
       * router under `transferFrom`, and this build chooses that router AFTER
       * this step — so at review time no exact executor address exists to ask
       * about. Passing the wallet in its place would answer a different
       * question and label it as this one.
       *
       * Never a gate. It states what the registry said and lets the reader
       * decide; a failed read is `not_established` and never a denial.
       */
      transferEligibility,
      /**
       * The same read, asked as the question `confirm` will ask.
       *
       * Phase 17.5. The evidence above was always here and was explicitly not
       * a gate — correct while the only thing downstream was another page.
       * `Prepare buy` / `Prepare sell` changed that: the next step hands out a
       * clearance, and it now refuses on a MEASURED denial of the scope that
       * governs this direction. Publishing the verdict here means the reader
       * learns it while they are reading, not at the moment they press the
       * button.
       *
       * Only `denied` stops anything. `not_established` is rendered as itself:
       * this gate fails open, and a surface that showed nothing would let a
       * reader conclude somebody checked when nobody could reach the registry.
       */
      transferGate: b20TransferGateV1({
        eligibility: transferEligibility,
        direction: rebuilt.handoff.direction,
      }),
      /** Said where the action can start. Base did not issue this and neither
       * did Miorail, and the issuer restricts who may hold it. */
      issuerNotice: STOCK_ISSUER_NOTICE_COPY_V1,
      /** Established NOW. `expired_quote` is a legitimate state to review in —
       * it is never promoted to `fresh_quote`, and the reader is told to
       * measure rather than shown an old figure as a current one. */
      evidenceState: rebuilt.handoff.evidenceState,
      quoteExpiresAt: rebuilt.handoff.quoteExpiresAt,
      /** The full current board for this exact question. The page renders the
       * SAME projection Stocks renders — one answer, two entry points. */
      reality,
      /**
       * Phase 17.9 — what the board below IS, on a sell, said here rather than
       * left for a screen to imply.
       *
       * The board answers the draft's CASH question. The sale is sized in
       * TOKENS by the holder, and until they name a number the two cannot be
       * the same size. Saying so is not a caveat: a page that renders market
       * figures for $0.09 directly above a confirm button that can authorise a
       * whole position has told the reader something false without writing a
       * single false sentence.
       *
       * Null on a BUY, where the cash question IS the size and there is
       * nothing to reconcile.
       */
      sizeContext:
        rebuilt.handoff.direction === 'sell'
          ? {
              boardSizeBasis: 'cash_equivalent' as const,
              boardRequestedCashAtomic: rebuilt.handoff.requestedCashAtomic,
              saleSizeBasis: 'exact_token_in' as const,
              /** No amount has been named yet, so no terms exist for one. The
               * sell-terms call establishes them. */
              termsEstablished: false,
              detail:
                'The market figures below were measured for the cash size this draft was prepared with. A sale is sized in tokens: name the exact amount and Miorail asks the reviewed routers about that amount before anything is confirmed.',
            }
          : null,
      confirmed: false,
      /** Preserved invariant: prepare is not confirmation, and confirmation is
       * not an executable action. Nothing on this response is executable. */
      executableActionAvailable: false,
      createsApproval: false,
      createsCalldata: false,
      createsTransaction: false,
      draftExpiresAt: claims.expiresAt,
      assembledAt: now.toISOString(),
    });
  } catch {
    res.status(500).json({ error: 'market_reality_failed', code: 'market_reality_failed' });
  }
});

/**
 * The reviewed board for ONE underlying, for the paid agent surface.
 *
 * The same assembly the Stocks screen renders, so an agent buying "which of
 * these three contracts actually trades" gets this product's answer rather
 * than a second one computed beside it. Read-only and stored-evidence only: it
 * measures nothing and spends no router call, so a paid read cannot be used to
 * make Miorail quote on somebody else's behalf.
 */
export async function readMarketRealityForX402V1(input: {
  underlyingKey: string;
  direction: 'buy' | 'sell';
  requestedCashAtomic: string;
}): Promise<unknown | null> {
  if (!(await rwaMarketRealityRuntime.migrationAvailable())) return null;
  try {
    return await rwaMarketRealityRuntime.assemble(
      {
        underlyings: rwaMarketRealityRuntime.underlyings(),
        cashExit: rwaMarketRealityRuntime.cashExit(),
        ratios: rwaMarketRealityRuntime.ratios(),
        supplies: rwaMarketRealityRuntime.supplies(),
        now: rwaMarketRealityRuntime.now,
        reference: rwaMarketRealityRuntime.reference(),
      },
      {
        underlyingKey: input.underlyingKey,
        direction: input.direction,
        requestedCashAtomic: input.requestedCashAtomic,
        destination: 'USDC',
      },
    );
  } catch {
    // An underlying this corpus does not review. Absent, never invented.
    return null;
  }
}

// ---------------------------------------------------------------------------
// Phase 17.9 — the terms for the size actually being sold.
//
// A separate call, and separate on purpose. The GET assembles the reviewed
// BOARD, which answers a cash-shaped question the draft was prepared with, and
// it cannot answer this one: at GET time nobody has said how many tokens they
// mean. So the board is a reading, and this is the sale.
//
// It spends real router calls, so it is a POST a person's action triggers,
// never something a page does while somebody types. `confirm` establishes the
// same terms again for itself and does not trust that this ran.
// ---------------------------------------------------------------------------

/**
 * Per wallet. Establishing terms spends real router calls, and this endpoint is
 * driven by a button a person can press repeatedly. The MCP measure tool is
 * bounded for the same reason and at the same rate.
 */
export const STOCK_SELL_TERMS_PER_MINUTE_V1 = 10;

/** A function rather than the limiter itself, so a test can hand in a fresh
 * budget instead of depending on how much the tests before it spent. */
export const stockSellTermsLimiterV1 = {
  current: new InMemoryRateLimiter({ windowMs: 60_000, max: STOCK_SELL_TERMS_PER_MINUTE_V1 }),
  reset() {
    this.current = new InMemoryRateLimiter({ windowMs: 60_000, max: STOCK_SELL_TERMS_PER_MINUTE_V1 });
  },
};

export interface StockSellTermsContextV1 {
  tokenAddress: string;
  walletAddress: string;
  tenantId: string;
  tokenAmountAtomic: string;
  /**
   * Which step is asking, so the refusal names what did NOT happen.
   *
   * Carried rather than edited afterwards: a sentence assembled by patching
   * another sentence is a sentence nobody wrote, and this is the copy a reader
   * is left with when Miorail cannot do the thing they asked for.
   */
  stage: 'measure' | 'confirm';
}

const STOCK_SELL_TERMS_NOTHING_V1: Readonly<Record<'measure' | 'confirm', string>> = {
  measure: 'Nothing was measured.',
  confirm: 'Nothing was confirmed.',
};

/**
 * Read the holding, refuse an amount above it, and establish the terms.
 *
 * One function because two callers must behave identically: a review that
 * showed terms one way and a confirm that established them another would be
 * the very disagreement this phase exists to remove.
 */
type StockSellTermsOutcomeV1 =
  | {
      ok: true;
      terms: StockSellTermsV1;
      holding: { balanceAtomic: string; decimals: number; blockTag: string };
    }
  | { ok: false; status: number; code: string; detail: string; holding?: unknown };

async function stockSellTermsForV1(
  context: StockSellTermsContextV1,
): Promise<StockSellTermsOutcomeV1> {
  const nothing = STOCK_SELL_TERMS_NOTHING_V1[context.stage];
  if (!/^[1-9][0-9]{0,77}$/.test(context.tokenAmountAtomic)) {
    return {
      ok: false,
      status: 400,
      code: 'stock_action_sell_requires_exact_size',
      detail: `A sell is sized as an exact number of token atoms, not as a cash equivalent. ${nothing}`,
    };
  }
  const holding = await readStockSellSizeV1({
    tokenAddress: context.tokenAddress,
    walletAddress: context.walletAddress,
  }).catch(() => null);
  if (holding === null || !holding.ok) {
    // Ours. Never rendered as "you hold none": a read that did not happen and
    // a balance of zero refuse the same way and mean opposite things.
    return {
      ok: false,
      status: 503,
      code: holding?.ok === false ? holding.code : 'stock_action_balance_unread',
      detail: `Miorail could not read this wallet’s holding of that exact token. ${nothing} Try again.`,
    };
  }
  if (BigInt(context.tokenAmountAtomic) > BigInt(holding.balanceAtomic)) {
    return {
      ok: false,
      status: 409,
      code: 'stock_action_sell_exceeds_balance',
      detail: `That is more of this token than this wallet holds at the block just read. ${nothing}`,
      holding: {
        balanceAtomic: holding.balanceAtomic,
        decimals: holding.decimals,
        blockTag: holding.blockTag,
      },
    };
  }
  const terms = await rwaMarketRealityRuntime.sellTerms({
    repository: rwaMarketRealityRuntime.cashExit(),
    adapters: rwaMarketRealityRuntime.quoteAdapters(),
    token: {
      address: context.tokenAddress.toLowerCase() as `0x${string}`,
      symbol: holding.symbol,
      decimals: holding.decimals,
    },
    tokenAmountAtomic: context.tokenAmountAtomic,
    walletAddress: context.walletAddress.toLowerCase() as `0x${string}`,
    tenantId: context.tenantId,
    now: rwaMarketRealityRuntime.now,
    captureMarketRealitySnapshots: rwaMarketRealityRuntime.capture(),
  });
  return {
    ok: true,
    terms,
    holding: {
      balanceAtomic: holding.balanceAtomic,
      decimals: holding.decimals,
      blockTag: holding.blockTag,
    },
  };
}

rwaMarketRealityRouter.post('/rwa/stock-action/:draft/sell-terms', async (req, res) => {
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
  const secret = (process.env.SESSION_SECRET ?? '').trim();
  if (secret.length === 0) {
    res.status(503).json({
      error: 'stock_action_secret_unavailable',
      code: 'stock_action_secret_unavailable',
    });
    return;
  }
  const verified = verifyStockActionDraftV1({
    draft: String(req.params.draft ?? ''),
    secret,
    now: rwaMarketRealityRuntime.now(),
    expectTenantId: user.id,
  });
  if (!verified.ok) {
    res.status(verified.reason === 'stock_action_draft_wrong_wallet' ? 403 : 400).json({
      error: verified.reason,
      code: verified.reason,
      detail: STOCK_ACTION_DRAFT_REFUSAL_COPY_V1[verified.reason],
    });
    return;
  }
  const claims = verified.claims;
  if (claims.direction !== 'sell') {
    // A BUY spends an exact number of USDC atoms and is sized before anything
    // quotes it. There is no second size to establish.
    res.status(400).json({
      error: 'stock_action_terms_sell_only',
      code: 'stock_action_terms_sell_only',
      detail:
        'Only a sell is sized in tokens. A buy spends the exact cash amount this draft already carries.',
    });
    return;
  }

  try {
    const allowance = await stockSellTermsLimiterV1.current.consume(`stock-sell-terms:${user.id}`);
    if (!allowance.success) {
      res.status(429).json({
        error: 'stock_sell_terms_rate_limited',
        code: 'stock_sell_terms_rate_limited',
        detail: `Miorail establishes terms at most ${STOCK_SELL_TERMS_PER_MINUTE_V1} times a minute for one wallet, because every one spends real router calls. Nothing was measured — wait a moment and check the amount again.`,
        confirmed: false,
        executableActionAvailable: false,
      });
      return;
    }
    const established = await stockSellTermsForV1({
      tokenAddress: claims.tokenAddress,
      walletAddress: user.address,
      tenantId: user.id,
      tokenAmountAtomic: String(
        (req.body as { tokenAmountAtomic?: unknown } | undefined)?.tokenAmountAtomic ?? '',
      ).trim(),
      stage: 'measure',
    });
    if (!established.ok) {
      res.status(established.status).json({
        error: established.code,
        code: established.code,
        detail: established.detail,
        ...(established.holding ? { holding: established.holding } : {}),
        confirmed: false,
        executableActionAvailable: false,
      });
      return;
    }
    res.status(200).json({
      schemaVersion: 'stock-action-sell-terms/v1',
      actionDraftId: claims.actionDraftId,
      representation: { chainId: 8453, tokenAddress: claims.tokenAddress, caip10: claims.caip10 },
      holding: established.holding,
      terms: stockSellTermsWireV1(established.terms),
      /** Preserved invariant: measuring is not confirming, and confirming is
       * not an executable action. */
      confirmed: false,
      executableActionAvailable: false,
      createsApproval: false,
      createsCalldata: false,
      createsTransaction: false,
      assembledAt: rwaMarketRealityRuntime.now().toISOString(),
    });
  } catch {
    res.status(500).json({ error: 'market_reality_failed', code: 'market_reality_failed' });
  }
});

// ---------------------------------------------------------------------------
// Connected Intelligence 2 — the explicit confirmation.
//
// Everything the GET does, then one more thing: it records that a PERSON, in
// their own session, looking at terms this server established just now, said
// yes to ONE exact representation.
//
// It is a POST because it is not a read, and it re-runs every check rather
// than trusting that the GET ran moments ago — a confirmation that believed a
// prior read would be a confirmation of whatever was true then.
//
// It still creates nothing executable. What it produces is a clearance: the
// authority to ASK for the unsigned request, which is a different thing again.
// ---------------------------------------------------------------------------

rwaMarketRealityRouter.post('/rwa/stock-action/:draft/confirm', async (req, res) => {
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
  const secret = (process.env.SESSION_SECRET ?? '').trim();
  if (secret.length === 0) {
    res.status(503).json({
      error: 'stock_action_secret_unavailable',
      code: 'stock_action_secret_unavailable',
    });
    return;
  }

  const verified = verifyStockActionDraftV1({
    draft: String(req.params.draft ?? ''),
    secret,
    now: rwaMarketRealityRuntime.now(),
    expectTenantId: user.id,
  });
  if (!verified.ok) {
    res.status(verified.reason === 'stock_action_draft_wrong_wallet' ? 403 : 400).json({
      error: verified.reason,
      code: verified.reason,
      detail: STOCK_ACTION_DRAFT_REFUSAL_COPY_V1[verified.reason],
    });
    return;
  }
  const claims = verified.claims;

  try {
    if (!(await rwaMarketRealityRuntime.migrationAvailable())) {
      res.status(503).json({
        error: 'market_reality_storage_unavailable',
        code: 'market_reality_storage_unavailable',
      });
      return;
    }

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
        underlyingKey: claims.underlyingKey,
        direction: claims.direction,
        requestedCashAtomic: claims.requestedCashAtomic,
        destination: 'USDC',
      },
    );
    const reality = MarketRealityResponseV2Schema.parse(assembled);
    const now = rwaMarketRealityRuntime.now();

    const rebuilt = stockExecutionHandoffV1({
      response: reality as never,
      tokenAddress: claims.tokenAddress,
      now,
    });
    if (rebuilt.status === 'refused') {
      res.status(409).json({
        error: rebuilt.reason,
        code: rebuilt.reason,
        detail: rebuilt.detail,
        confirmed: false,
        executableActionAvailable: false,
      });
      return;
    }
    if (rebuilt.handoff.routePolicyKey.toLowerCase() !== claims.routePolicyKey.toLowerCase()) {
      res.status(409).json({
        error: 'route_policy_changed',
        code: 'route_policy_changed',
        detail:
          'Miorail’s reviewed router policy for this representation changed after this draft was prepared. Nothing was confirmed — review again for a current answer.',
        confirmed: false,
        executableActionAvailable: false,
      });
      return;
    }

    // ------------------------------------------------------------------
    // Phase 17.5 — the issuer's own rule, asked before authority is handed
    // over.
    //
    // Everything above this line is about the MARKET: is there a route, what
    // does it cost, is the measurement basis still the one this draft was
    // prepared under. None of it asks the token whether this wallet may move
    // it at all — and for a regulated asset that is a separate axis that can
    // refuse while the market is perfectly healthy. Every reviewed Coinbase
    // representation points all three transfer scopes at a live blocklist, so
    // this is not hypothetical.
    //
    // It is enforced HERE, at confirm, and not one step earlier: the review is
    // a read, and refusing a read would deny somebody the explanation of why
    // they are being refused. Confirm is where a clearance is minted — the
    // authority to ask this server for an unsigned request — and that is the
    // narrowest place the check still means anything.
    //
    // ONLY A MEASURED DENIAL REFUSES. A read that did not happen, a throttled
    // RPC, and a contract that is not a B20 all come back `not_established`
    // and all proceed. This gate fails open by construction, because the
    // alternative — telling a holder their address is blocked when in fact our
    // endpoint was rate-limited — is a false positive indistinguishable from
    // the real thing, and it would be OUR failure wearing the issuer's name.
    //
    // Not a jurisdiction check. Not a geo-gate. An IP address is not a
    // jurisdiction and a VPN defeats one; this is the issuer's own per-address
    // policy, read from the registry the issuer publishes it in, enforced for
    // the exact wallet in this session.
    // ------------------------------------------------------------------
    const gate = b20TransferGateV1({
      eligibility: await rwaMarketRealityRuntime
        .eligibility({
          tokenAddress: claims.tokenAddress,
          wallet: user.address,
          // Still null, still deliberately. No router has been chosen at this
          // step, so the executor scope is `not_established` about a null
          // address — and `not_established` cannot refuse. Passing the wallet
          // in its place would answer a different question under this label.
          executor: null,
        })
        .catch(() => null),
      direction: claims.direction,
    });
    if (b20TransferGateRefusesV1(gate)) {
      logger.warn('Stock action refused by the issuer transfer policy', {
        tenantId: user.id,
        tokenAddress: claims.tokenAddress,
        direction: claims.direction,
        cause: gate.cause,
      });
      res.status(409).json({
        error: 'issuer_transfer_policy_denied',
        code: 'issuer_transfer_policy_denied',
        detail: gate.detail,
        // The verdict travels with the refusal so a reader can check it: which
        // scope was consulted, and at which block it answered.
        transferGate: gate,
        confirmed: false,
        executableActionAvailable: false,
      });
      return;
    }

    // ------------------------------------------------------------------
    // Phase 17.8 — a SELL is confirmed in TOKENS.
    //
    // The board asks a cash-shaped question, and for a BUY that question IS
    // the size: an exact number of USDC atoms, fixed before anything is
    // quoted. For a SELL it is not. "$1,000 worth" becomes a token amount only
    // once something prices it, and a price that moved between confirming and
    // signing would silently change how much of a position somebody sold.
    //
    // So the unit changed rather than the clock: the holder confirms an exact
    // `tokenAmountAtomic`, and this server checks it against what the wallet
    // actually holds, at one block, before it will mint any authority. There
    // is no "sell everything" here — the screen resolves that to a number and
    // sends the number. A server that accepted "all" would be deciding the
    // size itself.
    // ------------------------------------------------------------------
    //
    // Phase 17.9 added the second half of that sentence. Checking the amount
    // against the holding says the holder OWNS it; it says nothing about
    // whether the market will take it. The board assembled above answers the
    // draft's CASH question, so a draft prepared at $0.09 rendered the market
    // for $0.09 while this step happily minted authority over a whole position
    // — the reader approved a photograph of a different trade. So the routers
    // are asked about the exact amount being confirmed, here, before any
    // authority exists. What they say is evidence with its own clock, never a
    // permission: the release step plans again and the Safety Kernel decides.
    // ------------------------------------------------------------------
    let confirmedTokenAmountAtomic: string | null = null;
    let confirmedTerms: StockSellTermsV1 | null = null;
    if (rebuilt.handoff.direction === 'sell') {
      const raw = String(
        (req.body as { tokenAmountAtomic?: unknown } | undefined)?.tokenAmountAtomic ?? '',
      ).trim();
      const established = await stockSellTermsForV1({
        tokenAddress: claims.tokenAddress,
        walletAddress: user.address,
        tenantId: user.id,
        tokenAmountAtomic: raw,
        stage: 'confirm',
      });
      if (!established.ok) {
        res.status(established.status).json({
          error: established.code,
          code: established.code,
          detail: established.detail,
          ...(established.holding ? { holding: established.holding } : {}),
          confirmed: false,
          executableActionAvailable: false,
        });
        return;
      }
      if (established.terms.status === 'no_route') {
        // The routers answered, and none of them will sell this amount. A
        // market fact about this SIZE — never about the token, the direction
        // or the holder, and never a Miorail failure wearing the market's name.
        res.status(409).json({
          error: 'stock_action_sell_size_unroutable',
          code: 'stock_action_sell_size_unroutable',
          detail:
            'The reviewed routers were asked to sell this exact amount and none of them offered a route for it. That is a statement about this size right now — a smaller amount may route. Nothing was confirmed.',
          terms: stockSellTermsWireV1(established.terms),
          confirmed: false,
          executableActionAvailable: false,
        });
        return;
      }
      if (established.terms.status !== 'established') {
        // OURS. The measurement did not complete, so nothing is known about
        // this size, and an unknown must never be minted into authority.
        res.status(503).json({
          error: established.terms.code,
          code: established.terms.code,
          detail:
            'Miorail could not establish what the reviewed routers do at this exact amount, so it did not confirm a size. This is a statement about Miorail, never about the market. Nothing was confirmed; try again.',
          confirmed: false,
          executableActionAvailable: false,
        });
        return;
      }
      confirmedTokenAmountAtomic = raw;
      confirmedTerms = established.terms;
    }

    // The clearance is built from what was REBUILT, not from what the draft
    // remembered. What the person confirmed is what this server established
    // for them a moment ago.
    const issued = issueStockActionClearanceV1({
      tenantId: user.id,
      walletAddress: user.address,
      actionDraftId: claims.actionDraftId,
      handoff: rebuilt.handoff,
      confirmedTokenAmountAtomic,
      secret,
      now,
    });

    res.status(200).json({
      schemaVersion: 'stock-action-confirmation/v1',
      actionDraftId: claims.actionDraftId,
      clearanceId: issued.clearanceId,
      /**
       * The exact size this clearance authorises, echoed back.
       *
       * A SELL is in token atoms and a BUY in USDC atoms, and the basis says
       * which — so a reader can check that what was minted is what they
       * confirmed, rather than trust that it was.
       */
      confirmedSize: {
        sizeBasis: rebuilt.handoff.direction === 'sell' ? 'exact_token_in' : 'exact_cash_in',
        tokenAmountAtomic: confirmedTokenAmountAtomic,
        requestedCashAtomic: rebuilt.handoff.requestedCashAtomic,
      },
      /**
       * What the routers said about THIS amount, at the moment authority was
       * granted. Null on a BUY, which has no second size to establish.
       *
       * Recorded on the confirmation rather than merely consulted, for the same
       * reason `transferGate` is: a reader can check that the size they
       * approved is the size that was priced, instead of inferring it from the
       * absence of an error. It is evidence with its own expiry and it is not
       * spent as a route — the release step plans again.
       */
      confirmedTerms: confirmedTerms === null ? null : stockSellTermsWireV1(confirmedTerms),
      /** The credential the Connected surface needs to ask for the unsigned
       * request. It authorises ONE exact action and expires quickly. */
      clearance: issued.clearance,
      representation: {
        chainId: 8453,
        tokenAddress: rebuilt.handoff.tokenAddress,
        caip10: rebuilt.handoff.caip10,
        underlyingKey: rebuilt.handoff.underlyingKey,
        issuerId: rebuilt.handoff.issuerId,
        issuerInstrumentKey: rebuilt.handoff.issuerInstrumentKey,
        representationKind: rebuilt.handoff.representationKind,
      },
      question: {
        direction: rebuilt.handoff.direction,
        requestedCashAtomic: rebuilt.handoff.requestedCashAtomic,
        destination: 'USDC',
        sizeBasis: rebuilt.handoff.sizeBasis,
        routePolicyKey: rebuilt.handoff.routePolicyKey,
      },
      confirmed: true,
      /** What the issuer's registry said about THIS wallet at the moment
       * authority was granted. Recorded on the confirmation rather than merely
       * consulted, so "nothing refused" is a stated verdict with a block behind
       * it and not an inference from the absence of an error. */
      transferGate: gate,
      issuerNotice: STOCK_ISSUER_NOTICE_COPY_V1,
      /** Confirmation is not a wallet approval. Nothing here is executable, and
       * the unsigned request still has to be planned, simulated and passed
       * through the Safety Kernel before a wallet is ever asked. */
      approvalRequired: true,
      executableActionAvailable: false,
      createsApproval: false,
      createsCalldata: false,
      createsTransaction: false,
      expiresAt: issued.expiresAt,
      confirmedAt: now.toISOString(),
    });
  } catch {
    res.status(500).json({ error: 'market_reality_failed', code: 'market_reality_failed' });
  }
});
