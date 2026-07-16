// T56: named-value imports use each guard's own subpath export rather than
// the bare package barrel. @mioagent/security has no "type": "module" in its
// package.json, so a bare `@mioagent/security` import resolved from a sibling
// workspace package falls back to a CJS interop pre-parse that only picks up
// declarations made directly in index.ts (e.g. screenAction) — re-exports
// like `export * from './kyberGuard.js'` are invisible through that path.
// Subpath imports resolve the target file directly and sidestep this.
import { validateUniswapSwap, type UniswapSwapContext } from '@mioagent/security/uniswapGuard';
import { validateKyberSwap, type KyberSwapContext } from '@mioagent/security/kyberGuard';
import type { BaseCall } from '@mioagent/security/baseGuards';
import type { ExecutionTokenSecurityResult } from '@mioagent/security';
import type { ContractSecuritySummaryV1 } from '@mioagent/route-card';
import type {
  ExecutionCallV1,
  HashV1,
  RouteIntentV1,
  SafetyKernelCheckV1,
  SafetyKernelResultV1,
} from '@mioagent/route-domain';
import { SafetyKernelResultV1Schema } from '@mioagent/route-domain';
import type { SwapBuildProviderId } from './types.js';

export interface RunSafetyKernelInput {
  provider: SwapBuildProviderId;
  routerAddress: `0x${string}`;
  chainId: number;
  walletAddress: `0x${string}`;
  intent: RouteIntentV1;
  calls: ExecutionCallV1[];
  quoteExpiry: string;
  now: Date;
  contractSecurityRequired: boolean;
  contractSecurityProvider: string;
  contractSecurityResults: ExecutionTokenSecurityResult[];
  contractSecurityAddresses: `0x${string}`[];
  simulationAcceptable: boolean;
  simulationDetail: string;
  intentHash: HashV1;
  selectedCandidateHash: HashV1;
}

export interface RunSafetyKernelOutput {
  result: SafetyKernelResultV1;
  contractSecurity: ContractSecuritySummaryV1;
}

function check(
  id: string,
  description: string,
  status: SafetyKernelCheckV1['status'],
  detail: string | null,
): SafetyKernelCheckV1 {
  return { id, description, status, detail };
}

function evaluateContractSecurityV1(input: {
  required: boolean;
  provider: string;
  addresses: `0x${string}`[];
  results: ExecutionTokenSecurityResult[];
}): ContractSecuritySummaryV1 {
  if (!input.required) {
    return { provider: input.provider, required: false, status: 'skipped', verdicts: [] };
  }
  if (input.provider !== 'goplus') {
    return { provider: input.provider, required: true, status: 'blocked', verdicts: [] };
  }
  const verdicts = input.addresses.map((address) => {
    const found = input.results.find((entry) => entry.address.toLowerCase() === address.toLowerCase());
    return {
      address,
      provider: found?.provider ?? 'none',
      status: found?.status ?? ('unknown' as const),
      summary: found?.summary ?? null,
    };
  });
  const blocked = verdicts.some(
    (verdict) => verdict.provider !== 'goplus' || ['failed', 'unknown', 'high-risk'].includes(verdict.status),
  );
  const warning = verdicts.some((verdict) => verdict.status === 'warning');
  return {
    provider: input.provider,
    required: true,
    status: blocked ? 'blocked' : warning ? 'warning' : 'passed',
    verdicts,
  };
}

/**
 * Runs the strict, server-side Safety Kernel over ALREADY server-built calls.
 * Provider-specific structural validation is delegated to the shared guards
 * (validateUniswapSwap / validateKyberSwap) rather than forked. Any failed
 * check blocks the whole result — the composer never partially trusts a
 * batch. Contract/token security is mandatory at every verification depth;
 * simulation honesty (never a fabricated `passed`) is enforced by the caller
 * mapping simulationAcceptable before invoking this function (decision 6).
 */
