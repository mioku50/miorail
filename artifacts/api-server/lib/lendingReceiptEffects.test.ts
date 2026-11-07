import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { encodeAbiParameters, encodeEventTopics, encodeFunctionData, parseAbi, type Address, type Hex } from 'viem';
import { hashApprovedCallsV1 } from '@mioagent/route-domain';
import type { VerifiedReceiptLogV1, VerifiedReceiptSourceV1 } from '@mioagent/route-proof';
import { ADDRESSES, CRYPTO, STOCKS } from '@mioagent/still-engine/registry';
import { MORPHO_BLUE_BUNDLES_BASE_V1, MORPHO_WITHDRAW_COLLATERAL_ABI_V1 } from '@mioagent/rwa-issuer/morphoRepayPlan';
import { morphoDirectBorrowPlanV1, morphoDirectRepayPlanV1 } from '@mioagent/rwa-issuer/morphoDirectPlan';
import { aaveV4ExecutionEventAbiV1, aaveV4WriteAbiV1 } from './aaveV4BorrowPlan.js';
import { lendingReceiptVerifierV1, type LendingReceiptPositionV1 } from './lendingReceiptEffects.js';
import { type LoanExecutionV1 } from './loanExecutionStore.js';
import { loanReadyFixture, LOAN_OWNER_FIXTURE as OWNER, LOAN_WALLET_FIXTURE as WALLET, LOAN_OTHER_WALLET_FIXTURE as OTHER, LOAN_NOW_FIXTURE as NOW, LOAN_TX_FIXTURE as TX } from './loanExecutionTestFixtures.js';

const transferAbi = parseAbi(['event Transfer(address indexed from,address indexed to,uint256 value)']);
const morphoEvents = parseAbi([
  'event Deposit(address indexed dst,uint256 wad)',
  'event SetAuthorization(address indexed caller,address indexed authorizer,address indexed authorized,bool newIsAuthorized)',
  'event Borrow(bytes32 indexed id,address caller,address indexed onBehalf,address indexed receiver,uint256 assets,uint256 shares)',
  'event Repay(bytes32 indexed id,address indexed caller,address indexed onBehalf,uint256 assets,uint256 shares)',
  'event SupplyCollateral(bytes32 indexed id,address indexed caller,address indexed onBehalf,uint256 assets)',
]);
const bytes32 = (s: string) => s as Hex;
function transfer(token: string, from: string, to: string, value: bigint): VerifiedReceiptLogV1 {
  return { address: token, topics: encodeEventTopics({ abi: transferAbi, eventName: 'Transfer', args: { from: from as Address, to: to as Address } }) as Hex[],
    data: encodeAbiParameters([{ type: 'uint256' }], [value]) };
}
function morphoEvent(operation: 'borrow' | 'repay', patch: { market?: string; caller?: string; user?: string; receiver?: string; assets?: bigint; shares?: bigint } = {}): VerifiedReceiptLogV1 {
  const common = { id: bytes32(patch.market ?? CRYPTO[0]!.morphoMarket), onBehalf: (patch.user ?? WALLET) as Address };
  return operation === 'repay' ? { address: ADDRESSES.morpho,
    topics: encodeEventTopics({ abi: morphoEvents, eventName: 'Repay', args: { ...common, caller: (patch.caller ?? MORPHO_BLUE_BUNDLES_BASE_V1) as Address } }) as Hex[],
    data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [patch.assets ?? 2_000_000n, patch.shares ?? 200n]) }
    : { address: ADDRESSES.morpho,
      topics: encodeEventTopics({ abi: morphoEvents, eventName: 'Borrow', args: { ...common, receiver: (patch.receiver ?? WALLET) as Address } }) as Hex[],
      data: encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }, { type: 'uint256' }], [(patch.caller ?? MORPHO_BLUE_BUNDLES_BASE_V1) as Address, patch.assets ?? 2_000_000n, patch.shares ?? 200n]) };
}
function aaveEvent(operation: 'borrow' | 'repay', patch: { reserveId?: bigint; caller?: string; user?: string; assets?: bigint; shares?: bigint; premium?: bigint } = {}): VerifiedReceiptLogV1 {
  const args = { reserveId: patch.reserveId ?? 7n, caller: (patch.caller ?? WALLET) as Address, user: (patch.user ?? WALLET) as Address };
  return { address: ADDRESSES.aaveSpoke,
    topics: encodeEventTopics({ abi: aaveV4ExecutionEventAbiV1, eventName: operation === 'borrow' ? 'Borrow' : 'Repay', args }) as Hex[],
    data: operation === 'borrow' ? encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [patch.shares ?? 200n, patch.assets ?? 2_000_000n])
      : encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }, { type: 'tuple', components: [{ name: 'sharesDelta', type: 'int256' }, { name: 'offsetRayDelta', type: 'int256' }, { name: 'restoredPremiumRay', type: 'uint256' }] }],
        [patch.shares ?? 200n, patch.assets ?? 2_000_000n, { sharesDelta: 0n, offsetRayDelta: 0n, restoredPremiumRay: patch.premium ?? 0n }]) };
}
function supplyAave(assets: bigint, patch: { reserveId?: bigint; caller?: string; user?: string } = {}): VerifiedReceiptLogV1 {
  return { address: ADDRESSES.aaveSpoke, topics: encodeEventTopics({ abi: aaveV4ExecutionEventAbiV1, eventName: 'Supply', args: {
    reserveId: patch.reserveId ?? 0n, caller: (patch.caller ?? WALLET) as Address, user: (patch.user ?? WALLET) as Address,
  } }) as Hex[], data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [assets, assets]) };
}
function execution(venue: 'morpho' | 'aave-v4' = 'morpho', operation: 'borrow' | 'repay' = 'repay'): LoanExecutionV1 {
  const run = loanReadyFixture();
  Object.assign(run.facts, { venue, operation, collateralTokenAddress: venue === 'morpho' ? CRYPTO[0]!.token : STOCKS[0]!.token,
    collateralSymbol: venue === 'morpho' ? 'cbBTC' : 'AAPLc', marketId: venue === 'morpho' ? CRYPTO[0]!.morphoMarket : ADDRESSES.aaveSpoke.toLowerCase(),
    collateralBeforeShares: '100', collateralAfterShares: '100',
    debtBeforeShares: '300', debtAfterShares: operation === 'borrow' ? '500' : '100', debtBeforeAssets: '3000000', debtAfterAssets: operation === 'borrow' ? '5000000' : '1000000' });
  run.calls = run.calls.map((call, index) => ({ ...call, ...(index === 1 ? { to: venue === 'morpho' ? MORPHO_BLUE_BUNDLES_BASE_V1 : ADDRESSES.aaveSpoke,
    data: venue === 'aave-v4' ? encodeFunctionData({ abi: aaveV4WriteAbiV1, functionName: operation, args: [7n, 2_000_000n, WALLET as Address] }) : call.data } : {}) }));
  run.callsHash = hashApprovedCallsV1(run.calls);
  return { ...OWNER, executionId: 'synthetic-execution', draftId: 'synthetic-draft', state: 'submitted', run, attemptId: 'synthetic-attempt', batchId: 'synthetic-batch', transactionHash: null,
    verification: null, errorCode: null, version: 2, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() };
}
async function check(record: LoanExecutionV1, logs: readonly VerifiedReceiptLogV1[], p: LendingReceiptPositionV1 | null = { debtAssets: 1_000_000n, debtShares: 100n, collateralAssets: 100n }) {
  const receipt: VerifiedReceiptSourceV1 = { transactionHash: TX, status: 'success', blockNumber: 53000001n, logs, gasUsed: 1n, effectiveGasPriceWei: 1n };
  let read = 0;
  const verifier = lendingReceiptVerifierV1({ position: async (facts, wallet, block) => {
    read++; assert.equal(facts, record.run.facts); assert.equal(wallet, WALLET); assert.equal(block, receipt.blockNumber);
    return p === null ? null : { ...p, ...(facts.venue === 'aave-v4' && p.collateralShares === undefined ? { collateralShares: p.collateralAssets } : {}) };
  } });
  const result = await verifier({ execution: record, receipt, logs, operationNonce: '7', transaction: { from: OTHER, to: OTHER, value: 0n, input: '0x' } });
  return { result, read };
}
const outMorpho = (amount = 2_000_000n) => transfer(ADDRESSES.usdc, WALLET, MORPHO_BLUE_BUNDLES_BASE_V1, amount);
const outAave = (amount = 2_000_000n) => transfer(ADDRESSES.usdc, WALLET, ADDRESSES.aaveHub, amount);

