import { Router } from 'express';
import { StatusResponseSchema } from '@mioagent/api-zod';
import { getTokenBalancesProviderFromEnv, getPriceProviderFromEnv, getTokenSecurityProviderFromEnv, getApprovalProviderFromEnv } from '@mioagent/data-providers';

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

  const { providerName } = getTokenBalancesProviderFromEnv();
  const mode = (process.env.TOKEN_BALANCES_PROVIDER || '').toLowerCase();
  let tokenProvider = providerName;
  let tokenStatus: "connected" | "missing" | "failed" = providerName === 'none' ? "missing" : "connected";
  if (mode === 'moralis' && !process.env.MORALIS_API_KEY) {
    tokenProvider = 'moralis';
    tokenStatus = 'missing';
  } else if (mode === 'alchemy' && !process.env.ALCHEMY_API_KEY && !process.env.ALCHEMY_BASE_MAINNET_RPC_URL) {
    tokenProvider = 'alchemy';
    tokenStatus = 'missing';
  }

  const { providerName: priceProviderName } = getPriceProviderFromEnv();
  const priceProvider = priceProviderName;
  const priceStatus: "connected" | "missing" | "failed" = priceProviderName !== 'none' ? "connected" : "missing";


  const { providerName: riskProvider, statusCode: riskStatus } = getTokenSecurityProviderFromEnv();
  const { providerName: approvalProvider, statusCode: approvalStatus } = getApprovalProviderFromEnv();

  const baseMcpStatus: "configured" | "missing" = process.env.BASE_MCP_URL || process.env.BASE_MCP_ENABLED === 'true' ? "configured" : "missing";
  
  const x402Status: "simulated" | "configured" | "missing" = process.env.X402_FACILITATOR_URL ? "configured" : "simulated";

  const isReadonly = chainEnv === 'mainnet-readonly';
  const execution = {
    mode: isReadonly ? 'read-only' : chainEnv,
    enabled: !isReadonly,
    reason: isReadonly ? 'Mainnet execution is disabled in read-only mode' : 'Execution enabled on testnet',
  };

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
