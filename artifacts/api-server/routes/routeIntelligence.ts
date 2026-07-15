import { Router, type Request } from 'express';
import { RoutePlanRequestV1Schema, RoutePlanResponseV1Schema } from '@mioagent/api-zod';
import { createLlmProvider } from '@mioagent/llm';
import { createSwapRouteEngine } from '@mioagent/route-engine';
import { createDatabaseRouteStorageRepository } from '@mioagent/route-storage';
import { KyberSwapRouteAdapter, UniswapSwapRouteAdapter } from '@mioagent/swap-adapters';
import { client } from '@mioagent/db';
import { getMiorailProductMigrationFlags } from '../lib/productMigrationConfig.js';
import { RoutePlanCoordinator, type RoutePlanCoordinatorInput } from '../lib/routePlanCoordinator.js';

function signedRoutePlanUser(req: Request) {
  const user = req.session?.user;
  if (
    !user ||
    user.chainId !== 8453 ||
    !/^0x[0-9a-f]{40}$/.test(user.address) ||
    user.id !== `eip155:8453:${user.address}`
  ) return null;
  return user;
}

async function routeStorageMigrationAvailable(): Promise<boolean> {
  const rows = await client`
    SELECT
      to_regclass('public.route_runs') AS route_runs,
      to_regclass('public.route_candidates') AS route_candidates,
      to_regclass('public.route_evidence') AS route_evidence,
      to_regclass('public.route_evidence_sets') AS route_evidence_sets,
      to_regclass('public.route_score_snapshots') AS route_score_snapshots,
      to_regclass('public.route_cards') AS route_cards
  `;
  const row = rows[0];
  return Boolean(
    row &&
    row.route_runs &&
    row.route_candidates &&
    row.route_evidence &&
    row.route_evidence_sets &&
    row.route_score_snapshots &&
    row.route_cards
  );
}

export const routePlanRouteRuntime = {
  flags: getMiorailProductMigrationFlags,
  migrationAvailable: routeStorageMigrationAvailable,
  coordinate: async (input: RoutePlanCoordinatorInput) => {
    const coordinator = new RoutePlanCoordinator({
      llm: createLlmProvider(),
      engine: createSwapRouteEngine(),
      adapters: [new UniswapSwapRouteAdapter(), new KyberSwapRouteAdapter()],
      repository: createDatabaseRouteStorageRepository(client),
    });
    return coordinator.evaluate(input);
  },
  now: () => new Date(),
};

export const routeIntelligenceRouter = Router();

routeIntelligenceRouter.post('/swap/evaluate', async (req, res) => {
  const flags = routePlanRouteRuntime.flags(process.env);
  if (!flags.routeIntelligenceV1) {
    res.status(404).json({ error: 'route_intelligence_disabled', code: 'route_intelligence_disabled' });
    return;
  }
  const user = signedRoutePlanUser(req);
  if (!user) {
    res.status(401).json({ error: 'authentication_required', code: 'authentication_required' });
    return;
  }
  const parsed = RoutePlanRequestV1Schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_route_plan_request', code: 'invalid_route_plan_request' });
    return;
  }
  if (parsed.data.walletAddress !== user.address) {
    res.status(403).json({ error: 'wallet_mismatch', code: 'wallet_mismatch' });
    return;
  }
  const chainEnv = (process.env.CHAIN_ENV ?? 'sepolia').trim().toLowerCase();
  if (chainEnv !== 'mainnet' && chainEnv !== 'mainnet-readonly') {
    res.status(409).json({ error: 'base_mainnet_required', code: 'base_mainnet_required' });
    return;
  }
  try {
    if (!(await routePlanRouteRuntime.migrationAvailable())) {
      res.status(503).json({ error: 'route_storage_unavailable', code: 'route_storage_unavailable' });
      return;
    }
    const response = await routePlanRouteRuntime.coordinate({
      tenantId: user.id,
      walletAddress: user.address,
      message: parsed.data.message,
      requestId: parsed.data.requestId,
      now: routePlanRouteRuntime.now(),
    });
    res.json(RoutePlanResponseV1Schema.parse(response));
  } catch {
    res.status(500).json({ error: 'route_plan_evaluation_failed', code: 'route_plan_evaluation_failed' });
  }
});
