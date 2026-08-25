import { Router, type Request } from 'express';
import { OfficialAssetDossierResponseV1Schema } from '@mioagent/api-zod';
import { createB20ReaderV1 } from '@mioagent/b20-control';
import { client } from '@mioagent/db';
import {
  createDatabaseMarketTailRepository,
  createDatabaseOfficialAssetRepository,
} from '@mioagent/route-storage';
import { assembleOfficialAssetDossierV1 } from '@mioagent/rwa-dossier';
import { getMiorailProductMigrationFlags } from '../lib/productMigrationConfig.js';
// Loads the express-session augmentation as well as documenting which session
// identity this read-only evidence surface requires.
import type { TenantUser } from '../middleware/tenantAuth.js';

export const rwaDossierRouter = Router();

function rpcUrlV1(): string {
  return (process.env.BASE_MAINNET_RPC_URL || process.env.BASE_RPC_URL || '').trim();
}

export const rwaDossierRuntime = {
  enabled: (env: NodeJS.ProcessEnv): boolean => getMiorailProductMigrationFlags(env).routeIntelligenceV1,
  official: () => createDatabaseOfficialAssetRepository(client),
  marketTail: () => createDatabaseMarketTailRepository(client),
  reader: () => createB20ReaderV1({ rpcUrl: rpcUrlV1() }),
  now: () => new Date(),
  assemble: assembleOfficialAssetDossierV1,
  migrationAvailable: async (): Promise<boolean> => {
    const rows = await client`
      SELECT
        to_regclass('public.official_asset_sources') AS sources,
        to_regclass('public.official_assets') AS assets,
        to_regclass('public.market_venues') AS venues,
        to_regclass('public.market_venue_transfers') AS transfers,
        to_regclass('public.market_tail_cursors') AS cursors`;
    const row = rows[0];
    return Boolean(row?.sources && row.assets && row.venues && row.transfers && row.cursors);
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

rwaDossierRouter.get('/rwa/official/:tokenAddress/dossier', async (req, res) => {
  if (!rwaDossierRuntime.enabled(process.env)) {
    res.status(404).json({ error: 'route_intelligence_disabled', code: 'route_intelligence_disabled' });
    return;
  }
  if (!sessionUserV1(req)) {
    res.status(401).json({ error: 'authentication_required', code: 'authentication_required' });
    return;
  }
  const supplied = String(req.params.tokenAddress ?? '');
  if (!/^0x[0-9a-f]{40}$/i.test(supplied)) {
    res.status(400).json({
      error: 'invalid_official_asset_address',
      code: 'invalid_official_asset_address',
      detail: 'An exact Base contract address is required; symbols are display metadata only.',
    });
    return;
  }
  try {
    if (!(await rwaDossierRuntime.migrationAvailable())) {
      res.status(503).json({
        error: 'official_asset_dossier_storage_unavailable',
        code: 'official_asset_dossier_storage_unavailable',
      });
      return;
    }
    const result = await rwaDossierRuntime.assemble(
      {
        official: rwaDossierRuntime.official(),
        marketTail: rwaDossierRuntime.marketTail(),
        reader: rwaDossierRuntime.reader(),
        now: rwaDossierRuntime.now,
      },
      { chainId: 8453, tokenAddress: supplied.toLowerCase() },
    );
    const response = OfficialAssetDossierResponseV1Schema.parse(result);
    // Absence from the reviewed corpus is a typed evidence outcome, not a
    // transport failure. The clients must be able to render that distinction.
    res.status(200).json(response);
  } catch {
    // Provider and database details can contain connection material. The API
    // exposes only a stable refusal and never forwards the upstream message.
    res.status(500).json({ error: 'official_asset_dossier_failed', code: 'official_asset_dossier_failed' });
  }
});
