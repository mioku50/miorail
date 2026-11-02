import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { decodeFunctionData, erc20Abi } from 'viem';
import { hashApprovedCallsV1, type ExecutionCallV1 } from '@mioagent/route-domain';
import type { SimulationProvider, SimulationProviderResponseV1 } from '@mioagent/paid-intelligence';
import { ADDRESSES, STOCKS } from '@mioagent/still-engine/registry';

import type { LendingPaymentV1 } from './lendingDraft.js';
import type { LendingRunV1 } from './lendingReview.js';
import { attachSpendPaymentV1 } from './stillSpendPayment.js';

// The loan is the runner's; this only adds the payment after it and executes
// both once more. Every fixture here is synthetic.
const WALLET = '0x1111111111111111111111111111111111111111';
const PAY_TO = '0x3333333333333333333333333333333333333333';
const NOW = new Date('2026-11-01T12:00:00Z');
const STOCK = STOCKS[0]!.token.toLowerCase();
const PRICE = '13250000';
const PAYMENT: LendingPaymentV1 = {
  merchant: 'bitrefill', orderId: '6654a2ea-0df7-4f44-bc72-c1c6ad8b7b34', payTo: PAY_TO, assets: PRICE,
  productName: 'Bitrefill eSIM Germany', packageValue: '10GB, 30 Days', faceCurrency: 'USD', expiresAt: '2026-11-01T12:15:00.000Z',
};

function loan(): Extract<LendingRunV1, { state: 'ready' }> {
  const calls: ExecutionCallV1[] = [
    { index: 0, callType: 'approval', to: STOCK as `0x${string}`, valueWei: '0', data: '0x095ea7b3', asset: null, amountAtomic: '1000000', recipient: null, spender: ADDRESSES.aaveSpoke.toLowerCase() as `0x${string}` },
    { index: 1, callType: 'other', to: ADDRESSES.aaveSpoke.toLowerCase() as `0x${string}`, valueWei: '0', data: '0x12345678', asset: null, amountAtomic: null, recipient: null, spender: null },
  ];
  return { state: 'ready', calls, callsHash: hashApprovedCallsV1(calls), signingTermsHash: `0x${'11'.repeat(32)}`,
    expiresAt: new Date(NOW.getTime() + 30_000).toISOString(), atomicRequired: true,
    steps: calls.map((call) => ({ index: call.index, to: call.to, reading: 'Synthetic fixture only' })),
    measured: { provider: 'fixture', blockNumber: 53_100_000, loanDeltaAssets: PRICE },
    facts: { operation: 'borrow', venue: 'aave-v4', collateralTokenAddress: STOCK, collateralSymbol: 'AAPLc', collateralDecimals: 18,
      marketId: ADDRESSES.aaveSpoke.toLowerCase(), amountMode: 'assets', requestedAssets: PRICE, maximumDebitAssets: '0', collateralSupplyAssets: '1000000',
      debtBeforeAssets: '0', debtAfterAssets: PRICE, collateralBeforeAssets: '0', collateralAfterAssets: '1000000', debtBeforeShares: '0', debtAfterShares: PRICE,
      blockNumber: 53_100_000, warnings: ['Your collateral can be liquidated.'] } };
}

type Change = NonNullable<SimulationProviderResponseV1['assetChanges']>['changes'][number];
const MOVED: Change[] = [
  { kind: 'erc20_transfer', token: STOCK, direction: 'out', amountAtomic: '1000000', counterparty: ADDRESSES.aaveHub, callIndex: 1 },
  { kind: 'erc20_transfer', token: ADDRESSES.usdc, direction: 'in', amountAtomic: PRICE, counterparty: ADDRESSES.aaveHub, callIndex: 1 },
  { kind: 'erc20_transfer', token: ADDRESSES.usdc, direction: 'out', amountAtomic: PRICE, counterparty: PAY_TO, callIndex: 2 },
];

