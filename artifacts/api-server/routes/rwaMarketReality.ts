import { Router, type Request } from 'express';
import { client } from '@mioagent/db';
import {
  createDatabaseOfficialCashExitRepository,
  createDatabaseRepresentationRatioRepository,
  createDatabaseUnderlyingAssetRepository,
} from '@mioagent/route-storage';
import {
  MarketRealityResponseV1Schema,
  assembleMarketRealityV1,
} from '@mioagent/rwa-market-reality';
import type { TenantUser } from '../middleware/tenantAuth.js';
import { getMiorailProductMigrationFlags } from '../lib/productMigrationConfig.js';

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

export const rwaMarketRealityRuntime = {
  enabled: (env: NodeJS.ProcessEnv): boolean =>
    getMiorailProductMigrationFlags(env).routeIntelligenceV1,
  underlyings: () => createDatabaseUnderlyingAssetRepository(client),
  cashExit: () => createDatabaseOfficialCashExitRepository(client),
  ratios: () => createDatabaseRepresentationRatioRepository(client),
  now: () => new Date(),
  assemble: assembleMarketRealityV1,
  migrationAvailable: async (): Promise<boolean> => {
    const rows = await client`
      SELECT
        to_regclass('public.underlying_asset') AS underlying,
        to_regclass('public.representation_underlying') AS representations,
        to_regclass('public.official_cash_exit_runs') AS cash_exit,
        to_regclass('public.representation_ratio') AS ratios`;
    const row = rows[0];
    return Boolean(row?.underlying && row.representations && row.cash_exit && row.ratios);
  },
};

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
  const underlyingKey = String(req.params.underlyingKey ?? '');
  const direction = String(req.query.direction ?? '').toLowerCase();
  const requestedCashAtomic = String(req.query.requestedCashAtomic ?? '');
  const destination = String(req.query.destination ?? 'USDC').toUpperCase();
  if (!/^[a-z0-9_]+:[a-z0-9_]+:.+$/.test(underlyingKey)) {
    res.status(400).json({ error: 'invalid_underlying_key', code: 'invalid_underlying_key' });
    return;
  }
  if (!['buy', 'sell'].includes(direction) || !/^[1-9][0-9]*$/.test(requestedCashAtomic)) {
    res.status(400).json({
      error: 'invalid_market_reality_question',
      code: 'invalid_market_reality_question',
      detail: 'direction=buy|sell and an exact positive requestedCashAtomic are required.',
    });
    return;
  }
  if (!['USDC', 'ETH'].includes(destination)) {
    res.status(400).json({ error: 'invalid_destination', code: 'invalid_destination' });
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
        now: rwaMarketRealityRuntime.now,
      },
      {
        underlyingKey,
        direction: direction as 'buy' | 'sell',
        requestedCashAtomic,
        destination: destination as 'USDC' | 'ETH',
      },
    );
    res.status(200).json(MarketRealityResponseV1Schema.parse(result));
  } catch {
    res.status(500).json({ error: 'market_reality_failed', code: 'market_reality_failed' });
  }
});
