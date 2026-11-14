import { SPEND_DELIVERY_EMAIL_V1 } from '@mioagent/route-domain';
import type { FreshBorrowReviewV1 } from './borrowReviewFreshness';
import { hasBorrowSigningTermsV1 } from './borrowReviewFreshness';
import { tokenDecimalV1 } from './stockSellAmount';

export interface LendingFactsWireV1 {
  operation: 'borrow' | 'repay'; venue: 'morpho' | 'aave-v4';
  collateralTokenAddress: string; collateralSymbol: string; collateralDecimals: number; marketId: string;
  amountMode: 'assets' | 'all'; requestedAssets: string | null; maximumDebitAssets: string; collateralSupplyAssets: string;
  debtBeforeAssets: string; debtAfterAssets: string; collateralBeforeAssets: string; collateralAfterAssets: string;
  collateralBeforeShares?: string | null; collateralAfterShares?: string | null;
  debtBeforeShares: string | null; debtAfterShares: string | null; blockNumber: number; warnings: string[];
  nativeFunding?: {maximumNativeAssets:string;reserveAssets:string;balanceBeforeAssets:string;balanceAfterAssets:string;authorizedBefore:boolean;feeQuoteState:'wallet_quote_required'};
  healthBeforeWad?: string | null; healthAfterWad?: string | null;
  policyLimitAssets?: string | null; protocolLimitAssets?: string | null; termsVersion?: string | null;
  /** Still Spend: the loan's USDC pays this Bitrefill invoice in the same batch. */
  payment?: { merchant: 'bitrefill'; orderId: string; payTo: string; assets: string; productName: string; packageValue: string; faceCurrency: string | null; expiresAt: string };
  /** Repay all and take the collateral back: what returns to the wallet. */
  collateralReturnAssets?: string;
  /** A new loan: what a fall at once and a pause of the collateral's transfers would do to it. */
  stress?: LendingStressWireV1;
}

// ---------------------------------------------------------------------------
// What a new loan would face if prices fell at once, and if its collateral's
// transfers were paused (operator, 2026-11-13: «да сделать пункты 1 и 3, а
// пункт 2 после проверки на контракте»). Base's Stocks Maxxing brief asks a
// stock-backed loan to "model overnight price gaps and paused collateral
// transfers". The server reads every figure from the simulated position at the
// review's block (api-server lib/lendingStress.ts); this page only prints it.
// ---------------------------------------------------------------------------

export interface LendingStressWireV1 {
  /** What falls in each row: this collateral, the account's only one, or all the collateral it counts. */
  scope: 'collateral' | 'all_collateral';
  scenarios: { fallBps: number; healthWad: string; liquidatable: boolean }[];
  /** How far the collateral can fall at once before liquidation can start, in tenths of a percent; rounded down. */
  marginTenths: number;
  /** One collateral: its price per whole token as the venue reads it, and the price below which liquidation can start, in cents. */
  priceCents: string | null;
  liquidationPriceCents: string | null;
  /** Whether its transfers can be paused, whether they are (read at the review's block; null unread), and whether a liquidation waits for them. */
  transfers: { pausable: boolean; paused: boolean | null; liquidationMovesToken: boolean };
}

/** The stress as the server sent it, or null. An informational block that is not one is not shown, and it
 * never stands between the person and the review it sits on. */
export function lendingStressWireV1(value: unknown): LendingStressWireV1 | null {
  if (!object(value) || (value.scope !== 'collateral' && value.scope !== 'all_collateral')) return null;
  const rows = value.scenarios, t = value.transfers;
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > 6 || !rows.every(row => object(row) && Number.isInteger(row.fallBps) &&
      (row.fallBps as number) > 0 && (row.fallBps as number) < 10_000 && atomic(row.healthWad) && typeof row.liquidatable === 'boolean')) return null;
  if (!Number.isInteger(value.marginTenths) || (value.marginTenths as number) < 0 || (value.marginTenths as number) > 1000) return null;
  if (!(value.priceCents === null || atomic(value.priceCents)) || !(value.liquidationPriceCents === null || atomic(value.liquidationPriceCents))) return null;
  if (value.scope === 'all_collateral' && (value.priceCents !== null || value.liquidationPriceCents !== null)) return null;
  if (!object(t) || typeof t.pausable !== 'boolean' || !(t.paused === null || typeof t.paused === 'boolean') || typeof t.liquidationMovesToken !== 'boolean') return null;
  return {
    scope: value.scope, marginTenths: value.marginTenths as number,
    scenarios: (rows as LendingStressWireV1['scenarios']).map(row => ({ fallBps: row.fallBps, healthWad: row.healthWad, liquidatable: row.liquidatable })),
    priceCents: value.priceCents as string | null, liquidationPriceCents: value.liquidationPriceCents as string | null,
    transfers: { pausable: t.pausable, paused: t.paused as boolean | null, liquidationMovesToken: t.liquidationMovesToken },
  };
}

/** A health ratio to the hundredth, rounded down: the way that does not flatter the loan. */
export function lendingHealthHundredthsV1(wad: string): string {
  const value = BigInt(wad), unit = BigInt(10) ** BigInt(18);
  return `${value / unit}.${((value % unit) * BigInt(100) / unit).toString().padStart(2, '0')}`;
}

