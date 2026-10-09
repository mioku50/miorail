import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import type { Request } from 'express';
import { encodeAbiParameters, encodeEventTopics, encodeFunctionData, parseAbi, type Hex } from 'viem';
import {
  baseMcpAerodromeClaimRuntimeV1 as runtime, prepareBaseMcpAerodromeClaimV1,
  reconcileBaseMcpAerodromeClaimV1, aerodromeClaimEventsMatchV1,
} from './baseMcpAerodromeClaim.js';
import { InMemoryBaseMcpActionReceiptRepositoryV1 } from './baseMcpActionReceipts.js';
import { classifyBaseMcpExtensionIntentV1 } from './baseMcpExtensionActions.js';
import { baseMcpRuntimeSnapshotV1 } from './baseMcpRuntimeSnapshot.js';
import type { AerodromeClaimPlanV1 } from './aerodromeClaimReader.js';

const WALLET = '0x1111111111111111111111111111111111111111';
const POOL = '0x2222222222222222222222222222222222222222';
const HASH = `0x${'a'.repeat(64)}` as const;
const NOW = '2026-10-05T16:00:00.000Z';
const original = { ...runtime };
afterEach(() => Object.assign(runtime, original));
function plan(): AerodromeClaimPlanV1 {
  return { blockNumber: '100', poolsTotal: 38_794, poolsRead: 38_794, poolsUnread: 0, clPositionsTotal: 2, clPositionsRead: 2,
    positionsFound: 1, managedSkipped: 0, errorCode: null, calls: [{ kind: 'basic_fees', pool: POOL, tokenId: '0',
      token0: WALLET, token1: POOL, amount0: '10', amount1: '0', aero: '0',
      call: { index: 0, callType: 'other', to: POOL, valueWei: '0', asset: null, amountAtomic: null,
        recipient: WALLET, spender: null, data: encodeFunctionData({ abi: parseAbi(['function claimFees()']), functionName: 'claimFees' }) } }] };
}
function chainReceipt(wallet = WALLET) {
  return { transactionHash: HASH, status: 'success' as const, blockNumber: 102n, gasUsed: 42n,
    effectiveGasPriceWei: 1n, logs: [{ address: POOL,
      topics: encodeEventTopics({ abi: parseAbi(['event Claim(address indexed sender,address indexed recipient,uint256 amount0,uint256 amount1)']),
        eventName: 'Claim', args: { sender: wallet as `0x${string}`, recipient: wallet as `0x${string}` } }) as Hex[],
      data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [10n, 0n]) }] };
}
function setup() {
  const repository = new InMemoryBaseMcpActionReceiptRepositoryV1();
  const counters = { submit: 0, scan: 0, simulate: 0, status: 0 };
  runtime.repository = repository;
  runtime.now = () => NOW;
  runtime.builderCode = () => 'bc_test';
  runtime.createReader = async () => ({ blockNumber: 100n, read: async () => { throw new Error('not called'); } });
  runtime.readPlan = async () => { counters.scan++; return plan(); };
  runtime.simulate = async (snapshot) => {
    counters.simulate++;
    assert.ok(snapshot.calls[0].call.data.endsWith('62635f74657374070080218021802180218021802180218021'));
    return { status: 'passed', observedAt: runtime.now(), blockNumber: '101', requestHash: HASH, responseHash: HASH, errorCode: null };
  };
  runtime.verifyWallet = async () => ({ checked: true, match: true, mcpAddresses: [WALLET] });
  runtime.createTools = async (_req, _user, _secret, options) => ({
    listProviderTools: async () => [{ providerId: 'base-mcp-dynamic', tools: [
      { name: 'get_request_status', description: 'status', inputSchema: { type: 'object', properties: { requestId: {} } } },
    ] }],
    callTool: async (name: string, args: unknown) => {
      if (name === 'prepared_aerodrome_claim') {
        counters.submit++;
        assert.deepEqual(args, {});
        assert.equal(options?.baseMcpPreparedClaim?.calls[0].value, '0');
        return { isError: false, content: JSON.stringify({ requestId: 'claim-provider-1', approvalUrl: 'https://keys.coinbase.com/approve/claim-1' }) };
      }
      assert.equal(name, 'get_request_status'); counters.status++;
      return { isError: false, content: JSON.stringify({ status: 'completed', txHash: HASH }) };
    }, close: async () => {},
  } as any);
  runtime.receiptReader = () => ({ getTransactionReceipt: async () => chainReceipt() });
  return { repository, counters };
}
function input(idempotencyKey = 'claim-1') {
  return { req: {} as Request, userId: 'tenant-claim', walletAddress: WALLET, sessionSecret: 'test', idempotencyKey };
}

