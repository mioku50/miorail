// T56: named-value imports use each guard's own subpath export rather than
// the bare package barrel. @mioagent/security has no "type": "module" in its
// package.json, so a bare `@mioagent/security` import resolved from a sibling
// workspace package falls back to a CJS interop pre-parse that only picks up
// declarations made directly in index.ts (e.g. screenAction) — re-exports
// like `export * from './kyberGuard.js'` are invisible through that path.
// Subpath imports resolve the target file directly and sidestep this.
import { validateUniswapSwap, type UniswapSwapContext } from '@mioagent/security/uniswapGuard';
import { validateKyberSwap, type KyberSwapContext } from '@mioagent/security/kyberGuard';
import type { SwapGuardAssetV1 } from '@mioagent/security/swapAsset';
import { validateAerodromeSwap, type AerodromeSwapContext } from '@mioagent/security/aerodromeGuard';
import { validateO1Swap, type O1SwapContext } from '@mioagent/security/o1Guard';
import { validateHydrexSwap, type HydrexSwapContext } from '@mioagent/security/hydrexGuard';
import { validateBalancerSwap, type BalancerSwapContext } from '@mioagent/security/balancerGuard';
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
import type { AerodromeBuildFactsV1, BalancerBuildFactsV1, SwapBuildProviderId } from './types.js';

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
  /**
   * T67B.1 — required for `aerodrome` and ignored otherwise. Aerodrome
   * calldata is encoded by this server rather than fetched from a partner, so
   * the guard needs the route and factory it must find inside those bytes.
   * Absent facts are a BLOCK, never a skipped check.
   */
  aerodrome?: AerodromeBuildFactsV1;
  /**
   * T67B.1 — the minimum output the user actually reviewed on the Route Card.
   * Aerodrome checks decoded calldata against THIS rather than against the
   * blueprint's own minimum: a build that re-derived a weaker floor from a
   * decayed fresh quote agrees with itself, and would otherwise pass.
   */
  reviewedMinimumOutputAtomic?: string;
  /** Fresh proxy + implementation code-hash check. Required for o1 because
   * its pinned address is upgradeable. */
  o1ContractPinVerified?: boolean;
  /** Fresh outer proxy plus selected upstream code-hash/allowlist check. */
  hydrexContractPinVerified?: boolean;
  hydrexUpstreamRouter?: string;
  /** Locally rebuilt Balancer protocol and exact API path provenance. */
  balancer?: BalancerBuildFactsV1;
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

/**
 * What a token contract may do before Miorail will route it, expressed as the
 * refusal it earns. Null means nothing here refuses it.
 *
 * Grounded in what GoPlus actually reports, and deliberately NOT a list of
 * everything scary:
 *
 *   * A BLACKLIST is not a refusal. Canonical USDC has one. So does most of
 *     regulated stablecoin land. Refusing on it would refuse the safest asset
 *     on the chain, which is how a policy ends up switched off entirely.
 *   * MINTABLE and PROXY are not refusals either, for the same reason: USDC is
 *     both.
 *   * What IS refused is the token being unsellable or the owner being able to
 *     reach into a holder's balance — those are not risks to price, they are
 *     the absence of ownership.
 *
 * Tax has a threshold rather than a boolean: a small transfer fee is a design
 * choice, and a large one is a trap wearing the same field.
 */
export const MAX_TOKEN_TAX_PERCENT_V1 = 10;

export function tokenSecurityRefusalV1(
  result: Pick<ExecutionTokenSecurityResult, 'status' | 'flags'>,
): string | null {
  const flags = result.flags ?? {};
  if (flags.isHoneypot) return 'the token cannot be sold (honeypot)';
  if (flags.cannotSellAll) return 'the token cannot be fully sold';
  if (flags.ownerCanChangeBalance) return 'the owner can change holder balances';
  if (flags.hiddenOwner) return 'the token has a hidden owner';
  if (flags.canTakeBackOwnership) return 'ownership can be taken back';
  if (flags.selfdestruct) return 'the contract can self-destruct';
  for (const [name, raw] of [['buy tax', flags.buyTax], ['sell tax', flags.sellTax]] as const) {
    if (raw === undefined || raw === null || raw === '') continue;
    const percent = Number(raw);
    // An unreadable tax is not a zero tax.
    if (!Number.isFinite(percent)) return `${name} could not be read`;
    if (percent > MAX_TOKEN_TAX_PERCENT_V1) return `${name} is ${percent}%`;
  }
  return null;
}

/**
 * Every token contract this swap must have a security verdict for.
 *
 * It was the INPUT token alone, which was sound only while the perimeter was
 * three known assets: with USDC always on one side, the other side was
 * canonical by construction. Once either side can be an arbitrary token, the
 * output is exactly where the danger is — a honeypot bought is a honeypot that
 * cannot be sold, and the input verdict says nothing about it.
 *
 * Native ETH has no contract and contributes no address. Both sides being the
 * same address is impossible (the guards refuse it), but the dedupe keeps the
 * provider from being asked twice for the same token anyway.
 */