function stressDollarsV1(cents: string): string {
  const value = BigInt(cents), hundred = BigInt(100);
  return `$${(value / hundred).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${(value % hundred).toString().padStart(2, '0')}`;
}

/** How far the collateral can fall at once before liquidation can start: the block's one large figure. */
export function lendingStressFigureV1(stress: LendingStressWireV1): string {
  return `${Math.floor(stress.marginTenths / 10)}.${stress.marginTenths % 10}%`;
}

/** What that figure is, said beside it. */
export function lendingStressFigureLabelV1(facts: Pick<LendingFactsWireV1, 'collateralSymbol'>, stress: LendingStressWireV1): string {
  return stress.scope === 'all_collateral'
    ? 'All your collateral here can fall this much together before liquidation can start.'
    : `${facts.collateralSymbol} can fall this much at once before liquidation can start.`;
}

/** One collateral: the price below which liquidation can start, beside the price the venue reads now. */
export function lendingStressPriceTextV1(facts: Pick<LendingFactsWireV1, 'collateralSymbol' | 'venue'>, stress: LendingStressWireV1): string | null {
  if (stress.scope !== 'collateral' || stress.liquidationPriceCents === null || stress.priceCents === null) return null;
  return `The line is ${stressDollarsV1(stress.liquidationPriceCents)} per ${facts.collateralSymbol}; it is ${stressDollarsV1(stress.priceCents)} now, on the price ${facts.venue === 'aave-v4' ? 'Aave' : 'Morpho'} reads.`;
}

/** Why a fall can come at once, and what Still does about it. */
export function lendingStressGapTextV1(facts: Pick<LendingFactsWireV1, 'venue'>): string {
  return facts.venue === 'aave-v4'
    ? 'Stock prices can jump: after a weekend, a holiday or a night, the first new price can be far from the last one, with no moment between to repay. Still lends at most half of what Aave would, and less while Wall Street is closed or around earnings, so that a jump like these leaves room.'
    : 'A price can fall faster than anyone can repay. Still lends at most half of what Morpho would, so that a fall like these leaves room.';
}

/** What a pause of the collateral's transfers would do to this loan, as the contracts were read. */
export function lendingStressPauseTextV1(facts: Pick<LendingFactsWireV1, 'collateralSymbol' | 'venue' | 'blockNumber'>, stress: LendingStressWireV1): string {
  const s = facts.collateralSymbol, t = stress.transfers, block = facts.blockNumber.toLocaleString('en-US');
  if (!t.pausable) return `${s} has no pause: nobody can stop its transfers.`;
  const now = t.paused === null ? 'Still could not read whether they are paused now.'
    : t.paused ? `They are paused now (Base block ${block}).` : `They are not paused now (Base block ${block}).`;
  const liquidation = t.liquidationMovesToken
    ? `So does a liquidation, because ${facts.venue === 'aave-v4' ? 'Aave' : 'Morpho'} hands ${s} to the liquidator; once transfers resume, one can follow at once if the price has fallen far enough.`
    : 'A liquidation does not wait: Aave lets a liquidator take your deposit inside Aave, with no transfer.';
  return `${s}’s issuer can pause its transfers onchain. ${now} During a pause, repaying still works, because it moves only USDC, and taking ${s} back waits until transfers resume. ${liquidation}`;
}

export interface LendingReadyWireV1 extends FreshBorrowReviewV1 {
  state: 'ready'; facts: LendingFactsWireV1; executionId: string;
  calls: { to: string; value: string; data: string }[];
  callsHash: string; signingTermsHash: string; expiresAt: string;
  /** One batch, or, granted by the server for a wallet without batches, one transaction per call. */
  atomicRequired: boolean; delivery?: 'sequential';
  steps: { index: number; to: string; reading: string }[];
  measured: { provider: string; blockNumber: number; loanDeltaAssets: string };
  /** Still Spend: where Bitrefill sends what the loan pays for, as the open invoice holds it. */
  deliverTo?: SpendDeliveryWireV1;
  /** Still Spend: the invoice was opened with Still's affiliate code, so Bitrefill may pay Still a commission. */
  commission?: true;
}
/** The email Bitrefill sends a purchase to, and the number a top-up goes to. Fixed when the invoice was opened. */
export interface SpendDeliveryWireV1 { email: string; phone: string | null }
/** Reads a delivery as the server gave it, or null: nothing is shown from a shape that is not one. */
export function spendDeliveryWireV1(value: unknown): SpendDeliveryWireV1 | null {
  if (!object(value) || typeof value.email !== 'string' || value.email.length > 254 || !SPEND_DELIVERY_EMAIL_V1.test(value.email) ||
      // In full on the owner's own page; inside an assistant's card the server shows only their ends.
      !(value.phone === null || (typeof value.phone === 'string' && /^\+(?:\d{7,15}|…\d{4})$/.test(value.phone)))) return null;
  return { email: value.email, phone: value.phone };
}
export type LendingReviewWireV1 = LendingReadyWireV1 | { state: 'refused'; refusal: string; detail: string; facts?: LendingFactsWireV1;
  executionId?: string; executionState?: LendingExecutionStateV1;
  /** An earlier attempt of this review stopped before it paid its invoice, which the wallet can still pay. */
  walletPay?: { orderId: string } };