describe('protocol lending receipt effects and pinned positions', () => {
  it('Morpho exact repayment binds its market, owner, applied shares and remaining position without reading an oracle', async () => {
    const { result, read } = await check(execution(), [outMorpho(), morphoEvent('repay')]);
    assert.equal(result.state, 'matched'); assert.equal(read, 1);
  });
  it('Morpho full repayment permits a bounded pull and refund, but requires zero remaining debt shares', async () => {
    const record = execution(); Object.assign(record.run.facts, { amountMode: 'all', requestedAssets: null, maximumDebitAssets: '4000000' });
    const logs = [outMorpho(4_000_000n), transfer(ADDRESSES.usdc, MORPHO_BLUE_BUNDLES_BASE_V1, WALLET, 1_000_000n), morphoEvent('repay', { assets: 3_000_000n, shares: 300n })];
    assert.equal((await check(record, logs, { debtAssets: 0n, debtShares: 0n, collateralAssets: 100n })).result.state, 'matched');
    assert.notEqual((await check(record, logs, { debtAssets: 0n, debtShares: 1n, collateralAssets: 100n })).result.state, 'matched');
  });
  it('Morpho all follows the full sentinel at inclusion within the budget, even if another debt change preceded it', async () => {
    const record = execution(); Object.assign(record.run.facts, { amountMode: 'all', requestedAssets: null, maximumDebitAssets: '4000000' });
    const logs = [outMorpho(4_000_000n), transfer(ADDRESSES.usdc, MORPHO_BLUE_BUNDLES_BASE_V1, WALLET, 500_000n), morphoEvent('repay', { assets: 3_500_000n, shares: 350n })];
    assert.equal((await check(record, logs, { debtAssets: 0n, debtShares: 0n, collateralAssets: 100n })).result.state, 'matched');
  });
  it('rejects a gross USDC pull above the consented maximum even when a refund makes net debit small', async () => {
    const logs = [outMorpho(10_000_000n), transfer(ADDRESSES.usdc, MORPHO_BLUE_BUNDLES_BASE_V1, WALLET, 8_000_000n), morphoEvent('repay')];
    assert.notEqual((await check(execution(), logs)).result.state, 'matched');
  });
  it('rejects the wrong market, owner, caller, protocol emitter and duplicate event', async () => {
    const own = morphoEvent('repay');
    for (const events of [[morphoEvent('repay', { market: CRYPTO[1]!.morphoMarket })], [morphoEvent('repay', { user: OTHER })],
      [morphoEvent('repay', { caller: OTHER })], [{ ...own, address: OTHER }], [own, own]]) {
      assert.notEqual((await check(execution(), [outMorpho(), ...events])).result.state, 'matched');
    }
  });
  it('does not confirm if applied shares disagree with the pinned remaining position or it could not be read', async () => {
    const logs = [outMorpho(), morphoEvent('repay')];
    assert.notEqual((await check(execution(), logs, { debtAssets: 1_000_000n, debtShares: 99n, collateralAssets: 100n })).result.state, 'matched');
    assert.notEqual((await check(execution(), logs, null)).result.state, 'matched');
  });
  it('a Morpho borrow that BlueBundles forwards is matched only when all of it reaches the wallet from BlueBundles', async () => {
    // 2026-11-07: Morpho's Actions bundle borrowed to BlueBundles, which sent the 840000 USDC on to the wallet. This
    // check expected the wallet as receiver: the loan stayed unknown, held its market, and the repayment could not be armed.
    const record = execution('morpho', 'borrow'); Object.assign(record.run.facts, { collateralSupplyAssets: '10' });
    const supplied: VerifiedReceiptLogV1 = { address: ADDRESSES.morpho, topics: encodeEventTopics({ abi: morphoEvents, eventName: 'SupplyCollateral', args: {
      id: CRYPTO[0]!.morphoMarket, caller: MORPHO_BLUE_BUNDLES_BASE_V1, onBehalf: WALLET as Address } }) as Hex[], data: encodeAbiParameters([{ type: 'uint256' }], [10n]) };
    const pledge = [transfer(CRYPTO[0]!.token, WALLET, MORPHO_BLUE_BUNDLES_BASE_V1, 10n), transfer(CRYPTO[0]!.token, MORPHO_BLUE_BUNDLES_BASE_V1, ADDRESSES.morpho, 10n), supplied];
    const borrowed = [transfer(ADDRESSES.usdc, ADDRESSES.morpho, MORPHO_BLUE_BUNDLES_BASE_V1, 2_000_000n), morphoEvent('borrow', { receiver: MORPHO_BLUE_BUNDLES_BASE_V1 })];
    const position = { debtAssets: 5_000_000n, debtShares: 500n, collateralAssets: 110n };
    const forward = (to: string, value: bigint, from: string = MORPHO_BLUE_BUNDLES_BASE_V1) => transfer(ADDRESSES.usdc, from, to, value);
    assert.equal((await check(record, [...pledge, ...borrowed, forward(WALLET, 2_000_000n)], position)).result.state, 'matched');
    // Kept back, short, or sent to someone else: the wallet did not get the loan.
    for (const logs of [[...pledge, ...borrowed], [...pledge, ...borrowed, forward(WALLET, 1_999_999n)], [...pledge, ...borrowed, forward(OTHER, 2_000_000n)]]) {
      assert.deepEqual((await check(record, logs, position)).result, { state: 'mismatched', errorCode: 'loan_borrow_receipt_mismatch' });
    }
    // USDC that reaches the wallet from anyone but BlueBundles.
    assert.deepEqual((await check(record, [...pledge, ...borrowed, forward(WALLET, 1_000_000n), forward(WALLET, 1_000_000n, OTHER)], position)).result,
      { state: 'mismatched', errorCode: 'loan_borrow_forward_mismatch' });
    // Any other receiver is still refused.
    assert.deepEqual((await check(record, [...pledge, borrowed[0]!, morphoEvent('borrow', { receiver: OTHER }), forward(WALLET, 2_000_000n)], position)).result,
      { state: 'mismatched', errorCode: 'loan_protocol_event_mismatch' });
  });
  it('requires exact selected Morpho collateral event and preserved post-borrow position', async () => {
    const record = execution('morpho', 'borrow'); Object.assign(record.run.facts, { collateralSupplyAssets: '10' });
    const supplied: VerifiedReceiptLogV1 = { address: ADDRESSES.morpho, topics: encodeEventTopics({ abi: morphoEvents, eventName: 'SupplyCollateral', args: {
      id: CRYPTO[0]!.morphoMarket, caller: MORPHO_BLUE_BUNDLES_BASE_V1, onBehalf: WALLET as Address } }) as Hex[], data: encodeAbiParameters([{ type: 'uint256' }], [10n]) };
    const logs = [transfer(CRYPTO[0]!.token, WALLET, MORPHO_BLUE_BUNDLES_BASE_V1, 10n), supplied, transfer(ADDRESSES.usdc, ADDRESSES.morpho, WALLET, 2_000_000n), morphoEvent('borrow')];
    assert.equal((await check(record, logs, { debtAssets: 5_000_000n, debtShares: 500n, collateralAssets: 110n })).result.state, 'matched');
    assert.notEqual((await check(record, logs.filter(log => log !== supplied), { debtAssets: 5_000_000n, debtShares: 500n, collateralAssets: 110n })).result.state, 'matched');
    assert.notEqual((await check(record, logs, { debtAssets: 5_000_000n, debtShares: 500n, collateralAssets: 100n })).result.state, 'matched');
  });
  it('Aave partial repayment can repay premium while drawn shares stay unchanged', async () => {
    const record = execution('aave-v4'); record.run.facts.debtBeforeAssets = '6000000';
    const logs = [outAave(), aaveEvent('repay', { shares: 0n, premium: 2_000_000n * 10n ** 27n })];
    assert.equal((await check(record, logs, { debtAssets: 4_000_000n, debtShares: 300n, collateralAssets: 100n })).result.state, 'matched');
  });
  it('Aave receipt proof preserves shares while debt premium and supplied value accrue after review', async () => {
    const record = execution('aave-v4');
    const logs = [outAave(), aaveEvent('repay', { shares: 0n, premium: 2_000_000n * 10n ** 27n })];
    const actual = { debtAssets: 3_100_000n, debtShares: 300n, collateralAssets: 101n, collateralShares: 100n };
    assert.equal((await check(record, logs, actual)).result.state, 'matched');
    assert.notEqual((await check(record, logs, { ...actual, collateralShares: 99n })).result.state, 'matched');
  });
  it('Aave repayment binds the actual USDC reserve and exact owner/caller', async () => {
    for (const event of [aaveEvent('repay', { reserveId: 0n }), aaveEvent('repay', { user: OTHER }), aaveEvent('repay', { caller: OTHER })]) {
      assert.notEqual((await check(execution('aave-v4'), [outAave(), event])).result.state, 'matched');
    }
  });
  it('Aave full repayment does not close while any debt or drawn shares remain', async () => {
    const record = execution('aave-v4'); Object.assign(record.run.facts, { amountMode: 'all', requestedAssets: null, maximumDebitAssets: '4000000' });
    const logs = [outAave(3_000_000n), aaveEvent('repay', { assets: 3_000_000n, shares: 300n })];
    assert.equal((await check(record, logs, { debtAssets: 0n, debtShares: 0n, collateralAssets: 100n })).result.state, 'matched');
    for (const p of [{ debtAssets: 1n, debtShares: 0n, collateralAssets: 100n }, { debtAssets: 0n, debtShares: 1n, collateralAssets: 100n }]) assert.notEqual((await check(record, logs, p)).result.state, 'matched');
  });
  it('Aave borrow requires the selected stock supply event, destination and resulting pledge', async () => {
    const record = execution('aave-v4', 'borrow'); record.run.facts.collateralSupplyAssets = '10';
    const supplyCall = { ...record.run.calls[1]!, data: encodeFunctionData({ abi: aaveV4WriteAbiV1, functionName: 'supply', args: [0n, 10n, WALLET as Address] }) };
    record.run.calls = [...record.run.calls.slice(0, 1), { ...supplyCall, index: 1 }, { ...record.run.calls[1]!, index: 2 }]; record.run.callsHash = hashApprovedCallsV1(record.run.calls);
    const supplied = supplyAave(10n), transferIn = transfer(ADDRESSES.usdc, ADDRESSES.aaveHub, WALLET, 2_000_000n), transferOut = transfer(STOCKS[0]!.token, WALLET, ADDRESSES.aaveHub, 10n);
    const logs = [transferOut, supplied, transferIn, aaveEvent('borrow')];
    assert.equal((await check(record, logs, { debtAssets: 5_000_000n, debtShares: 500n, collateralAssets: 110n })).result.state, 'matched');
    for (const bad of [logs.filter(log => log !== supplied), logs.map(log => log === supplied ? supplyAave(10n, { reserveId: 1n }) : log), logs.map(log => log === supplied ? supplyAave(10n, { caller: OTHER }) : log)]) {
      assert.notEqual((await check(record, bad, { debtAssets: 5_000_000n, debtShares: 500n, collateralAssets: 110n })).result.state, 'matched');
    }
    assert.notEqual((await check(record, logs, { debtAssets: 5_000_000n, debtShares: 500n, collateralAssets: 100n })).result.state, 'matched');
  });
  it('a loan that pays a Bitrefill invoice is matched only with one exact transfer to the invoice address', async () => {
    const record = execution('aave-v4', 'borrow'), PAY_TO = '0x3333333333333333333333333333333333333333';
    const payment = { merchant: 'bitrefill' as const, orderId: '6654a2ea-0df7-4f44-bc72-c1c6ad8b7b34', payTo: PAY_TO, assets: '2000000',
      productName: 'Bitrefill eSIM Germany', packageValue: '10GB, 30 Days', faceCurrency: 'USD', expiresAt: '2026-11-01T12:15:00.000Z' };
    record.run.facts.payment = payment;
    const paid = transfer(ADDRESSES.usdc, WALLET, PAY_TO, 2_000_000n);
    const logs = [transfer(ADDRESSES.usdc, ADDRESSES.aaveHub, WALLET, 2_000_000n), aaveEvent('borrow'), paid];
    const position = { debtAssets: 5_000_000n, debtShares: 500n, collateralAssets: 100n };
    const matched = await check(record, logs, position);
    assert.equal(matched.result.state, 'matched');
    assert.deepEqual(matched.result.state === 'matched' && matched.result.proof.payment, { merchant: 'bitrefill', orderId: payment.orderId, payTo: PAY_TO, assets: '2000000' });
    for (const bad of [
      logs.filter(log => log !== paid),
      logs.map(log => log === paid ? transfer(ADDRESSES.usdc, WALLET, OTHER, 2_000_000n) : log),
      logs.map(log => log === paid ? transfer(ADDRESSES.usdc, WALLET, PAY_TO, 1_999_999n) : log),
      [...logs, transfer(ADDRESSES.usdc, WALLET, PAY_TO, 1n)],
      [...logs, transfer(ADDRESSES.usdc, WALLET, OTHER, 1n)],
    ]) assert.equal((await check(record, bad, position)).result.state, 'mismatched');
    // Without a payment in its facts, a loan still may not send USDC anywhere.
    delete record.run.facts.payment;
    assert.equal((await check(record, logs, position)).result.state, 'mismatched');
  });
  it('rejects an unrequested token movement or collateral change during repayment', async () => {
    assert.notEqual((await check(execution(), [outMorpho(), transfer(STOCKS[0]!.token, WALLET, OTHER, 1n), morphoEvent('repay')])).result.state, 'matched');
    assert.notEqual((await check(execution(), [outMorpho(), morphoEvent('repay')], { debtAssets: 1_000_000n, debtShares: 100n, collateralAssets: 99n })).result.state, 'matched');
  });
  for (const authorizedBefore of [false, true]) {
    it(`native ETH Morpho borrow verifies WETH wrap, bundle supply, USDC sweep and ${authorizedBefore ? 'preserved' : 'temporary'} authorization`, async () => {
      const wethMarket = CRYPTO[1]!.morphoMarket;
      const record = execution('morpho', 'borrow');
      Object.assign(record.run.facts, {
        collateralTokenAddress: ADDRESSES.weth.toLowerCase(),
        collateralSymbol: 'WETH',
        marketId: wethMarket,
        collateralSupplyAssets: '10',
        nativeFunding: {
          wrapperContract: MORPHO_BLUE_BUNDLES_BASE_V1,
          wrappedTokenAddress: ADDRESSES.weth.toLowerCase(),
          maximumNativeAssets: '10',
          reserveNativeAssets: '500000000000000',
          walletNativeBeforeAssets: '100000000000000000',
          walletNativeAfterAssets: '99999999999999990',
          authorizedBefore,
          feeQuoteState: 'wallet_quote_required' as const,
        },
      });
      const deposit: VerifiedReceiptLogV1 = { address: ADDRESSES.weth,
        topics: encodeEventTopics({ abi: morphoEvents, eventName: 'Deposit', args: { dst: MORPHO_BLUE_BUNDLES_BASE_V1 } }) as Hex[],
        data: encodeAbiParameters([{ type: 'uint256' }], [10n]) };
      const auth = (flag: boolean): VerifiedReceiptLogV1 => ({ address: ADDRESSES.morpho,
        topics: encodeEventTopics({ abi: morphoEvents, eventName: 'SetAuthorization', args: {
          caller: WALLET as Address, authorizer: WALLET as Address, authorized: MORPHO_BLUE_BUNDLES_BASE_V1 } }) as Hex[],
        data: encodeAbiParameters([{ type: 'bool' }], [flag]) });
      const supplied: VerifiedReceiptLogV1 = { address: ADDRESSES.morpho,
        topics: encodeEventTopics({ abi: morphoEvents, eventName: 'SupplyCollateral', args: {
          id: wethMarket, caller: MORPHO_BLUE_BUNDLES_BASE_V1, onBehalf: WALLET as Address } }) as Hex[],
        data: encodeAbiParameters([{ type: 'uint256' }], [10n]) };
      const logs = [
        ...(authorizedBefore ? [] : [auth(true)]),
        deposit,
        transfer(ADDRESSES.weth, MORPHO_BLUE_BUNDLES_BASE_V1, ADDRESSES.morpho, 10n),
        supplied,
        morphoEvent('borrow', { market: wethMarket, caller: MORPHO_BLUE_BUNDLES_BASE_V1, receiver: MORPHO_BLUE_BUNDLES_BASE_V1 }),
        transfer(ADDRESSES.usdc, MORPHO_BLUE_BUNDLES_BASE_V1, WALLET, 2_000_000n),
        ...(authorizedBefore ? [] : [auth(false)]),
      ];
      const pos = { debtAssets: 5_000_000n, debtShares: 500n, collateralAssets: 110n, nativeAuthorized: authorizedBefore };
      assert.equal((await check(record, logs, pos)).result.state, 'matched');
      assert.notEqual((await check(record, logs.filter(log => log !== deposit), pos)).result.state, 'matched');
      assert.notEqual((await check(record, [...logs, transfer(ADDRESSES.weth, WALLET, MORPHO_BLUE_BUNDLES_BASE_V1, 10n)], pos)).result.state, 'matched');
      assert.notEqual((await check(record, logs, { ...pos, nativeAuthorized: !authorizedBefore })).result.state, 'matched');
    });
  }
});

