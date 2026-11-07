// ---------------------------------------------------------------------------
// A Still loan on Morpho as the wallet's own calls to Morpho Blue.
//
// WHY STILL WRITES THESE CALLS ITSELF (operator, 2026-11-07: «да делай прямые
// вызовы для всех кошельков»)
//
// Until 2026-11-07 a loan against cbBTC, WETH or PAXG was prepared by Morpho's
// Actions API as one opaque bundle. That day it changed three things under us,
// and each one stopped every such loan until it was fixed:
// - the name its proof is signed with;
// - an approval for every unit of the collateral token;
// - the borrowed USDC, routed through its BlueBundles contract.
// The bundle also gave BlueBundles the right to act for the wallet inside
// Morpho, "until it is revoked", and it was never revoked. Its calls carried a
// deadline and a share-price bound, so they were new on every read. That is why
// a review asked twice before opening the wallet, and why a loan could not go
// one transaction at a time to a wallet without batches (Rabby).
//
// WHAT THE WALLET CALLS INSTEAD, AND WHY IT NEEDS NO AUTHORIZATION
//
// Morpho Blue, read in its verified source, behaves as follows:
// - `supplyCollateral` and `repay` take tokens from msg.sender only, and anyone
//   may call them for any account. An allowance to Morpho Blue can therefore be
//   spent only by calls this wallet makes itself.
// - `borrow` and `withdrawCollateral` require msg.sender == onBehalf, or a grant.
//   The wallet calling for itself needs no grant to any contract.
//
// So a loan is approve, supplyCollateral, borrow; native ETH is wrapped by the
// wallet itself first. A repayment is approve, repay, and withdrawCollateral to
// take the collateral back. Nothing in these calls depends on the clock. The
// same question at the same position gives the same bytes, which is what lets
// a loan in steps be read again from the chain and compared before each next
// step, as an Aave V4 loan in steps is.
//
// Allowances follow the Aave V4 plan. In one batch the allowance is cleared, set
// to the exact amount, and cleared again after the operation. In steps it is set
// to the exact amount unless it already is exactly that. What a repayment in
// steps leaves of its cap stays with Morpho Blue, which spends it only for this
// wallet's own calls.
// ---------------------------------------------------------------------------

import { encodeAbiParameters, encodeFunctionData, keccak256, parseAbi, type Address, type Hex } from 'viem';
import type { ExecutionCallV1 } from '@mioagent/route-domain';

import type { MorphoBorrowPlanV1, MorphoPlanStepV1 } from './morphoBorrowPlan.js';
import type { MorphoRepayAmountV1 } from './morphoRepayMath.js';
import { MORPHO_BLUE_BASE_V1, MORPHO_REPAY_USDC_BASE_V1, morphoWithdrawCollateralCallV1, type MorphoRepayMarketParamsV1 } from './morphoRepayPlan.js';

/** Base's canonical WETH, which wraps ETH for whoever sends it. */
export const MORPHO_DIRECT_WETH_BASE_V1 = '0x4200000000000000000000000000000000000006' as const;

const MARKET_PARAMS = '(address loanToken,address collateralToken,address oracle,address irm,uint256 lltv) marketParams';
export const MORPHO_DIRECT_ABI_V1 = parseAbi([
  `function supplyCollateral(${MARKET_PARAMS},uint256 assets,address onBehalf,bytes data)`,
  `function borrow(${MARKET_PARAMS},uint256 assets,uint256 shares,address onBehalf,address receiver) returns (uint256 assetsBorrowed,uint256 sharesBorrowed)`,
  `function repay(${MARKET_PARAMS},uint256 assets,uint256 shares,address onBehalf,bytes data) returns (uint256 assetsRepaid,uint256 sharesRepaid)`,
]);
const APPROVE_ABI_V1 = parseAbi(['function approve(address spender,uint256 amount) returns (bool)']);
const WETH_DEPOSIT_ABI_V1 = parseAbi(['function deposit() payable']);

/** A plan whose every call Still wrote and read itself. */
export interface MorphoDirectPlanV1 extends MorphoBorrowPlanV1 {
  /** One batch, or one transaction per call for a wallet that cannot send a batch. */
  forceAtomic: boolean;
}
export type MorphoDirectPlanRefusalV1 = 'morpho_direct_inputs_invalid' | 'morpho_direct_market_mismatch';
export type MorphoDirectPlanResultV1 = { ok: true; plan: MorphoDirectPlanV1 } | { ok: false; refusal: MorphoDirectPlanRefusalV1; detail: string };

