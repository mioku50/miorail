import { Router, type Request } from 'express';
import { OfficialAssetDossierResponseV1Schema } from '@mioagent/api-zod';
import { createB20ReaderV1 } from '@mioagent/b20-control';
import { client } from '@mioagent/db';
import {
  createDatabaseMarketTailRepository,
  createDatabaseOfficialCashExitRepository,
  createDatabaseOfficialAssetRepository,
  isOfficialV1,
} from '@mioagent/route-storage';
import { measureOfficialCashExitV1 } from '@mioagent/rwa-cash-exit';
import { assembleOfficialAssetDossierV1 } from '@mioagent/rwa-dossier';
import { KyberSwapRouteAdapter } from '@mioagent/swap-adapters';
import { decodeFunctionResult, encodeFunctionData } from 'viem';
import { getMiorailProductMigrationFlags } from '../lib/productMigrationConfig.js';
// Loads the express-session augmentation as well as documenting which session
// identity this read-only evidence surface requires.
import type { TenantUser } from '../middleware/tenantAuth.js';

export const rwaDossierRouter = Router();

function rpcUrlV1(): string {
  return (process.env.BASE_MAINNET_RPC_URL || process.env.BASE_RPC_URL || '').trim();
}

export const rwaDossierRuntime = {
  enabled: (env: NodeJS.ProcessEnv): boolean =>
    getMiorailProductMigrationFlags(env).routeIntelligenceV1,
  official: () => createDatabaseOfficialAssetRepository(client),
  marketTail: () => createDatabaseMarketTailRepository(client),
  cashExit: () => createDatabaseOfficialCashExitRepository(client),
  quoteAdapters: () => [new KyberSwapRouteAdapter()],
  measure: measureOfficialCashExitV1,
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
        to_regclass('public.market_tail_cursors') AS cursors,
        to_regclass('public.official_cash_exit_runs') AS cash_exit`;
    const row = rows[0];
    return Boolean(
      row?.sources && row.assets && row.venues && row.transfers && row.cursors && row.cash_exit,
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

rwaDossierRouter.get('/rwa/official/:tokenAddress/dossier', async (req, res) => {
  if (!rwaDossierRuntime.enabled(process.env)) {
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
        cashExit: rwaDossierRuntime.cashExit(),
        reader: rwaDossierRuntime.reader(),
        now: rwaDossierRuntime.now,
        tenantId: user.id,
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
    res
      .status(500)
      .json({ error: 'official_asset_dossier_failed', code: 'official_asset_dossier_failed' });
  }
});

const ERC20_BALANCE_ABI_V1 = [
  {
    type: 'function',
    name: 'decimals',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint8' }],
  },
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

rwaDossierRouter.post('/rwa/official/:tokenAddress/dossier/measure', async (req, res) => {
  if (!rwaDossierRuntime.enabled(process.env)) {
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
    res
      .status(400)
      .json({ error: 'invalid_official_asset_address', code: 'invalid_official_asset_address' });
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
    const reader = rwaDossierRuntime.reader();
    const cashExit = rwaDossierRuntime.cashExit();
    const official = rwaDossierRuntime.official();
    const deps = {
      official,
      marketTail: rwaDossierRuntime.marketTail(),
      cashExit,
      reader,
      now: rwaDossierRuntime.now,
      tenantId: user.id,
    };
    const identity = await official.officialIdentity({ chainId: 8453, tokenAddress });
    if (!isOfficialV1(identity)) {
      res.status(200).json(
        OfficialAssetDossierResponseV1Schema.parse({
          outcome: 'not_in_reviewed_corpus',
          chainId: 8453,
          tokenAddress,
          detail:
            'No currently listed reviewed source snapshot establishes this exact address as official.',
        }),
      );
      return;
    }
    const anchor = await reader.readBlockAnchor();
    if (!anchor.ok) {
      res.status(503).json({
        error: 'cash_exit_token_decimals_unavailable',
        code: 'cash_exit_token_decimals_unavailable',
      });
      return;
    }
    const decimalsRaw = await reader.call({
      to: tokenAddress,
      data: encodeFunctionData({ abi: ERC20_BALANCE_ABI_V1, functionName: 'decimals' }),
      blockTag: anchor.value.blockTag,
    });
    if (!decimalsRaw.ok) {
      res.status(503).json({
        error: 'cash_exit_token_decimals_unavailable',
        code: 'cash_exit_token_decimals_unavailable',
      });
      return;
    }
    const decimals = Number(
      decodeFunctionResult({
        abi: ERC20_BALANCE_ABI_V1,
        functionName: 'decimals',
        data: decimalsRaw.value as `0x${string}`,
      }),
    );
    const listing =
      identity!.listings.find((item) => item.currentlyListed) ?? identity!.listings[0]!;
    const adapters = rwaDossierRuntime.quoteAdapters();
    await rwaDossierRuntime.measure({
      repository: cashExit,
      adapters,
      token: { address: tokenAddress as `0x${string}`, symbol: listing.ticker, decimals },
      walletAddress: user.address as `0x${string}`,
      tenantId: user.id,
      scope: 'public_ladder',
      now: rwaDossierRuntime.now,
    });

    if (anchor.ok) {
      const raw = await reader.call({
        to: tokenAddress,
        data: encodeFunctionData({
          abi: ERC20_BALANCE_ABI_V1,
          functionName: 'balanceOf',
          args: [user.address as `0x${string}`],
        }),
        blockTag: anchor.value.blockTag,
      });
      if (raw.ok) {
        const balance = decodeFunctionResult({
          abi: ERC20_BALANCE_ABI_V1,
          functionName: 'balanceOf',
          data: raw.value as `0x${string}`,
        });
        if (balance > 0n) {
          await rwaDossierRuntime.measure({
            repository: cashExit,
            adapters,
            token: { address: tokenAddress as `0x${string}`, symbol: listing.ticker, decimals },
            walletAddress: user.address as `0x${string}`,
            tenantId: user.id,
            scope: 'tenant_position',
            positionTokenAtomic: balance.toString(),
            now: rwaDossierRuntime.now,
          });
        }
      }
    }
    const after = await rwaDossierRuntime.assemble(deps, { chainId: 8453, tokenAddress });
    res.status(200).json(OfficialAssetDossierResponseV1Schema.parse(after));
  } catch {
    res.status(500).json({
      error: 'official_cash_exit_measurement_failed',
      code: 'official_cash_exit_measurement_failed',
    });
  }
});
