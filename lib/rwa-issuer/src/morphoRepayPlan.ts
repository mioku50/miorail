import { decodeFunctionData, encodeAbiParameters, encodeFunctionData, keccak256, parseAbi, type Address, type Hex } from 'viem';
import type { ExecutionCallV1 } from '@mioagent/route-domain';
import type { MorphoBorrowPlanV1, MorphoPlanStepV1, PreparedTransactionV1 } from './morphoBorrowPlan.js';
import type { MorphoRepayAmountV1 } from './morphoRepayMath.js';

// Base deployment and ABI checked against the official SDK and Sourcify on
// 2026-10-28. The runtime was compared byte-for-byte with Base eth_getCode.
// This is a direct, non-proxy BlueBundlesV1 entrypoint. Old Bundler3 nesting
// and unrecognised calls are deliberately not accepted by this repay path.
export const MORPHO_BLUE_BUNDLES_BASE_V1 = '0x4d28d900e381ece4b351302f1abe588496793a2b' as const;
export const MORPHO_BLUE_BUNDLES_RUNTIME_HASH_V1 = '0x46e8135ff76a288ffd07a20f507fba7ebd79c698df7ed8737113a2de0974b65a' as const;
export const MORPHO_REPAY_USDC_BASE_V1 = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' as const;
export const MORPHO_REPAY_MAX_UINT256_V1 = (1n << 256n) - 1n;
const MAX_UINT128_V1 = (1n << 128n) - 1n;
const ZERO = '0x0000000000000000000000000000000000000000';
const ZERO_WORD = `0x${'0'.repeat(64)}`;

export const MORPHO_REPAY_BUNDLE_ABI_V1 = parseAbi([
  'function blueBundlesV1RepayAndWithdrawCollateral((address loanToken,address collateralToken,address oracle,address irm,uint256 lltv) marketParams,uint256 repayAssets,uint256 repayShares,uint256 maxRepayAssets,uint256 collateralAssets,uint256 maxLtv,(uint8 kind,bytes data) loanTokenPermit,((uint8 v,bytes32 r,bytes32 s) signature,uint256 nonce,uint256 deadline) signedAuthorization,uint256 referralFeePct,address referralFeeRecipient,uint256 deadline) payable',
]);
export const MORPHO_REPAY_APPROVAL_ABI_V1 = parseAbi(['function approve(address spender,uint256 amount) returns (bool)']);

/** Immutable parameters from the bounded chain reader, which must first bind
 * the market to Still's registered cbBTC/USDC or WETH/USDC identity. */
export interface MorphoRepayMarketParamsV1 {
  loanToken: string;
  collateralToken: string;
  oracle: string;
  irm: string;
  lltv: bigint;
}
export interface MorphoRepayPlanV1 extends MorphoBorrowPlanV1 {
  /** Gross pull bound enforced by the verified deployed contract, not merely
   * the net debit found by one simulation. The wallet must hold this amount. */
  encodedMaximumAssets: bigint;
  deadline: bigint;
  prepareSource: 'verified_protocol_abi' | 'canonical_calldata_guard';
}
export type MorphoRepayPlanRefusalV1 = 'repay_plan_inputs_invalid' | 'repay_runtime_unverified' | 'repay_calls_unreadable' |
  'repay_call_moves_native_value' | 'repay_call_not_allowed' | 'repay_market_mismatch' | 'repay_maximum_mismatch' |
  'repay_amount_mismatch' | 'repay_unrequested_authority' | 'repay_deadline_invalid';
export type MorphoRepayPlanResultV1 = { ok: true; plan: MorphoRepayPlanV1 } |
  { ok: false; refusal: MorphoRepayPlanRefusalV1; detail: string };

const address = (value: unknown): Address | null => typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value) ? value.toLowerCase() as Address : null;
const uint128 = (value: unknown): value is bigint => typeof value === 'bigint' && value >= 0n && value <= MAX_UINT128_V1;
const dataHex = (value: unknown): value is Hex => typeof value === 'string' && /^0x(?:[0-9a-fA-F]{2}){4,}$/.test(value);
const zeroValue = (value: PreparedTransactionV1['value']): boolean => {
  if (value === undefined || value === null || value === '') return true;
  try { return (typeof value !== 'number' || Number.isSafeInteger(value)) && BigInt(value) === 0n; } catch { return false; }
};

/** Fail-closed byte-level binding for repayment. In contrast to the legacy
 * borrow structural reader, every call here must be canonically decoded.
 * A valid venue proof and a current simulation are still required by the
 * runner; neither is replaced by this guard. */