test('claim is deterministic, runtime-gated, and refuses injected receiver or extra withdrawals', () => {
  const snapshot = { ...baseMcpRuntimeSnapshotV1(), batchSimulationAvailable: true, releasedActionPlugins: ['aerodrome'] };
  for (const text of ['Claim my Aerodrome fees', 'Collect my fees on Aerodrome', 'Забери мои комиссии Aerodrome']) {
    assert.equal(classifyBaseMcpExtensionIntentV1(text, snapshot).kind, 'aerodrome_claim');
  }
  assert.equal(classifyBaseMcpExtensionIntentV1('Claim my Aerodrome fees', { ...snapshot, batchSimulationAvailable: false }).kind, 'needs_input');
  assert.equal(classifyBaseMcpExtensionIntentV1(`Claim my Aerodrome fees to ${POOL}`, snapshot).kind, 'needs_input');
  assert.equal(classifyBaseMcpExtensionIntentV1('Claim my Aerodrome fees and withdraw', snapshot).kind, 'needs_input');
  for (const text of ['How do I claim Aerodrome fees?', 'Claim my Aerodrome voting bribes', 'Claim Aerodrome veAERO rebase']) {
    assert.notEqual(classifyBaseMcpExtensionIntentV1(text, snapshot).kind, 'aerodrome_claim');
  }
});
test('simulated claim is durable, idempotent across refreshes and concurrent prepares', async () => {
  const { repository, counters } = setup();
  const [first, second] = await Promise.all([prepareBaseMcpAerodromeClaimV1(input()), prepareBaseMcpAerodromeClaimV1(input())]);
  assert.equal(counters.submit, 1);
  assert.ok(first.approvalUrl || second.approvalUrl);
  assert.equal(first.receipt?.id, second.receipt?.id);
  assert.equal(first.receipt?.routeVerified, false);
  if (first.receipt?.actionType === 'aerodrome_claim') assert.equal(first.receipt.claimCount, 1);
  await prepareBaseMcpAerodromeClaimV1(input());
  assert.equal(counters.submit, 1); assert.equal(counters.scan, 2);
  const stored = await repository.get(first.receipt!.id, 'tenant-claim');
  assert.equal(stored?.status, 'approval_required');
});
test('mismatched or unverified wallet blocks scan and submission', async () => {
  const { counters } = setup();
  runtime.verifyWallet = async () => ({ checked: false, match: false, mcpAddresses: [] });
  assert.equal((await prepareBaseMcpAerodromeClaimV1(input())).errorCode, 'base_mcp_wallet_unverified');
  assert.equal(counters.scan, 0); assert.equal(counters.submit, 0);
});
test('new request IDs cannot overlap an active claim, including concurrent prepares', async () => {
  const { repository, counters } = setup();
  const [first, second] = await Promise.all([prepareBaseMcpAerodromeClaimV1(input('one')), prepareBaseMcpAerodromeClaimV1(input('two'))]);
  assert.equal(counters.submit, 1);
  assert.equal(first.receipt?.id, second.receipt?.id);
  const scanCount = counters.scan;
  const third = await prepareBaseMcpAerodromeClaimV1(input('three'));
  assert.equal(third.receipt?.id, first.receipt?.id);
  assert.equal(counters.scan, scanCount);
  await repository.update({ id: first.receipt!.id, tenantId: 'tenant-claim', status: 'rejected', reconciliationState: 'not_started', now: NOW });
  await prepareBaseMcpAerodromeClaimV1(input('four'));
  assert.equal(counters.submit, 2);
});
test('full empty result has no approval or failed receipt; partial empty is explicitly unread', async () => {
  const { counters } = setup();
  runtime.readPlan = async () => ({ ...plan(), calls: [], positionsFound: 0 });
  const empty = await prepareBaseMcpAerodromeClaimV1(input());
  assert.equal(empty.kind, 'answered'); assert.equal(empty.receipt, null);
  assert.match(empty.reply, /38,794.*38,794/);
  assert.match(empty.reply, /Checked 2 of 2 concentrated positions held in your wallet/);
  runtime.readPlan = async () => ({ ...plan(), calls: [], poolsRead: 9_000, poolsUnread: 29_794, errorCode: 'aerodrome_incomplete_coverage' });
  const partial = await prepareBaseMcpAerodromeClaimV1(input());
  assert.equal(partial.kind, 'failed'); assert.match(partial.reply, /29794 pools unread/);
  assert.doesNotMatch(partial.reply, /No claimable/); assert.equal(counters.submit, 0);
});
for (const status of ['failed', 'unavailable'] as const) test(`simulation ${status} blocks the approval request`, async () => {
  const { counters } = setup();
  runtime.simulate = async () => ({ status, observedAt: NOW, blockNumber: null, requestHash: HASH, responseHash: null, errorCode: 'timeout' });
  const failed = await prepareBaseMcpAerodromeClaimV1(input());
  assert.equal(failed.errorCode, 'aerodrome_simulation_required');
  assert.equal(failed.receipt?.status, 'failed'); assert.equal(counters.submit, 0);
});
test('simulation older than positions and wallet switched after simulation both block writes', async () => {
  const { counters } = setup();
  runtime.simulate = async () => ({ status: 'passed', observedAt: NOW, blockNumber: '99', requestHash: HASH, responseHash: HASH, errorCode: null });
  assert.equal((await prepareBaseMcpAerodromeClaimV1(input())).errorCode, 'aerodrome_simulation_expired');
  let checks = 0;
  runtime.verifyWallet = async () => ({ checked: true, match: ++checks === 1, mcpAddresses: [] });
  assert.equal((await prepareBaseMcpAerodromeClaimV1(input('claim-2'))).errorCode, 'base_mcp_wallet_mismatch');
  assert.equal(counters.submit, 0);
});
test('submission uncertainty remains pending and cannot resubmit using the same request ID', async () => {
  const { counters } = setup();
  const create = runtime.createTools;
  runtime.createTools = async (...args) => {
    const tools = await create(...args);
    if (args[3]?.baseMcpPreparedClaim) tools.callTool = async () => { counters.submit++; throw new Error('lost response'); };
    return tools;
  };
  const first = await prepareBaseMcpAerodromeClaimV1(input());
  assert.equal(first.receipt?.status, 'pending');
  assert.equal(first.errorCode, 'base_mcp_claim_outcome_unknown');
  await prepareBaseMcpAerodromeClaimV1(input()); assert.equal(counters.submit, 1);
  await prepareBaseMcpAerodromeClaimV1(input('different-id')); assert.equal(counters.submit, 1);
});
const LATER = '2026-10-05T17:00:01.000Z';
test('an unknown outcome stops blocking a new claim after an hour, never sooner', async () => {
  const { repository, counters } = setup();
  const create = runtime.createTools;
  let lose = true;
  runtime.createTools = async (...args) => {
    const tools = await create(...args);
    if (args[3]?.baseMcpPreparedClaim && lose) tools.callTool = async () => { counters.submit++; throw new Error('lost response'); };
    return tools;
  };
  const first = await prepareBaseMcpAerodromeClaimV1(input('lost'));
  assert.equal(first.receipt?.status, 'pending'); assert.equal(counters.submit, 1);
  runtime.now = () => '2026-10-05T16:59:59.000Z';
  assert.equal((await prepareBaseMcpAerodromeClaimV1(input('too-soon'))).receipt?.id, first.receipt?.id);
  assert.equal(counters.submit, 1);
  lose = false; runtime.now = () => LATER;
  const next = await prepareBaseMcpAerodromeClaimV1(input('after-an-hour'));
  assert.notEqual(next.receipt?.id, first.receipt?.id); assert.equal(counters.submit, 2);
  const expired = await repository.get(first.receipt!.id, 'tenant-claim');
  assert.equal(expired?.status, 'failed'); assert.equal(expired?.errorCode, 'aerodrome_claim_outcome_expired');
});
test('an aged approval is asked about first: the wallet’s answer is kept, a silent one expires', async () => {
  const { repository, counters } = setup();
  const first = await prepareBaseMcpAerodromeClaimV1(input('ignored'));
  assert.equal(first.receipt?.status, 'approval_required');
  const create = runtime.createTools;
  runtime.createTools = async (...args) => {
    const tools = await create(...args);
    const submit = tools.callTool;
    tools.callTool = async (name: string, toolArgs: unknown) => name === 'get_request_status'
      ? (counters.status++, { isError: false, content: JSON.stringify({ status: 'rejected' }) })
      : submit(name, toolArgs as Record<string, unknown>);
    return tools;
  };
  runtime.now = () => LATER;
  const next = await prepareBaseMcpAerodromeClaimV1(input('after-rejection'));
  assert.equal(counters.status, 1); assert.equal(counters.submit, 2);
  assert.notEqual(next.receipt?.id, first.receipt?.id);
  assert.equal((await repository.get(first.receipt!.id, 'tenant-claim'))?.status, 'rejected');
  runtime.createTools = async (...args) => {
    const tools = await create(...args);
    const submit = tools.callTool;
    tools.callTool = async (name: string, toolArgs: unknown) => name === 'get_request_status'
      ? { isError: false, content: JSON.stringify({ status: 'pending' }) } : submit(name, toolArgs as Record<string, unknown>);
    return tools;
  };
  runtime.now = () => '2026-10-05T18:00:02.000Z';
  const third = await prepareBaseMcpAerodromeClaimV1(input('after-silence'));
  assert.notEqual(third.receipt?.id, next.receipt?.id); assert.equal(counters.submit, 3);
  const silent = await repository.get(next.receipt!.id, 'tenant-claim');
  assert.equal(silent?.status, 'failed'); assert.equal(silent?.errorCode, 'aerodrome_claim_outcome_expired');
});
test('a completion still waiting for its events keeps blocking, however old', async () => {
  const { repository, counters } = setup();
  const first = await prepareBaseMcpAerodromeClaimV1(input('mined'));
  runtime.receiptReader = () => ({ getTransactionReceipt: async () => null });
  runtime.now = () => LATER;
  const blocked = await prepareBaseMcpAerodromeClaimV1(input('while-reconciling'));
  assert.equal(blocked.receipt?.id, first.receipt?.id); assert.equal(counters.submit, 1);
  assert.equal((await repository.get(first.receipt!.id, 'tenant-claim'))?.status, 'reconciling');
});
test('reconciling an unknown outcome releases it only after an hour', async () => {
  const { repository } = setup();
  const create = runtime.createTools;
  runtime.createTools = async (...args) => {
    const tools = await create(...args);
    if (args[3]?.baseMcpPreparedClaim) tools.callTool = async () => { throw new Error('lost response'); };
    return tools;
  };
  const first = await prepareBaseMcpAerodromeClaimV1(input('lost'));
  let stored = (await repository.get(first.receipt!.id, 'tenant-claim'))!;
  const soon = await reconcileBaseMcpAerodromeClaimV1({ ...input(), receipt: stored });
  assert.equal(soon.errorCode, 'base_mcp_claim_outcome_unknown'); assert.equal(soon.receipt?.status, 'pending');
  runtime.now = () => LATER;
  stored = (await repository.get(first.receipt!.id, 'tenant-claim'))!;
  const released = await reconcileBaseMcpAerodromeClaimV1({ ...input(), receipt: stored });
  assert.equal(released.errorCode, 'aerodrome_claim_outcome_expired'); assert.equal(released.receipt?.status, 'failed');
});
test('only matching onchain claim events finalize, completion alone stays reconciling', async () => {
  const { repository } = setup();
  const prepared = await prepareBaseMcpAerodromeClaimV1(input());
  let stored = (await repository.get(prepared.receipt!.id, 'tenant-claim'))!;
  runtime.receiptReader = () => ({ getTransactionReceipt: async () => null });
  const waiting = await reconcileBaseMcpAerodromeClaimV1({ ...input(), receipt: stored });
  assert.equal(waiting.receipt?.status, 'reconciling');
  stored = (await repository.get(stored.id, 'tenant-claim'))!;
  runtime.receiptReader = () => ({ getTransactionReceipt: async () => chainReceipt() });
  const done = await reconcileBaseMcpAerodromeClaimV1({ ...input(), receipt: stored });
  assert.equal(done.receipt?.status, 'completed'); assert.equal(done.receipt?.reconciliationState, 'matched');
});
test('reconciliation refuses an unrelated wallet, old block, missing and reused claim logs', () => {
  assert.equal(aerodromeClaimEventsMatchV1(plan(), WALLET, chainReceipt()), true);
  assert.equal(aerodromeClaimEventsMatchV1(plan(), WALLET, chainReceipt(POOL)), false);
  assert.equal(aerodromeClaimEventsMatchV1(plan(), WALLET, { ...chainReceipt(), blockNumber: 99n }), false);
  assert.equal(aerodromeClaimEventsMatchV1(plan(), WALLET, { ...chainReceipt(), logs: [] }), false);
  const two = plan(); two.calls.push({ ...two.calls[0] });
  assert.equal(aerodromeClaimEventsMatchV1(two, WALLET, chainReceipt()), false);
  assert.equal(aerodromeClaimEventsMatchV1(plan(), WALLET, { ...chainReceipt(), status: 'reverted' }), false);
});
test('changed-wallet idempotency key is a conflict, and tenants cannot reconcile another receipt', async () => {
  const { repository } = setup();
  const prepared = await prepareBaseMcpAerodromeClaimV1(input());
  const changed = await prepareBaseMcpAerodromeClaimV1({ ...input(), walletAddress: POOL });
  assert.equal(changed.errorCode, 'base_mcp_action_idempotency_conflict');
  const stored = (await repository.get(prepared.receipt!.id, 'tenant-claim'))!;
  const foreign = await reconcileBaseMcpAerodromeClaimV1({ ...input(), userId: 'other-tenant', receipt: stored });
  assert.equal(foreign.receipt, null);
  const foreignFinal = await reconcileBaseMcpAerodromeClaimV1({ ...input(), userId: 'other-tenant', receipt: { ...stored, status: 'completed' } });
  assert.equal(foreignFinal.receipt, null);
});

