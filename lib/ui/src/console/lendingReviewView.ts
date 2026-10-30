import type { FreshBorrowReviewV1 } from './borrowReviewFreshness';
import { hasBorrowSigningTermsV1 } from './borrowReviewFreshness';

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
}
export interface LendingReadyWireV1 extends FreshBorrowReviewV1 {
  state: 'ready'; facts: LendingFactsWireV1; executionId: string;
  calls: { to: string; value: string; data: string }[];
  callsHash: string; signingTermsHash: string; expiresAt: string; atomicRequired: true;
  steps: { index: number; to: string; reading: string }[];
  measured: { provider: string; blockNumber: number; loanDeltaAssets: string };
}
export type LendingReviewWireV1 = LendingReadyWireV1 | { state: 'refused'; refusal: string; detail: string; facts?: LendingFactsWireV1;
  executionId?: string; executionState?: LendingExecutionStateV1 };
export type LendingExecutionStateV1 = 'ready' | 'awaiting_wallet' | 'submitted' | 'unknown' | 'confirmed' | 'failed';
export interface LendingExecutionWireV1 {
  executionId: string; state: LendingExecutionStateV1;
  transactionHash: string | null; errorCode: string | null;
}
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 2000;
const atomic = (value: unknown): value is string => typeof value === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(value);
const address = (value: unknown): value is string => typeof value === 'string' && /^0x[0-9a-f]{40}$/i.test(value);
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
const id = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,200}$/.test(value);

export function isLendingFactsWireV1(value: unknown): value is LendingFactsWireV1 {
  if (!object(value)) return false;
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
    ...(['ready', 'awaiting_wallet', 'submitted', 'unknown', 'confirmed', 'failed'].includes(String(value.executionState)) ? { executionState: value.executionState as LendingExecutionStateV1 } : {}) };
  if (value.state !== 'ready' || !hasBorrowSigningTermsV1(value as FreshBorrowReviewV1, 8) || !isLendingFactsWireV1(value.facts) ||
      !id(value.executionId) || value.atomicRequired !== true || !Array.isArray(value.calls) || !value.calls.every(c => object(c) && atomic(c.value)) ||
      !Array.isArray(value.steps) || value.steps.length !== value.calls.length || !value.steps.every((s, index) => object(s) && s.index === index && address(s.to) &&
        (value.calls as { to: string }[])[index]?.to.toLowerCase() === s.to.toLowerCase() && text(s.reading)) ||
      !object(value.measured) || !text(value.measured.provider) || !integer(value.measured.blockNumber) ||
      typeof value.measured.loanDeltaAssets !== 'string' || !/^-?(0|[1-9][0-9]{0,77})$/.test(value.measured.loanDeltaAssets)) return null;
  const native = value.facts.nativeFunding;
  const calls=value.calls as {to:string;value:string;data:string}[];
  if (!native) {
    if(calls.some(c=>c.value!=='0')) return null;
  } else {
    const funded=calls.filter(c=>c.value!=='0');
    if(funded.length!==1 || funded[0]!.to.toLowerCase()!=='0x4d28d900e381ece4b351302f1abe588496793a2b' ||
      funded[0]!.value!==native.maximumNativeAssets || calls.length!==(native.authorizedBefore?1:3) ||
      calls.indexOf(funded[0]!)!==(native.authorizedBefore?0:1) ||
      calls.some(c=>c!==funded[0] && (c.to.toLowerCase()!=='0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb' || c.value!=='0'))) return null;
  }
  return value as unknown as LendingReadyWireV1;
}
export function parseLendingExecutionWireV1(value: unknown, executionId: string): LendingExecutionWireV1 | null {
  if (!object(value) || value.executionId !== executionId || !id(value.executionId) ||
      !['ready', 'awaiting_wallet', 'submitted', 'unknown', 'confirmed', 'failed'].includes(String(value.state)) ||
      (value.transactionHash !== null && (typeof value.transactionHash !== 'string' || !/^0x[0-9a-f]{64}$/i.test(value.transactionHash))) ||
      (value.errorCode !== null && !text(value.errorCode))) return null;
  return value as unknown as LendingExecutionWireV1;
}
export function lendingExecutionCopyV1(state: LendingExecutionStateV1): string {
  switch (state) {
    case 'ready': return 'The review is ready. Nothing has been submitted.';
    case 'awaiting_wallet': return 'A wallet request was armed. Its outcome is not yet confirmed. This review will not be sent again.';
    case 'submitted': return 'Submitted from your wallet. The blockchain result has not been confirmed yet.';
    case 'unknown': return 'The submission result is unknown. Check your wallet activity and the onchain result before taking another action.';
    case 'confirmed': return 'Confirmed onchain: the approved calls and the resulting position were verified.';
    case 'failed': return 'The transaction or this wallet’s operation reverted onchain. Read the result before taking another action.';
  }
}