export interface MorphoRepayPlanInputV1 {
  prepared: readonly PreparedTransactionV1[];
  walletAddress: string;
  marketId: string;
  marketParams: MorphoRepayMarketParamsV1;
  amount: MorphoRepayAmountV1;
  maximumAssets: bigint;
  /** Authenticated Actions max_repay_assets, when available. */
  preparedMaximumAssets?: bigint;
  /** Same-block eth_getCode hash, never a venue-supplied assertion. */
  runtimeCodeHash: string;
  now?: Date;
  /** Actions action expiry, distinct from the shorter attestation lifetime. */
  actionExpiresAt?: string;
  venueSimulation?: { reverted: boolean; reason: string | null } | null;
}

export function morphoRepayPlanV1(input: MorphoRepayPlanInputV1): MorphoRepayPlanResultV1 {
  const fail = (refusal: MorphoRepayPlanRefusalV1, detail: string): MorphoRepayPlanResultV1 => ({ ok: false, refusal, detail });
  const wallet = address(input.walletAddress);
  const p = input.marketParams;
  const params = { loanToken: address(p.loanToken), collateralToken: address(p.collateralToken), oracle: address(p.oracle), irm: address(p.irm), lltv: p.lltv };
  const now = (input.now ?? new Date()).getTime();
  if (!wallet || wallet === ZERO || !/^0x[0-9a-fA-F]{64}$/.test(input.marketId) || !Number.isFinite(now) ||
      !params.loanToken || !params.collateralToken || !params.oracle || !params.irm || params.collateralToken === ZERO ||
      params.oracle === ZERO || params.irm === ZERO || params.loanToken !== MORPHO_REPAY_USDC_BASE_V1 || params.collateralToken === params.loanToken ||
      typeof params.lltv !== 'bigint' || params.lltv <= 0n || params.lltv > 10n ** 18n ||
      !uint128(input.maximumAssets) || input.maximumAssets === 0n ||
      (input.amount.mode !== 'assets' && input.amount.mode !== 'all') ||
      (input.amount.mode === 'assets' && (!uint128(input.amount.assets) || input.amount.assets === 0n || input.amount.assets > input.maximumAssets)) ||
      (input.preparedMaximumAssets !== undefined && (!uint128(input.preparedMaximumAssets) || input.preparedMaximumAssets === 0n)) ||
      input.prepared.length < 1 || input.prepared.length > 4) return fail('repay_plan_inputs_invalid', 'The exact repayment identity, amount and maximum were not established.');
  const marketId = keccak256(encodeAbiParameters(
    [{ type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'uint256' }],
    [params.loanToken, params.collateralToken, params.oracle, params.irm, params.lltv],
  ));
  if (marketId !== input.marketId.toLowerCase()) return fail('repay_market_mismatch', 'The immutable parameters do not derive this market id.');
  if (typeof input.runtimeCodeHash !== 'string' || input.runtimeCodeHash.toLowerCase() !== MORPHO_BLUE_BUNDLES_RUNTIME_HASH_V1) return fail('repay_runtime_unverified', 'The Base BlueBundles runtime was not verified at the reading block.');

  const actionIndexes = input.prepared.flatMap((tx, index) => address(tx.to) === MORPHO_BLUE_BUNDLES_BASE_V1 ? [index] : []);
  if (actionIndexes.length !== 1) return fail('repay_call_not_allowed', 'Exactly one pinned BlueBundles repayment is required.');
  const actionIndex = actionIndexes[0]!;
  const final = input.prepared[actionIndex]!;
  const finalTo = address(final.to);
  if (!zeroValue(final.value)) return fail('repay_call_moves_native_value', 'Repayment requested ERC-20 USDC, not native funding.');
  if (finalTo !== MORPHO_BLUE_BUNDLES_BASE_V1 || !dataHex(final.data)) return fail('repay_call_not_allowed', 'The final call is not the pinned Base BlueBundles repayment entrypoint.');
  let decoded: ReturnType<typeof decodeFunctionData<typeof MORPHO_REPAY_BUNDLE_ABI_V1>>;
  try {
    decoded = decodeFunctionData({ abi: MORPHO_REPAY_BUNDLE_ABI_V1, data: final.data });
    if (encodeFunctionData({ abi: MORPHO_REPAY_BUNDLE_ABI_V1, functionName: decoded.functionName, args: decoded.args }).toLowerCase() !== final.data.toLowerCase()) {
      return fail('repay_calls_unreadable', 'The repayment calldata is not canonical or has trailing bytes.');
    }
  } catch { return fail('repay_calls_unreadable', 'The repayment calldata could not be completely decoded.'); }
  const [encoded, repayAssets, repayShares, maxRepayAssets, collateralAssets, maxLtv, permit, authorization, fee, feeRecipient, deadline] = decoded.args;
  if (address(encoded.loanToken) !== params.loanToken || address(encoded.collateralToken) !== params.collateralToken ||
      address(encoded.oracle) !== params.oracle || address(encoded.irm) !== params.irm || encoded.lltv !== params.lltv) {
    return fail('repay_market_mismatch', 'The encoded market differs from the registered chain reading.');
  }
  if (!uint128(maxRepayAssets) || maxRepayAssets === 0n || maxRepayAssets > input.maximumAssets ||
      (input.preparedMaximumAssets !== undefined && maxRepayAssets !== input.preparedMaximumAssets)) {
    return fail('repay_maximum_mismatch', 'The contract pull bound exceeds the signed budget or differs from the authenticated venue maximum.');
  }
  if (input.amount.mode === 'assets' ? repayAssets !== input.amount.assets || repayShares !== 0n || repayAssets > maxRepayAssets
    : repayAssets !== 0n || repayShares !== MORPHO_REPAY_MAX_UINT256_V1) return fail('repay_amount_mismatch', 'The exact-asset repayment or full-position sentinel changed.');
  if (collateralAssets !== 0n || maxLtv !== MORPHO_REPAY_MAX_UINT256_V1 || permit.kind !== 0 || permit.data !== '0x' ||
      authorization.signature.v !== 0 || authorization.signature.r !== ZERO_WORD || authorization.signature.s !== ZERO_WORD ||
      authorization.nonce !== 0n || authorization.deadline !== 0n || fee !== 0n || address(feeRecipient) !== ZERO) {
    return fail('repay_unrequested_authority', 'A repayment must not withdraw collateral, require an oracle/health gate, grant authority, carry a permit or charge a fee.');
  }
  const actionExpiry = input.actionExpiresAt === undefined ? null : Date.parse(input.actionExpiresAt);
  if (deadline <= BigInt(Math.floor(now / 1000)) || deadline > BigInt(Math.floor(now / 1000) + 900) ||
      (actionExpiry !== null && (!Number.isFinite(actionExpiry) || deadline * 1000n !== BigInt(actionExpiry)))) {
    return fail('repay_deadline_invalid', 'The onchain deadline is stale, too distant or differs from the authenticated action expiry.');
  }

  const calls: ExecutionCallV1[] = [];
  const steps: MorphoPlanStepV1[] = [];
  const approvals: bigint[] = [];
  for (const [index, tx] of input.prepared.entries()) {
    const to = address(tx.to);
    if (!zeroValue(tx.value)) return fail('repay_call_moves_native_value', 'A repayment prerequisite sends native value.');
    if (!to || !dataHex(tx.data)) return fail('repay_calls_unreadable', 'A repayment call has unreadable target or calldata.');
    const isFinal = index === actionIndex;
    let approvalAmount: bigint | null = null;
    if (!isFinal) {
      if (to !== MORPHO_REPAY_USDC_BASE_V1) return fail('repay_call_not_allowed', 'Only a USDC approval may precede repayment.');
      try {
        const approval = decodeFunctionData({ abi: MORPHO_REPAY_APPROVAL_ABI_V1, data: tx.data });
        if (encodeFunctionData({ abi: MORPHO_REPAY_APPROVAL_ABI_V1, functionName: 'approve', args: approval.args }).toLowerCase() !== tx.data.toLowerCase()) {
          return fail('repay_calls_unreadable', 'The USDC approval is not canonical.');
        }
        if (address(approval.args[0]) !== MORPHO_BLUE_BUNDLES_BASE_V1 || approval.args[1] > maxRepayAssets) {
          return fail('repay_unrequested_authority', 'The approval names another spender or exceeds the contract pull maximum.');
        }
        approvalAmount = approval.args[1];
        if (index > actionIndex) {
          if (index !== actionIndex + 1 || index !== input.prepared.length - 1 || approvalAmount !== 0n) {
            return fail('repay_unrequested_authority', 'The only call after repayment may revoke the USDC allowance to zero.');
          }
        } else approvals.push(approvalAmount);
      } catch { return fail('repay_call_not_allowed', 'A prerequisite is not the exact supported USDC approval.'); }
    }
    const description = typeof tx.description === 'string' ? tx.description : null;
    const reading = isFinal
      ? `Repays this wallet's ${input.amount.mode === 'all' ? 'entire debt-share balance at inclusion' : `${input.amount.assets} USDC atomic units`} in the exact market, with a gross USDC pull of at most ${maxRepayAssets}. No collateral is withdrawn, no permit or delegation is granted, and unused USDC is refunded.`
      : index > actionIndex ? 'Revokes the USDC allowance to the verified repayment contract after repayment.'
        : `Approves only the verified Base BlueBundles repayment contract for ${approvalAmount} USDC atomic units.`;
    calls.push({ index, callType: isFinal ? 'other' : 'approval', to, data: tx.data.toLowerCase() as Hex, valueWei: '0',
      asset: { kind: 'erc20', chainId: 8453, address: MORPHO_REPAY_USDC_BASE_V1, symbol: 'USDC', decimals: 6,
        assetId: `eip155:8453/erc20:${MORPHO_REPAY_USDC_BASE_V1}` }, amountAtomic: (isFinal ? maxRepayAssets : approvalAmount)!.toString(),
      recipient: isFinal ? wallet : null, spender: isFinal ? null : MORPHO_BLUE_BUNDLES_BASE_V1 });
    steps.push({ index, to, selector: tx.data.slice(0, 10).toLowerCase(), venueDescription: description, decodedByMiorail: true, reading });
  }
  if (approvals.length > 2 || (approvals.length === 1 && approvals[0] === 0n) ||
      (approvals.length === 2 && (approvals[0] !== 0n || approvals[1] === 0n))) {
    return fail('repay_unrequested_authority', 'Repayment permits one bounded approval, optionally preceded by a zero reset.');
  }
  return { ok: true, plan: { calls, steps, targets: [...new Set(calls.map(call => call.to))], authorizations: [],
    venueSimulation: input.venueSimulation ?? null, encodedMaximumAssets: maxRepayAssets, deadline, prepareSource: 'canonical_calldata_guard' } };
}