describe('repay all, then take the stock back: what the receipt must show', () => {
  const STOCK = STOCKS[0]!.token, DEPOSIT = 100n, CLOSED = { debtAssets: 0n, debtShares: 0n, collateralAssets: 0n, collateralShares: 0n };
  function returning(repay = true): LoanExecutionV1 {
    const record = execution('aave-v4', 'repay');
    Object.assign(record.run.facts, { amountMode: 'all', requestedAssets: null, maximumDebitAssets: repay ? '4000000' : '0', collateralReturnAssets: DEPOSIT.toString(),
      collateralBeforeAssets: DEPOSIT.toString(), collateralAfterAssets: '0', collateralAfterShares: '0', debtAfterAssets: '0', debtAfterShares: '0',
      ...(repay ? {} : { debtBeforeAssets: '0', debtBeforeShares: '0' }) });
    const withdraw = { ...record.run.calls[1]!, callType: 'withdraw' as const, amountAtomic: DEPOSIT.toString(), recipient: WALLET,
      data: encodeFunctionData({ abi: aaveV4WriteAbiV1, functionName: 'withdraw', args: [0n, DEPOSIT, WALLET as Address] }) };
    record.run.calls = repay ? [...record.run.calls, { ...withdraw, index: record.run.calls.length }] : [{ ...withdraw, index: 0 }];
    record.run.callsHash = hashApprovedCallsV1(record.run.calls);
    return record;
  }
  function withdrawn(amount = DEPOSIT, patch: { reserveId?: bigint; caller?: string } = {}): VerifiedReceiptLogV1 {
    return { address: ADDRESSES.aaveSpoke, topics: encodeEventTopics({ abi: aaveV4ExecutionEventAbiV1, eventName: 'Withdraw', args: {
      reserveId: patch.reserveId ?? 0n, caller: (patch.caller ?? WALLET) as Address, user: WALLET as Address } }) as Hex[],
      data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [amount, amount]) };
  }
  const arrived = (amount = DEPOSIT) => transfer(STOCK, ADDRESSES.aaveHub, WALLET, amount);
  it('matches the repayment, the one withdrawal of the whole deposit and its arrival, with nothing left in the Spoke', async () => {
    const { result } = await check(returning(), [outAave(), aaveEvent('repay'), arrived(), withdrawn()], CLOSED);
    assert.equal(result.state, 'matched', result.state !== 'matched' ? result.errorCode : '');
    if (result.state === 'matched') assert.equal(result.proof.collateralReturnedAssets, DEPOSIT.toString());
  });
  it('with no debt left matches the withdrawal alone, and refuses a repayment nobody approved', async () => {
    assert.equal((await check(returning(false), [arrived(), withdrawn()], CLOSED)).result.state, 'matched');
    const { result } = await check(returning(false), [outAave(), aaveEvent('repay'), arrived(), withdrawn()], CLOSED);
    assert.equal(result.state === 'mismatched' && result.errorCode, 'loan_protocol_event_not_unique');
  });
  it('refuses a short withdrawal, a missing arrival, another reserve or caller, and a deposit still in the Spoke', async () => {
    for (const logs of [
      [outAave(), aaveEvent('repay'), arrived(), withdrawn(DEPOSIT - 1n)],
      [outAave(), aaveEvent('repay'), withdrawn()],
      [outAave(), aaveEvent('repay'), arrived(), withdrawn(DEPOSIT, { reserveId: 1n })],
      [outAave(), aaveEvent('repay'), arrived(), withdrawn(DEPOSIT, { caller: OTHER })],
      [outAave(), aaveEvent('repay'), arrived(), withdrawn(), withdrawn()],
    ]) {
      const { result } = await check(returning(), logs, CLOSED);
      assert.equal(result.state === 'mismatched' && result.errorCode, 'loan_withdraw_event_mismatch');
    }
    const held = await check(returning(), [outAave(), aaveEvent('repay'), arrived(), withdrawn()], { ...CLOSED, collateralAssets: DEPOSIT, collateralShares: DEPOSIT });
    assert.equal(held.result.state, 'unavailable');
  });
  it('a plain repayment still refuses any withdrawal and any stock that arrives', async () => {
    const plain = execution('aave-v4', 'repay');
    const a = await check(plain, [outAave(), aaveEvent('repay'), withdrawn()]);
    assert.equal(a.result.state === 'mismatched' && a.result.errorCode, 'loan_unrequested_collateral_withdrawal');
    const b = await check(plain, [outAave(), aaveEvent('repay'), arrived()]);
    assert.equal(b.result.state === 'mismatched' && b.result.errorCode, 'loan_unrequested_receipt_asset_change');
  });
});

