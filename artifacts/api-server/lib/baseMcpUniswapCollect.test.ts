import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import type { Request } from 'express';
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, parseAbi, type Hex } from 'viem';
import { BASE_MCP_PROVIDER_INTENTS_V1, exampleCapabilityStateV1 } from '@mioagent/security';
import { validateUniswapCollectCallsV1 } from '@mioagent/security/uniswapCollectGuard';

import { InMemoryBaseMcpActionReceiptRepositoryV1 } from './baseMcpActionReceipts.js';
import { classifyBaseMcpExtensionIntentV1 } from './baseMcpExtensionActions.js';
import { baseMcpRuntimeSnapshotV1, foundClaimsReleasedV1 } from './baseMcpRuntimeSnapshot.js';
import {
  baseMcpUniswapCollectRuntimeV1 as runtime, prepareBaseMcpUniswapCollectV1, reconcileBaseMcpUniswapCollectV1,
  uniswapCollectEventsMatchV1, uniswapCollectPlanV1,
} from './baseMcpUniswapCollect.js';
import { UNISWAP_V3_POSITIONS_ABI_V1, UNISWAP_V3_POSITION_MANAGER_V1, type UniswapFeesPlanV1 } from './uniswapFeesReader.js';

const WALLET = '0x1111111111111111111111111111111111111111';
const OTHER = '0x2222222222222222222222222222222222222222';
const WETH = '0x4200000000000000000000000000000000000006';
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const HASH = `0x${'b'.repeat(64)}` as const;
const NOW = '2026-10-11T21:00:00.000Z';
const SUFFIX = '62635f74657374070080218021802180218021802180218021';
const original = { ...runtime };
afterEach(() => Object.assign(runtime, original));

function feesPlan(count = 2, over: Partial<UniswapFeesPlanV1> = {}): UniswapFeesPlanV1 {
  return {
    blockNumber: '100', positionsHeld: count + 1, positionsOpen: count, v4PositionsHeld: 0, unreadable: 0, errorCode: null,
    positions: Array.from({ length: count }, (_, index) => ({ tokenId: String(41 + index), token0: WETH, token1: USDC, fee: 500,
      amount0: String(1_000 + index), amount1: '0' })),
    ...over,
  };
}
function collectLog(tokenId: bigint, recipient = WALLET, amount0 = 10n, address = UNISWAP_V3_POSITION_MANAGER_V1) {
  return { address,
    topics: encodeEventTopics({ abi: parseAbi(['event Collect(uint256 indexed tokenId,address recipient,uint256 amount0,uint256 amount1)']),
      eventName: 'Collect', args: { tokenId } }) as Hex[],
    data: encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }, { type: 'uint256' }], [recipient as Hex, amount0, 0n]) };
}
function chainReceipt(logs = [collectLog(41n), collectLog(42n)]) {
  return { transactionHash: HASH, status: 'success' as const, blockNumber: 102n, gasUsed: 42n, effectiveGasPriceWei: 1n, logs };
}
function setup() {
  const repository = new InMemoryBaseMcpActionReceiptRepositoryV1();
  const counters = { submit: 0, read: 0, simulate: 0, status: 0, rank: 0 };
  runtime.repository = repository;
  runtime.now = () => NOW;
  runtime.builderCode = () => 'bc_test';
  runtime.createReader = async () => ({ blockNumber: 100n, readMany: async () => [], dryCollect: async () => [] });
  runtime.readPlan = async () => { counters.read++; return feesPlan(); };
  runtime.rank = async (plan) => { counters.rank++; return [...plan.positions].reverse(); };
  runtime.simulate = async (snapshot) => {
    counters.simulate++;
    // The simulated calls are exactly what the closed guard accepts.
    validateUniswapCollectCallsV1(WALLET, snapshot.calls.map(({ call }) => ({ to: call.to, value: call.valueWei, data: call.data })));
    assert.ok(snapshot.calls.every(({ call }) => call.data.endsWith(SUFFIX)));
    return { status: 'passed', observedAt: runtime.now(), blockNumber: '101', requestHash: HASH, responseHash: HASH, errorCode: null };
  };
  runtime.verifyWallet = async () => ({ checked: true, match: true, mcpAddresses: [WALLET] });
  runtime.createTools = async (_req, _user, _secret, options) => ({
    listProviderTools: async () => [{ providerId: 'base-mcp-dynamic', tools: [
      { name: 'get_request_status', description: 'status', inputSchema: { type: 'object', properties: { requestId: {} } } },
    ] }],
    callTool: async (name: string, args: unknown) => {
      if (name === 'prepared_uniswap_collect') {
        counters.submit++;
        assert.deepEqual(args, {});
        assert.equal(options?.baseMcpPreparedClaim?.actionType, 'uniswap_collect');
        return { isError: false, content: JSON.stringify({ requestId: 'collect-provider-1', approvalUrl: 'https://keys.coinbase.com/approve/collect-1' }) };
      }
      assert.equal(name, 'get_request_status'); counters.status++;
      return { isError: false, content: JSON.stringify({ status: 'completed', txHash: HASH }) };
    }, close: async () => {},
  } as any);
  runtime.receiptReader = () => ({ getTransactionReceipt: async () => chainReceipt() });
  return { repository, counters };
}
function input(idempotencyKey = 'collect-1') {
  return { req: {} as Request, userId: 'tenant-collect', walletAddress: WALLET, sessionSecret: 'test', idempotencyKey };
}

