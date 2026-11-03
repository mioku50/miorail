import { hashApprovedCallsV1, type ExecutionCallV1, type HashV1 } from '@mioagent/route-domain';
import type { SpendWalletReadyV1 } from './stillSpendWallet.js';

// A wallet payment review for the store's tests, in memory and in PostgreSQL. Synthetic only.
export const SPEND_WALLET_FIXTURE = '0x1111111111111111111111111111111111111111';
export const SPEND_WALLET_OTHER_FIXTURE = '0x2222222222222222222222222222222222222222';
export const SPEND_WALLET_OWNER_FIXTURE = { walletAddress: SPEND_WALLET_FIXTURE, tenantId: `eip155:8453:${SPEND_WALLET_FIXTURE}` };
export const SPEND_WALLET_NOW_FIXTURE = new Date('2026-11-01T12:00:00Z');
export const SPEND_WALLET_TX_FIXTURE = `0x${'ab'.repeat(32)}` as HashV1;

export function spendWalletReadyFixture(orderId: string, patch: { payTo?: string; assets?: string; terms?: string } = {}): SpendWalletReadyV1 {
  const payTo = patch.payTo ?? '0x3333333333333333333333333333333333333333', assets = patch.assets ?? '2000000';
  const calls: ExecutionCallV1[] = [{ index: 0, callType: 'transfer', to: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', valueWei: '0', data: '0xa9059cbb',
    asset: null, amountAtomic: assets, recipient: payTo as `0x${string}`, spender: null }];
  return { state: 'ready', calls, callsHash: hashApprovedCallsV1(calls), signingTermsHash: (patch.terms ?? `0x${'44'.repeat(32)}`) as HashV1,
    expiresAt: new Date(SPEND_WALLET_NOW_FIXTURE.getTime() + 120_000).toISOString(), steps: [{ index: 0, to: calls[0]!.to, reading: 'Pay Bitrefill' }],
    facts: { payment: { merchant: 'bitrefill', orderId, payTo, assets, productName: 'PUBG Mobile', packageValue: '60 UC', faceCurrency: null,
      expiresAt: '2026-11-01T12:15:00.000Z' }, usdcBeforeAtomic: '2120000', usdcAfterAtomic: String(2_120_000n - BigInt(assets)), blockNumber: 53_100_000, warnings: [] } };
}
