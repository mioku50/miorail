import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { decodeFunctionData, encodeAbiParameters, erc20Abi, keccak256, pad, stringToHex } from 'viem';
import type { HashV1 } from '@mioagent/route-domain';
import type { SimulationProvider, SimulationProviderResponseV1 } from '@mioagent/paid-intelligence';
import type { VerifiedReceiptLogV1, VerifiedReceiptSourceV1 } from '@mioagent/route-proof';
import { ADDRESSES } from '@mioagent/still-engine/registry';

import type { BaseChainReaderV1, BaseTransactionSourceV1 } from './baseReceiptReader.js';
import type { LendingPaymentV1 } from './lendingDraft.js';
import { prepareSpendWalletPaymentV1, refreshSpendWalletPaymentV1, withSpendInvoiceLockV1, type SpendWalletReadyV1 } from './stillSpendWallet.js';
import { MemorySpendWalletStoreV1 } from './stillSpendWalletStore.js';

// An invoice paid from the wallet's own USDC: one exact transfer, executed on
// the state its balance was read at, and confirmed only from the chain. Every
// fixture here is synthetic.
const WALLET = '0x1111111111111111111111111111111111111111';
const PAY_TO = '0x3333333333333333333333333333333333333333';
const OWNER = { walletAddress: WALLET, tenantId: `eip155:8453:${WALLET}` };
const NOW = new Date('2026-11-01T12:00:00Z');
const PRICE = '2000000';
const PAYMENT: LendingPaymentV1 = {
  merchant: 'bitrefill', orderId: '6654a2ea-0df7-4f44-bc72-c1c6ad8b7b34', payTo: PAY_TO, assets: PRICE,
  productName: 'PUBG Mobile', packageValue: '60 UC', faceCurrency: null, expiresAt: '2026-11-01T12:15:00.000Z',
};
const USDC = ADDRESSES.usdc.toLowerCase();

type Change = NonNullable<SimulationProviderResponseV1['assetChanges']>['changes'][number];
const PAID: Change[] = [{ kind: 'erc20_transfer', token: ADDRESSES.usdc, direction: 'out', amountAtomic: PRICE, counterparty: PAY_TO, callIndex: 0 }];

function chain(changes: Change[] = PAID, status: 'success' | 'reverted' = 'success', moved = false) {
  const requests: Parameters<SimulationProvider['simulate']>[0][] = [];
  const provider: SimulationProvider = { providerId: 'wallet-fixture', async simulate(request) {
    requests.push(request);
    return { ok: true, body: { status, blockNumber: moved || request.baseBlockNumber === undefined ? 53_100_009 : request.baseBlockNumber + 1, gasUsed: '50000',
      stateChanges: [], revertReason: null, assetChanges: { status: 'available', unavailableReason: null, changes } } };
  } };
  return { chain: { providers: [provider], batchCapableIds: new Set(['wallet-fixture']) }, requests };
}
const held = (balanceAtomic: string) => async () => ({ balanceAtomic, blockNumber: '53100000' });