test('a collect order is classified only where it can be prepared, and only for the wallet itself', () => {
  const snapshot = { ...baseMcpRuntimeSnapshotV1(), batchSimulationAvailable: true, releasedActionPlugins: ['aerodrome', 'uniswap'] };
  for (const text of ['Collect my Uniswap fees', 'Claim my Uniswap fees', 'Забери мои комиссии Uniswap', 'Collect fees from my Uniswap liquidity positions']) {
    assert.equal(classifyBaseMcpExtensionIntentV1(text, snapshot).kind, 'uniswap_collect', text);
  }
  assert.equal(classifyBaseMcpExtensionIntentV1('Collect my Uniswap fees', { ...snapshot, batchSimulationAvailable: false }).kind, 'needs_input');
  assert.equal(classifyBaseMcpExtensionIntentV1('Collect my Uniswap fees', { ...snapshot, releasedActionPlugins: ['aerodrome'] }).kind, 'needs_input');
  for (const text of [`Collect my Uniswap fees to ${OTHER}`, 'Collect my Uniswap fees and remove liquidity', 'Collect my Uniswap fees and withdraw']) {
    const intent = classifyBaseMcpExtensionIntentV1(text, snapshot);
    assert.deepEqual(intent.kind === 'needs_input' ? intent.errorCode : intent, 'uniswap_collect_scope_required', text);
  }
  // A question reads; v4 is not this collect.
  const read = classifyBaseMcpExtensionIntentV1('Check my Uniswap fees', snapshot);
  assert.deepEqual(read.kind === 'read' ? [read.providerId, read.exampleId] : read, ['uniswap', 'v3-fees']);
  assert.notEqual(classifyBaseMcpExtensionIntentV1('Collect my Uniswap v4 fees', snapshot).kind, 'uniswap_collect');
  // Aerodrome's claim is untouched.
  assert.equal(classifyBaseMcpExtensionIntentV1('Claim my Aerodrome fees', snapshot).kind, 'aerodrome_claim');
});

test('"What can I claim?" reads both protocols; a protocol Found does not read is not asked', () => {
  const snapshot = { ...baseMcpRuntimeSnapshotV1(), batchSimulationAvailable: true };
  for (const text of ['What can I claim?', 'Check my rewards', 'Do I have unclaimed fees?', 'Что я могу забрать?',
    'Проверь мои награды', 'What can I claim on Aerodrome and Uniswap?']) {
    assert.deepEqual(classifyBaseMcpExtensionIntentV1(text, snapshot), { kind: 'found_read', protocols: ['aerodrome', 'uniswap'] }, text);
  }
  for (const text of ['What fees will I pay to swap 100 USDC?', 'Check my Moonwell rewards', 'What does my wallet hold?']) {
    assert.notEqual(classifyBaseMcpExtensionIntentV1(text, snapshot).kind, 'found_read', text);
  }
  assert.deepEqual(classifyBaseMcpExtensionIntentV1('Notify me when my rewards reach $5', snapshot), { kind: 'aerodrome_rewards_alert', thresholdUsdCents: 500 });
});