export type LendingExecutionStateV1 = 'ready' | 'awaiting_wallet' | 'submitted' | 'unknown' | 'confirmed' | 'failed';
export interface LendingExecutionWireV1 {
  executionId: string; state: LendingExecutionStateV1;
  transactionHash: string | null; errorCode: string | null;
  /** Still Spend: a confirmed loan that paid an invoice offers its owner a card to share. */
  share?: { path: string } | null;
  /** A loan in steps: how many landed, of how many, and whether its owner can stop it there. */
  steps?: { landed: number; total: number; stoppable: boolean } | null;
  /** One sent as a single batch that its wallet may never have sent: whether its owner can ask to
   * release it now, and from when (ten minutes after the review's own time ran out). */
  release?: { offered: boolean; from: string } | null;
  /** A confirmed Repay all on Aave V4 that left interest owing: how much, in USDC base units. */
  remainingDebtAtomic?: string | null;
  /** Confirmed, and at its receipt the position was moved by another hand too (audit LM-1). */
  positionMovedOutside?: boolean;
  /** Still Spend: a loan in steps that stopped before its payment, whose Bitrefill invoice is still open
   * for the wallet to pay from its own USDC. */
  walletPay?: { orderId: string } | null;
}
const spendOrderId = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
/** The wallet-pay offer as the server sent it, or null: an order id that is not one is no offer. */
export function spendWalletPayWireV1(value: unknown): { orderId: string } | null {
  return value !== null && typeof value === 'object' && spendOrderId((value as { orderId?: unknown }).orderId) ? { orderId: (value as { orderId: string }).orderId } : null;
}
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 2000;
const atomic = (value: unknown): value is string => typeof value === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(value);
const address = (value: unknown): value is string => typeof value === 'string' && /^0x[0-9a-f]{40}$/i.test(value);
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
const id = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,200}$/.test(value);

export function isLendingFactsWireV1(value: unknown): value is LendingFactsWireV1 {
  if (!object(value)) return false;
  if (value.payment !== undefined) {
    const p = value.payment;
    if (!object(p) || value.operation !== 'borrow' || value.nativeFunding !== undefined || p.merchant !== 'bitrefill' || !address(p.payTo) ||
      !atomic(p.assets) || p.assets !== value.requestedAssets || !text(p.productName) || !text(p.packageValue) ||
      typeof p.orderId !== 'string' || !/^[0-9a-f-]{36}$/.test(p.orderId) || typeof p.expiresAt !== 'string' || !Number.isFinite(Date.parse(p.expiresAt)) ||
      !(p.faceCurrency === null || typeof p.faceCurrency === 'string' && /^[A-Z]{3}$/.test(p.faceCurrency))) return false;
  }
  if (value.collateralReturnAssets !== undefined && (!atomic(value.collateralReturnAssets) || BigInt(value.collateralReturnAssets) <= BigInt(0) ||
      value.operation !== 'repay' || value.amountMode !== 'all')) return false;
  if (value.nativeFunding !== undefined) {
    const n=value.nativeFunding;
    if (!object(n) || value.operation!=='borrow' || value.venue!=='morpho' || value.collateralTokenAddress!=='0x4200000000000000000000000000000000000006' ||
      value.collateralDecimals!==18 || !['maximumNativeAssets','reserveAssets','balanceBeforeAssets','balanceAfterAssets'].every(k=>atomic(n[k])) ||
      n.maximumNativeAssets!==value.collateralSupplyAssets || BigInt(n.maximumNativeAssets as string)<=BigInt(0) || BigInt(n.reserveAssets as string)<=BigInt(0) ||
      BigInt(n.balanceBeforeAssets as string)-BigInt(n.maximumNativeAssets as string)!==BigInt(n.balanceAfterAssets as string) ||
      BigInt(n.balanceAfterAssets as string)<BigInt(n.reserveAssets as string) || typeof n.authorizedBefore!=='boolean' || n.feeQuoteState!=='wallet_quote_required') return false;
  }
  return (value.operation === 'borrow' || value.operation === 'repay') && (value.venue === 'morpho' || value.venue === 'aave-v4') &&
    address(value.collateralTokenAddress) && text(value.collateralSymbol) && text(value.marketId) &&
    Number.isInteger(value.collateralDecimals) && (value.collateralDecimals as number) >= 0 && (value.collateralDecimals as number) <= 36 &&
    (value.amountMode === 'assets' || value.amountMode === 'all') && (value.requestedAssets === null || atomic(value.requestedAssets)) &&
    ['maximumDebitAssets', 'collateralSupplyAssets', 'debtBeforeAssets', 'debtAfterAssets', 'collateralBeforeAssets', 'collateralAfterAssets'].every(k => atomic(value[k])) &&
    ['debtBeforeShares', 'debtAfterShares'].every(k => value[k] === null || atomic(value[k])) && integer(value.blockNumber) &&
    ['collateralBeforeShares', 'collateralAfterShares', 'healthBeforeWad', 'healthAfterWad', 'policyLimitAssets', 'protocolLimitAssets'].every(k => value[k] === undefined || value[k] === null || atomic(value[k])) &&
    (value.termsVersion === undefined || value.termsVersion === null || text(value.termsVersion)) &&
    Array.isArray(value.warnings) && value.warnings.every(text);
}
/** A refused response cannot retain calls, even if a malformed upstream
 * response attached them. Signing requires the entire bounded ready union. */