const UINT128_MAX = (1n << 128n) - 1n;
const ZERO = '0x0000000000000000000000000000000000000000';
const exactAddress = (value: unknown): Address | null =>
  typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value) && value.toLowerCase() !== ZERO ? value.toLowerCase() as Address : null;
const amount = (value: unknown, positive = false): value is bigint =>
  typeof value === 'bigint' && value >= (positive ? 1n : 0n) && value <= UINT128_MAX;
/** An ERC-20 allowance may be any uint256, an unlimited one from another app included. */
const allowance = (value: unknown): value is bigint => typeof value === 'bigint' && value >= 0n && value < 1n << 256n;

interface ParamsV1 { loanToken: Address; collateralToken: Address; oracle: Address; irm: Address; lltv: bigint }

/** The immutable parameters, bound to the market id they derive, and to USDC as the loan. */
function marketV1(marketId: string, p: MorphoRepayMarketParamsV1): { ok: true; params: ParamsV1 } | { ok: false; refusal: MorphoDirectPlanRefusalV1; detail: string } {
  const loanToken = exactAddress(p?.loanToken), collateralToken = exactAddress(p?.collateralToken), oracle = exactAddress(p?.oracle), irm = exactAddress(p?.irm);
  if (!loanToken || !collateralToken || !oracle || !irm || loanToken !== MORPHO_REPAY_USDC_BASE_V1 ||
      typeof p.lltv !== 'bigint' || p.lltv <= 0n || p.lltv > 10n ** 18n || typeof marketId !== 'string') {
    return { ok: false, refusal: 'morpho_direct_inputs_invalid', detail: 'The exact registered market parameters were not established.' };
  }
  const id = keccak256(encodeAbiParameters(
    [{ type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'uint256' }],
    [loanToken, collateralToken, oracle, irm, p.lltv],
  ));
  if (id !== marketId.toLowerCase()) return { ok: false, refusal: 'morpho_direct_market_mismatch', detail: 'The immutable parameters do not derive this market id.' };
  return { ok: true, params: { loanToken, collateralToken, oracle, irm, lltv: p.lltv } };
}

function assemblerV1(sequential: boolean) {
  const calls: ExecutionCallV1[] = [], steps: MorphoPlanStepV1[] = [];
  function push(call: Omit<ExecutionCallV1, 'index' | 'asset'>, reading: string) {
    const index = calls.length;
    calls.push({ index, ...call, asset: null });
    steps.push({ index, to: call.to, selector: call.data.slice(0, 10), venueDescription: null, decodedByMiorail: true, reading });
  }
  function approve(token: Address, symbol: string, value: bigint, last = false) {
    push({ callType: 'approval', to: token, valueWei: '0', amountAtomic: value.toString(), recipient: null, spender: MORPHO_BLUE_BASE_V1,
      data: encodeFunctionData({ abi: APPROVE_ABI_V1, functionName: 'approve', args: [MORPHO_BLUE_BASE_V1, value] }).toLowerCase() as Hex },
    value === 0n
      ? `${last ? 'Clears this wallet’s' : 'Clears any earlier'} ${symbol} allowance to Morpho Blue${last ? ' again, so none is left standing' : ''}.`
      : sequential
        ? `Allows only Morpho Blue to move up to ${value} atomic units of ${symbol}; the next step uses this allowance, and Morpho Blue takes tokens only in calls this wallet makes itself.`
        : `Allows only Morpho Blue to move up to ${value} atomic units of ${symbol} in this atomic batch; Morpho Blue takes tokens only in calls this wallet makes itself.`);
  }
  function finish(): MorphoDirectPlanResultV1 {
    return { ok: true, plan: { calls, steps, authorizations: [], targets: [...new Set(calls.map(call => call.to))], venueSimulation: null, forceAtomic: !sequential } };
  }
  return { push, approve, finish };
}

/**
 * A loan: the wallet pledges exactly the chosen collateral (wrapping exactly
 * the chosen ETH first, for the WETH market) and borrows exactly the chosen
 * USDC to itself. With no new collateral it is the borrow alone.
 */