test('Uniswap’s v3 read and collect are released here; its v4 fee read stays unavailable', () => {
  const snapshot = { ...baseMcpRuntimeSnapshotV1(), batchSimulationAvailable: true };
  const uniswap = BASE_MCP_PROVIDER_INTENTS_V1.find((plugin) => plugin.pluginId === 'uniswap')!;
  const cell = (id: string, runtime = snapshot) => exampleCapabilityStateV1(uniswap, uniswap.examples.find((example) => example.id === id)!, runtime);
  assert.equal(cell('v3-fees').state, 'released');
  assert.equal(cell('v3-collect').state, 'released');
  assert.equal(cell('v3-collect', { ...snapshot, batchSimulationAvailable: false }).state, 'unavailable');
  assert.equal(cell('fees').state, 'unavailable');
  assert.equal(cell('create-lp').state, 'unsupported');
  assert.deepEqual(uniswap.examples.slice(0, 2).map((example) => example.id), ['v3-fees', 'v3-collect']);
  assert.deepEqual(foundClaimsReleasedV1({ ...snapshot, batchSimulationAvailable: false }), { aerodromeClaimReleased: false, uniswapCollectReleased: false });
});

test('the approval holds the positions owing fees, the largest first past twenty, each attributed', async () => {
  let ranked = 0;
  const small = await uniswapCollectPlanV1(feesPlan(2), WALLET, { builderCode: 'bc_test', rank: async () => { ranked++; return []; } });
  assert.equal(ranked, 0, 'twenty or fewer need no prices');
  assert.deepEqual(small.calls.map((item) => item.tokenId), ['41', '42']);
  assert.equal(small.positionsLeft, 0);
  const decoded = decodeFunctionData({ abi: UNISWAP_V3_POSITIONS_ABI_V1, data: small.calls[0]!.call.data.slice(0, -SUFFIX.length) as Hex });
  assert.deepEqual(decoded.args, [{ tokenId: 41n, recipient: WALLET, amount0Max: (1n << 128n) - 1n, amount1Max: (1n << 128n) - 1n }]);
  const many = await uniswapCollectPlanV1(feesPlan(23), WALLET, { builderCode: 'bc_test',
    rank: async (plan) => [...plan.positions].reverse() });
  assert.equal(many.calls.length, 20);
  assert.equal(many.calls[0]!.tokenId, '63');
  assert.equal(many.positionsLeft, 3);
});

test('a simulated collect is durable and idempotent, and asks the wallet once', async () => {
  const { repository, counters } = setup();
  const [first, second] = await Promise.all([prepareBaseMcpUniswapCollectV1(input()), prepareBaseMcpUniswapCollectV1(input())]);
  assert.equal(counters.submit, 1);
  assert.ok(first.approvalUrl || second.approvalUrl);
  assert.equal(first.receipt?.id, second.receipt?.id);
  assert.equal(first.receipt?.routeVerified, false);
  if (first.receipt?.actionType === 'uniswap_collect') assert.deepEqual([first.receipt.positionCount, first.receipt.positionsHeld], [2, 3]);
  assert.match(first.reply + second.reply, /2 collect calls passed batch simulation/);
  // Another request ID meets the open collect instead of a second approval.
  const third = await prepareBaseMcpUniswapCollectV1(input('collect-2'));
  assert.equal(third.receipt?.id, first.receipt?.id);
  assert.equal(counters.submit, 1);
  assert.equal((await repository.get(first.receipt!.id, 'tenant-collect'))?.status, 'approval_required');
});

test('an unverified wallet, nothing owed, a failed read or a failed simulation asks the wallet nothing', async () => {
  const { counters } = setup();
  runtime.verifyWallet = async () => ({ checked: false, match: false, mcpAddresses: [] });
  assert.equal((await prepareBaseMcpUniswapCollectV1(input('a'))).errorCode, 'base_mcp_wallet_unverified');
  assert.equal(counters.read, 0);
  runtime.verifyWallet = original.verifyWallet;
  setup();
  runtime.readPlan = async () => feesPlan(0);
  const empty = await prepareBaseMcpUniswapCollectV1(input('b'));
  assert.deepEqual([empty.kind, empty.receipt], ['answered', null]);
  assert.match(empty.reply, /No fees to collect/);
  runtime.readPlan = async () => ({ ...feesPlan(0), errorCode: 'uniswap_positions_limit' });
  assert.equal((await prepareBaseMcpUniswapCollectV1(input('c'))).errorCode, 'uniswap_positions_limit');
  const { counters: after } = setup();
  runtime.simulate = async () => ({ status: 'failed', observedAt: NOW, blockNumber: null, requestHash: HASH, responseHash: null, errorCode: 'reverted' });
  const failed = await prepareBaseMcpUniswapCollectV1(input('d'));
  assert.deepEqual([failed.errorCode, failed.receipt?.status, after.submit], ['uniswap_simulation_required', 'failed', 0]);
});