export function parseLendingReviewWireV1(value: unknown): LendingReviewWireV1 | null {
  if (!object(value)) return null;
  if (value.state === 'refused' && text(value.refusal) && text(value.detail)) return { state: 'refused', refusal: value.refusal, detail: value.detail,
    ...(isLendingFactsWireV1(value.facts) ? { facts: value.facts } : {}), ...(id(value.executionId) ? { executionId: value.executionId } : {}),
    ...(['ready', 'awaiting_wallet', 'submitted', 'unknown', 'confirmed', 'failed'].includes(String(value.executionState)) ? { executionState: value.executionState as LendingExecutionStateV1 } : {}),
    ...(spendWalletPayWireV1(value.walletPay) ? { walletPay: spendWalletPayWireV1(value.walletPay)! } : {}) };
  if (value.state !== 'ready' || !hasBorrowSigningTermsV1(value as FreshBorrowReviewV1, 8) || !isLendingFactsWireV1(value.facts) ||
      !id(value.executionId) || !Array.isArray(value.calls) || !value.calls.every(c => object(c) && atomic(c.value)) ||
      !Array.isArray(value.steps) || value.steps.length !== value.calls.length || !value.steps.every((s, index) => object(s) && s.index === index && address(s.to) &&
        (value.calls as { to: string }[])[index]?.to.toLowerCase() === s.to.toLowerCase() && text(s.reading)) ||
      !object(value.measured) || !text(value.measured.provider) || !integer(value.measured.blockNumber) ||
      typeof value.measured.loanDeltaAssets !== 'string' || !/^-?(0|[1-9][0-9]{0,77})$/.test(value.measured.loanDeltaAssets)) return null;
  const native = value.facts.nativeFunding;
  // Steps only where the server grants them: an Aave V4 action without native ETH,
  // and since 2026-11-07 any Morpho one, which is the wallet's own calls to Morpho
  // Blue; a Spend payment goes last, to Base USDC.
  const delivered = value.atomicRequired === true ? value.delivery === undefined
    : value.atomicRequired === false && value.delivery === 'sequential' && (value.facts.venue === 'morpho' || (value.facts.venue === 'aave-v4' && !native)) &&
      (!value.facts.payment || (value.calls as { to: string }[]).at(-1)?.to.toLowerCase() === USDC_BASE);
  if (!delivered) return null;
  const calls=value.calls as {to:string;value:string;data:string}[];
  if (!native) {
    if(calls.some(c=>c.value!=='0')) return null;
  } else {
    // Native ETH (2026-11-07): the wallet's own wrap of exactly the chosen ETH into Base WETH comes first;
    // every other call moves no ETH and goes to WETH or Morpho Blue. No bundle, no authorization.
    const funded = calls.filter(c => c.value !== '0');
    if (value.facts.venue !== 'morpho' || funded.length !== 1 || calls[0] !== funded[0] || funded[0]!.to.toLowerCase() !== WETH_BASE ||
        funded[0]!.value !== native.maximumNativeAssets ||
        calls.some(c => c !== funded[0] && c.to.toLowerCase() !== WETH_BASE && c.to.toLowerCase() !== MORPHO_BLUE)) return null;
  }
  // Shown only as the server gave it, and only beside a payment.
  const deliverTo = value.facts.payment ? spendDeliveryWireV1(value.deliverTo) : null;
  const commission = Boolean(value.facts.payment) && (value as { commission?: unknown }).commission === true;
  const { deliverTo: _given, commission: _said, ...rest } = value as Record<string, unknown>;
  void _given; void _said;
  // The stress of a new loan, only in the shape the server writes it; any other is left out, not the review.
  const { stress: given, ...facts } = value.facts;
  const stress = value.facts.operation === 'borrow' && given !== undefined ? lendingStressWireV1(given) : null;
  return { ...(rest as unknown as LendingReadyWireV1), facts: { ...facts, ...(stress ? { stress } : {}) }, ...(deliverTo ? { deliverTo } : {}),
    ...(commission ? { commission: true as const } : {}) };
}
export function parseLendingExecutionWireV1(value: unknown, executionId: string): LendingExecutionWireV1 | null {
  if (!object(value) || value.executionId !== executionId || !id(value.executionId) ||
      !['ready', 'awaiting_wallet', 'submitted', 'unknown', 'confirmed', 'failed'].includes(String(value.state)) ||
      (value.transactionHash !== null && (typeof value.transactionHash !== 'string' || !/^0x[0-9a-f]{64}$/i.test(value.transactionHash))) ||
      (value.errorCode !== null && !text(value.errorCode)) || (value.steps != null && !stepsStanding(value.steps)) ||
      (value.release != null && !(object(value.release) && typeof value.release.offered === 'boolean' && text(value.release.from) && Number.isFinite(Date.parse(value.release.from)))) ||
      (value.remainingDebtAtomic != null && !(atomic(value.remainingDebtAtomic) && value.remainingDebtAtomic !== '0'))) return null;
  return { ...(value as unknown as LendingExecutionWireV1), walletPay: spendWalletPayWireV1(value.walletPay),
    positionMovedOutside: value.state === 'confirmed' && value.positionMovedOutside === true };
}
function stepsStanding(value: unknown): boolean {
  return object(value) && Number.isSafeInteger(value.landed) && Number.isSafeInteger(value.total) && typeof value.stoppable === 'boolean' &&
    (value.landed as number) >= 0 && (value.total as number) >= 1 && (value.total as number) <= 16 && (value.landed as number) <= (value.total as number);
}

