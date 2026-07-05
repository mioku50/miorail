import { Router } from 'express';
import { MemoryService } from '@mioagent/memory';
import {
  AutonomyStateResponseSchema,
  ConfigureAutonomyRequestSchema,
  ConfigureAutonomyResponseSchema,
  KillAutonomyResponseSchema,
  TestnetConfigureAutonomyRequestSchema,
  TestnetRevokeAutonomyRequestSchema,
  TestnetExecuteActionRequestSchema,
} from '@mioagent/api-zod';
import {
  isTestnetAutonomyEnabled,
  getBaseSepoliaControllerAddress,
  getBaseSepoliaUsdcAddress,
  readOnchainPermission,
  executeTestnetConfigureOnchain,
  executeTestnetRevokeOnchain,
  executeTestnetSpendOnchain,
} from '../lib/testnetAutonomy.js';
import { formatUnits, type Hex } from 'viem';

export const autonomyRouter = Router();

async function getAutonomyState(userId: string, query?: { owner?: string; executor?: string; token?: string }) {
  const settings = await MemoryService.getUserSettings(userId);
  const autonomy = (settings?.protocolToggles as any)?.autonomy || {};

  const isConfigured = autonomy.status === 'configured' || !!autonomy.dailyLimitUsdc;
  const isKillSwitch = autonomy.killSwitch === true;

  let status: 'active' | 'inactive' | 'unconfigured' | 'configured' | 'revoked' | 'expired' = (isKillSwitch || autonomy.status === 'revoked') ? 'revoked' : (isConfigured ? 'active' : 'unconfigured');
  let sessionKeyStatus: 'configured' | 'unconfigured' | 'inactive' | 'revoked' | 'expired' | 'active' = (isKillSwitch || autonomy.status === 'revoked') ? 'revoked' : (isConfigured ? 'configured' : 'unconfigured');
  let source: 'memory' | 'onchain' | 'base-sepolia-contract' | 'missing' = isConfigured ? 'memory' : 'missing';

  let chainId: number | undefined;
  let contractAddress: string | null | undefined;
  let owner: string | null = autonomy.owner || query?.owner || null;
  let executor: string | null = autonomy.executor || query?.executor || null;
  let token: string | null = autonomy.token || query?.token || null;
  let validUntil: number | string | null = autonomy.expiresAt || null;
  let dailyLimitUsdc = autonomy.dailyLimitUsdc || null;
  let spentTodayUsdc = autonomy.spentTodayUsdc || '0';
  let maxPerActionUsdc = autonomy.maxPerActionUsdc || null;
  let ttlSeconds = autonomy.ttlSeconds || null;
  let whitelist: string[] = autonomy.whitelist || [];
  let scope = autonomy.scope || 'none';
  let txHashLastConfigured = autonomy.txHashLastConfigured || null;
  let txHashLastRevoked = autonomy.txHashLastRevoked || null;

  if (isTestnetAutonomyEnabled()) {
    contractAddress = getBaseSepoliaControllerAddress();
    if (!contractAddress) {
      if (!isKillSwitch && autonomy.status !== 'revoked') {
        status = 'unconfigured';
        sessionKeyStatus = 'unconfigured';
        source = 'missing';
      }
    } else {
      chainId = 84532;
      const queryOwner = query?.owner || owner;
      const queryExecutor = query?.executor || executor;
      const queryToken = query?.token || token || getBaseSepoliaUsdcAddress();

      if (queryOwner && queryExecutor && queryOwner.startsWith('0x') && queryExecutor.startsWith('0x')) {
        const onchainPerm = await readOnchainPermission(queryOwner as Hex, queryExecutor as Hex, queryToken as Hex);
        if (onchainPerm) {
          source = 'base-sepolia-contract';
          owner = onchainPerm.owner;
          executor = onchainPerm.executor;
          token = onchainPerm.token;
          dailyLimitUsdc = formatUnits(onchainPerm.dailyLimit, 6);
          maxPerActionUsdc = formatUnits(onchainPerm.maxPerAction, 6);
          spentTodayUsdc = formatUnits(onchainPerm.spentToday, 6);
          validUntil = Number(onchainPerm.validUntil);
          whitelist = [...onchainPerm.whitelist];

          const isExpired = Number(onchainPerm.validUntil) < Math.floor(Date.now() / 1000);
          if (onchainPerm.revoked) {
            status = 'revoked';
            sessionKeyStatus = 'revoked';
          } else if (isExpired) {
            status = 'expired';
            sessionKeyStatus = 'expired';
          } else {
            status = 'configured';
            sessionKeyStatus = 'configured';
          }
        } else if (isKillSwitch || autonomy.status === 'revoked') {
          status = 'revoked';
          sessionKeyStatus = 'revoked';
          source = 'memory';
        } else if (!isConfigured) {
          status = 'unconfigured';
          sessionKeyStatus = 'unconfigured';
          source = 'missing';
        }
      } else if (isKillSwitch || autonomy.status === 'revoked') {
        status = 'revoked';
        sessionKeyStatus = 'revoked';
        source = 'memory';
      } else if (!isConfigured) {
        status = 'unconfigured';
        sessionKeyStatus = 'unconfigured';
        source = 'missing';
      }
    }
  }

  const isDummyAddr = (val?: string | null) => {
    if (!val) return false;
    const v = val.toLowerCase();
    return v === '0x1111111111111111111111111111111111111111' ||
           v === '0x2222222222222222222222222222222222222222' ||
           v.startsWith('0x1111') || v.startsWith('0x2222');
  };
  const isFakeHash = (val?: string | null) => {
    if (!val) return false;
    const v = val.toLowerCase();
    return v.startsWith('0xmock') || v.startsWith('0xfake') ||
           v.includes('mock') || v.includes('fake') || isDummyAddr(val);
  };
  const isStaleTestMemory = source === 'memory' && (
    isDummyAddr(owner) || isDummyAddr(executor) ||
    isFakeHash(txHashLastConfigured) || isFakeHash(txHashLastRevoked) ||
    isDummyAddr(autonomy.owner) || isDummyAddr(autonomy.executor) ||
    isFakeHash(autonomy.txHashLastConfigured) || isFakeHash(autonomy.txHashLastRevoked)
  );

  if (isStaleTestMemory) {
    status = 'unconfigured';
    sessionKeyStatus = 'unconfigured';
  }

  return {
    status,
    source,
    isStaleTestMemory,
    chainId,
    contractAddress,
    sessionKey: {
      status: sessionKeyStatus,
      source,
      isStaleTestMemory,
      dailyLimitUsdc,
      spentTodayUsdc,
      maxPerActionUsdc,
      ttlSeconds,
      expiresAt: autonomy.expiresAt || null,
      whitelist,
      scope,
      killSwitch: isKillSwitch || status === 'revoked',
      owner,
      executor,
      token,
      validUntil,
      txHashLastConfigured,
      txHashLastRevoked,
    },
    autonomy: {
      dailySpendLimit: dailyLimitUsdc,
      maxActionSpend: maxPerActionUsdc,
      whitelistedProtocolsCount: whitelist.length,
      mode: isTestnetAutonomyEnabled() ? 'base-sepolia' : (process.env.CHAIN_ENV || 'mainnet-readonly'),
      source,
      isStaleTestMemory,
    },
  };
}