/** Code-owned repayment-only preparation from the verified protocol ABI.
 * This does not call Actions and must never be described as a venue API's
 * preparation or attestation. Its maximum debit is in the contract bytes;
 * the runner must still independently simulate and prove debt reduction. */
export function buildMorphoRepayPlanV1(input: Omit<MorphoRepayPlanInputV1, 'prepared' | 'preparedMaximumAssets' | 'actionExpiresAt' | 'venueSimulation'>): MorphoRepayPlanResultV1 {
  const fail = (detail: string): MorphoRepayPlanResultV1 => ({ ok: false, refusal: 'repay_plan_inputs_invalid', detail });
  const p = input.marketParams;
  const loanToken = address(p.loanToken), collateralToken = address(p.collateralToken), oracle = address(p.oracle), irm = address(p.irm);
  const at = (input.now ?? new Date()).getTime();
  if (!loanToken || !collateralToken || !oracle || !irm || !Number.isFinite(at) ||
      !uint128(input.maximumAssets) || input.maximumAssets === 0n ||
      (input.amount.mode !== 'assets' && input.amount.mode !== 'all') ||
      (input.amount.mode === 'assets' && (!uint128(input.amount.assets) || input.amount.assets === 0n || input.amount.assets > input.maximumAssets))) {
    return fail('The exact repayment amount and maximum were not established.');
  }
  const encodedMaximum = input.amount.mode === 'assets' ? input.amount.assets : input.maximumAssets;
  const deadline = BigInt(Math.floor(at / 1000) + 300);
  try {
    const approval = (amount: bigint): PreparedTransactionV1 => ({ to: loanToken, value: '0',
      data: encodeFunctionData({ abi: MORPHO_REPAY_APPROVAL_ABI_V1, functionName: 'approve', args: [MORPHO_BLUE_BUNDLES_BASE_V1, amount] }) });
    const action: PreparedTransactionV1 = { to: MORPHO_BLUE_BUNDLES_BASE_V1, value: '0',
      data: encodeFunctionData({ abi: MORPHO_REPAY_BUNDLE_ABI_V1, functionName: 'blueBundlesV1RepayAndWithdrawCollateral', args: [
        { loanToken, collateralToken, oracle, irm, lltv: p.lltv },
        input.amount.mode === 'assets' ? input.amount.assets : 0n,
        input.amount.mode === 'all' ? MORPHO_REPAY_MAX_UINT256_V1 : 0n,
        encodedMaximum, 0n, MORPHO_REPAY_MAX_UINT256_V1,
        { kind: 0, data: '0x' }, { signature: { v: 0, r: ZERO_WORD as Hex, s: ZERO_WORD as Hex }, nonce: 0n, deadline: 0n },
        0n, ZERO, deadline,
      ] }) };
    const guarded = morphoRepayPlanV1({ ...input, now: new Date(at),
      prepared: [approval(0n), approval(encodedMaximum), action, approval(0n)],
      preparedMaximumAssets: encodedMaximum, actionExpiresAt: new Date(Number(deadline) * 1000).toISOString() });
    if (!guarded.ok) return guarded;
    return { ok: true, plan: { ...guarded.plan, prepareSource: 'verified_protocol_abi' } };
  } catch { return fail('The canonical repayment bytes could not be built from the exact inputs.'); }
}
