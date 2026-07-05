import { Router } from 'express';
import { StatusResponseSchema } from '@mioagent/api-zod';
import { getTokenBalancesProviderFromEnv, getPriceProviderFromEnv, getTokenSecurityProviderFromEnv, getApprovalProviderFromEnv } from '@mioagent/data-providers';
import { getProviderBudgetSnapshot, getProviderCacheDiagnostics } from '../lib/providerCache.js';

export function getSystemStatus(envOverride?: string) {
  const chainEnv = envOverride || process.env.CHAIN_ENV || 'sepolia';
  const chainId = chainEnv === 'sepolia' ? 84532 : 8453;
  const rpcUrl = chainEnv === 'sepolia' 
    ? process.env.BASE_SEPOLIA_RPC_URL || 'https://sepolia.base.org' 
    : process.env.BASE_MAINNET_RPC_URL || 'https://mainnet.base.org';

  let rpcProvider = 'custom';
  if (rpcUrl.includes('alchemy.com')) {
    rpcProvider = 'alchemy';
  } else if (rpcUrl.includes('base.org')) {
    rpcProvider = 'base-public';
  }

  const { providerName, statusCode: tokenStatusCode } = getTokenBalancesProviderFromEnv();
  const mode = (process.env.TOKEN_BALANCES_PROVIDER || '').toLowerCase();
  let tokenProvider = providerName;
  let tokenStatus: "connected" | "missing" | "failed" | "disabled" = tokenStatusCode;
  // Preserve the intended provider label when a provider was configured but its key is absent.
  if (mode === 'moralis' && !process.env.MORALIS_API_KEY) {
    tokenProvider = 'moralis';
    tokenStatus = 'missing';
  } else if (mode === 'alchemy' && !process.env.ALCHEMY_API_KEY && !process.env.ALCHEMY_BASE_MAINNET_RPC_URL) {
    tokenProvider = 'alchemy';
    tokenStatus = 'missing';
  }

  const { providerName: priceProviderName, statusCode: priceStatusCode } = getPriceProviderFromEnv();
  const priceProvider = priceProviderName;
  const priceStatus: "connected" | "missing" | "failed" | "disabled" = priceStatusCode;


  const { providerName: riskProvider, statusCode: riskStatus } = getTokenSecurityProviderFromEnv();
  const { providerName: approvalProvider, statusCode: approvalStatus } = getApprovalProviderFromEnv();

  const baseMcpStatus: "configured" | "missing" = process.env.BASE_MCP_URL || process.env.BASE_MCP_ENABLED === 'true' ? "configured" : "missing";
  
  const x402Status: "simulated" | "configured" | "missing" = process.env.X402_FACILITATOR_URL ? "configured" : "simulated";

  const isReadonly = chainEnv === 'mainnet-readonly';
  // T19: the user-confirmed flow (Base Account wallet_sendCalls) is always
  // available — the server only prepares unsigned payloads and records results.
  // `broadcastEnabled` is the separate, legacy server-broadcast capability,
  // gated by MAINNET_EXECUTION_ENABLED (stays false in production).
  const broadcastEnabled = !isReadonly && (chainEnv !== 'mainnet' || process.env.MAINNET_EXECUTION_ENABLED === 'true');
  const execution = {
    mode: 'user-confirmed',
    enabled: true,
    broadcastEnabled,
    reason: isReadonly
      ? 'User-confirmed flow via Base Account; server never broadcasts'
      : (broadcastEnabled ? 'Server-broadcast enabled (testnet/dev)' : 'User-confirmed flow via Base Account; server-broadcast disabled'),
  };

  const cache = getProviderCacheDiagnostics();
  const budgets = getProviderBudgetSnapshot();

  return {
    chainEnv,
    chainId,
    rpc: {
      status: "connected" as const,
      provider: rpcProvider,
    },
    tokenBalances: {
      status: tokenStatus,
      provider: tokenProvider,
    },
    prices: {
      status: priceStatus,
      provider: priceProvider,
    },
    risk: {
      status: riskStatus,
      provider: riskProvider,
    },
    approvals: {
      status: approvalStatus,
      provider: approvalProvider,
    },
    cache,
    budgets,
    baseMcp: {
      status: baseMcpStatus,
    },
    x402: {
      status: x402Status,
    },
    execution,
  };
}

export const statusRouter = Router();

statusRouter.get('/', (req, res, next) => {
  try {
    const statusData = getSystemStatus();
    res.json(StatusResponseSchema.parse(statusData));
  } catch (error) {
    next(error);
  }
});
