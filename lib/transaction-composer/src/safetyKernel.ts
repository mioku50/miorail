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
  AssetRefV1,
  ExecutionCallV1,
  HashV1,
  RouteIntentV1,
  SafetyKernelCheckV1,
  SafetyKernelResultV1,
} from '@mioagent/route-domain';
import { SafetyKernelResultV1Schema } from '@mioagent/route-domain';
import { validateGiftTransferV1, type GiftDeclarationV1 } from './gift.js';
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
  /** Fresh read of AllowanceHolder's code and of 0x's registry. Required for
   * o1 because the Settler its order runs is redeployed and can be paused. */
  o1ContractPinVerified?: boolean;
  /** The Settlers the registry vouched for: at build, the ones it named; at
   * approval, the one the stored calls run, confirmed by the same fresh read.
   * Never taken from the order's own bytes. */
  o1Settlers?: readonly string[];
  /** Fresh outer proxy plus selected upstream code-hash/allowlist check. */
  hydrexContractPinVerified?: boolean;
  hydrexUpstreamRouter?: string;
  /** Locally rebuilt Balancer protocol and exact API path provenance. */
  balancer?: BalancerBuildFactsV1;
  /**
   * A gift, as declared: who receives and how many token units. From the
   * prepare request on prepare, and from the stored transfer call on replay
   * and approve. Absent means no transfer call may be in the batch.
   */
  gift?: GiftDeclarationV1 | null;
  /** The swap's guaranteed minimum output — required when a gift is declared,
   * because it is the only amount a gift may send. */
  swapMinimumOutputAtomic?: string | null;
  /**
   * The wallet's balance of the asset this batch spends, read just before the
   * kernel runs, for every swap whether or not it was simulated.
   *
   * 2026-11-18: a 150 USDC swap to PAXG was signed from a wallet holding
   * 125.74 USDC. The KyberSwap route was not simulated, so nothing read the
   * balance; the approve landed and the swap reverted with
   * `TRANSFER_FROM_FAILED`, at the person's gas. The only balance read lived
   * inside the simulation, after a revert.
   *
   * A balance that was not read (`heldAtomic: null`, or no fact at all) is not
   * an empty one, so it never blocks: the check says it was not made.
   */
  spendBalance?: SpendBalanceFactV1 | null;
}