export function runSafetyKernel(input: RunSafetyKernelInput): RunSafetyKernelOutput {
  const checks: SafetyKernelCheckV1[] = [];
  const baseCalls: BaseCall[] = input.calls.map((call) => ({
    to: call.to,
    value: call.valueWei,
    data: call.data,
  }));

  checks.push(
    check(
      'tenant_wallet_binding',
      'Wallet address matches the authenticated tenant and stored intent',
      input.walletAddress.toLowerCase() === input.intent.walletAddress.toLowerCase()
        ? 'passed'
        : 'failed',
      input.walletAddress.toLowerCase() === input.intent.walletAddress.toLowerCase()
        ? null
        : 'walletAddress does not match the stored intent',
    ),
  );

  checks.push(
    check(
      'base_chain_pinned',
      'Chain is pinned to Base mainnet (8453)',
      input.chainId === 8453 ? 'passed' : 'failed',
      input.chainId === 8453 ? null : `Unsupported chain ${input.chainId}`,
    ),
  );

  const quoteExpiryMs = Date.parse(input.quoteExpiry);
  checks.push(
    check(
      'quote_deadline_unexpired',
      'Fresh quote has not expired',
      Number.isFinite(quoteExpiryMs) && quoteExpiryMs > input.now.getTime() ? 'passed' : 'failed',
      Number.isFinite(quoteExpiryMs) && quoteExpiryMs > input.now.getTime()
        ? null
        : 'Fresh quote is expired or has an invalid expiry',
    ),
  );

  const swapCalls = input.calls.filter((call) => call.callType === 'swap');
  const approvalCalls = input.calls.filter((call) => call.callType === 'approval');
  const otherCalls = input.calls.filter((call) => call.callType !== 'swap' && call.callType !== 'approval');
  const orderedCorrectly =
    swapCalls.length === 1 &&
    otherCalls.length === 0 &&
    approvalCalls.every((call) => call.index < swapCalls[0]!.index);
  checks.push(
    check(
      'call_order_and_count',
      'Calls are exactly zero-or-more approvals followed by exactly one swap call',
      orderedCorrectly ? 'passed' : 'failed',
      orderedCorrectly ? null : 'Calls must contain approvals before exactly one swap call, nothing else',
    ),
  );

  const recipientsBound = swapCalls.every(
    (call) => call.recipient?.toLowerCase() === input.walletAddress.toLowerCase(),
  );
  checks.push(
    check(
      'recipient_is_wallet',
      'Swap call recipient equals the authenticated wallet',
      recipientsBound ? 'passed' : 'failed',
      recipientsBound ? null : 'Swap recipient does not equal the authenticated wallet',
    ),
  );

  const expectedInputAtomic = input.intent.amount.amountAtomic;
  const approvalAmountsMatch = approvalCalls.every((call) => call.amountAtomic === expectedInputAtomic);
  checks.push(
    check(
      'input_amount_matches_intent',
      'Every approval amount exactly equals the stored intent input amount',
      approvalAmountsMatch ? 'passed' : 'failed',
      approvalAmountsMatch ? null : 'An approval amount does not exactly match the stored intent input amount',
    ),
  );

  checks.push(
    check(
      'linkage_hashes_present',
      'Intent and selected-candidate hashes are bound to this preparation request',
      input.intentHash && input.selectedCandidateHash ? 'passed' : 'failed',
      input.intentHash && input.selectedCandidateHash ? null : 'Missing intent or candidate linkage hash',
    ),
  );

  if (input.provider === 'uniswap') {
    const toAssetSymbol = input.intent.toAsset?.symbol;
    const context: UniswapSwapContext = {
      amountDecimal: input.intent.amount.amountDecimal,
      inputToken: 'USDC',
      outputToken: toAssetSymbol === 'WETH' ? 'WETH' : 'ETH',
      swapper: input.walletAddress,
      routerVersion: '2.0',
      expiresAt: input.quoteExpiry,
    };
    const guard = validateUniswapSwap({ chain: input.chainId, calls: baseCalls, context, now: input.now });
    checks.push(
      check(
        'provider_guard_uniswap',
        'Uniswap-specific structural and router-pinning validation (validateUniswapSwap)',
        guard.success ? 'passed' : 'failed',
        guard.success ? null : `${guard.code}: ${guard.reason}`,
      ),
    );
  } else {
    const toAssetSymbol = input.intent.toAsset?.symbol;
    const context: KyberSwapContext = {
      amountDecimal: input.intent.amount.amountDecimal,
      inputToken: 'USDC',
      outputToken: toAssetSymbol === 'WETH' ? 'WETH' : 'ETH',
      swapper: input.walletAddress,
      recipient: input.walletAddress,
      routerAddress: input.routerAddress,
      expiresAt: input.quoteExpiry,
    };
    const guard = validateKyberSwap({ chain: input.chainId, calls: baseCalls, context, now: input.now });
    checks.push(
      check(
        'provider_guard_kyberswap',
        'KyberSwap-specific structural and router-pinning validation (validateKyberSwap)',
        guard.success ? 'passed' : 'failed',
        guard.success ? null : `${guard.code}: ${guard.reason}`,
      ),
    );
  }

  const contractSecurity = evaluateContractSecurityV1({
    required: input.contractSecurityRequired,
    provider: input.contractSecurityProvider,
    addresses: input.contractSecurityAddresses,
    results: input.contractSecurityResults,
  });
  checks.push(
    check(
      'contract_token_security',
      'Contract/token security verdict for the canonical input token (GoPlus)',
      contractSecurity.status === 'blocked' ? 'failed' : 'passed',
      contractSecurity.status === 'blocked'
        ? 'No usable GoPlus verdict for the canonical input token'
        : contractSecurity.status === 'warning'
          ? 'GoPlus reported a non-blocking warning'
          : null,
    ),
  );

  checks.push(
    check(
      'simulation_evidence',
      'Required simulation evidence availability for the requested verification depth',
      input.simulationAcceptable ? 'passed' : 'failed',
      input.simulationAcceptable ? null : input.simulationDetail,
    ),
  );

  const failed = checks.filter((entry) => entry.status === 'failed');
  const verdict: SafetyKernelResultV1['verdict'] = failed.length === 0 ? 'allowed' : 'blocked';
  const result = SafetyKernelResultV1Schema.parse({
    schemaVersion: 'safety-kernel-result/v1',
    verdict,
    checks,
    blockedReason: verdict === 'blocked' ? failed.map((entry) => `${entry.id}: ${entry.detail}`).join('; ') : null,
  });
  return { result, contractSecurity };
}