describe('repay all on Morpho, then the wallet takes its collateral back: what the receipt must show', () => {
  const CBBTC = CRYPTO[0]!, COLLATERAL = 100n, CLOSED = { debtAssets: 0n, debtShares: 0n, collateralAssets: 0n };
  const withdrawEvents = parseAbi(['event WithdrawCollateral(bytes32 indexed id,address caller,address indexed onBehalf,address indexed receiver,uint256 assets)']);
  function returning(repay = true): LoanExecutionV1 {
    const record = execution('morpho', 'repay');
    Object.assign(record.run.facts, { amountMode: 'all', requestedAssets: null, maximumDebitAssets: repay ? '4000000' : '0', collateralReturnAssets: COLLATERAL.toString(),
      collateralBeforeAssets: COLLATERAL.toString(), collateralAfterAssets: '0', debtAfterAssets: '0', debtAfterShares: '0',
      ...(repay ? {} : { debtBeforeAssets: '0', debtBeforeShares: '0' }) });
    const params = { loanToken: ADDRESSES.usdc, collateralToken: CBBTC.token, oracle: `0x${'a1'.repeat(20)}` as Address, irm: `0x${'a2'.repeat(20)}` as Address, lltv: 860_000_000_000_000_000n };
    const back = { index: 0, callType: 'withdraw' as const, to: ADDRESSES.morpho.toLowerCase() as Address, valueWei: '0', asset: null, amountAtomic: COLLATERAL.toString(), recipient: WALLET, spender: null,
      data: encodeFunctionData({ abi: MORPHO_WITHDRAW_COLLATERAL_ABI_V1, functionName: 'withdrawCollateral', args: [params, COLLATERAL, WALLET as Address, WALLET as Address] }) };
    record.run.calls = repay ? [...record.run.calls, { ...back, index: record.run.calls.length }] : [back];
    record.run.callsHash = hashApprovedCallsV1(record.run.calls);
    return record;
  }
  function withdrawn(patch: { receiver?: string; caller?: string; assets?: bigint } = {}): VerifiedReceiptLogV1 {
    return { address: ADDRESSES.morpho, topics: encodeEventTopics({ abi: withdrawEvents, eventName: 'WithdrawCollateral', args: {
      id: bytes32(CBBTC.morphoMarket), onBehalf: WALLET as Address, receiver: (patch.receiver ?? WALLET) as Address } }) as Hex[],
      data: encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [(patch.caller ?? WALLET) as Address, patch.assets ?? COLLATERAL]) };
  }
  const arrived = (amount = COLLATERAL) => transfer(CBBTC.token, ADDRESSES.morpho, WALLET, amount);
  const repaid = () => [outMorpho(4_000_000n), transfer(ADDRESSES.usdc, MORPHO_BLUE_BUNDLES_BASE_V1, WALLET, 1_000_000n), morphoEvent('repay', { assets: 3_000_000n, shares: 300n })];
  it('matches the bundled full repayment, then the owner’s own withdrawal of the whole collateral and its arrival', async () => {
    const { result } = await check(returning(), [...repaid(), arrived(), withdrawn()], CLOSED);
    assert.equal(result.state, 'matched', result.state !== 'matched' ? result.errorCode : '');
    if (result.state === 'matched') assert.equal(result.proof.collateralReturnedAssets, COLLATERAL.toString());
  });
  it('with no debt left matches the withdrawal alone', async () => {
    const { result } = await check(returning(false), [arrived(), withdrawn()], CLOSED);
    assert.equal(result.state, 'matched', result.state !== 'matched' ? result.errorCode : '');
  });
  it('refuses another receiver or caller, a short withdrawal, a missing arrival, and collateral still in the market', async () => {
    for (const logs of [
      [...repaid(), arrived(), withdrawn({ receiver: OTHER })],
      [...repaid(), arrived(), withdrawn({ caller: MORPHO_BLUE_BUNDLES_BASE_V1 })],
      [...repaid(), arrived(), withdrawn({ assets: COLLATERAL - 1n })],
      [...repaid(), withdrawn()],
    ]) {
      const { result } = await check(returning(), logs, CLOSED);
      assert.equal(result.state === 'mismatched' && result.errorCode, 'loan_withdraw_event_mismatch');
    }
    const held = await check(returning(), [...repaid(), arrived(), withdrawn()], { ...CLOSED, collateralAssets: COLLATERAL });
    assert.equal(held.result.state, 'unavailable');
  });
  it('a plain Morpho repayment still refuses any collateral withdrawal', async () => {
    const plain = execution('morpho', 'repay'); Object.assign(plain.run.facts, { amountMode: 'all', requestedAssets: null, maximumDebitAssets: '4000000' });
    const { result } = await check(plain, [...repaid(), withdrawn()], { debtAssets: 0n, debtShares: 0n, collateralAssets: 100n });
    assert.equal(result.state === 'mismatched' && result.errorCode, 'loan_unrequested_collateral_withdrawal');
  });
});