/** What a swap spends, and what the wallet held of it when read. */
export interface SpendBalanceFactV1 {
  /** The asset the batch spends: the intent's input. */
  asset: AssetRefV1;
  /** What the batch spends of it, in atomic units (`swapSpendV1`). */
  spentAtomic: string;
  /** What the wallet holds of it, read now. Null: the read did not come back. */
  heldAtomic: string | null;
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

const ATOMIC_V1 = /^[0-9]+$/;

/**
 * What a swap takes from the wallet: the intent's input asset and amount.
 *
 * The amount is the intent's own, which every approval
 * (`input_amount_matches_intent`) and each provider guard hold the calls to;
 * "all" and "half" reach the composer already as an exact amount, read from
 * the wallet when the swap was written. Native ETH leaves the wallet as call
 * value rather than through an allowance, so for it the ETH the batch sends is
 * counted as well, and the larger of the two is what the wallet must hold. Gas
 * is not counted: the batch does not name it, and a sponsored one costs the
 * wallet none.
 */
export function swapSpendV1(
  intent: RouteIntentV1,
  calls: readonly ExecutionCallV1[],
): { asset: AssetRefV1; amountAtomic: string } | null {
  const asset = intent.fromAsset;
  if (!asset || !ATOMIC_V1.test(intent.amount.amountAtomic)) return null;
  let spent = BigInt(intent.amount.amountAtomic);
  if (asset.kind === 'native') {
    const sent = calls.reduce(
      (total, call) => total + (ATOMIC_V1.test(call.valueWei) ? BigInt(call.valueWei) : 0n),
      0n,
    );
    if (sent > spent) spent = sent;
  }
  return { asset, amountAtomic: spent.toString() };
}

/**
 * An amount in whole tokens, ROUNDED DOWN to `places` decimals, so a balance is
 * never said to be larger than it is. Below one token two significant digits
 * stay, because 0.004 ETH is not an empty wallet. With `places` equal to the
 * token's decimals it is the exact amount.
 */
function tokenAmountDownV1(atomic: bigint, decimals: number, places: number): string {
  const digits = atomic.toString().padStart(decimals + 1, '0');
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = digits.slice(digits.length - decimals);
  const lead = whole === '0' ? fraction.search(/[1-9]/) : -1;
  const shown = fraction.slice(0, Math.min(decimals, Math.max(places, lead + 2))).replace(/0+$/, '');
  return shown ? `${whole}.${shown}` : whole;
}

/**
 * The balance check (`spendBalance` above): passed when the wallet holds at
 * least what the batch spends; failed, in the wallet's own numbers, when it
 * holds less; skipped, and saying so, when the balance was not read.
 *
 * Held to what the batch itself spends as well as to what the fact says, so a
 * fact can only make the check stricter; and a balance of another asset says
 * nothing about this one, so it counts as not read.
 */
function spendBalanceCheckV1(
  intent: RouteIntentV1,
  calls: readonly ExecutionCallV1[],
  fact: SpendBalanceFactV1 | null,
): SafetyKernelCheckV1 {
  const description = 'Your wallet holds at least the amount this swap spends';
  const spend = swapSpendV1(intent, calls);
  if (!spend) {
    return check(
      'wallet_balance_covers_input',
      description,
      'skipped',
      'This swap names no asset it spends, so no balance was read or checked.',
    );
  }
  const { asset } = spend;
  let spentAtomic = BigInt(spend.amountAtomic);
  if (fact && ATOMIC_V1.test(fact.spentAtomic) && BigInt(fact.spentAtomic) > spentAtomic) {
    spentAtomic = BigInt(fact.spentAtomic);
  }
  const spent = tokenAmountDownV1(spentAtomic, asset.decimals, asset.decimals);
  const heldAtomic =
    fact &&
    fact.asset.assetId === asset.assetId &&
    fact.heldAtomic !== null &&
    ATOMIC_V1.test(fact.heldAtomic)
      ? BigInt(fact.heldAtomic)
      : null;
  if (heldAtomic === null) {
    return check(
      'wallet_balance_covers_input',
      description,
      'skipped',
      `This wallet’s ${asset.symbol} balance could not be read just now, so it was not checked. An unread balance is not an empty one; this swap spends ${spent} ${asset.symbol}, and it fails onchain if the wallet holds less.`,
    );
  }
  if (heldAtomic < spentAtomic) {
    // As many places as the amount it is compared with, and at least two.
    const places = Math.max(2, spent.includes('.') ? spent.length - spent.indexOf('.') - 1 : 0);
    const held = tokenAmountDownV1(heldAtomic, asset.decimals, places);
    return check(
      'wallet_balance_covers_input',
      description,
      'failed',
      `This wallet holds ${held} ${asset.symbol}; this swap spends ${spent} ${asset.symbol}.`,
    );
  }
  return check('wallet_balance_covers_input', description, 'passed', null);
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
 * What a verdict that could not be read says — per token, in the provider's
 * own words. "No usable GoPlus verdict for the input token" was said about
 * USDC on 2026-09-24 when the unread token was NVDAc and the reason was
 * GoPlus's rate limit: a sentence about the wrong token, and about the token
 * at all, when it was about the provider. A provider that did not answer must
 * never read as a fact about the token.
 */
function unreadVerdictDetailV1(
  verdicts: ContractSecuritySummaryV1['verdicts'],
  intent: RouteIntentV1,
): string | null {
  const unread = verdicts.filter(
    (verdict) => verdict.provider !== 'goplus' || verdict.status === 'failed' || verdict.status === 'unknown',
  );
  if (unread.length === 0) return null;
  const symbolOf = (address: string): string => {
    for (const asset of [intent.fromAsset, intent.toAsset]) {
      if (asset?.address && asset.address.toLowerCase() === address.toLowerCase()) return `${asset.symbol} ${address}`;
    }
    return address;
  };
  const bySummary = new Map<string, string[]>();
  for (const verdict of unread) {
    const summary = verdict.summary ?? 'no verdict was returned';
    bySummary.set(summary, [...(bySummary.get(summary) ?? []), symbolOf(verdict.address)]);
  }
  return [...bySummary].map(([summary, tokens]) => `${tokens.join(', ')}: ${summary}`).join('; ');
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
  const gift = input.gift ?? null;
  // A declared gift's transfer is checked by its own rule below and is never
  // shown to a provider guard: every guard validates a swap to the wallet and
  // rightly refuses a call to the output token. Everything else — including
  // an UNdeclared transfer — still reaches the guard and fails there too.
  const giftCall = gift ? input.calls.find((call) => call.callType === 'transfer') ?? null : null;
  const swapPartCalls = giftCall ? input.calls.filter((call) => call !== giftCall) : input.calls;
  const baseCalls: BaseCall[] = swapPartCalls.map((call) => ({
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
  const otherCalls = input.calls.filter(
    (call) => call.callType !== 'swap' && call.callType !== 'approval' && call !== giftCall,
  );
  const orderedCorrectly =
    swapCalls.length === 1 &&
    otherCalls.length === 0 &&
    approvalCalls.every((call) => call.index < swapCalls[0]!.index) &&
    (!giftCall || giftCall.index > swapCalls[0]!.index);
  checks.push(
    check(
      'call_order_and_count',
      gift
        ? 'Calls are zero-or-more approvals, exactly one swap, then exactly one gift transfer'
        : 'Calls are exactly zero-or-more approvals followed by exactly one swap call',
      orderedCorrectly ? 'passed' : 'failed',
      orderedCorrectly
        ? null
        : gift
          ? 'Calls must be approvals, one swap and then the one gift transfer, nothing else'
          : 'Calls must contain approvals before exactly one swap call, nothing else',
    ),
  );

  // Present only when the batch is a gift or carries a transfer: an ordinary
  // swap's check list stays exactly what it was.
  if (gift || input.calls.some((call) => call.callType === 'transfer')) {
    const giftCheck = validateGiftTransferV1({
      calls: input.calls,
      intent: input.intent,
      walletAddress: input.walletAddress,
      routerAddress: input.routerAddress,
      gift,
      swapMinimumOutputAtomic: input.swapMinimumOutputAtomic,
    });
    checks.push(
      check(
        'gift_transfer_exact',
        'The gift sends exactly the swap’s guaranteed minimum of the bought token to the declared recipient, and nothing else',
        giftCheck.ok ? 'passed' : 'failed',
        giftCheck.ok ? null : `${giftCheck.code}: ${giftCheck.detail}`,
      ),
    );
  }

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

  // Every swap, simulated or not: the only balance read used to live inside
  // the simulation, after a revert (see `spendBalance`).
  checks.push(spendBalanceCheckV1(input.intent, input.calls, input.spendBalance ?? null));

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
        '0x AllowanceHolder code matches the reviewed pin and 0x’s registry names the Settler',
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
            settlers: input.o1Settlers ?? [],
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
        'o1 calldata: exact one-transaction allowance to the registry’s Settler, which pays the wallet the reviewed minimum (validateO1Swap)',
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
    // The minimum the review states, stored with the calls: the router's own minimums in the bytes must
    // add up to at least it (audit SW-1, 2026-11-14). Without it there is nothing to hold them to.
    const minimum = input.swapMinimumOutputAtomic ?? null;
    const context: UniswapSwapContext | undefined =
      inputAsset && outputAsset && minimum
        ? {
            amountDecimal: input.intent.amount.amountDecimal,
            inputAsset,
            outputAsset,
            swapper: input.walletAddress,
            routerVersion: '2.0',
            expiresAt: input.quoteExpiry,
            minimumOutputAtomic: minimum,
          }
        : undefined;
    // An absent context is a REFUSAL inside the guard, not a skipped check.
    const guard = validateUniswapSwap({ chain: input.chainId, calls: baseCalls, context, now: input.now });
    checks.push(
      check(
        'provider_guard_uniswap',
        'Uniswap router calldata decoded: only swap commands, exactly the reviewed input drawn, every payment to your wallet, and at least the reviewed minimum guaranteed by the router (validateUniswapSwap)',
        guard.success ? 'passed' : 'failed',
        guard.success ? null : `${guard.code}: ${guard.reason}`,
      ),
    );
  } else {
    const inputAsset = guardAssetV1(input.intent.fromAsset);
    const outputAsset = guardAssetV1(input.intent.toAsset);
    const minimum = input.swapMinimumOutputAtomic ?? null;
    const context: KyberSwapContext | undefined =
      inputAsset && outputAsset && minimum
        ? {
            amountDecimal: input.intent.amount.amountDecimal,
            inputAsset,
            outputAsset,
            swapper: input.walletAddress,
            recipient: input.walletAddress,
            routerAddress: input.routerAddress,
            expiresAt: input.quoteExpiry,
            minimumOutputAtomic: minimum,
          }
        : undefined;
    const guard = validateKyberSwap({ chain: input.chainId, calls: baseCalls, context, now: input.now });
    checks.push(
      check(
        'provider_guard_kyberswap',
        'KyberSwap router calldata decoded: exactly the reviewed input drawn, your wallet paid, no fee or permit, and at least the reviewed minimum guaranteed by the router (validateKyberSwap)',
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
      'Contract/token security verdict for every token in the swap (GoPlus)',
      contractSecurity.status === 'blocked' ? 'failed' : 'passed',
      contractSecurity.status === 'blocked'
        ? (input.contractSecurityResults
            .map((entry) => {
              const reason = tokenSecurityRefusalV1(entry);
              return reason ? `${entry.address} — ${reason}` : null;
            })
            .filter((reason): reason is string => reason !== null)
            .join('; ') ||
          unreadVerdictDetailV1(contractSecurity.verdicts, input.intent) ||
          'No usable GoPlus verdict for a token in this swap')
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
  // The schema caps the reason at 500 characters, and the balance check can
  // now fail beside the longest of the others (a simulation that found no
  // funds). A refusal must stay a refusal, never become a parse error.
  const reason = failed.map((entry) => `${entry.id}: ${entry.detail}`).join('; ');
  const result = SafetyKernelResultV1Schema.parse({
    schemaVersion: 'safety-kernel-result/v1',
    verdict,
    checks,
    blockedReason: verdict === 'blocked' ? (reason.length > 500 ? `${reason.slice(0, 499)}…` : reason) : null,
  });
  return { result, contractSecurity };
}
