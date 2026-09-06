import { Router, type Request, type Response } from 'express';
import { createB20ReaderV1 } from '@mioagent/b20-control';
import { client } from '@mioagent/db';
import { b20SenderRelationV1 } from '@mioagent/opportunity-rail/launchContext';
import {
  createDatabaseB20LaunchDeployerRepository,
  createDatabaseB20ObservationRepository,
  createDatabaseB20ProjectRepository,
  createDatabaseMarketTailRepository,
  createDatabaseOfficialAssetRepository,
  createDatabaseOfficialCashExitRepository,
  createDatabaseOfficialLookalikeRepository,
} from '@mioagent/route-storage';
import {
  assembleAddressDossierV1,
  AddressDossierV1Schema,
  type AddressDossierV1,
  type AddressDossierDepsV1,
} from '@mioagent/rwa-dossier';
import { getMiorailProductMigrationFlags } from '../lib/productMigrationConfig.js';
import type { TenantUser } from '../middleware/tenantAuth.js';

// ---------------------------------------------------------------------------
// Phase 7 — one pasted address, read as deeply as the evidence allows.
//
// Read-only, and structurally so: no clearance, no plan, no wallet, no write.
// The chain reads it does make are a block anchor, the token's controls and —
// for an officially listed address only — its reference feed.
//
// The address is taken from the PATH and validated as an address. There is no
// symbol lookup anywhere on this route, because a symbol is exactly what an
// impostor supplies: 61.7% of indexed launches share one with another launch.
// ---------------------------------------------------------------------------

export const rwaInvestigateRouter = Router();

function rpcUrlV1(): string {
  return (process.env.BASE_MAINNET_RPC_URL || process.env.BASE_RPC_URL || '').trim();
}

export const rwaInvestigateRuntime = {
  enabled: (env: NodeJS.ProcessEnv): boolean =>
    getMiorailProductMigrationFlags(env).routeIntelligenceV1,
  deps: (): AddressDossierDepsV1 => {
    const observations = createDatabaseB20ObservationRepository(client);
    const deployers = createDatabaseB20LaunchDeployerRepository(client);
    const projects = createDatabaseB20ProjectRepository(client);
    return {
      official: createDatabaseOfficialAssetRepository(client),
      cashExit: createDatabaseOfficialCashExitRepository(client),
      marketTail: createDatabaseMarketTailRepository(client),
      lookalikes: createDatabaseOfficialLookalikeRepository(client),
      launches: observations,
      projects,
      deployers: {
        // The relation is classified HERE, with the one function that owns that
        // rule, and the dossier owns the redaction. A second copy of the rule
        // would drift towards the permissive reading, and the permissive
        // reading files one project's launch under a bundler's address.
        readDeployer: async (launchId) => {
          const row = await deployers.readDeployer(launchId);
          if (row === null) return null;
          return {
            deployerAddress: row.deployerAddress,
            relation: b20SenderRelationV1(row.transactionTo),
            readAt: row.readAt,
          };
        },
      },
      reader: createB20ReaderV1({ rpcUrl: rpcUrlV1() }),
      now: () => new Date(),
    };
  },
  assemble: assembleAddressDossierV1,
  migrationAvailable: async (): Promise<boolean> => {
    const rows = await client`
      SELECT
        to_regclass('public.official_assets') AS assets,
        to_regclass('public.official_cash_exit_runs') AS cash_exit,
        to_regclass('public.official_asset_lookalikes') AS lookalikes,
        to_regclass('public.market_venues') AS venues,
        to_regclass('public.market_tail_cursors') AS cursors`;
    const row = rows[0];
    return Boolean(row?.assets && row.cash_exit && row.lookalikes && row.venues && row.cursors);
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

/**
 * The same dossier the Investigate screen reads, for the paid agent surface.
 *
 * Exported rather than re-derived: an agent buying an identity check must get
 * the answer this product already computes, not a second opinion assembled
 * beside it. Null only when the address is malformed or the evidence tables
 * are not migrated — an address nothing knows still returns a dossier, because
 * "no reviewed source lists it" is the answer and the most common one.
 */
export async function readAddressDossierForX402V1(
  tokenAddress: string,
): Promise<AddressDossierV1 | null> {
  if (!/^0x[0-9a-f]{40}$/.test(tokenAddress)) return null;
  if (!(await rwaInvestigateRuntime.migrationAvailable())) return null;
  return rwaInvestigateRuntime.assemble(rwaInvestigateRuntime.deps(), {
    chainId: 8453,
    tokenAddress,
  });
}

rwaInvestigateRouter.get('/rwa/investigate/:tokenAddress', async (req: Request, res: Response) => {
  if (!rwaInvestigateRuntime.enabled(process.env)) {
    res
      .status(404)
      .json({ error: 'route_intelligence_disabled', code: 'route_intelligence_disabled' });
    return;
  }
  if (!sessionUserV1(req)) {
    res.status(401).json({ error: 'authentication_required', code: 'authentication_required' });
    return;
  }
  const supplied = String(req.params.tokenAddress ?? '');
  // Decided with no network access at all, so a malformed input never becomes
  // a chain read — and a ticker is refused rather than resolved.
  if (!/^0x[0-9a-f]{40}$/i.test(supplied)) {
    res.status(400).json({
      error: 'invalid_token_address',
      code: 'invalid_token_address',
      detail:
        'An exact Base contract address is required. A symbol identifies nothing: most indexed launches share one with another launch.',
    });
    return;
  }
  try {
    if (!(await rwaInvestigateRuntime.migrationAvailable())) {
      res
        .status(503)
        .json({ error: 'address_dossier_storage_unavailable', code: 'address_dossier_storage_unavailable' });
      return;
    }
    const dossier = await rwaInvestigateRuntime.assemble(rwaInvestigateRuntime.deps(), {
      chainId: 8453,
      tokenAddress: supplied.toLowerCase(),
    });
    // An address nothing knows is a DOSSIER, not a 404: "no reviewed source
    // lists it and our index has never seen it" is the answer, and the most
    // common one.
    res.status(200).json(AddressDossierV1Schema.parse(dossier));
  } catch {
    // Provider and database details can carry connection material. The route
    // exposes a stable refusal and never forwards the upstream message.
    res.status(500).json({ error: 'address_dossier_failed', code: 'address_dossier_failed' });
  }
});