test('only Collect events from the pinned manager, paying this wallet, for every position, finalize it', async () => {
  const { repository } = setup();
  const prepared = await prepareBaseMcpUniswapCollectV1(input());
  let stored = (await repository.get(prepared.receipt!.id, 'tenant-collect'))!;
  runtime.receiptReader = () => ({ getTransactionReceipt: async () => null });
  assert.equal((await reconcileBaseMcpUniswapCollectV1({ ...input(), receipt: stored })).receipt?.status, 'reconciling');
  stored = (await repository.get(stored.id, 'tenant-collect'))!;
  runtime.receiptReader = () => ({ getTransactionReceipt: async () => chainReceipt() });
  const done = await reconcileBaseMcpUniswapCollectV1({ ...input(), receipt: stored });
  assert.deepEqual([done.receipt?.status, done.receipt?.reconciliationState], ['completed', 'matched']);

  const plan = (stored.durableProof as { collectPlan: Parameters<typeof uniswapCollectEventsMatchV1>[0] }).collectPlan;
  assert.equal(uniswapCollectEventsMatchV1(plan, WALLET, chainReceipt()), true);
  assert.equal(uniswapCollectEventsMatchV1(plan, WALLET, chainReceipt([collectLog(41n)])), false, 'every position needs its own');
  assert.equal(uniswapCollectEventsMatchV1(plan, WALLET, chainReceipt([collectLog(41n), collectLog(42n, OTHER)])), false, 'paid elsewhere');
  assert.equal(uniswapCollectEventsMatchV1(plan, WALLET, chainReceipt([collectLog(41n), collectLog(42n, WALLET, 10n, OTHER)])), false, 'another manager');
  assert.equal(uniswapCollectEventsMatchV1(plan, WALLET, chainReceipt([collectLog(41n), collectLog(42n, WALLET, 0n)])), false, 'nothing paid');
  assert.equal(uniswapCollectEventsMatchV1(plan, WALLET, { ...chainReceipt(), blockNumber: 99n }), false);
  assert.equal(uniswapCollectEventsMatchV1(plan, WALLET, { ...chainReceipt(), status: 'reverted' }), false);
  // Another tenant cannot reconcile it.
  assert.equal((await reconcileBaseMcpUniswapCollectV1({ ...input(), userId: 'other-tenant', receipt: stored })).receipt, null);
});

test('a lost submission stays pending, is never resent, and stops blocking after an hour', async () => {
  const { repository, counters } = setup();
  const create = runtime.createTools;
  let lose = true;
  runtime.createTools = async (...args) => {
    const tools = await create(...args);
    if (args[3]?.baseMcpPreparedClaim && lose) tools.callTool = async () => { counters.submit++; throw new Error('lost response'); };
    return tools;
  };
  const first = await prepareBaseMcpUniswapCollectV1(input('lost'));
  assert.deepEqual([first.receipt?.status, first.errorCode], ['pending', 'base_mcp_claim_outcome_unknown']);
  await prepareBaseMcpUniswapCollectV1(input('lost'));
  runtime.now = () => '2026-10-11T21:59:59.000Z';
  assert.equal((await prepareBaseMcpUniswapCollectV1(input('too-soon'))).receipt?.id, first.receipt?.id);
  assert.equal(counters.submit, 1);
  lose = false; runtime.now = () => '2026-10-11T22:00:01.000Z';
  const next = await prepareBaseMcpUniswapCollectV1(input('after-an-hour'));
  assert.notEqual(next.receipt?.id, first.receipt?.id);
  assert.equal(counters.submit, 2);
  assert.equal((await repository.get(first.receipt!.id, 'tenant-collect'))?.errorCode, 'uniswap_collect_outcome_expired');
});