describe('a review that pays the invoice from the wallet’s USDC', () => {
  it('is one exact transfer to the invoice, run on the state the balance was read at', async () => {
    const fixture = chain();
    const run = await prepareSpendWalletPaymentV1({ walletAddress: WALLET, payment: PAYMENT, now: NOW }, { chain: fixture.chain, readUsdc: held('2120000') });
    assert.equal(run.state, 'ready', run.state === 'refused' ? run.detail : '');
    if (run.state !== 'ready') return;
    assert.equal(run.calls.length, 1);
    const call = run.calls[0]!;
    assert.deepEqual({ to: call.to, callType: call.callType, valueWei: call.valueWei, recipient: call.recipient, amountAtomic: call.amountAtomic },
      { to: USDC, callType: 'transfer', valueWei: '0', recipient: PAY_TO, amountAtomic: PRICE });
    assert.deepEqual(decodeFunctionData({ abi: erc20Abi, data: call.data as `0x${string}` }).args, [PAY_TO, 2_000_000n]);
    assert.equal(fixture.requests[0]!.baseBlockNumber, 53_100_000);
    assert.deepEqual([run.facts.usdcBeforeAtomic, run.facts.usdcAfterAtomic, run.facts.blockNumber], ['2120000', '120000', 53_100_000]);
    assert.match(run.facts.warnings[0]!, /^Your wallet sends 2 USDC of its own to Bitrefill’s invoice address 0x3333…3333 for PUBG Mobile · 60 UC\. No loan is taken\./);
    assert.equal(run.steps[0]!.reading, 'Pay Bitrefill: send 2 USDC to the invoice address 0x3333…3333');
    // Two minutes to sign, and never past Bitrefill's price less the review margin.
    assert.equal(run.expiresAt, '2026-11-01T12:02:00.000Z');
    const late = await prepareSpendWalletPaymentV1({ walletAddress: WALLET, payment: PAYMENT, now: new Date('2026-11-01T12:12:30Z') }, { chain: chain().chain, readUsdc: held('2120000') });
    assert.equal(late.state === 'ready' && late.expiresAt, '2026-11-01T12:13:00.000Z');
  });

  it('says what the wallet holds when it is less than the price, and refuses a read that did not answer', async () => {
    const short = await prepareSpendWalletPaymentV1({ walletAddress: WALLET, payment: PAYMENT, now: NOW }, { chain: chain().chain, readUsdc: held('1500000') });
    assert.deepEqual(short, { state: 'refused', refusal: 'spend_wallet_usdc_short',
      detail: 'Your wallet holds 1.5 USDC and this invoice is 2 USDC. Nothing can be paid from it; a loan from Still can pay it instead.' });
    for (const readUsdc of [async () => null, async () => { throw new Error('rpc'); }, async () => ({ balanceAtomic: '-1', blockNumber: '53100000' })]) {
      const unread = await prepareSpendWalletPaymentV1({ walletAddress: WALLET, payment: PAYMENT, now: NOW }, { chain: chain().chain, readUsdc });
      assert.equal(unread.state === 'refused' && unread.refusal, 'spend_wallet_usdc_unread');
    }
  });

  it('refuses an invoice address Still never pays, an amount over the cap, and a price about to lapse', async () => {
    for (const payTo of [WALLET, USDC, ADDRESSES.aaveSpoke.toLowerCase(), '0x0000000000000000000000000000000000000000', 'not-an-address']) {
      const run = await prepareSpendWalletPaymentV1({ walletAddress: WALLET, payment: { ...PAYMENT, payTo }, now: NOW }, { chain: chain().chain, readUsdc: held('9000000') });
      assert.equal(run.state === 'refused' && run.refusal, 'spend_payee_refused', payTo);
    }
    for (const assets of ['0', '100000001', '1.5']) {
      const run = await prepareSpendWalletPaymentV1({ walletAddress: WALLET, payment: { ...PAYMENT, assets }, now: NOW }, { chain: chain().chain, readUsdc: held('900000000') });
      assert.equal(run.state === 'refused' && run.refusal, 'spend_payment_question_mismatch', assets);
    }
    const lapsing = await prepareSpendWalletPaymentV1({ walletAddress: WALLET, payment: PAYMENT, now: new Date('2026-11-01T12:13:30Z') }, { chain: chain().chain, readUsdc: held('9000000') });
    assert.equal(lapsing.state === 'refused' && lapsing.refusal, 'spend_invoice_expiring');
  });

  it('is ready only if exactly the invoice amount leaves for exactly the invoice, on that block, and nothing else moves', async () => {
    const cases: Array<[ReturnType<typeof chain>, string]> = [
      [chain(PAID, 'reverted'), 'spend_simulation_reverted'],
      [chain(PAID, 'success', true), 'spend_simulation_moved'],
      [chain([{ ...PAID[0]!, amountAtomic: '1999999' }]), 'spend_effects_mismatch'],
      [chain([{ ...PAID[0]!, counterparty: '0x4444444444444444444444444444444444444444' }]), 'spend_unrequested_asset_change'],
      [chain([...PAID, { kind: 'erc20_transfer', token: ADDRESSES.weth, direction: 'out', amountAtomic: '1', counterparty: PAY_TO, callIndex: 0 }]), 'spend_unrequested_asset_change'],
      // A malformed amount never reaches the review: the simulation's answer is refused as a whole.
      [chain([{ ...PAID[0]!, amountAtomic: '2.0' }]), 'invalid_response'],
    ];
    for (const [fixture, refusal] of cases) {
      const run = await prepareSpendWalletPaymentV1({ walletAddress: WALLET, payment: PAYMENT, now: NOW }, { chain: fixture.chain, readUsdc: held('5000000') });
      assert.equal(run.state === 'refused' && run.refusal, refusal);
    }
  });
});

