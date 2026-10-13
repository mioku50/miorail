import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import type { Request } from 'express';
import { encodeAbiParameters, encodeEventTopics, encodeFunctionData, parseAbi, type Hex } from 'viem';
import { validateAerodromeClaimCallsV1 } from '@mioagent/security/aerodromeClaimGuard';
import { validateUniswapCollectCallsV1 } from '@mioagent/security/uniswapCollectGuard';

import type { AerodromeClaimPlanV1 } from './aerodromeClaimReader.js';
import { InMemoryBaseMcpActionReceiptRepositoryV1 } from './baseMcpActionReceipts.js';
import { baseMcpAerodromeClaimRuntimeV1 as aero } from './baseMcpAerodromeClaim.js';
import { baseMcpExtensionActionRuntime as extension, reconcileBaseMcpActionV1 } from './baseMcpExtensionActions.js';
import { baseMcpUniswapCollectRuntimeV1 as uni } from './baseMcpUniswapCollect.js';
import {
  FOUND_WALLET_CLAIM_PREPARE_STALE_MS_V1, FOUND_WALLET_CLAIM_UNSENT_TTL_MS_V1, foundWalletChainReceiptV1,
  foundWalletClaimRuntimeV1 as runtime, prepareFoundWalletClaimV1, reconcileFoundWalletClaimV1, recordFoundWalletSubmissionV1,
} from './foundWalletClaim.js';
import { UNISWAP_V3_POSITION_MANAGER_V1, type UniswapFeesPlanV1 } from './uniswapFeesReader.js';

const WALLET = '0x1111111111111111111111111111111111111111';
const OTHER = '0x3333333333333333333333333333333333333333';
const POOL = '0x2222222222222222222222222222222222222222';
const WETH = '0x4200000000000000000000000000000000000006';
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const TENANT = 'tenant-found';
const HASH_A = `0x${'a'.repeat(64)}` as const;
const HASH_B = `0x${'b'.repeat(64)}` as const;
const SUFFIX = '62635f74657374070080218021802180218021802180218021';
let clock = Date.parse('2026-10-12T09:00:00.000Z');
const NOW = () => new Date(clock).toISOString();
const saved = { runtime: { ...runtime }, aero: { ...aero }, uni: { ...uni }, extension: { ...extension } };
afterEach(() => {
  Object.assign(runtime, saved.runtime); Object.assign(aero, saved.aero); Object.assign(uni, saved.uni);
  Object.assign(extension, saved.extension);
  clock = Date.parse('2026-10-12T09:00:00.000Z');
});

function feesPlan(count = 2, over: Partial<UniswapFeesPlanV1> = {}): UniswapFeesPlanV1 {
  return {
    blockNumber: '100', positionsHeld: count + 1, positionsOpen: count, v4PositionsHeld: 0, unreadable: 0, errorCode: null,
    positions: Array.from({ length: count }, (_, index) => ({ tokenId: String(41 + index), token0: WETH, token1: USDC, fee: 500,
      amount0: String(1_000 + index), amount1: '0' })),
    ...over,
  };
}
function claimPlan(): AerodromeClaimPlanV1 {
  return { blockNumber: '100', poolsTotal: 38_794, poolsRead: 38_794, poolsUnread: 0, poolsReadDirect: 0, clPositionsTotal: 0, clPositionsRead: 0,
    positionsFound: 1, managedSkipped: 0, errorCode: null, calls: [{ kind: 'basic_fees', pool: POOL, tokenId: '0',
      token0: WETH, token1: USDC, amount0: '10', amount1: '0', aero: '0',
      call: { index: 0, callType: 'other', to: POOL, valueWei: '0', asset: null, amountAtomic: null,
        recipient: WALLET, spender: null, data: encodeFunctionData({ abi: parseAbi(['function claimFees()']), functionName: 'claimFees' }) } }] };
}
function collectLog(tokenId: bigint, recipient = WALLET, amount0 = 10n) {
  return { address: UNISWAP_V3_POSITION_MANAGER_V1,
    topics: encodeEventTopics({ abi: parseAbi(['event Collect(uint256 indexed tokenId,address recipient,uint256 amount0,uint256 amount1)']),
      eventName: 'Collect', args: { tokenId } }) as Hex[],
    data: encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }, { type: 'uint256' }], [recipient as Hex, amount0, 0n]) };
}
function claimLog(wallet = WALLET) {
  return { address: POOL,
    topics: encodeEventTopics({ abi: parseAbi(['event Claim(address indexed sender,address indexed recipient,uint256 amount0,uint256 amount1)']),
      eventName: 'Claim', args: { sender: wallet as Hex, recipient: wallet as Hex } }) as Hex[],
    data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [10n, 0n]) };
}
type Log = ReturnType<typeof collectLog>;
function tx(hash: Hex, logs: Log[], blockNumber = 102n, status: 'success' | 'reverted' = 'success') {
  return { transactionHash: hash, status, blockNumber, gasUsed: 42n, effectiveGasPriceWei: 1n, logs };
}