autonomyRouter.get('/', async (req, res, next) => {
  try {
    const userId = (req as { session?: { user?: { id?: string } } }).session?.user?.id || 'default-user';
    const query = {
      owner: req.query.owner as string | undefined,
      executor: req.query.executor as string | undefined,
      token: req.query.token as string | undefined,
    };
    const state = await getAutonomyState(userId, query);
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

autonomyRouter.post('/testnet/configure', async (req, res, next) => {
  try {
    if (!isTestnetAutonomyEnabled()) {
      return res.status(403).json({ error: 'Testnet autonomy is disabled. Set ENABLE_TESTNET_AUTONOMY=true' });
    }
    const userId = (req as { session?: { user?: { id?: string } } }).session?.user?.id || 'default-user';
    const parsed = TestnetConfigureAutonomyRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid testnet autonomy configuration payload', details: parsed.error });
    }
    const data = parsed.data;

    let txHash: string | undefined = (req.body as any).txHash;
    const token = (data.token || getBaseSepoliaUsdcAddress()) as Hex;
    const executor = (data.executor || null) as Hex | null;
    const owner = (data.owner || null) as Hex | null;

    if (!txHash) {
      const hash = await executeTestnetConfigureOnchain(
        executor,
        token,
        data.dailyLimitUsdc,
        data.maxPerActionUsdc,
        data.ttlSeconds,
        (data.whitelist || []).map(a => a as Hex)
      );
      if (hash) txHash = hash;
    }

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
      ttlSeconds: data.ttlSeconds,
      expiresAt: new Date(Date.now() + data.ttlSeconds * 1000).toISOString(),
      owner,
      executor,
      token,
      txHashLastConfigured: txHash || existingAutonomy.txHashLastConfigured || null,
    };

    const newToggles = {
      ...existingToggles,
      autonomy: newAutonomy,
    };

    await MemoryService.updateUserSettings(userId, { protocolToggles: newToggles });
    const state = await getAutonomyState(userId, { owner, executor, token });
    res.json({ success: true, state, txHash });
  } catch (error) {
    next(error);
  }
});

autonomyRouter.post('/testnet/revoke', async (req, res, next) => {
  try {
    if (!isTestnetAutonomyEnabled()) {
      return res.status(403).json({ error: 'Testnet autonomy is disabled. Set ENABLE_TESTNET_AUTONOMY=true' });
    }
    const userId = (req as { session?: { user?: { id?: string } } }).session?.user?.id || 'default-user';
    const parsed = TestnetRevokeAutonomyRequestSchema.safeParse(req.body);
    const data = parsed.success ? parsed.data : {};

    const settings = await MemoryService.getUserSettings(userId);
    const existingToggles = (settings?.protocolToggles as any) || {};
    const existingAutonomy = existingToggles.autonomy || {};

    const token = (data.token || existingAutonomy.token || getBaseSepoliaUsdcAddress()) as Hex;
    const executor = (data.executor || existingAutonomy.executor || null) as Hex | null;
    const owner = (data.owner || existingAutonomy.owner || null) as Hex | null;

    let txHash: string | undefined = (req.body as any).txHash;
    if (!txHash) {
      const hash = await executeTestnetRevokeOnchain(executor, token);
      if (hash) txHash = hash;
    }

    const newAutonomy = {
      ...existingAutonomy,
      killSwitch: true,
      status: 'revoked',
      txHashLastRevoked: txHash || existingAutonomy.txHashLastRevoked || null,
    };

    const newToggles = {
      ...existingToggles,
      autonomy: newAutonomy,
    };

    await MemoryService.updateUserSettings(userId, { protocolToggles: newToggles });
    const state = await getAutonomyState(userId, { owner, executor, token });
    res.json({ success: true, state, txHash });
  } catch (error) {
    next(error);
  }
});

autonomyRouter.post('/testnet/execute-test-action', async (req, res, next) => {
  try {
    if (!isTestnetAutonomyEnabled()) {
      return res.status(403).json({ error: 'Testnet autonomy is disabled. Set ENABLE_TESTNET_AUTONOMY=true' });
    }
    const parsed = TestnetExecuteActionRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid test-action payload', details: parsed.error });
    }
    const data = parsed.data;

    const userId = (req as { session?: { user?: { id?: string } } }).session?.user?.id || 'default-user';
    const settings = await MemoryService.getUserSettings(userId);
    const existingAutonomy = (settings?.protocolToggles as any)?.autonomy || {};

    const token = (data.token || existingAutonomy.token || getBaseSepoliaUsdcAddress()) as Hex;
    const owner = (data.owner || existingAutonomy.owner || null) as Hex | null;
    const target = data.target as Hex;

    let txHash: string | undefined = (req.body as any).txHash;
    if (!txHash) {
      try {
        const hash = await executeTestnetSpendOnchain(owner, token, target, data.amountUsdc);
        if (hash) txHash = hash;
      } catch (err: any) {
        return res.status(400).json({ error: 'Onchain execution failed', details: err?.message || String(err) });
      }
    }

    res.json({ success: true, txHash, amountUsdc: data.amountUsdc, target });
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