// The chain's side: the wallet sent the one approved call itself, and its USDC Transfer reached the invoice.
const TRANSFER_TOPIC = keccak256(stringToHex('Transfer(address,address,uint256)'));
const HASH = `0x${'ab'.repeat(32)}` as HashV1;
const transferLog = (input: { token?: string; from?: string; to?: string; value?: bigint } = {}): VerifiedReceiptLogV1 => ({
  address: input.token ?? USDC,
  topics: [TRANSFER_TOPIC, pad((input.from ?? WALLET) as `0x${string}`), pad((input.to ?? PAY_TO) as `0x${string}`)],
  data: encodeAbiParameters([{ type: 'uint256' }], [input.value ?? 2_000_000n]),
});

async function armed(run: SpendWalletReadyV1) {
  const store = new MemorySpendWalletStoreV1();
  await store.putReady({ owner: OWNER, run, now: NOW });
  const arm = await store.arm({ owner: OWNER, orderId: PAYMENT.orderId, callsHash: run.callsHash, signingTermsHash: run.signingTermsHash, now: NOW });
  assert.equal(arm.ok, true);
  if (!arm.ok) throw new Error('not armed');
  await store.recordSubmission({ owner: OWNER, orderId: PAYMENT.orderId, attemptId: arm.attemptId, outcome: 'submitted', transactionHash: HASH, now: NOW });
  return store;
}
function reader(input: { logs?: VerifiedReceiptLogV1[]; status?: 'success' | 'reverted'; data?: string; blockNumber?: bigint }, run: SpendWalletReadyV1): BaseChainReaderV1 {
  const receipt: VerifiedReceiptSourceV1 = { transactionHash: HASH, status: input.status ?? 'success', blockNumber: input.blockNumber ?? 53_100_002n, gasUsed: 50_000n,
    effectiveGasPriceWei: 1n, logs: input.logs ?? [transferLog()], from: WALLET };
  const transaction: BaseTransactionSourceV1 = { from: WALLET, to: USDC, value: 0n, input: input.data ?? run.calls[0]!.data };
  return { getTransactionReceipt: async () => receipt, getTransaction: async () => transaction } as unknown as BaseChainReaderV1;
}