function chain(changes: Change[] = MOVED, status: 'success' | 'reverted' = 'success') {
  const requests: Parameters<SimulationProvider['simulate']>[0][] = [];
  const provider: SimulationProvider = { providerId: 'spend-fixture', async simulate(request) {
    requests.push(request);
    // A provider honours the pin: its simulated block is the one on top of the base it was given.
    return { ok: true, body: { status, blockNumber: request.baseBlockNumber === undefined ? 53_100_002 : request.baseBlockNumber + 1, gasUsed: '300000', stateChanges: [], revertReason: null,
      assetChanges: { status: 'available', unavailableReason: null, changes } } };
  } };
  return { chain: { providers: [provider], batchCapableIds: new Set(['spend-fixture']) }, requests };
}

describe('the loan’s USDC pays the invoice in the same batch', () => {
  it('appends one exact transfer, executes both together, and binds both in new hashes', async () => {
    const fixture = chain(), run = loan();
    const paid = await attachSpendPaymentV1({ walletAddress: WALLET, run, payment: PAYMENT, now: NOW }, { chain: fixture.chain });
    assert.equal(paid.state, 'ready', paid.state === 'refused' ? paid.detail : '');
    if (paid.state !== 'ready') return;
    assert.equal(paid.calls.length, 3);
    const transfer = paid.calls[2]!;
    assert.deepEqual({ to: transfer.to, callType: transfer.callType, recipient: transfer.recipient, amountAtomic: transfer.amountAtomic, valueWei: transfer.valueWei },
      { to: ADDRESSES.usdc.toLowerCase(), callType: 'transfer', recipient: PAY_TO, amountAtomic: PRICE, valueWei: '0' });
    assert.deepEqual(decodeFunctionData({ abi: erc20Abi, data: transfer.data as `0x${string}` }).args, [PAY_TO, 13_250_000n]);
    assert.equal(paid.callsHash, hashApprovedCallsV1(paid.calls));
    assert.notEqual(paid.callsHash, run.callsHash);
    assert.notEqual(paid.signingTermsHash, run.signingTermsHash);
    assert.deepEqual(paid.facts.payment, PAYMENT);
    assert.match(paid.facts.warnings.at(-1)!, /pays 13\.25 USDC to Bitrefill’s invoice address 0x3333…3333 for Bitrefill eSIM Germany · 10GB, 30 Days/);
    assert.match(paid.steps[2]!.reading, /^Pay Bitrefill: send 13\.25 USDC to the invoice address 0x3333…3333$/);
    // One execution of the whole batch, the loan's calls first.
    assert.equal(fixture.requests.length, 1);
    assert.equal(fixture.requests[0]!.callsHash, paid.callsHash);
    // On the loan's own state: the facts, the measured block and the combined run are one block.
    assert.equal(fixture.requests[0]!.baseBlockNumber, 53_099_999);
    assert.equal(paid.measured.blockNumber, 53_100_000);
    assert.equal(paid.facts.blockNumber, 53_100_000);
  });

  it('refuses a loan and payment checked on another block than the loan’s own figures', async () => {
    const later: SimulationProvider = { providerId: 'spend-later', async simulate() {
      return { ok: true, body: { status: 'success', blockNumber: 53_100_001, gasUsed: '300000', stateChanges: [], revertReason: null,
        assetChanges: { status: 'available', unavailableReason: null, changes: MOVED } } };
    } };
    const paid = await attachSpendPaymentV1({ walletAddress: WALLET, run: loan(), payment: PAYMENT, now: NOW },
      { chain: { providers: [later], batchCapableIds: new Set(['spend-later']) } });
    assert.deepEqual([paid.state, paid.state === 'refused' ? paid.refusal : null], ['refused', 'spend_simulation_moved']);
  });

  it('for a loan in steps, keeps the steps: the payment is the last one, and the warning says how it is checked', async () => {
    const fixture = chain(), run = { ...loan(), atomicRequired: false as const, delivery: 'sequential' as const };
    const paid = await attachSpendPaymentV1({ walletAddress: WALLET, run, payment: PAYMENT, now: NOW }, { chain: fixture.chain });
    assert.equal(paid.state, 'ready', paid.state === 'refused' ? paid.detail : '');
    if (paid.state !== 'ready') return;
    assert.deepEqual([paid.atomicRequired, paid.delivery, paid.calls.at(-1)!.callType], [false, 'sequential', 'transfer']);
    assert.match(paid.facts.warnings.at(-1)!, /^The last step then pays 13\.25 USDC to Bitrefill’s invoice address 0x3333…3333 for Bitrefill eSIM Germany · 10GB, 30 Days\. Still reads the invoice again before your wallet is asked for it/);
    // The whole sequence is still executed once, as the wallet will send it.
    assert.equal(fixture.requests.length, 1);
    // A batch stays a batch.
    const batch = await attachSpendPaymentV1({ walletAddress: WALLET, run: loan(), payment: PAYMENT, now: NOW }, { chain: chain().chain });
    assert.deepEqual(batch.state === 'ready' ? [batch.atomicRequired, batch.delivery] : null, [true, undefined]);
  });

  it('refuses a payee that is the wallet, a token or a contract the loan calls', async () => {
    for (const payTo of [WALLET, ADDRESSES.usdc.toLowerCase(), ADDRESSES.aaveSpoke.toLowerCase(), STOCK, '0x0000000000000000000000000000000000000000']) {
      const paid = await attachSpendPaymentV1({ walletAddress: WALLET, run: loan(), payment: { ...PAYMENT, payTo }, now: NOW }, { chain: chain().chain });
      assert.equal(paid.state === 'refused' && paid.refusal, 'spend_payee_refused', payTo);
    }
  });

  it('refuses a loan of another amount, and an invoice whose price lock is nearly over', async () => {
    const other = await attachSpendPaymentV1({ walletAddress: WALLET, run: loan(), payment: { ...PAYMENT, assets: '13250001' }, now: NOW }, { chain: chain().chain });
    assert.equal(other.state === 'refused' && other.refusal, 'spend_payment_question_mismatch');
    const late = await attachSpendPaymentV1({ walletAddress: WALLET, run: loan(), payment: PAYMENT, now: new Date('2026-11-01T12:13:30Z') }, { chain: chain().chain });
    assert.equal(late.state === 'refused' && late.refusal, 'spend_invoice_expiring');
  });

  it('refuses when the executed batch moves anything but the loan and the exact payment', async () => {
    const cases: Array<[string, Change[] | 'reverted']> = [
      ['paid elsewhere', MOVED.map((c) => c.callIndex === 2 ? { ...c, counterparty: '0x4444444444444444444444444444444444444444' } : c)],
      ['paid less', MOVED.map((c) => c.callIndex === 2 ? { ...c, amountAtomic: '13000000' } : c)],
      ['loan smaller', MOVED.map((c) => c.direction === 'in' ? { ...c, amountAtomic: '13000000' } : c)],
      ['extra token', [...MOVED, { kind: 'erc20_transfer', token: ADDRESSES.weth, direction: 'out', amountAtomic: '1', counterparty: PAY_TO, callIndex: 2 }]],
      ['more collateral', MOVED.map((c) => c.token === STOCK ? { ...c, amountAtomic: '2000000' } : c)],
      ['reverted', 'reverted'],
    ];
    for (const [name, changes] of cases) {
      const fixture = changes === 'reverted' ? chain(MOVED, 'reverted') : chain(changes);
      const paid = await attachSpendPaymentV1({ walletAddress: WALLET, run: loan(), payment: PAYMENT, now: NOW }, { chain: fixture.chain });
      assert.equal(paid.state, 'refused', name);
      assert.equal(paid.state === 'refused' && 'calls' in paid, false, name);
    }
  });

  it('passes a refused loan through untouched, without executing anything', async () => {
    const fixture = chain();
    const refused: LendingRunV1 = { state: 'refused', refusal: 'aave_over_still_limit', detail: 'Over the limit.' };
    assert.deepEqual(await attachSpendPaymentV1({ walletAddress: WALLET, run: refused, payment: PAYMENT, now: NOW }, { chain: fixture.chain }), refused);
    assert.equal(fixture.requests.length, 0);
  });
});