/** Wallet MCP must never be touched on this path. */
function noWalletMcp(): never { throw new Error('wallet path must not open Wallet MCP'); }

function setup(chain: Record<string, ReturnType<typeof tx> | null> = {}) {
  const repository = new InMemoryBaseMcpActionReceiptRepositoryV1();
  const counters = { read: 0, simulate: 0, chain: 0 };
  runtime.repository = repository;
  runtime.now = NOW;
  runtime.receiptReader = () => ({ getTransactionReceipt: async (hash) => { counters.chain++; return chain[hash] ?? null; } });
  for (const side of [aero, uni] as const) {
    side.repository = repository;
    side.now = NOW;
    side.builderCode = () => 'bc_test';
    side.createTools = noWalletMcp as never;
    side.verifyWallet = noWalletMcp as never;
  }
  uni.createReader = async () => ({ blockNumber: 100n, readMany: async () => [], dryCollect: async () => [] });
  uni.readPlan = async () => { counters.read++; return feesPlan(); };
  uni.simulate = async (plan, wallet) => {
    counters.simulate++;
    assert.equal(wallet, WALLET, 'simulated from the wallet that will send');
    validateUniswapCollectCallsV1(WALLET, plan.calls.map(({ call }) => ({ to: call.to, value: call.valueWei, data: call.data })));
    return { status: 'passed', observedAt: NOW(), blockNumber: '101', requestHash: HASH_A, responseHash: HASH_A, errorCode: null };
  };
  aero.createReader = async () => ({ blockNumber: 100n, read: async () => { throw new Error('not called'); } }) as never;
  aero.readPlan = async () => { counters.read++; return claimPlan(); };
  aero.simulate = async (plan) => {
    counters.simulate++;
    validateAerodromeClaimCallsV1(WALLET, plan.calls.map(({ call }) => ({ to: call.to, value: call.valueWei, data: call.data })));
    return { status: 'passed', observedAt: NOW(), blockNumber: '101', requestHash: HASH_A, responseHash: HASH_A, errorCode: null };
  };
  return { repository, counters };
}
const prepare = (idempotencyKey: string, protocol: 'aerodrome' | 'uniswap' = 'uniswap', walletAddress: string = WALLET) =>
  prepareFoundWalletClaimV1({ userId: TENANT, walletAddress, idempotencyKey, protocol });