describe('the payment’s result, read from the chain', () => {
  async function ready(): Promise<SpendWalletReadyV1> {
    const run = await prepareSpendWalletPaymentV1({ walletAddress: WALLET, payment: PAYMENT, now: NOW }, { chain: chain().chain, readUsdc: held('2120000') });
    if (run.state !== 'ready') throw new Error(run.detail);
    return run;
  }
  const deps = (store: MemorySpendWalletStoreV1, chainReader: BaseChainReaderV1) => ({ store, reader: chainReader, readBatchHashes: async () => null, now: () => NOW });

  it('is confirmed by the approved call and its one USDC transfer of the invoice amount to the invoice', async () => {
    const run = await ready(), store = await armed(run);
    const record = await refreshSpendWalletPaymentV1({ owner: OWNER, orderId: PAYMENT.orderId }, deps(store, reader({}, run)));
    assert.equal(record?.state, 'confirmed');
    assert.equal(record?.transactionHash, HASH);
    assert.deepEqual((record?.verification as { payment: unknown }).payment, { merchant: 'bitrefill', orderId: PAYMENT.orderId, payTo: PAY_TO, assets: PRICE });
  });

  it('is failed when the transaction reverted, and unknown for anything it cannot prove', async () => {
    const run = await ready();
    assert.equal((await refreshSpendWalletPaymentV1({ owner: OWNER, orderId: PAYMENT.orderId }, deps(await armed(run), reader({ status: 'reverted', logs: [] }, run))))?.state, 'failed');
    const unproven: Array<[Parameters<typeof reader>[0], string]> = [
      [{ data: '0xa9059cbb' }, 'spend_wallet_receipt_not_matched'],
      [{ logs: [transferLog({ value: 1_999_999n })] }, 'spend_wallet_transfer_mismatch'],
      [{ logs: [transferLog({ token: ADDRESSES.weth.toLowerCase() })] }, 'spend_wallet_transfer_mismatch'],
      [{ logs: [transferLog({ from: '0x4444444444444444444444444444444444444444' })] }, 'spend_wallet_transfer_mismatch'],
      [{ logs: [transferLog(), transferLog()] }, 'spend_wallet_transfer_mismatch'],
      [{ logs: [] }, 'spend_wallet_transfer_mismatch'],
      [{ blockNumber: 53_099_999n }, 'spend_wallet_receipt_predates_review'],
    ];
    for (const [input, errorCode] of unproven) {
      const record = await refreshSpendWalletPaymentV1({ owner: OWNER, orderId: PAYMENT.orderId }, deps(await armed(run), reader(input, run)));
      assert.deepEqual([record?.state, record?.errorCode], ['unknown', errorCode]);
    }
  });

  it('reads nothing for a payment the wallet has not answered for, and turns a confirmed one unknown when its receipt changes', async () => {
    const run = await ready(), store = new MemorySpendWalletStoreV1();
    await store.putReady({ owner: OWNER, run, now: NOW });
    await store.arm({ owner: OWNER, orderId: PAYMENT.orderId, callsHash: run.callsHash, signingTermsHash: run.signingTermsHash, now: NOW });
    let reads = 0;
    const counting = { getTransactionReceipt: async () => { reads++; return null; }, getTransaction: async () => null } as unknown as BaseChainReaderV1;
    assert.equal((await refreshSpendWalletPaymentV1({ owner: OWNER, orderId: PAYMENT.orderId }, deps(store, counting)))?.state, 'awaiting_wallet');
    assert.equal(reads, 0);
    const confirmed = await armed(run);
    assert.equal((await refreshSpendWalletPaymentV1({ owner: OWNER, orderId: PAYMENT.orderId }, deps(confirmed, reader({}, run))))?.state, 'confirmed');
    const reorged = await refreshSpendWalletPaymentV1({ owner: OWNER, orderId: PAYMENT.orderId }, deps(confirmed, reader({ blockNumber: 53_100_003n }, run)));
    assert.deepEqual([reorged?.state, reorged?.errorCode], ['unknown', 'spend_wallet_receipt_changed']);
  });
});

describe('the lock one invoice’s arms share', () => {
  it('runs them one at a time per invoice, and never holds another invoice', async () => {
    const order: string[] = [];
    const slow = (name: string, ms: number) => async () => { order.push(`${name}:in`); await new Promise((resolve) => setTimeout(resolve, ms)); order.push(`${name}:out`); return name; };
    const results = await Promise.all([
      withSpendInvoiceLockV1(PAYMENT.orderId, slow('a', 20)),
      withSpendInvoiceLockV1(PAYMENT.orderId.toUpperCase(), slow('b', 1)),
      withSpendInvoiceLockV1('00000000-0000-4000-8000-000000000001', slow('c', 1)),
    ]);
    assert.deepEqual(results, ['a', 'b', 'c']);
    assert.deepEqual(order.filter((step) => !step.startsWith('c')), ['a:in', 'a:out', 'b:in', 'b:out']);
    assert.ok(order.indexOf('c:out') < order.indexOf('a:out'));
    // A failed arm releases the invoice for the next one.
    await assert.rejects(withSpendInvoiceLockV1(PAYMENT.orderId, async () => { throw new Error('arm failed'); }), /arm failed/);
    assert.equal(await withSpendInvoiceLockV1(PAYMENT.orderId, async () => 'next'), 'next');
  });
});