test('CL fee events bind the NFT and recipient; each gauge reward needs its own event', () => {
  const snapshot = plan();
  const fee = { ...snapshot.calls[0], kind: 'cl_fees' as const, tokenId: '7' };
  const reward = { ...snapshot.calls[0], kind: 'cl_aero' as const, tokenId: '8' };
  snapshot.calls = [fee, reward, { ...reward, tokenId: '9' }];
  const collect = { address: POOL,
    topics: encodeEventTopics({ abi: parseAbi(['event Collect(uint256 indexed tokenId,address recipient,uint256 amount0,uint256 amount1)']),
      eventName: 'Collect', args: { tokenId: 7n } }) as Hex[],
    data: encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }, { type: 'uint256' }], [WALLET, 0n, 10n]) };
  const aero = { address: POOL,
    topics: encodeEventTopics({ abi: parseAbi(['event ClaimRewards(address indexed from,uint256 amount)']),
      eventName: 'ClaimRewards', args: { from: WALLET } }) as Hex[], data: encodeAbiParameters([{ type: 'uint256' }], [20n]) };
  const receipt = { ...chainReceipt(), logs: [collect, aero, { ...aero }] };
  assert.equal(aerodromeClaimEventsMatchV1(snapshot, WALLET, receipt), true);
  assert.equal(aerodromeClaimEventsMatchV1(snapshot, WALLET, { ...receipt, logs: [collect, aero] }), false);
  assert.equal(aerodromeClaimEventsMatchV1({ ...snapshot, calls: [{ ...fee, tokenId: '10' }, reward] }, WALLET, receipt), false);
  assert.equal(aerodromeClaimEventsMatchV1({ ...snapshot, calls: [{ ...reward, kind: 'basic_aero' }] }, WALLET, receipt), true);
});
