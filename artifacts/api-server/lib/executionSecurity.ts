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
import { isMoonwellActionType } from '@mioagent/security/moonwellGuard';
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
  const moonwell = isMoonwellActionType(actionType);
  const required = chainId === 8453 && (actionType === 'limited_transfer' || actionType === 'uniswap_swap' || moonwell);
  const configured = executionSecurityRuntime.getProvider();
  if (!required) return contextFrom(configured, [], false);
  if (configured.providerName !== 'goplus') return contextFrom(configured, [], true);

  const canonicalUsdc = canonicalUsdcForBaseChain(chainId).toLowerCase();
  // T44b: Moonwell batches legitimately target protocol contracts, but the
  // token-security question is always about canonical USDC — a fixed, never
  // attacker-controlled address, so querying it is safe unconditionally.
  if (moonwell || actionType === 'uniswap_swap') {
    return loadTokenSecurityContext(chainId, [canonicalUsdc]);
  }

  // Never spend an external provider request on attacker-controlled addresses.
  // The unified guard will report the precise structural error afterwards.
  if (calls.length === 0 || calls.some((call) => call.to.toLowerCase() !== canonicalUsdc)) {
    return contextFrom(configured, [], true);
  }
  return loadTokenSecurityContext(chainId, [canonicalUsdc]);
}

export async function loadTokenSecurityContext(
  chainId: number,
  tokenAddresses: string[],
): Promise<ExecutionSecurityContext> {
  const configured = executionSecurityRuntime.getProvider();
  if (configured.providerName !== 'goplus') return contextFrom(configured, [], true);
  let results: TokenSecurityResult[];
  try {
    // Execution decisions always bypass portfolio/cache freshness. A previous
    // unknown verdict must trigger a new token-level request before preparation.
    results = await configured.provider.getTokenSecurity({ chainId, tokenAddresses, forceFresh: true });
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