export function morphoDirectBorrowPlanV1(input: {
  walletAddress: string;
  marketId: string;
  marketParams: MorphoRepayMarketParamsV1;
  collateralSymbol: string;
  collateralSupplyAssets: bigint;
  borrowAssets: bigint;
  /** Native ETH, wrapped into WETH by the wallet itself before the pledge. */
  nativeSupply?: boolean;
  delivery?: 'atomic' | 'sequential';
  /** For steps: this wallet's allowance of the collateral to Morpho Blue, read at the same block. */
  allowanceAssets?: bigint;
}): MorphoDirectPlanResultV1 {
  const invalid = (detail: string): MorphoDirectPlanResultV1 => ({ ok: false, refusal: 'morpho_direct_inputs_invalid', detail });
  const wallet = exactAddress(input.walletAddress);
  const market = marketV1(input.marketId, input.marketParams);
  if (!market.ok) return market;
  const p = market.params, supply = input.collateralSupplyAssets, native = input.nativeSupply === true, sequential = input.delivery === 'sequential';
  if (!wallet || !amount(supply) || !amount(input.borrowAssets, true) || typeof input.collateralSymbol !== 'string' || !input.collateralSymbol) {
    return invalid('The exact wallet, collateral and positive USDC amount are required.');
  }
  if (native && (p.collateralToken !== MORPHO_DIRECT_WETH_BASE_V1 || supply === 0n)) return invalid('Native ETH is pledged only to the registered WETH market, and only a positive amount.');
  if (sequential && supply > 0n && !allowance(input.allowanceAssets)) return invalid('Steps need the wallet’s current allowance, read at the same block.');
  const batch = assemblerV1(sequential);
  const marketParams = { loanToken: p.loanToken, collateralToken: p.collateralToken, oracle: p.oracle, irm: p.irm, lltv: p.lltv };
  if (native) {
    batch.push({ callType: 'other', to: MORPHO_DIRECT_WETH_BASE_V1, valueWei: supply.toString(), amountAtomic: supply.toString(), recipient: wallet, spender: null,
      data: encodeFunctionData({ abi: WETH_DEPOSIT_ABI_V1, functionName: 'deposit' }).toLowerCase() as Hex },
    `Wraps exactly ${supply} wei of this wallet’s ETH into WETH, kept in this wallet for the pledge that follows.`);
  }
  if (supply > 0n) {
    if (!sequential) { batch.approve(p.collateralToken, input.collateralSymbol, 0n); batch.approve(p.collateralToken, input.collateralSymbol, supply); }
    // The same rule with or without the wrap: once the wrap has landed, the steps left are read again
    // as a WETH pledge, and must come out as exactly the steps approved.
    else if (input.allowanceAssets !== supply) batch.approve(p.collateralToken, input.collateralSymbol, supply);
    batch.push({ callType: 'deposit', to: MORPHO_BLUE_BASE_V1, valueWei: '0', amountAtomic: supply.toString(), recipient: MORPHO_BLUE_BASE_V1, spender: null,
      data: encodeFunctionData({ abi: MORPHO_DIRECT_ABI_V1, functionName: 'supplyCollateral', args: [marketParams, supply, wallet, '0x'] }).toLowerCase() as Hex },
    `Pledges exactly ${supply} atomic units of ${input.collateralSymbol} as this wallet’s collateral in the registered Morpho market. No authorization is granted to any contract.`);
  }
  batch.push({ callType: 'other', to: MORPHO_BLUE_BASE_V1, valueWei: '0', amountAtomic: input.borrowAssets.toString(), recipient: wallet, spender: null,
    data: encodeFunctionData({ abi: MORPHO_DIRECT_ABI_V1, functionName: 'borrow', args: [marketParams, input.borrowAssets, 0n, wallet, wallet] }).toLowerCase() as Hex },
  `Borrows exactly ${input.borrowAssets} atomic USDC from the registered Morpho market, paid straight to this wallet. The wallet calls Morpho Blue itself, so no authorization is granted.`);
  if (supply > 0n && !sequential) batch.approve(p.collateralToken, input.collateralSymbol, 0n, true);
  return batch.finish();
}

