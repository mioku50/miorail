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
} from '../lib/testnetAutonomy.js';
import { getAutonomyPolicyRepository } from '../lib/autonomyGateway.js';
import { formatUnits, type Hex } from 'viem';

export const autonomyRouter = Router();

async function getAutonomyState(userId: string, query?: { owner?: string; executor?: string; token?: string }) {
  const settings = await MemoryService.getUserSettings(userId).catch(() => null);
  const autonomy = (settings?.protocolToggles as any)?.autonomy || {};

  const isConfigured = autonomy.status === 'configured' || !!autonomy.dailyLimitUsdc;
  let isKillSwitch = autonomy.killSwitch === true;

  let status: 'active' | 'inactive' | 'unconfigured' | 'configured' | 'revoked' | 'expired' = (isKillSwitch || autonomy.status === 'revoked') ? 'revoked' : (isConfigured ? 'active' : 'unconfigured');
  let sessionKeyStatus: 'configured' | 'unconfigured' | 'inactive' | 'revoked' | 'expired' | 'active' = (isKillSwitch || autonomy.status === 'revoked') ? 'revoked' : (isConfigured ? 'configured' : 'unconfigured');
  let source: 'database' | 'memory' | 'onchain' | 'base-sepolia-contract' | 'missing' = isConfigured ? 'memory' : 'missing';

  let chainId: number | undefined;
  let contractAddress: string | null | undefined;
  let owner: string | null = autonomy.owner || query?.owner || null;
  let executor: string | null = autonomy.executor || query?.executor || null;
  let token: string | null = autonomy.token || query?.token || null;
  let validUntil: number | string | null = autonomy.expiresAt || null;
  let expiresAt: string | null = autonomy.expiresAt || null;
  let dailyLimitUsdc = autonomy.dailyLimitUsdc || null;
  let spentTodayUsdc = autonomy.spentTodayUsdc || '0';
  let reservedTodayUsdc = autonomy.reservedTodayUsdc || '0';
  let maxPerActionUsdc = autonomy.maxPerActionUsdc || null;
  let ttlSeconds = autonomy.ttlSeconds || null;
  let whitelist: string[] = autonomy.whitelist || [];
  let scope = autonomy.scope || 'none';
  const txHashLastConfigured = autonomy.txHashLastConfigured || null;
  const txHashLastRevoked = autonomy.txHashLastRevoked || null;
  let walletAddress: string | null = autonomy.walletAddress || null;
  let mainnetOptIn = autonomy.mainnetOptIn === true;
  let executionReady = false;
  let blockedReasons: string[] = [];

  const runtimeChainEnv = process.env.CHAIN_ENV || 'mainnet-readonly';
  if (runtimeChainEnv === 'mainnet' || runtimeChainEnv === 'mainnet-readonly') {
    chainId = 8453;
    owner = null;
    executor = null;
    token = null;
    validUntil = null;
    try {
      const policy = await getAutonomyPolicyRepository().getByUser(userId, chainId);
      if (policy) {
        source = 'database';
        isKillSwitch = policy.killSwitch || !policy.isActive;
        walletAddress = policy.walletAddress;
        owner = policy.walletAddress;
        mainnetOptIn = policy.mainnetOptIn;
        dailyLimitUsdc = String(policy.dailyLimit);
        spentTodayUsdc = String(policy.spentToday);
        reservedTodayUsdc = String(policy.reservedToday);
        maxPerActionUsdc = String(policy.maxPerAction);
        validUntil = Math.floor(policy.expiresAt / 1000);
        expiresAt = new Date(policy.expiresAt).toISOString();
        ttlSeconds = Math.max(0, Math.floor((policy.expiresAt - Date.now()) / 1000));
        whitelist = policy.whitelist;
        scope = policy.scope;

        const expired = policy.expiresAt <= Date.now();
        status = expired ? 'expired' : policy.killSwitch || !policy.isActive ? 'inactive' : 'configured';
        sessionKeyStatus = expired ? 'expired' : policy.killSwitch || !policy.isActive ? 'inactive' : 'configured';
        if (runtimeChainEnv === 'mainnet-readonly') blockedReasons.push('mainnet_readonly');
        if (process.env.MAINNET_EXECUTION_ENABLED !== 'true') blockedReasons.push('mainnet_execution_disabled');
        if (!policy.mainnetOptIn) blockedReasons.push('mainnet_opt_in_required');
        if (policy.killSwitch || !policy.isActive) blockedReasons.push('kill_switch');
        if (expired) blockedReasons.push('permission_expired');
        executionReady = blockedReasons.length === 0;
      } else {
        source = 'missing';
        status = 'unconfigured';
        sessionKeyStatus = 'unconfigured';
        dailyLimitUsdc = null;
        spentTodayUsdc = '0';
        reservedTodayUsdc = '0';
        maxPerActionUsdc = null;
        ttlSeconds = null;
        expiresAt = null;
        whitelist = [];
        scope = 'none';
        walletAddress = null;
        mainnetOptIn = false;
        blockedReasons = ['autonomy_policy_missing'];
      }
    } catch {
      source = 'missing';
      status = 'unconfigured';
      sessionKeyStatus = 'unconfigured';
      dailyLimitUsdc = null;
      spentTodayUsdc = '0';
      reservedTodayUsdc = '0';
      maxPerActionUsdc = null;
      ttlSeconds = null;
      expiresAt = null;
      whitelist = [];
      scope = 'none';
      walletAddress = null;
      mainnetOptIn = false;
      blockedReasons = ['autonomy_database_unavailable'];
    }
  }

  if (isTestnetAutonomyEnabled() && runtimeChainEnv === 'sepolia') {
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

  const isPastDate = (val?: number | string | null) => {
    if (!val) return false;
    const now = Date.now();
    if (typeof val === 'number') {
      return (val > 10000000000 ? val : val * 1000) <= now;
    }
    const parsed = new Date(val).getTime();
    return !isNaN(parsed) && parsed <= now;
  };

  const isExpiredMemory = source === 'memory' && !isStaleTestMemory && isPastDate(autonomy.expiresAt);

  if (isStaleTestMemory) {
    status = 'unconfigured';
    sessionKeyStatus = 'unconfigured';
  } else if (isExpiredMemory) {
    status = 'expired';
    sessionKeyStatus = 'expired';
    dailyLimitUsdc = null;
    maxPerActionUsdc = null;
  }

  return {
    status,
    source,
    isStaleTestMemory,
    isExpiredMemory,
    chainId,
    contractAddress,
    sessionKey: {
      status: sessionKeyStatus,
      source,
      isStaleTestMemory,
      isExpiredMemory,
      dailyLimitUsdc,
      spentTodayUsdc,
      reservedTodayUsdc,
      maxPerActionUsdc,
      ttlSeconds,
      expiresAt,
      whitelist,
      scope,
      killSwitch: isKillSwitch || status === 'revoked',
      walletAddress,
      mainnetOptIn,
      executionReady,
      blockedReasons,
      gatewayMode: 'unsigned-eip5792' as const,
      requiresUserApproval: true,
      owner,
      executor,
      token,
      validUntil,
      txHashLastConfigured: source === 'memory' || source === 'base-sepolia-contract' ? txHashLastConfigured : null,
      txHashLastRevoked: source === 'memory' || source === 'base-sepolia-contract' ? txHashLastRevoked : null,
    },
    autonomy: {
      dailySpendLimit: dailyLimitUsdc,
      maxActionSpend: maxPerActionUsdc,
      whitelistedProtocolsCount: whitelist.length,
      mode: isTestnetAutonomyEnabled() && runtimeChainEnv === 'sepolia' ? 'base-sepolia' : runtimeChainEnv,
      source,
      isStaleTestMemory,
      isExpiredMemory,
      executionReady,
      blockedReasons,
      reservedTodayUsdc,
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
    if (data.mainnetOptIn && !data.acknowledgeMainnetRisk) {
      return res.status(400).json({ error: 'Explicit mainnet risk acknowledgement is required' });
    }

    const runtimeChainEnv = process.env.CHAIN_ENV || 'mainnet-readonly';
    const chainId = runtimeChainEnv === 'sepolia' ? 84532 : 8453;
    const whitelist = [...new Set(data.whitelist.map((address) => address.toLowerCase()))];
    if (runtimeChainEnv === 'mainnet' || runtimeChainEnv === 'mainnet-readonly') {
      await getAutonomyPolicyRepository().configure({
        userId,
        chainId,
        walletAddress: data.walletAddress,
        dailyLimit: Number(data.dailyLimitUsdc),
        maxPerAction: Number(data.maxPerActionUsdc),
        whitelist,
        scope: data.scope || 'bounded-approval',
        expiresAt: Date.now() + data.ttlSeconds * 1000,
        mainnetOptIn: data.mainnetOptIn,
      });
    }

    const settings = await MemoryService.getUserSettings(userId).catch(() => null);
    const existingToggles = (settings?.protocolToggles as any) || {};
    const existingAutonomy = existingToggles.autonomy || {};

    const newAutonomy = {
      ...existingAutonomy,
      status: 'configured',
      killSwitch: false,
      dailyLimitUsdc: data.dailyLimitUsdc,
      maxPerActionUsdc: data.maxPerActionUsdc,
      whitelist,
      scope: data.scope || existingAutonomy.scope || 'bounded-approval',
      ttlSeconds: data.ttlSeconds,
      expiresAt: new Date(Date.now() + data.ttlSeconds * 1000).toISOString(),
      walletAddress: data.walletAddress.toLowerCase(),
      mainnetOptIn: data.mainnetOptIn,
    };

    const newToggles = {
      ...existingToggles,
      autonomy: newAutonomy,
    };

    if (runtimeChainEnv === 'mainnet' || runtimeChainEnv === 'mainnet-readonly') {
      await MemoryService.updateUserSettings(userId, { protocolToggles: newToggles }).catch(() => undefined);
    } else {
      await MemoryService.updateUserSettings(userId, { protocolToggles: newToggles });
    }
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

    const txHash: string | undefined = (req.body as any).txHash;
    const token = (data.token || getBaseSepoliaUsdcAddress()) as Hex;
    const executor = (data.executor || null) as Hex | null;
    const owner = (data.owner || null) as Hex | null;

    if (!txHash) {
      return res.status(409).json({
        error: 'wallet_confirmation_required',
        details: 'The server never signs or broadcasts. Submit a wallet-confirmed transaction hash.',
      });
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
    const state = await getAutonomyState(userId, { owner: owner || undefined, executor: executor || undefined, token });
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

    const txHash: string | undefined = (req.body as any).txHash;
    if (!txHash) {
      return res.status(409).json({
        error: 'wallet_confirmation_required',
        details: 'The server never signs or broadcasts. Submit a wallet-confirmed transaction hash.',
      });
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
    const state = await getAutonomyState(userId, { owner: owner || undefined, executor: executor || undefined, token });
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

    const target = data.target as Hex;

    const txHash: string | undefined = (req.body as any).txHash;
    if (!txHash) {
      return res.status(409).json({
        error: 'wallet_confirmation_required',
        details: 'The server never signs or broadcasts. Submit a wallet-confirmed transaction hash.',
      });
    }

    res.json({ success: true, txHash, amountUsdc: data.amountUsdc, target });
  } catch (error) {
    next(error);
  }
});

autonomyRouter.post('/kill', async (req, res, next) => {
  try {
    const userId = (req as { session?: { user?: { id?: string } } }).session?.user?.id || 'default-user';
    const runtimeChainEnv = process.env.CHAIN_ENV || 'mainnet-readonly';
    const chainId = runtimeChainEnv === 'sepolia' ? 84532 : 8453;
    if (runtimeChainEnv === 'mainnet' || runtimeChainEnv === 'mainnet-readonly') {
      const policy = await getAutonomyPolicyRepository().getByUser(userId, chainId);
      if (policy) await getAutonomyPolicyRepository().setKillSwitch(policy.id, true);
    }
    const settings = await MemoryService.getUserSettings(userId).catch(() => null);
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

    await MemoryService.updateUserSettings(userId, { protocolToggles: newToggles }).catch(() => undefined);
    const state = await getAutonomyState(userId);
    res.json(KillAutonomyResponseSchema.parse({ success: true, state }));
  } catch (error) {
    next(error);
  }
});

autonomyRouter.post('/reset', async (req, res, next) => {
  try {
    const userId = (req as { session?: { user?: { id?: string } } }).session?.user?.id || 'default-user';
    const runtimeChainEnv = process.env.CHAIN_ENV || 'mainnet-readonly';
    const chainId = runtimeChainEnv === 'sepolia' ? 84532 : 8453;
    if (runtimeChainEnv === 'mainnet' || runtimeChainEnv === 'mainnet-readonly') {
      const policy = await getAutonomyPolicyRepository().getByUser(userId, chainId);
      if (policy) await getAutonomyPolicyRepository().setKillSwitch(policy.id, true);
    }
    const settings = await MemoryService.getUserSettings(userId).catch(() => null);
    const existingToggles = (settings?.protocolToggles as any) || {};

    const newToggles = {
      ...existingToggles,
      autonomy: {
        status: 'unconfigured',
        killSwitch: false,
      },
    };

    await MemoryService.updateUserSettings(userId, { protocolToggles: newToggles }).catch(() => undefined);
    const state = await getAutonomyState(userId);
    res.json(KillAutonomyResponseSchema.parse({ success: true, state }));
  } catch (error) {
    next(error);
  }
});