// ---------------------------------------------------------------------------
// The result is read without a press (operator, 2026-11-12: «вместо кнопки
// check onchain result авто результат»).
//
// A loan, a repayment or a take-back stayed "Submitted" until its owner pressed
// "Check onchain result" or did the next thing in that market. On 2026-11-07 a
// PAXG take-back that had landed was still "submitted" an hour later. Still's
// Spend page already reads a wallet payment by itself; this page now does too.
//
// The reads come quickly at first, because Base lands a batch in seconds, then
// further apart, for 103 seconds in all. If Base has not answered by then, the
// press is offered again: what the wallet is doing is not visible from here.
// ---------------------------------------------------------------------------

/** The waits before each automatic read, in milliseconds: 103 seconds in all. */
export const LENDING_FOLLOW_MS_V1: readonly number[] = [2_000, 3_000, 4_000, 5_000, 6_000, 8_000, 10_000, 15_000, 20_000, 30_000];

/**
 * Whether the page reads this result again by itself: Base has given no final answer yet, and
 * Still has something to read there. A submitted record always has a handle. One unknown or
 * still armed has one only when the wallet named a batch or a transaction: without one, a read
 * changes nothing, and the page offers a pasted hash and the release instead.
 */
export function lendingFollowsResultV1(input: {
  state: LendingExecutionStateV1 | null;
  batchId: string | null;
  transactionHash: string | null;
}): boolean {
  if (input.state === 'submitted') return true;
  if (input.state === 'unknown' || input.state === 'awaiting_wallet') return Boolean(input.batchId || input.transactionHash);
  return false;
}
/** Said of a confirmed result whose position another hand moved too (audit LM-1): what the receipt proves
 * stands, and what the position holds now is not what the review showed. */
export const LENDING_MOVED_OUTSIDE_COPY_V1 = 'Your position also changed outside this review around then: a liquidation, a repayment or pledge someone made for this wallet, or something done in the protocol’s own app. What it holds now differs from what this review showed, so check it on Home before your next step.';
export function lendingExecutionCopyV1(state: LendingExecutionStateV1, errorCode: string | null = null, remainingDebtAtomic: string | null = null,
  movedOutside = false): string {
  // A Repay all that landed and left a little owing (audit LEND-2): said as that, with the amount.
  if (state === 'confirmed' && remainingDebtAtomic !== null && atomic(remainingDebtAtomic) && remainingDebtAtomic !== '0') {
    const micro = BigInt(remainingDebtAtomic), fraction = (micro % BigInt(1_000_000)).toString().padStart(6, '0').replace(/0+$/, '');
    const owing = `${micro / BigInt(1_000_000)}${fraction ? `.${fraction}` : ''} USDC`;
    // With another hand in the position, what is left is not only interest.
    return movedOutside ? `Confirmed onchain: the repayment landed, and ${owing} is still owing: repay it to close the loan. ${LENDING_MOVED_OUTSIDE_COPY_V1}`
      : `Confirmed onchain: the repayment landed. Interest that added to the debt until it landed left ${owing} owing: repay it to close the loan.`;
  }
  if (state === 'confirmed' && movedOutside) return `Confirmed onchain: the approved calls landed exactly as reviewed. ${LENDING_MOVED_OUTSIDE_COPY_V1}`;
  // A loan in steps that stopped on purpose is final with what landed, not a revert.
  if (state === 'failed' && errorCode === 'loan_steps_stopped') return 'Stopped part way: the steps that landed are in place on Base, and the rest was never sent. You can repay or start a new review now.';
  // Released by its owner: no transaction exists, so nothing reverted (audit LEND-1).
  if (state === 'failed' && errorCode === 'loan_wallet_sent_nothing') return 'Released as not sent: Base shows your wallet has sent nothing since this review, so it borrowed and repaid nothing. You can start a new review now.';
  switch (state) {
    case 'ready': return 'The review is ready. Nothing has been submitted.';
    case 'awaiting_wallet': return 'A wallet request was armed. Its outcome is not yet confirmed. This review will not be sent again.';
    case 'submitted': return 'Submitted from your wallet. The blockchain result has not been confirmed yet.';
    case 'unknown': return 'The submission result is unknown. Check your wallet activity and the onchain result before taking another action.';
    case 'confirmed': return 'Confirmed onchain: the approved calls and the resulting position were verified.';
    case 'failed': return 'The transaction or this wallet’s operation reverted onchain. Read the result before taking another action.';
  }
}

const NO_DEBT_HEALTH_SENTINEL = BigInt(1) << BigInt(128);
const HEALTH_HUNDREDTH_WAD = BigInt(10) ** BigInt(16);
/** As the server's bucket: from 100 up the ratio is "far from liquidation", one bucket. */
const HEALTH_FAR_WAD = BigInt(100) * BigInt(10) ** BigInt(18);
const USDC_BASE = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const WETH_BASE = '0x4200000000000000000000000000000000000006';
const MORPHO_BLUE = '0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb';
const MORPHO_BUNDLER = '0x4d28d900e381ece4b351302f1abe588496793a2b';