test('a Found claim is read, guarded and simulated for the page wallet, and handed to it as exact calls', async () => {
  const { repository, counters } = setup();
  const ready = await prepare('collect-1');
  assert.equal(ready.kind, 'action', ready.reply);
  assert.equal(ready.errorCode, null);
  assert.deepEqual([ready.receipt?.provider, ready.receipt?.status, ready.receipt?.actionType], ['wallet', 'approval_required', 'uniswap_collect']);
  assert.match(ready.reply, /2 calls passed batch simulation\. Confirm them in your wallet/);
  assert.equal(ready.calls?.length, 2);
  assert.ok(ready.calls!.every((call) => call.to === UNISWAP_V3_POSITION_MANAGER_V1 && call.value === '0' && call.data.endsWith(SUFFIX)));
  // What the wallet gets is exactly what the guard and the simulation saw.
  validateUniswapCollectCallsV1(WALLET, ready.calls!.map((call) => ({ to: call.to, value: call.value, data: call.data })));
  const row = await repository.get(ready.receipt!.id, TENANT);
  assert.equal((row?.durableProof?.simulation as { status: string }).status, 'passed');
  assert.equal(row?.durableProof?.channel, 'wallet');
  assert.match(String(row?.durableProof?.callsHash), /^0x[0-9a-f]{64}$/);
  // A repeat of the same request reads nothing and hands back the same calls.
  const again = await prepare('collect-1');
  assert.deepEqual([again.receipt?.id, again.calls], [ready.receipt?.id, ready.calls]);
  assert.deepEqual([counters.read, counters.simulate], [1, 1]);

  // The Aerodrome claim rides the same path, with its own guard.
  const claim = await prepare('claim-1', 'aerodrome');
  assert.deepEqual([claim.kind, claim.receipt?.provider, claim.receipt?.actionType], ['action', 'wallet', 'aerodrome_claim']);
  assert.match(claim.reply, /1 call passed batch simulation\. Confirm it in your wallet/);
  assert.deepEqual(claim.calls?.map((call) => [call.to, call.data.slice(0, 10), call.data.endsWith(SUFFIX)]), [[POOL, '0xd294f093', true]]);
});

test('a fresh ask replaces calls nobody sent, but never a claim the wallet reported sending', async () => {
  const { repository, counters } = setup();
  const first = await prepare('collect-1');
  const second = await prepare('collect-2');
  assert.equal(second.kind, 'action');
  assert.notEqual(second.receipt?.id, first.receipt?.id);
  const replaced = await repository.get(first.receipt!.id, TENANT);
  assert.deepEqual([replaced?.status, replaced?.errorCode], ['failed', 'found_claim_replaced']);
  assert.equal(counters.read, 2);

  await recordFoundWalletSubmissionV1({ userId: TENANT, walletAddress: WALLET, receiptId: second.receipt!.id, transactionHashes: [HASH_A] });
  const blocked = await prepare('collect-3');
  assert.deepEqual([blocked.receipt?.id, blocked.receipt?.status, blocked.calls], [second.receipt?.id, 'pending', null]);
  assert.match(blocked.reply, /already on its way/);
  assert.equal(counters.read, 2, 'a blocked ask reads nothing');
  // Aerodrome's claim is its own kind and is not blocked by it.
  assert.equal((await prepare('claim-1', 'aerodrome')).kind, 'action');
});

test('a prepare still running blocks a second one; one cut short stops blocking after two minutes', async () => {
  const { repository, counters } = setup();
  const stuck = await repository.create({ tenantId: TENANT, walletAddress: WALLET, idempotencyKey: 'cut-short',
    actionType: 'uniswap_collect', intent: { operation: 'collect', recipient: WALLET }, now: NOW(), provider: 'wallet' });
  const busy = await prepare('collect-1');
  assert.deepEqual([busy.receipt?.id, busy.calls], [stuck.receipt.id, null]);
  assert.match(busy.reply, /being prepared in another window/);
  assert.equal(counters.read, 0);
  clock += FOUND_WALLET_CLAIM_PREPARE_STALE_MS_V1;
  const fresh = await prepare('collect-2');
  assert.equal(fresh.kind, 'action');
  assert.equal((await repository.get(stuck.receipt.id, TENANT))?.errorCode, 'found_claim_replaced');
});

