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
  const source = isConfigured ? 'memory' : 'missing';

  return {
    status,
    source,
    sessionKey: {
      status: sessionKeyStatus,
      source,
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
      source,
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
    const parsed = ConfigureAutonomyRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid autonomy configuration payload', details: parsed.error });
    }
    const data = parsed.data;

    const settings = await MemoryService.getUserSettings(userId);
    const existingToggles = (settings?.protocolToggles as any) || {};
    const existingAutonomy = existingToggles.autonomy || {};

    const newAutonomy = {
      ...existingAutonomy,
      status: 'configured',
      killSwitch: false,
      dailyLimitUsdc: data.dailyLimitUsdc,
      maxPerActionUsdc: data.maxPerActionUsdc,
      whitelist: data.whitelist,
      scope: data.scope || existingAutonomy.scope || 'Yield + Rebalance',
      ttlSeconds: data.ttlSeconds,
      expiresAt: new Date(Date.now() + data.ttlSeconds * 1000).toISOString(),
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

autonomyRouter.post('/reset', async (req, res, next) => {
  try {
    const userId = (req as { session?: { user?: { id?: string } } }).session?.user?.id || 'default-user';
    const settings = await MemoryService.getUserSettings(userId);
    const existingToggles = (settings?.protocolToggles as any) || {};

    const newToggles = {
      ...existingToggles,
      autonomy: {
        status: 'unconfigured',
        killSwitch: false,
      },
    };

    await MemoryService.updateUserSettings(userId, { protocolToggles: newToggles });
    const state = await getAutonomyState(userId);
    res.json(KillAutonomyResponseSchema.parse({ success: true, state }));
  } catch (error) {
    next(error);
  }
});
