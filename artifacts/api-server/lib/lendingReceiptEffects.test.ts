import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { encodeAbiParameters, encodeEventTopics, encodeFunctionData, parseAbi, type Address, type Hex } from 'viem';
import { hashApprovedCallsV1 } from '@mioagent/route-domain';
import type { VerifiedReceiptLogV1, VerifiedReceiptSourceV1 } from '@mioagent/route-proof';
import { ADDRESSES, CRYPTO, STOCKS } from '@mioagent/still-engine/registry';
import { MORPHO_BLUE_BUNDLES_BASE_V1 } from '@mioagent/rwa-issuer/morphoRepayPlan';
import { aaveV4ExecutionEventAbiV1, aaveV4WriteAbiV1 } from './aaveV4BorrowPlan.js';
import { lendingReceiptVerifierV1, type LendingReceiptPositionV1 } from './lendingReceiptEffects.js';
import { type LoanExecutionV1 } from './loanExecutionStore.js';
import { loanReadyFixture, LOAN_OWNER_FIXTURE as OWNER, LOAN_WALLET_FIXTURE as WALLET, LOAN_OTHER_WALLET_FIXTURE as OTHER, LOAN_NOW_FIXTURE as NOW, LOAN_TX_FIXTURE as TX } from './loanExecutionTestFixtures.js';

const transferAbi = parseAbi(['event Transfer(address indexed from,address indexed to,uint256 value)']);
const morphoEvents = parseAbi([
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
  it('rejects an unrequested token movement or collateral change during repayment', async () => {
    assert.notEqual((await check(execution(), [outMorpho(), transfer(STOCKS[0]!.token, WALLET, OTHER, 1n), morphoEvent('repay')])).result.state, 'matched');
    assert.notEqual((await check(execution(), [outMorpho(), morphoEvent('repay')], { debtAssets: 1_000_000n, debtShares: 100n, collateralAssets: 99n })).result.state, 'matched');
  });
});