export function materialLendingHealthBucketV1(value: string | null | undefined, debtAssets: string): string | null {
  if (debtAssets === '0' || value == null) return null;
  try {
    const parsed = BigInt(value);
    if (parsed < BigInt(0) || parsed >= NO_DEBT_HEALTH_SENTINEL) return null;
    if (parsed >= HEALTH_FAR_WAD) return 'far';
    return (parsed / HEALTH_HUNDREDTH_WAD).toString();
  } catch {
    return null;
  }
}

export function formatLendingHealthRatioV1(
  value: string | null | undefined,
  debtAssets: string,
  operation: 'borrow' | 'repay' = 'borrow',
): string {
  if (debtAssets === '0') return '— No debt (N/A)';
  if (value == null) return operation === 'repay' ? '— Not applicable (repayment only reduces debt)' : 'Not read';
  try {
    if (BigInt(value) >= NO_DEBT_HEALTH_SENTINEL) return '— No debt (N/A)';
  } catch {
    return operation === 'repay' ? '— Not applicable (repayment only reduces debt)' : 'Not read';
  }
  return tokenDecimalV1(value, 18);
}

export function labelLendingTargetV1(to: string, facts: LendingFactsWireV1): string {
  const lower = to.toLowerCase();
  if (lower === facts.collateralTokenAddress.toLowerCase()) return `${facts.collateralSymbol} token`;
  if (lower === USDC_BASE) return 'USDC token';
  if (facts.venue === 'aave-v4' && lower === facts.marketId.toLowerCase()) return 'Aave V4 Spoke';
  if (lower === MORPHO_BLUE) return 'Morpho Blue';
  if (lower === MORPHO_BUNDLER) return 'Morpho BlueBundlesV1';
  return 'Verified contract';
}

/** What a person reads on a ready review, as one comparable value: every
 * figure, every limit, the health ratio as it is weighed (to the hundredth),
 * the money that moves and each wallet step with its target.
 * Left out: the clock, the block, debt shares, and the calls' own bytes. A
 * loan's calls carry a deadline and a share-price bound, so the bytes are new
 * on every read (2026-11-07: two Morpho preparations three seconds apart
 * differed in those two words only). The call count, targets and values stay
 * in. The figures that move by themselves between two reads (a debt that
 * accrues, a limit that follows a live price, a risk note that states a
 * distance) are compared apart, each with its own measure of "the same". */
function lendingReadingV1(body: LendingReadyWireV1): string {
  const f = body.facts;
  return JSON.stringify({
    operation: f.operation, venue: f.venue, token: f.collateralTokenAddress.toLowerCase(), symbol: f.collateralSymbol, decimals: f.collateralDecimals,
    market: f.marketId.toLowerCase(), mode: f.amountMode, requested: f.requestedAssets, maximum: f.maximumDebitAssets, supply: f.collateralSupplyAssets,
    collateral: [f.collateralBeforeAssets, f.collateralAfterAssets],
    health: [materialLendingHealthBucketV1(f.healthBeforeWad, f.debtBeforeAssets), materialLendingHealthBucketV1(f.healthAfterWad, f.debtAfterAssets)],
    terms: f.termsVersion ?? null,
    native: f.nativeFunding ? [f.nativeFunding.maximumNativeAssets, f.nativeFunding.reserveAssets, f.nativeFunding.authorizedBefore, f.nativeFunding.feeQuoteState] : null,
    payment: f.payment ? [f.payment.orderId, f.payment.payTo.toLowerCase(), f.payment.assets] : null,
    back: f.collateralReturnAssets ?? null,
    delivery: [body.atomicRequired, body.delivery ?? null],
    steps: body.steps.map(step => [step.index, step.to.toLowerCase(), step.reading]),
    calls: body.calls.map(call => [call.to.toLowerCase(), call.value]),
  });
}

const BPS_SCALE_V1 = BigInt(10_000);
/** A debt between two reads a few seconds apart: one part in a million, or a hundredth of a cent, whichever
 * is more. A minute of interest at 10% a year is a fifth of that; a second loan or a repayment is far past it. */
const DEBT_DRIFT_PER_MILLION_V1 = BigInt(1);
const DEBT_DRIFT_FLOOR_ASSETS_V1 = BigInt(100);
/** A debt ceiling that follows a live price: 1%. Wall Street moves a stock that far in seconds only when
 * something happened, and then the person is asked again. */
const LIMIT_DRIFT_BPS_V1 = BigInt(100);
/** A distance a risk note states ("a 49.9% fall liquidates this"): half a point. */
const NOTE_DRIFT_V1 = 0.5;

function unitsV1(value: string | null | undefined): bigint | null {
  if (value == null || !/^\d+$/.test(value)) return null;
  return BigInt(value);
}