export function swapTokenSecurityAddressesV1(intent: RouteIntentV1): `0x${string}`[] {
  const seen = new Set<string>();
  const addresses: `0x${string}`[] = [];
  for (const asset of [intent.fromAsset, intent.toAsset]) {
    const address = asset?.address;
    if (!address) continue;
    const lower = address.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    addresses.push(address as `0x${string}`);
  }
  return addresses;
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
  // The aggregated status, as before — plus the specific contract powers the
  // kernel could not see until the flags were carried through.
  const refusals = input.results
    .map((entry) => {
      const reason = tokenSecurityRefusalV1(entry);
      return reason ? `${entry.address}: ${reason}` : null;
    })
    .filter((reason): reason is string => reason !== null);
  const blocked =
    refusals.length > 0 ||
    verdicts.some(
      (verdict) => verdict.provider !== 'goplus' || ['failed', 'unknown', 'high-risk'].includes(verdict.status),
    );
  const warning = verdicts.some((verdict) => verdict.status === 'warning');
  return {
    provider: input.provider,
    required: true,
    status: blocked ? 'blocked' : warning ? 'warning' : 'passed',
    // The refusal reads back verbatim. "No usable verdict" was true of the one
    // case this check originally had; a token the contract itself makes
    // unsellable is a different statement and deserves its own words.
    verdicts: verdicts.map((verdict) => {
      const found = input.results.find((entry) => entry.address.toLowerCase() === verdict.address.toLowerCase());
      const refusal = found ? tokenSecurityRefusalV1(found) : null;
      return refusal ? { ...verdict, summary: refusal } : verdict;
    }),
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
/**
 * The asset a guard context pins one side of the swap to.
 *
 * It used to answer with one of three names, and anything else was null — a
 * refusal. That made the guarded perimeter exactly three assets wide, which is
 * not a security property: the guard's job is to prove the calldata matches
 * the asset the user reviewed, and it can do that for any asset whose address
 * and decimals are known. WHETHER a token may be routed at all is decided
 * elsewhere and earlier — by the contract-security verdict below, which is why
 * the output token is now sent for that verdict too.
 *
 * Identified by ADDRESS, never by symbol: a symbol is a label anyone can
 * reuse, and this value decides which token an approval is allowed to name.
 * Native ETH has no address, so `kind` identifies it.
 */
function guardAssetV1(asset: RouteIntentV1['fromAsset']): SwapGuardAssetV1 | null {
  if (!asset) return null;
  if (asset.kind === 'native') return { kind: 'native' };
  const address = asset.address?.toLowerCase();
  if (!address) return null;
  return { kind: 'erc20', address, decimals: asset.decimals };
}

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

  if (input.provider === 'balancer') {
    const inputAddress = input.intent.fromAsset?.address?.toLowerCase();
    const outputAddress = input.intent.toAsset?.address?.toLowerCase();
    const reviewedMinimum = input.reviewedMinimumOutputAtomic;
    const context: BalancerSwapContext | undefined =
      inputAddress && outputAddress && reviewedMinimum && input.balancer
        ? {
            protocolVersion: input.balancer.protocolVersion,
            inputTokenAddress: inputAddress,
            outputTokenAddress: outputAddress,
            amountInAtomic: input.intent.amount.amountAtomic,
            minimumOutputAtomic: reviewedMinimum,
            walletAddress: input.walletAddress,
            routerAddress: input.routerAddress,
            sourceKeys: input.balancer.sourceKeys,
          }
        : undefined;
    const guard = validateBalancerSwap({
      chain: input.chainId,
      calls: baseCalls,
      context,
      now: input.now,
    });
    checks.push(
      check(
        'provider_guard_balancer',
        'Balancer pinned contracts, exact approvals, reviewed pools and exact-input calldata',
        guard.success ? 'passed' : 'failed',
        guard.success ? null : `${guard.code}: ${guard.reason}`,
      ),
    );
  } else if (input.provider === 'hydrex') {
    checks.push(
      check(
        'provider_contract_pin_hydrex',
        'Hydrex proxy, implementation and selected upstream code hashes match reviewed pins',
        input.hydrexContractPinVerified ? 'passed' : 'failed',
        input.hydrexContractPinVerified ? null : 'hydrex_contract_pin_unverified',
      ),
    );
    const inputAddress = input.intent.fromAsset?.address?.toLowerCase();
    const outputAddress = input.intent.toAsset?.address?.toLowerCase();
    const reviewedMinimum = input.reviewedMinimumOutputAtomic;
    const context: HydrexSwapContext | undefined =
      inputAddress && outputAddress && reviewedMinimum && input.hydrexUpstreamRouter
        ? {
            inputTokenAddress: inputAddress,
            outputTokenAddress: outputAddress,
            amountInAtomic: input.intent.amount.amountAtomic,
            minimumOutputAtomic: reviewedMinimum,
            recipient: input.walletAddress,
            routerAddress: input.routerAddress,
            upstreamRouter: input.hydrexUpstreamRouter,
            expiresAt: input.quoteExpiry,
          }
        : undefined;
    const guard = validateHydrexSwap({ chain: input.chainId, calls: baseCalls, context, now: input.now });
    checks.push(
      check(
        'provider_guard_hydrex',
        'Hydrex outer calldata, nested route boundary and pinned upstream validation',
        guard.success ? 'passed' : 'failed',
        guard.success ? null : `${guard.code}: ${guard.reason}`,
      ),
    );
  } else if (input.provider === 'o1-exchange') {
    checks.push(
      check(
        'provider_contract_pin_o1',
        'o1 proxy, admin and implementation code hashes match the reviewed pins',
        input.o1ContractPinVerified ? 'passed' : 'failed',
        input.o1ContractPinVerified ? null : 'o1_contract_pin_unverified',
      ),
    );
    const inputAddress = input.intent.fromAsset?.address?.toLowerCase();
    const outputAddress = input.intent.toAsset?.address?.toLowerCase();
    const reviewedMinimum = input.reviewedMinimumOutputAtomic;
    const context: O1SwapContext | undefined =
      inputAddress && outputAddress && reviewedMinimum
        ? {
            inputTokenAddress: inputAddress,
            outputTokenAddress: outputAddress,
            amountInAtomic: input.intent.amount.amountAtomic,
            minimumOutputAtomic: reviewedMinimum,
            swapper: input.walletAddress,
            routerAddress: input.routerAddress,
            expiresAt: input.quoteExpiry,
          }
        : undefined;
    const guard = validateO1Swap({
      chain: input.chainId,
      calls: baseCalls,
      context,
      now: input.now,
    });
    checks.push(
      check(
        'provider_guard_o1',
        'o1-specific RLP-derived calldata, route and router validation (validateO1Swap)',
        guard.success ? 'passed' : 'failed',
        guard.success ? null : `${guard.code}: ${guard.reason}`,
      ),
    );
  } else if (input.provider === 'aerodrome') {
    const facts = input.aerodrome;
    const reviewedMinimum = input.reviewedMinimumOutputAtomic;
    if (!facts || !reviewedMinimum) {
      // No facts means nothing to compare the calldata against. That is a
      // wiring failure, and it fails closed rather than validating the bytes
      // against themselves.
      checks.push(
        check(
          'provider_guard_aerodrome',
          'Aerodrome calldata decoding and route/factory pinning (validateAerodromeSwap)',
          'failed',
          'aerodrome_build_facts_missing: no reviewed route, factory or minimum output to check the calldata against',
        ),
      );
    } else {
      const context: AerodromeSwapContext = {
        inputTokenAddress: facts.inputTokenAddress,
        inputIsNative: facts.inputIsNative,
        outputIsNative: facts.outputIsNative,
        amountInAtomic: input.intent.amount.amountAtomic,
        minimumOutputAtomic: reviewedMinimum,
        swapper: input.walletAddress,
        recipient: input.walletAddress,
        routerAddress: input.routerAddress,
        factory: facts.factory,
        route: facts.route.map((leg) => ({ ...leg })),
        expiresAt: input.quoteExpiry,
      };
      const guard = validateAerodromeSwap({ chain: input.chainId, calls: baseCalls, context, now: input.now });
      checks.push(
        check(
          'provider_guard_aerodrome',
          'Aerodrome calldata decoding and route/factory pinning (validateAerodromeSwap)',
          guard.success ? 'passed' : 'failed',
          guard.success ? null : `${guard.code}: ${guard.reason}`,
        ),
      );
    }
  } else if (input.provider === 'uniswap') {
    // Both sides come from the stored intent's ADDRESSES. They used to be
    // `inputToken: 'USDC'` and an output guessed from a symbol, which pinned
    // the guard to one direction and would have mislabelled the approval
    // target the moment the other direction shipped.
    const inputAsset = guardAssetV1(input.intent.fromAsset);
    const outputAsset = guardAssetV1(input.intent.toAsset);
    const context: UniswapSwapContext | undefined =
      inputAsset && outputAsset
        ? {
            amountDecimal: input.intent.amount.amountDecimal,
            inputAsset,
            outputAsset,
            swapper: input.walletAddress,
            routerVersion: '2.0',
            expiresAt: input.quoteExpiry,
          }
        : undefined;
    // An absent context is a REFUSAL inside the guard, not a skipped check.
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
    const inputAsset = guardAssetV1(input.intent.fromAsset);
    const outputAsset = guardAssetV1(input.intent.toAsset);
    const context: KyberSwapContext | undefined =
      inputAsset && outputAsset
        ? {
            amountDecimal: input.intent.amount.amountDecimal,
            inputAsset,
            outputAsset,
            swapper: input.walletAddress,
            recipient: input.walletAddress,
            routerAddress: input.routerAddress,
            expiresAt: input.quoteExpiry,
          }
        : undefined;
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
      'Contract/token security verdict for the input token (GoPlus)',
      contractSecurity.status === 'blocked' ? 'failed' : 'passed',
      contractSecurity.status === 'blocked'
        ? (input.contractSecurityResults
            .map((entry) => {
              const reason = tokenSecurityRefusalV1(entry);
              return reason ? `${entry.address} — ${reason}` : null;
            })
            .filter((reason): reason is string => reason !== null)
            .join('; ') || 'No usable GoPlus verdict for the input token')
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
