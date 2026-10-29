// Synthetic lending execution fixtures shared by focused tests. No wallet
// session, signed token, network request or real protocol action is involved.
import { hashApprovedCallsV1, type ExecutionCallV1, type HashV1 } from '@mioagent/route-domain';
import type { LendingRunV1 } from './lendingReview.js';
import { type LoanOwnerV1 } from './loanExecutionStore.js';

export const LOAN_WALLET_FIXTURE = `0x${'1'.repeat(40)}` as const;
export const LOAN_OTHER_WALLET_FIXTURE = `0x${'2'.repeat(40)}` as const;
export const LOAN_TARGET_FIXTURE = `0x${'3'.repeat(40)}` as const;
export const LOAN_USDC_FIXTURE = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
export const LOAN_MARKET_FIXTURE = `0x${'4'.repeat(64)}`;
export const LOAN_TX_FIXTURE = `0x${'5'.repeat(64)}` as HashV1;
export const LOAN_NOW_FIXTURE = new Date('2026-10-29T03:30:00Z');
export const LOAN_OWNER_FIXTURE: LoanOwnerV1 = { walletAddress: LOAN_WALLET_FIXTURE, tenantId: `eip155:8453:${LOAN_WALLET_FIXTURE}` };
export function loanReadyFixture(patch: Partial<Extract<LendingRunV1, { state: 'ready' }>> = {}): Extract<LendingRunV1, { state: 'ready' }> {
  const calls: ExecutionCallV1[] = [
    { index: 0, callType: 'approval', to: LOAN_USDC_FIXTURE, valueWei: '0', data: '0x095ea7b3', asset: null, amountAtomic: '2000000', recipient: null, spender: LOAN_TARGET_FIXTURE },
    { index: 1, callType: 'other', to: LOAN_TARGET_FIXTURE, valueWei: '0', data: '0x12345678', asset: null, amountAtomic: null, recipient: null, spender: null },
  ];
  return { state: 'ready', facts: { operation: 'repay', venue: 'morpho', collateralTokenAddress: LOAN_OTHER_WALLET_FIXTURE,
    collateralSymbol: 'cbBTC', collateralDecimals: 8, marketId: LOAN_MARKET_FIXTURE, amountMode: 'assets', requestedAssets: '2000000',
    maximumDebitAssets: '2000000', collateralSupplyAssets: '0', debtBeforeAssets: '3000000', debtAfterAssets: '1000000',
    collateralBeforeAssets: '100', collateralAfterAssets: '100', debtBeforeShares: '3000000', debtAfterShares: '1000000', blockNumber: 53000000, warnings: [] },
    calls, callsHash: hashApprovedCallsV1(calls), signingTermsHash: `0x${'9'.repeat(64)}`, expiresAt: new Date(LOAN_NOW_FIXTURE.getTime() + 30_000).toISOString(), atomicRequired: true,
    steps: [], measured: { provider: 'fixture', blockNumber: 53000000, loanDeltaAssets: '-2000000' }, ...patch };
}