/** The same debt to a reader: equal, or apart by no more than interest accrues between two reads. */
function sameDebtV1(a: string | null | undefined, b: string | null | undefined): boolean {
  if ((a ?? null) === (b ?? null)) return true;
  const x = unitsV1(a), y = unitsV1(b);
  if (x === null || y === null) return false;
  const apart = x > y ? x - y : y - x, larger = x > y ? x : y;
  const allowed = (larger * DEBT_DRIFT_PER_MILLION_V1) / BigInt(1_000_000);
  return apart <= (allowed > DEBT_DRIFT_FLOOR_ASSETS_V1 ? allowed : DEBT_DRIFT_FLOOR_ASSETS_V1);
}

/** The same ceiling to a reader: equal, or moved by a hair with the debt after this loan still on the same
 * side of it. A ceiling the loan no longer fits under is never the same. */
function sameLimitV1(a: string | null | undefined, b: string | null | undefined, debtAfter: string): boolean {
  if ((a ?? null) === (b ?? null)) return true;
  const x = unitsV1(a), y = unitsV1(b), needed = unitsV1(debtAfter);
  if (x === null || y === null || needed === null) return false;
  if ((x < needed) !== (y < needed)) return false;
  const apart = x > y ? x - y : y - x, larger = x > y ? x : y;
  return apart * BPS_SCALE_V1 <= larger * LIMIT_DRIFT_BPS_V1;
}

/** The same risk notes to a reader: the same sentences, in the same order, whose numbers are each within
 * half a point. A note that appears, disappears or says something else is not the same. */
function sameNotesV1(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const NUMBER = /\d+(?:\.\d+)?/g;
  return a.every((note, index) => {
    const other = b[index]!;
    if (note === other) return true;
    if (note.replace(NUMBER, '#') !== other.replace(NUMBER, '#')) return false;
    const mine = note.match(NUMBER) ?? [], theirs = other.match(NUMBER) ?? [];
    return mine.length === theirs.length && mine.every((value, at) => Math.abs(Number(value) - Number(theirs[at])) <= NOTE_DRIFT_V1);
  });
}

/**
 * Whether a fresh review reads as the one the person pressed on, so that its
 * calls, prepared again for this moment, can go to the wallet with no second
 * press: the person has read every term these calls carry.
 *
 * What the person chose and what the calls do must be exactly the same. What
 * only moves with time is the same within its own measure. Until 2026-11-11
 * every figure had to be equal to the unit, and during market hours a stock's
 * debt ceiling moves with its price every few seconds: the first press of a
 * loan against AAPL answered "The terms changed" in red, for a ceiling a
 * fraction of a cent away, and the person had to think of pressing again.
 */
export function lendingReviewReadsTheSameV1(previous: LendingReadyWireV1, next: LendingReadyWireV1): boolean {
  if (previous.state !== 'ready' || next.state !== 'ready' || lendingReadingV1(previous) !== lendingReadingV1(next)) return false;
  const p = previous.facts, n = next.facts;
  return sameDebtV1(p.debtBeforeAssets, n.debtBeforeAssets) && sameDebtV1(p.debtAfterAssets, n.debtAfterAssets) &&
    sameDebtV1(previous.measured?.loanDeltaAssets, next.measured?.loanDeltaAssets) &&
    sameLimitV1(p.policyLimitAssets, n.policyLimitAssets, n.debtAfterAssets) &&
    sameLimitV1(p.protocolLimitAssets, n.protocolLimitAssets, n.debtAfterAssets) &&
    sameNotesV1(p.warnings, n.warnings);
}