/**
 * A repayment: an exact amount, or all of this wallet's debt shares at a cap the
 * person set; then, when asked, the wallet takes its whole collateral back.
 * With no debt left it is the withdrawal alone, and no USDC moves.
 */
export function morphoDirectRepayPlanV1(input: {
  walletAddress: string;
  marketId: string;
  marketParams: MorphoRepayMarketParamsV1;
  amount: MorphoRepayAmountV1;
  /** This wallet's debt shares, read at the same block: what "all" repays. */
  borrowShares: bigint;
  /** The person's cap. For an exact amount it is that amount. */
  maximumAssets: bigint;
  repaying: boolean;
  returnCollateralAssets?: bigint;
  delivery?: 'atomic' | 'sequential';
  /** For steps: this wallet's USDC allowance to Morpho Blue, read at the same block. */
  allowanceAssets?: bigint;
}): MorphoDirectPlanResultV1 {
  const invalid = (detail: string): MorphoDirectPlanResultV1 => ({ ok: false, refusal: 'morpho_direct_inputs_invalid', detail });
  const wallet = exactAddress(input.walletAddress);
  const market = marketV1(input.marketId, input.marketParams);
  if (!market.ok) return market;
  const p = market.params, sequential = input.delivery === 'sequential', back = input.returnCollateralAssets;
  if (!wallet || typeof input.repaying !== 'boolean' || (back !== undefined && !amount(back, true))) return invalid('The exact wallet and collateral to take back are required.');
  if (!input.repaying && back === undefined) return invalid('A plan with no repayment only takes the collateral back.');
  const batch = assemblerV1(sequential);
  const marketParams = { loanToken: p.loanToken, collateralToken: p.collateralToken, oracle: p.oracle, irm: p.irm, lltv: p.lltv };
  if (input.repaying) {
    const all = input.amount.mode === 'all';
    if (!amount(input.maximumAssets, true) || !amount(input.borrowShares, true) ||
        (input.amount.mode === 'assets' ? !amount(input.amount.assets, true) || input.amount.assets !== input.maximumAssets : input.amount.mode !== 'all')) {
      return invalid('An exact positive repayment, or all of a recorded debt within a positive cap, is required.');
    }
    if (sequential && !allowance(input.allowanceAssets)) return invalid('Steps need the wallet’s current allowance, read at the same block.');
    if (!sequential) { batch.approve(MORPHO_REPAY_USDC_BASE_V1, 'USDC', 0n); batch.approve(MORPHO_REPAY_USDC_BASE_V1, 'USDC', input.maximumAssets); }
    else if (input.allowanceAssets !== input.maximumAssets) batch.approve(MORPHO_REPAY_USDC_BASE_V1, 'USDC', input.maximumAssets);
    batch.push({ callType: 'other', to: MORPHO_BLUE_BASE_V1, valueWei: '0', amountAtomic: input.maximumAssets.toString(), recipient: MORPHO_BLUE_BASE_V1, spender: null,
      data: encodeFunctionData({ abi: MORPHO_DIRECT_ABI_V1, functionName: 'repay', args: all
        ? [marketParams, 0n, input.borrowShares, wallet, '0x'] : [marketParams, input.maximumAssets, 0n, wallet, '0x'] }).toLowerCase() as Hex },
    all
      ? `Repays all ${input.borrowShares} debt shares this wallet owes in the registered Morpho market. Morpho Blue takes what they are worth when the transaction lands, never more than the ${input.maximumAssets} atomic USDC allowed${back === undefined ? '; your collateral stays deposited' : ''}.`
      : `Repays exactly ${input.maximumAssets} atomic USDC of this wallet’s debt in the registered Morpho market${back === undefined ? '; your collateral stays deposited' : ''}.`);
    if (!sequential) batch.approve(MORPHO_REPAY_USDC_BASE_V1, 'USDC', 0n, true);
  }
  if (back !== undefined) {
    const out = morphoWithdrawCollateralCallV1({ walletAddress: wallet, marketId: input.marketId, marketParams: input.marketParams, assets: back, index: 0 });
    if (!out.ok) return invalid(out.detail);
    batch.push({ callType: out.call.callType, to: out.call.to, valueWei: out.call.valueWei, data: out.call.data, amountAtomic: out.call.amountAtomic,
      recipient: out.call.recipient, spender: out.call.spender }, out.step.reading);
  }
  return batch.finish();
}