test('two prepares with different IDs at once: the store lets one through and the other hands out nothing', async () => {
  const { counters } = setup();
  const [left, right] = await Promise.all([prepare('collect-a'), prepare('collect-b')]);
  const handed = [left, right].filter((one) => one.calls);
  assert.equal(handed.length, 1);
  const other = handed[0] === left ? right : left;
  assert.equal(other.calls, null);
  assert.match(other.reply, /being prepared in another window|already on its way/);
  assert.ok(counters.simulate <= 2);
});

test('nothing to claim, an incomplete reading, or a failed simulation hands nothing to the wallet', async () => {
  const { repository } = setup();
  uni.readPlan = async () => feesPlan(0);
  const none = await prepare('collect-1');
  assert.deepEqual([none.kind, none.receipt, none.calls], ['answered', null, null]);
  assert.match(none.reply, /No fees to collect/);

  uni.readPlan = async () => feesPlan(1, { errorCode: 'uniswap_positions_limit' });
  const partial = await prepare('collect-2');
  assert.deepEqual([partial.kind, partial.errorCode, partial.receipt, partial.calls], ['failed', 'uniswap_positions_limit', null, null]);

  uni.readPlan = async () => feesPlan();
  uni.simulate = async () => ({ status: 'failed', observedAt: NOW(), blockNumber: '101', requestHash: HASH_A, responseHash: HASH_A, errorCode: 'simulation_reverted' });
  const refused = await prepare('collect-3');
  assert.deepEqual([refused.errorCode, refused.calls, refused.receipt?.status], ['uniswap_simulation_required', null, 'failed']);
  assert.match(refused.reply, /nothing was handed to your wallet/);

  uni.builderCode = () => undefined;
  const unattributed = await prepare('collect-4');
  assert.deepEqual([unattributed.errorCode, unattributed.calls], ['uniswap_builder_code_unavailable', null]);
  assert.equal((await repository.list(TENANT)).filter((row) => row.status !== 'failed').length, 0);
});

test('no signed-in wallet or no request ID prepares nothing', async () => {
  const { counters } = setup();
  assert.equal((await prepareFoundWalletClaimV1({ userId: TENANT, protocol: 'uniswap', idempotencyKey: 'k' })).errorCode, 'base_mcp_action_wallet_required');
  assert.equal((await prepare('k', 'uniswap', `0x${'0'.repeat(40)}`)).errorCode, 'base_mcp_action_wallet_required');
  assert.equal((await prepareFoundWalletClaimV1({ userId: TENANT, walletAddress: WALLET, protocol: 'uniswap' })).errorCode, 'base_mcp_action_request_id_required');
  assert.equal(counters.read, 0);
});

test('the wallet reports what it sent: kept as its word, once, for its own wallet only', async () => {
  const { repository } = setup();
  const ready = await prepare('collect-1');
  const id = ready.receipt!.id;
  const record = (over: Partial<Parameters<typeof recordFoundWalletSubmissionV1>[0]> = {}) =>
    recordFoundWalletSubmissionV1({ userId: TENANT, walletAddress: WALLET, receiptId: id, transactionHashes: [HASH_A, HASH_B], ...over });
  assert.equal((await record({ walletAddress: OTHER })).errorCode, 'base_mcp_action_receipt_not_found');
  assert.equal((await record({ userId: 'tenant-other' })).errorCode, 'base_mcp_action_receipt_not_found');
  assert.equal((await record({ transactionHashes: ['0x12'] })).errorCode, 'found_claim_hashes_invalid');
  assert.equal((await record({ transactionHashes: [] })).errorCode, 'found_claim_hashes_invalid');

  const sent = await record({ transactionHashes: [HASH_A.toUpperCase().replace('0X', '0x'), HASH_B, HASH_B] });
  assert.equal(sent.errorCode, null);
  assert.deepEqual([sent.receipt?.status, sent.receipt?.transactionHash, sent.calls], ['pending', HASH_B, null]);
  const row = await repository.get(id, TENANT);
  assert.deepEqual((row?.durableProof?.submitted as { transactionHashes: string[] }).transactionHashes, [HASH_A, HASH_B]);
  assert.ok(row?.durableProof?.collectPlan, 'the plan stays beside the hashes');
  // The same report again is fine; a different one is refused.
  assert.equal((await record()).errorCode, null);
  assert.equal((await record({ transactionHashes: [HASH_A] })).errorCode, 'found_claim_already_submitted');

  // A Wallet MCP receipt is not this path's to touch.
  const mcp = await repository.create({ tenantId: TENANT, walletAddress: WALLET, idempotencyKey: 'mcp-1', actionType: 'send',
    intent: { operation: 'send', asset: 'USDC', amountAtomic: '1', recipient: OTHER } as never, now: NOW() });
  assert.equal((await record({ receiptId: mcp.receipt.id })).errorCode, 'base_mcp_action_receipt_not_found');
  await assert.rejects(repository.create({ tenantId: TENANT, walletAddress: WALLET, idempotencyKey: 'mcp-2', actionType: 'send',
    intent: { operation: 'send', asset: 'USDC', amountAtomic: '1', recipient: OTHER } as never, now: NOW(), provider: 'wallet' }),
  /base_mcp_action_provider_invalid/);
});

