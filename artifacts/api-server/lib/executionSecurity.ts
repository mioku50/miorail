import {
  getTokenSecurityProviderFromEnv,
  setTokenSecurityHealthStatus,
  type TokenSecurityProviderEnvResult,
  type TokenSecurityResult,
} from '@mioagent/data-providers';
import type {
  BaseCall,
  ExecutableActionType,
  ExecutionGuardProviderContext,
  ExecutionTokenSecurityResult,
} from '@mioagent/security';
import { canonicalUsdcForBaseChain } from '@mioagent/security/baseGuards';

export interface ExecutionSecurityContext {
  providerContext: ExecutionGuardProviderContext;
  tokenSecurity: ExecutionTokenSecurityResult[];
  required: boolean;
}

export const executionSecurityRuntime = {
  getProvider: getTokenSecurityProviderFromEnv,
  setHealth: setTokenSecurityHealthStatus,
};

export async function loadExecutionSecurityContext(
  chainId: number,
  actionType: ExecutableActionType,
  calls: BaseCall[],
): Promise<ExecutionSecurityContext> {
  const required = chainId === 8453 && actionType === 'limited_transfer';
  const configured = executionSecurityRuntime.getProvider();
  if (!required) return contextFrom(configured, [], false);
  if (configured.providerName !== 'goplus') return contextFrom(configured, [], true);

  // Never spend an external provider request on attacker-controlled addresses.
  // The unified guard will report the precise structural error afterwards.
  const canonicalUsdc = canonicalUsdcForBaseChain(chainId).toLowerCase();
  if (calls.length === 0 || calls.some((call) => call.to.toLowerCase() !== canonicalUsdc)) {
    return contextFrom(configured, [], true);
  }
  const tokenAddresses = [canonicalUsdc];
  let results: TokenSecurityResult[];
  try {
    results = await configured.provider.getTokenSecurity({ chainId, tokenAddresses });
  } catch {
    executionSecurityRuntime.setHealth('failed');
    return contextFrom({ ...configured, statusCode: 'failed' }, [], true);
  }

  const usableCount = results.filter((result) => !['failed', 'unknown'].includes(result.status)).length;
  const status = usableCount === 0
    ? 'failed'
    : usableCount < tokenAddresses.length
      ? 'partial'
      : 'connected';
  executionSecurityRuntime.setHealth(status);
  return contextFrom({ ...configured, statusCode: status }, results, true);
}

function contextFrom(
  provider: TokenSecurityProviderEnvResult,
  results: TokenSecurityResult[],
  required: boolean,
): ExecutionSecurityContext {
  return {
    required,
    providerContext: {
      risk: provider.statusCode,
      riskProvider: provider.providerName,
      securityProvider: provider.providerName,
    },
    tokenSecurity: results.map((result) => ({
      address: result.address,
      provider: result.provider,
      status: result.status,
      summary: result.summary,
      rawRiskLabels: result.rawRiskLabels,
    })),
  };
}