// 2026-11-07, the operator: «да делай прямые вызовы для всех кошельков». A Still loan on Morpho is now the
// wallet's own calls to Morpho Blue: the wallet is the caller of every protocol event, is paid by Morpho Blue
// itself, and pays Morpho Blue exactly what it repays. One approved as a bundle is read as it was approved.
describe('the wallet’s own calls to Morpho Blue: what the receipt must show', () => {
  const CBBTC = CRYPTO[0]!, WETH_MARKET = CRYPTO[1]!.morphoMarket;
  const PARAMS = { loanToken: ADDRESSES.usdc, collateralToken: CBBTC.token, oracle: '0x663becd10dae6c4a3dcd89f1d76c1174199639b9', irm: '0x46415998764c29ab2a25cbea6254146d50d22687', lltv: 860_000_000_000_000_000n };
  const WETH_PARAMS = { loanToken: ADDRESSES.usdc, collateralToken: ADDRESSES.weth, oracle: '0xfea2d58cefcb9fcb597723c6bae66ffe4193afe4', irm: '0x46415998764c29ab2a25cbea6254146d50d22687', lltv: 860_000_000_000_000_000n };
  const withdrawEvents = parseAbi(['event WithdrawCollateral(bytes32 indexed id,address caller,address indexed onBehalf,address indexed receiver,uint256 assets)']);
  const withCalls = (record: LoanExecutionV1, calls: readonly unknown[]) => { record.run.calls = [...calls] as LoanExecutionV1['run']['calls']; record.run.callsHash = hashApprovedCallsV1(record.run.calls); return record; };
  const supplied = (caller: string = WALLET, market: string = CBBTC.morphoMarket, assets = 10n): VerifiedReceiptLogV1 => ({ address: ADDRESSES.morpho,
    topics: encodeEventTopics({ abi: morphoEvents, eventName: 'SupplyCollateral', args: { id: market as Hex, caller: caller as Address, onBehalf: WALLET as Address } }) as Hex[],
    data: encodeAbiParameters([{ type: 'uint256' }], [assets]) });
  const LOANED = { debtAssets: 5_000_000n, debtShares: 500n, collateralAssets: 110n };
  function borrowed(): LoanExecutionV1 {
    const record = execution('morpho', 'borrow'); Object.assign(record.run.facts, { collateralSupplyAssets: '10' });
    const plan = morphoDirectBorrowPlanV1({ walletAddress: WALLET, marketId: CBBTC.morphoMarket, marketParams: PARAMS, collateralSymbol: 'cbBTC', collateralSupplyAssets: 10n, borrowAssets: 2_000_000n });
    assert.ok(plan.ok); return withCalls(record, plan.ok ? plan.plan.calls : []);
  }
  const loan = (patch: { caller?: string; receiver?: string } = {}) => [transfer(CBBTC.token, WALLET, ADDRESSES.morpho, 10n), supplied(),
    transfer(ADDRESSES.usdc, ADDRESSES.morpho, WALLET, 2_000_000n), morphoEvent('borrow', { caller: WALLET, ...patch })];

  it('a loan: the wallet pledges and borrows itself, and Morpho Blue pays it', async () => {
    const { result } = await check(borrowed(), loan(), LOANED);
    assert.equal(result.state, 'matched', result.state !== 'matched' ? result.errorCode : '');
    // The bundle's caller or receiver, or USDC from anyone but Morpho Blue, is not the wallet's own loan.
    assert.deepEqual((await check(borrowed(), loan({ caller: MORPHO_BLUE_BUNDLES_BASE_V1 }), LOANED)).result, { state: 'mismatched', errorCode: 'loan_protocol_caller_mismatch' });
    assert.deepEqual((await check(borrowed(), loan({ receiver: MORPHO_BLUE_BUNDLES_BASE_V1 }), LOANED)).result, { state: 'mismatched', errorCode: 'loan_protocol_event_mismatch' });
    const routed = [...loan().slice(0, 2), transfer(ADDRESSES.usdc, OTHER, WALLET, 2_000_000n), morphoEvent('borrow', { caller: WALLET })];
    assert.deepEqual((await check(borrowed(), routed, LOANED)).result, { state: 'mismatched', errorCode: 'loan_borrow_source_mismatch' });
    // The pledge must be exactly the one chosen, and the position must hold it.
    assert.notEqual((await check(borrowed(), loan().filter((_, i) => i !== 1), LOANED)).result.state, 'matched');
    assert.notEqual((await check(borrowed(), loan(), { ...LOANED, collateralAssets: 100n })).result.state, 'matched');
  });

  it('native ETH: the wallet wraps exactly the chosen ETH itself, pledges it and authorizes nobody', async () => {
    const record = execution('morpho', 'borrow');
    Object.assign(record.run.facts, { collateralTokenAddress: ADDRESSES.weth.toLowerCase(), collateralSymbol: 'WETH', marketId: WETH_MARKET, collateralSupplyAssets: '10',
      nativeFunding: { maximumNativeAssets: '10', reserveAssets: '500000000000000', balanceBeforeAssets: '100000000000000000', balanceAfterAssets: '99999999999999990',
        authorizedBefore: false, feeQuoteState: 'wallet_quote_required' as const } });
    const plan = morphoDirectBorrowPlanV1({ walletAddress: WALLET, marketId: WETH_MARKET, marketParams: WETH_PARAMS, collateralSymbol: 'WETH', collateralSupplyAssets: 10n, borrowAssets: 2_000_000n, nativeSupply: true });
    assert.ok(plan.ok); withCalls(record, plan.ok ? plan.plan.calls : []);
    const wrap = (dst: string = WALLET, wad = 10n): VerifiedReceiptLogV1 => ({ address: ADDRESSES.weth,
      topics: encodeEventTopics({ abi: morphoEvents, eventName: 'Deposit', args: { dst: dst as Address } }) as Hex[], data: encodeAbiParameters([{ type: 'uint256' }], [wad]) });
    const grant: VerifiedReceiptLogV1 = { address: ADDRESSES.morpho, topics: encodeEventTopics({ abi: morphoEvents, eventName: 'SetAuthorization', args: {
      caller: WALLET as Address, authorizer: WALLET as Address, authorized: MORPHO_BLUE_BUNDLES_BASE_V1 } }) as Hex[], data: encodeAbiParameters([{ type: 'bool' }], [true]) };
    const logs = (first = wrap(), extra: VerifiedReceiptLogV1[] = []) => [first, transfer(ADDRESSES.weth, WALLET, ADDRESSES.morpho, 10n), supplied(WALLET, WETH_MARKET),
      transfer(ADDRESSES.usdc, ADDRESSES.morpho, WALLET, 2_000_000n), morphoEvent('borrow', { market: WETH_MARKET, caller: WALLET }), ...extra];
    // The authorization read at the receipt is still what it was before: nobody was given a right.
    const AT_RECEIPT = { ...LOANED, nativeAuthorized: false };
    const { result } = await check(record, logs(), AT_RECEIPT);
    assert.equal(result.state, 'matched', result.state !== 'matched' ? result.errorCode : '');
    for (const [bad, code] of [[logs(wrap(MORPHO_BLUE_BUNDLES_BASE_V1)), 'loan_native_wrapping_event_mismatch'], [logs(wrap(WALLET, 9n)), 'loan_native_wrapping_event_mismatch'],
      [logs(wrap(), [grant]), 'loan_native_authorization_mismatch']] as const) {
      assert.deepEqual((await check(record, bad, AT_RECEIPT)).result, { state: 'mismatched', errorCode: code });
    }
    assert.equal((await check(record, logs(), { ...LOANED, nativeAuthorized: true })).result.state, 'unavailable');
    const bundled = [wrap(), transfer(ADDRESSES.weth, WALLET, ADDRESSES.morpho, 10n), supplied(MORPHO_BLUE_BUNDLES_BASE_V1, WETH_MARKET),
      transfer(ADDRESSES.usdc, ADDRESSES.morpho, WALLET, 2_000_000n), morphoEvent('borrow', { market: WETH_MARKET, caller: WALLET })];
    assert.deepEqual((await check(record, bundled, AT_RECEIPT)).result, { state: 'mismatched', errorCode: 'loan_native_protocol_source_mismatch' });
  });

  function repaidAll(back = false): LoanExecutionV1 {
    const record = execution('morpho', 'repay');
    Object.assign(record.run.facts, { amountMode: 'all', requestedAssets: null, maximumDebitAssets: '4000000', debtAfterAssets: '0', debtAfterShares: '0',
      ...(back ? { collateralReturnAssets: '100', collateralBeforeAssets: '100', collateralAfterAssets: '0' } : {}) });
    const plan = morphoDirectRepayPlanV1({ walletAddress: WALLET, marketId: CBBTC.morphoMarket, marketParams: PARAMS, amount: { mode: 'all' }, borrowShares: 300n,
      maximumAssets: 4_000_000n, repaying: true, ...(back ? { returnCollateralAssets: 100n } : {}) });
    assert.ok(plan.ok); return withCalls(record, plan.ok ? plan.plan.calls : []);
  }
  const repay = (assets = 3_000_000n, caller: string = WALLET) => [transfer(ADDRESSES.usdc, WALLET, ADDRESSES.morpho, assets), morphoEvent('repay', { assets, shares: 300n, caller })];

  it('a repayment: the wallet pays Morpho Blue exactly what it repays, within the cap, and takes nothing back', async () => {
    const CLOSED = { debtAssets: 0n, debtShares: 0n, collateralAssets: 100n };
    const { result } = await check(repaidAll(), repay(), CLOSED);
    assert.equal(result.state, 'matched', result.state !== 'matched' ? result.errorCode : '');
    assert.deepEqual((await check(repaidAll(), repay(3_000_000n, MORPHO_BLUE_BUNDLES_BASE_V1), CLOSED)).result, { state: 'mismatched', errorCode: 'loan_protocol_caller_mismatch' });
    // More than the cap, a refund, or a debt left: not this repayment.
    assert.notEqual((await check(repaidAll(), repay(4_000_001n), CLOSED)).result.state, 'matched');
    assert.notEqual((await check(repaidAll(), [...repay(), transfer(ADDRESSES.usdc, ADDRESSES.morpho, WALLET, 1n)], CLOSED)).result.state, 'matched');
    assert.notEqual((await check(repaidAll(), repay(), { ...CLOSED, debtShares: 1n })).result.state, 'matched');
  });

  it('repay all, then take the collateral back: the wallet’s own repayment and its own withdrawal', async () => {
    const withdrawn: VerifiedReceiptLogV1 = { address: ADDRESSES.morpho, topics: encodeEventTopics({ abi: withdrawEvents, eventName: 'WithdrawCollateral', args: {
      id: bytes32(CBBTC.morphoMarket), onBehalf: WALLET as Address, receiver: WALLET as Address } }) as Hex[],
      data: encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [WALLET as Address, 100n]) };
    const logs = [...repay(), transfer(CBBTC.token, ADDRESSES.morpho, WALLET, 100n), withdrawn];
    const { result } = await check(repaidAll(true), logs, { debtAssets: 0n, debtShares: 0n, collateralAssets: 0n });
    assert.equal(result.state, 'matched', result.state !== 'matched' ? result.errorCode : '');
    if (result.state === 'matched') assert.equal(result.proof.collateralReturnedAssets, '100');
    // The repayment is in the approved calls, so it must also be in the receipt.
    const { result: unpaid } = await check(repaidAll(true), logs.slice(2), { debtAssets: 0n, debtShares: 0n, collateralAssets: 0n });
    assert.equal(unpaid.state === 'mismatched' && unpaid.errorCode, 'loan_protocol_event_not_unique');
  });
});