test('the chain settles it: every reported transaction must succeed and pay this wallet for every prepared call', async () => {
  // A wallet without atomic batches sends the two collects one by one.
  const chain: Record<string, ReturnType<typeof tx> | null> = {};
  const { repository, counters } = setup(chain);
  const ready = await prepare('collect-1');
  const stored = async () => (await repository.get(ready.receipt!.id, TENANT))!;
  const reconcile = async (walletAddress: string = WALLET) =>
    reconcileFoundWalletClaimV1({ userId: TENANT, walletAddress, receipt: await stored() });

  // Before the wallet answers: the calls again, and no chain read.
  const waiting = await reconcile();
  assert.deepEqual([waiting.receipt?.status, waiting.calls?.length, counters.chain], ['approval_required', 2, 0]);
  assert.equal((await reconcile(OTHER)).errorCode, 'base_mcp_wallet_mismatch');

  await recordFoundWalletSubmissionV1({ userId: TENANT, walletAddress: WALLET, receiptId: ready.receipt!.id, transactionHashes: [HASH_A, HASH_B] });
  // Not on Base yet.
  chain[HASH_A] = tx(HASH_A, [collectLog(41n)], 103n);
  const notYet = await reconcile();
  assert.deepEqual([notYet.errorCode, notYet.receipt?.status], [null, 'reconciling']);
  // Both mined: the logs are taken together, from the earliest block.
  chain[HASH_B] = tx(HASH_B, [collectLog(42n)], 104n);
  const done = await reconcile();
  assert.deepEqual([done.errorCode, done.receipt?.status, done.receipt?.reconciliationState], [null, 'completed', 'matched']);
  assert.deepEqual([done.receipt?.transactionHash, done.receipt?.blockNumber], [HASH_B, '103']);
  assert.match(done.reply, /Confirmed on Base/);
  assert.equal((await reconcile()).reply, 'This Action Receipt is final.');
});