export function describeLendingTermsChangesV1(previous: LendingReadyWireV1, next: LendingReadyWireV1): string {
  const p = previous.facts, n = next.facts;
  const usdc = (v: string) => `${tokenDecimalV1(v, 6)} USDC`;
  const asset = (v: string) => `${tokenDecimalV1(v, n.collateralDecimals)} ${n.collateralSymbol}`;
  const changes: string[] = [];
  if (p.debtBeforeAssets !== n.debtBeforeAssets) {
    changes.push(`debt before (${usdc(p.debtBeforeAssets)} → ${usdc(n.debtBeforeAssets)})`);
  }
  if (p.debtAfterAssets !== n.debtAfterAssets) {
    changes.push(`simulated debt after (${usdc(p.debtAfterAssets)} → ${usdc(n.debtAfterAssets)})`);
  }
  if (p.collateralBeforeAssets !== n.collateralBeforeAssets) {
    changes.push(`collateral before (${asset(p.collateralBeforeAssets)} → ${asset(n.collateralBeforeAssets)})`);
  }
  if (p.collateralAfterAssets !== n.collateralAfterAssets) {
    changes.push(`simulated collateral after (${asset(p.collateralAfterAssets)} → ${asset(n.collateralAfterAssets)})`);
  }
  const hBeforePrev = formatLendingHealthRatioV1(p.healthBeforeWad, p.debtBeforeAssets, p.operation);
  const hBeforeNext = formatLendingHealthRatioV1(n.healthBeforeWad, n.debtBeforeAssets, n.operation);
  if (materialLendingHealthBucketV1(p.healthBeforeWad, p.debtBeforeAssets) !== materialLendingHealthBucketV1(n.healthBeforeWad, n.debtBeforeAssets)) {
    changes.push(`health ratio before (${hBeforePrev} → ${hBeforeNext})`);
  }
  const hAfterPrev = formatLendingHealthRatioV1(p.healthAfterWad, p.debtAfterAssets, p.operation);
  const hAfterNext = formatLendingHealthRatioV1(n.healthAfterWad, n.debtAfterAssets, n.operation);
  if (materialLendingHealthBucketV1(p.healthAfterWad, p.debtAfterAssets) !== materialLendingHealthBucketV1(n.healthAfterWad, n.debtAfterAssets)) {
    changes.push(`health ratio after (${hAfterPrev} → ${hAfterNext})`);
  }
  if ((p.policyLimitAssets ?? null) !== (n.policyLimitAssets ?? null) && p.policyLimitAssets && n.policyLimitAssets) {
    changes.push(`Still debt limit (${usdc(p.policyLimitAssets)} → ${usdc(n.policyLimitAssets)})`);
  }
  if ((p.protocolLimitAssets ?? null) !== (n.protocolLimitAssets ?? null) && p.protocolLimitAssets && n.protocolLimitAssets) {
    changes.push(`protocol debt limit (${usdc(p.protocolLimitAssets)} → ${usdc(n.protocolLimitAssets)})`);
  }
  if (JSON.stringify(p.warnings) !== JSON.stringify(n.warnings)) changes.push('risk notes');
  const steps = (body: LendingReadyWireV1) => JSON.stringify(body.steps.map(step => [step.index, step.to.toLowerCase(), step.reading]));
  if (steps(previous) !== steps(next)) changes.push('wallet steps');
  if (changes.length === 0 && previous.callsHash !== next.callsHash) {
    // A loan's calls carry a deadline, so they are new on every fresh read;
    // "the terms changed (approved calldata)" read as if the loan had.
    return 'The calls were prepared again for this moment. The amounts, collateral, health ratio and limits above did not change. Open your wallet again to send these exact calls.';
  }
  if (previous.callsHash !== next.callsHash) {
    changes.push('approved calldata');
  }
  const detail = changes.length > 0 ? ` (${changes.join('; ')})` : '';
  return `The terms changed${detail}. Read the updated review, then open your wallet again to accept these exact terms.`;
}

/**
 * Where a refused or unreadable review sends the person: the page that asked
 * it. Read from the link's own question and trusted for nothing else; it only
 * picks a page (2026-11-03: a refusal in Farcaster left one red line and no
 * way on).
 */
export function lendingBackLinkV1(draft: string | null | undefined): { href: string; label: string } | null {
  const body = typeof draft === 'string' ? draft.split('.')[1] : undefined;
  if (!body || !/^[A-Za-z0-9_-]+$/.test(body) || typeof atob !== 'function') return null;
  try {
    const question = (JSON.parse(atob(body.replace(/-/g, '+').replace(/_/g, '/'))) as { question?: { operation?: unknown; collateralTokenAddress?: unknown } }).question;
    if (question?.operation === 'repay') {
      const token = typeof question.collateralTokenAddress === 'string' && /^0x[0-9a-f]{40}$/.test(question.collateralTokenAddress) ? question.collateralTokenAddress : null;
      return { href: token ? `/repay?token=${token}` : '/repay', label: 'Back to Repay' };
    }
    if (question?.operation === 'borrow') return { href: '/borrow', label: 'Back to Get money' };
  } catch {
    // Not a link this page can read: no way back is offered, and nothing else depends on it.
  }
  return null;
}


/**
 * Still's offer to have a loan's network fee paid (ERC-7677), as the arm answered it: Still's own
 * paymaster URL and the token the server bound to this wallet and these exact calls (2026-11-08).
 * The token decides nothing here; the paymaster checks it against the operation the wallet builds.
 */
export interface LendingFeeSponsorV1 { paymasterUrl: string; context: { sponsorship: string } }

/** The arm's offer, or null for anything that is not one: an https URL on Still's sponsorship path. */
export function parseLendingFeeSponsorV1(value: unknown): LendingFeeSponsorV1 | null {
  if (!value || typeof value !== 'object') return null;
  const { paymasterUrl, context } = value as { paymasterUrl?: unknown; context?: unknown };
  const token = context && typeof context === 'object' ? (context as { sponsorship?: unknown }).sponsorship : undefined;
  if (typeof paymasterUrl !== 'string' || paymasterUrl.length > 2200 || typeof token !== 'string' || token.length < 1 || token.length > 2000) return null;
  let url: URL;
  try { url = new URL(paymasterUrl); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password || !url.pathname.startsWith('/api/paymaster/sponsorship/')) return null;
  return { paymasterUrl, context: { sponsorship: token } };
}

/**
 * Said beside the wallet button of a loan or repayment sent as one batch: an offer, never a promise.
 * Only when this server sponsors loans and the wallet says it takes a fee sponsor; whether this fee is
 * paid is decided when the wallet asks, so the wallet's own fee line is where the answer is.
 */
export function lendingFeeNoteV1(input: { loansSponsored: boolean; walletTakesSponsor: boolean | null; dailyLimitPerWallet: number | null }): string | null {
  if (!input.loansSponsored || input.walletTakesSponsor !== true) return null;
  const limit = input.dailyLimitPerWallet;
  const many = limit === 1 ? '1 loan or repayment' : `${limit} loans or repayments`;
  return `Still offers to pay the network fee${limit ? `, for up to ${many} a day` : ''}. Your wallet shows who pays before you confirm.`;
}
