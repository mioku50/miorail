import { Router, type Request, type Response } from 'express';
import { createB20ReaderV1 } from '@mioagent/b20-control';
import { client } from '@mioagent/db';
import {
  createDatabaseMarketTailRepository,
  createDatabaseOfficialAssetRepository,
  createDatabaseOfficialCashExitRepository,
  createDatabaseOfficialLookalikeRepository,
  createDatabaseB20CorporateActionRepository,
  createDatabaseRwaSignalRepository,
  LOOKALIKE_ALIAS_KINDS_V1,
  type LookalikeAliasKindV1,
} from '@mioagent/route-storage';
import {
  assembleOfficialAssetsOverviewV1,
  assembleOfficialLookalikeFeedV1,
  assembleRwaSignalFeedV1,
  OfficialAssetsOverviewV1Schema,
  OfficialLookalikeFeedV1Schema,
  RwaSignalFeedV1Schema,
  type OfficialDiscoverDepsV1,
} from '@mioagent/rwa-dossier';
import { getMiorailProductMigrationFlags } from '../lib/productMigrationConfig.js';
import type { TenantUser } from '../middleware/tenantAuth.js';

// ---------------------------------------------------------------------------
// Phase 6 — the three Discover reads.
//
// Read-only, and structurally so: none of these handlers can create a
// clearance, prepare a plan, reach a wallet or write a row. The measurement
// that fills them is a worker's job, and the one endpoint here that touches
// the chain reads a price feed at an anchored block.
//
// Every failure answers with a stable code and never the upstream message: a
// provider error can carry an endpoint and an endpoint can carry a key.
// ---------------------------------------------------------------------------

export const rwaDiscoverRouter = Router();

function rpcUrlV1(): string {
  return (process.env.BASE_MAINNET_RPC_URL || process.env.BASE_RPC_URL || '').trim();
}

export const rwaDiscoverRuntime = {
  enabled: (env: NodeJS.ProcessEnv): boolean =>
    getMiorailProductMigrationFlags(env).routeIntelligenceV1,
  deps: (): OfficialDiscoverDepsV1 => ({
    official: createDatabaseOfficialAssetRepository(client),
    cashExit: createDatabaseOfficialCashExitRepository(client),
    marketTail: createDatabaseMarketTailRepository(client),
    lookalikes: createDatabaseOfficialLookalikeRepository(client),
    signals: createDatabaseRwaSignalRepository(client),
    corporateActions: createDatabaseB20CorporateActionRepository(client),
    reader: createB20ReaderV1({ rpcUrl: rpcUrlV1() }),
    now: () => new Date(),
  }),
  overview: assembleOfficialAssetsOverviewV1,
  lookalikes: assembleOfficialLookalikeFeedV1,
  signals: assembleRwaSignalFeedV1,
  migrationAvailable: async (): Promise<boolean> => {
    const rows = await client`
      SELECT
        to_regclass('public.official_asset_sources') AS sources,
        to_regclass('public.official_assets') AS assets,
        to_regclass('public.official_cash_exit_runs') AS cash_exit,
        to_regclass('public.official_asset_lookalikes') AS lookalikes,
        to_regclass('public.market_venues') AS venues,
        to_regclass('public.market_tail_cursors') AS cursors,
        to_regclass('public.rwa_signals') AS signals,
        to_regclass('public.rwa_signal_watch') AS watch,
        to_regclass('public.b20_corporate_actions') AS corporate_actions`;
    const row = rows[0];
    return Boolean(
      row?.sources &&
        row.assets &&
        row.cash_exit &&
        row.lookalikes &&
        row.venues &&
        row.cursors &&
        row.signals &&
        row.watch &&
        // Listed here rather than defended at the read: the signal feed asks
        // this table what range the corporate-action record covers, and a
        // surface that answered without it would print a watch date over a
        // record it could not see. The migration goes on before the deploy.
        row.corporate_actions,
    );
  },
};

function sessionUserV1(req: Request): TenantUser | null {
  const user = req.session?.user;
  if (
    !user ||
    user.chainId !== 8453 ||
    !/^0x[0-9a-f]{40}$/.test(user.address) ||
    user.id !== `eip155:8453:${user.address}`
  ) {
    return null;
  }
  return user;
}

/** The three checks every Discover read shares. Returns false once it has
 * already answered. */
async function discoverGuardV1(req: Request, res: Response): Promise<boolean> {
  if (!rwaDiscoverRuntime.enabled(process.env)) {
    res
      .status(404)
      .json({ error: 'route_intelligence_disabled', code: 'route_intelligence_disabled' });
    return false;
  }
  if (!sessionUserV1(req)) {
    res.status(401).json({ error: 'authentication_required', code: 'authentication_required' });
    return false;
  }
  if (!(await rwaDiscoverRuntime.migrationAvailable())) {
    res
      .status(503)
      .json({ error: 'rwa_discover_storage_unavailable', code: 'rwa_discover_storage_unavailable' });
    return false;
  }
  return true;
}

function boundedLimitV1(raw: unknown, fallback: number, max: number): number {
  const value = Number.parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(max, value));
}

rwaDiscoverRouter.get('/rwa/official/assets', async (req, res) => {
  if (!(await discoverGuardV1(req, res))) return;
  try {
    const overview = await rwaDiscoverRuntime.overview(rwaDiscoverRuntime.deps(), {
      limit: boundedLimitV1(req.query.limit, 64, 64),
    });
    res.status(200).json(OfficialAssetsOverviewV1Schema.parse(overview));
  } catch {
    res
      .status(500)
      .json({ error: 'official_assets_overview_failed', code: 'official_assets_overview_failed' });
  }
});

rwaDiscoverRouter.get('/rwa/lookalikes', async (req, res) => {
  if (!(await discoverGuardV1(req, res))) return;
  const aliasRaw = req.query.alias === undefined ? null : String(req.query.alias);
  // Refused rather than ignored. Silently serving all 112 for a filter the
  // caller believed in would put "Published ticker" above 95 contracts wearing
  // an ordinary English word.
  if (aliasRaw !== null && !(LOOKALIKE_ALIAS_KINDS_V1 as readonly string[]).includes(aliasRaw)) {
    res.status(400).json({ error: 'unknown_alias_filter', code: 'unknown_alias_filter' });
    return;
  }
  try {
    const feed = await rwaDiscoverRuntime.lookalikes(rwaDiscoverRuntime.deps(), {
      matchedAlias: aliasRaw as LookalikeAliasKindV1 | null,
      limit: boundedLimitV1(req.query.limit, 50, 200),
    });
    res.status(200).json(OfficialLookalikeFeedV1Schema.parse(feed));
  } catch {
    res
      .status(500)
      .json({ error: 'official_lookalike_feed_failed', code: 'official_lookalike_feed_failed' });
  }
});

rwaDiscoverRouter.get('/rwa/signals', async (req, res) => {
  if (!(await discoverGuardV1(req, res))) return;
  try {
    const feed = await rwaDiscoverRuntime.signals(rwaDiscoverRuntime.deps(), {
      limit: boundedLimitV1(req.query.limit, 50, 200),
    });
    res.status(200).json(RwaSignalFeedV1Schema.parse(feed));
  } catch {
    res.status(500).json({ error: 'rwa_signal_feed_failed', code: 'rwa_signal_feed_failed' });
  }
});