test('a reverted transaction, events paying someone else, or an unreadable chain never completes a claim', async () => {
  const chain: Record<string, ReturnType<typeof tx> | null> = {};
  const { repository } = setup(chain);
  const sendAndCheck = async (key: string, hashes: Hex[]) => {
    const ready = await prepare(key);
    await recordFoundWalletSubmissionV1({ userId: TENANT, walletAddress: WALLET, receiptId: ready.receipt!.id, transactionHashes: hashes });
    return reconcileFoundWalletClaimV1({ userId: TENANT, walletAddress: WALLET, receipt: (await repository.get(ready.receipt!.id, TENANT))! });
  };
  chain[HASH_A] = tx(HASH_A, [collectLog(41n)], 103n);
  chain[HASH_B] = tx(HASH_B, [], 104n, 'reverted');
  const reverted = await sendAndCheck('collect-1', [HASH_A, HASH_B]);
  assert.deepEqual([reverted.errorCode, reverted.receipt?.status], ['found_claim_reverted', 'failed']);

  chain[HASH_B] = tx(HASH_B, [collectLog(41n), collectLog(42n, OTHER)], 104n);
  const elsewhere = await sendAndCheck('collect-2', [HASH_B]);
  assert.deepEqual([elsewhere.errorCode, elsewhere.receipt?.status], ['uniswap_collect_events_mismatch', 'failed']);

  // Events from before the reading are not this claim's.
  chain[HASH_B] = tx(HASH_B, [collectLog(41n), collectLog(42n)], 99n);
  assert.equal((await sendAndCheck('collect-3', [HASH_B])).errorCode, 'uniswap_collect_events_mismatch');

  runtime.receiptReader = () => ({ getTransactionReceipt: async () => { throw new Error('rpc down'); } });
  const unread = await sendAndCheck('collect-4', [HASH_A]);
  assert.deepEqual([unread.errorCode, unread.receipt?.status], ['found_claim_reconciliation_unavailable', 'pending']);
});

test('calls the wallet never reported stop waiting after an hour, and the reply does not claim they were never sent', async () => {
  const { repository } = setup();
  const ready = await prepare('collect-1');
  clock += FOUND_WALLET_CLAIM_UNSENT_TTL_MS_V1;
  const expired = await reconcileFoundWalletClaimV1({ userId: TENANT, walletAddress: WALLET, receipt: (await repository.get(ready.receipt!.id, TENANT))! });
  assert.deepEqual([expired.errorCode, expired.receipt?.status, expired.calls], ['found_claim_not_reported', 'failed', null]);
  assert.match(expired.reply, /never reported sending/);
  assert.match(expired.reply, /If you did send it, your wallet's activity shows it/);
});

test('the receipts route sends a wallet claim to the chain, never to Wallet MCP', async () => {
  const chain: Record<string, ReturnType<typeof tx> | null> = { [HASH_A]: tx(HASH_A, [claimLog()], 103n) };
  const { repository } = setup(chain);
  extension.repository = repository;
  const ready = await prepare('claim-1', 'aerodrome');
  await recordFoundWalletSubmissionV1({ userId: TENANT, walletAddress: WALLET, receiptId: ready.receipt!.id, transactionHashes: [HASH_A] });
  const checked = await reconcileBaseMcpActionV1({ req: {} as Request, userId: TENANT, walletAddress: WALLET, sessionSecret: 'test',
    receiptId: ready.receipt!.id });
  assert.deepEqual([checked.errorCode, checked.receipt?.status, checked.approvalUrl], [null, 'completed', null]);
});

test('several transactions read as one receipt: missing while any is missing, reverted if any reverted', async () => {
  const chain: Record<string, ReturnType<typeof tx> | null> = { [HASH_A]: tx(HASH_A, [collectLog(41n)], 105n) };
  const reader = { getTransactionReceipt: async (hash: string) => chain[hash] ?? null };
  const receipt = (hashes: string[]) => ({ durableProof: { submitted: { transactionHashes: hashes } } }) as never;
  assert.equal(await foundWalletChainReceiptV1(receipt([]), reader as never), 'missing');
  assert.equal(await foundWalletChainReceiptV1(receipt([HASH_A, HASH_B]), reader as never), 'missing');
  chain[HASH_B] = tx(HASH_B, [collectLog(42n)], 104n);
  const both = await foundWalletChainReceiptV1(receipt([HASH_A, HASH_B]), reader as never);
  assert.ok(typeof both === 'object');
  assert.deepEqual([both.transactionHash, both.blockNumber, both.logs.length], [HASH_B, 104n, 2]);
  chain[HASH_B] = tx(HASH_B, [], 104n, 'reverted');
  assert.equal(await foundWalletChainReceiptV1(receipt([HASH_A, HASH_B]), reader as never), 'reverted');
});
