import { Router } from 'express';
import { MemoryService } from '@mioagent/memory';
import {
  AutonomyStateResponseSchema,
  ConfigureAutonomyRequestSchema,
  ConfigureAutonomyResponseSchema,
  KillAutonomyResponseSchema,
} from '@mioagent/api-zod';

export const autonomyRouter = Router();

async function getAutonomyState(userId: string) {
  const settings = await MemoryService.getUserSettings(userId);
  const autonomy = (settings?.protocolToggles as any)?.autonomy || {};

  const isConfigured = autonomy.status === 'configured' || !!autonomy.dailyLimitUsdc;
  const isKillSwitch = autonomy.killSwitch === true;

  const status = isKillSwitch ? 'inactive' : (isConfigured ? 'active' : 'unconfigured');
  const sessionKeyStatus = isKillSwitch ? 'inactive' : (isConfigured ? 'configured' : 'unconfigured');

  return {
    status,
    sessionKey: {
      status: sessionKeyStatus,
      dailyLimitUsdc: autonomy.dailyLimitUsdc || null,
      spentTodayUsdc: autonomy.spentTodayUsdc || '0',
      maxPerActionUsdc: autonomy.maxPerActionUsdc || null,
      ttlSeconds: autonomy.ttlSeconds || null,
      expiresAt: autonomy.expiresAt || null,
      whitelist: autonomy.whitelist || [],
      scope: autonomy.scope || 'none',
      killSwitch: isKillSwitch,
    },
    autonomy: {
      dailySpendLimit: autonomy.dailyLimitUsdc || null,
      maxActionSpend: autonomy.maxPerActionUsdc || null,
      whitelistedProtocolsCount: (autonomy.whitelist || []).length,
      mode: process.env.CHAIN_ENV || 'mainnet-readonly',
    },
  };
}

autonomyRouter.get('/', async (req, res, next) => {
  try {
    const userId = (req as { session?: { user?: { id?: string } } }).session?.user?.id || 'default-user';
    const state = await getAutonomyState(userId);
    res.json(AutonomyStateResponseSchema.parse(state));
  } catch (error) {
    next(error);
  }
});

autonomyRouter.post('/config', async (req, res, next) => {
  try {
    const userId = (req as { session?: { user?: { id?: string } } }).session?.user?.id || 'default-user';
    const data = ConfigureAutonomyRequestSchema.parse(req.body);

    const settings = await MemoryService.getUserSettings(userId);
    const existingToggles = (settings?.protocolToggles as any) || {};
    const existingAutonomy = existingToggles.autonomy || {};

    const newAutonomy = {
      ...existingAutonomy,
      status: 'configured',
      killSwitch: false,
      dailyLimitUsdc: data.dailyLimitUsdc !== undefined ? data.dailyLimitUsdc : (existingAutonomy.dailyLimitUsdc || '100'),
      maxPerActionUsdc: data.maxPerActionUsdc !== undefined ? data.maxPerActionUsdc : (existingAutonomy.maxPerActionUsdc || '10'),
      whitelist: data.whitelist !== undefined ? data.whitelist : (existingAutonomy.whitelist || ['0x036cbd53842c5426634e7929541ec2318f3dcf7e']),
      scope: data.scope !== undefined ? data.scope : (existingAutonomy.scope || 'Yield + Rebalance'),
      ttlSeconds: data.ttlSeconds !== undefined ? data.ttlSeconds : (existingAutonomy.ttlSeconds || 86400),
      expiresAt: new Date(Date.now() + (data.ttlSeconds || 86400) * 1000).toISOString(),
    };

    const newToggles = {
      ...existingToggles,
      autonomy: newAutonomy,
    };

    await MemoryService.updateUserSettings(userId, { protocolToggles: newToggles });
    const state = await getAutonomyState(userId);
    res.json(ConfigureAutonomyResponseSchema.parse({ success: true, state }));
  } catch (error) {
    next(error);
  }
});

autonomyRouter.post('/kill', async (req, res, next) => {
  try {
    const userId = (req as { session?: { user?: { id?: string } } }).session?.user?.id || 'default-user';
    const settings = await MemoryService.getUserSettings(userId);
    const existingToggles = (settings?.protocolToggles as any) || {};
    const existingAutonomy = existingToggles.autonomy || {};

    const newAutonomy = {
      ...existingAutonomy,
      killSwitch: true,
      status: 'inactive',
    };

    const newToggles = {
      ...existingToggles,
      autonomy: newAutonomy,
    };

    await MemoryService.updateUserSettings(userId, { protocolToggles: newToggles });
    const state = await getAutonomyState(userId);
    res.json(KillAutonomyResponseSchema.parse({ success: true, state }));
  } catch (error) {
    next(error);
  }
});
