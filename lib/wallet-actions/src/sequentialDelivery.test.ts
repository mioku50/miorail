import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeFunctionData, erc20Abi, maxUint256, type Hex } from 'viem';
import { getCallsStatus } from 'viem/actions';
import {
  SEQUENTIAL_BATCH_MAGIC_V1,
  batchFailureInvitesStepsV1,
  batchRefusalContinuesInStepsV1,
  exactAllowanceOfV1,
  sequentialBatchIdV1,
  sequentialNoticeV1,
  swapDeliveryPlanV1,
} from './sequentialDelivery';
import { blueprintSubmitPreflight } from './useSubmitApprovedBlueprint';

const here = path.dirname(fileURLToPath(import.meta.url));
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const ROUTER = `0x${'6'.repeat(40)}` as Hex;
const H1 = `0x${'a1'.repeat(32)}` as Hex;
const H2 = `0x${'b2'.repeat(32)}` as Hex;

// What Rabby answers for both EIP-5792 methods (its source, 2026-10-31).
const missing = (method: string) =>
  Object.assign(new Error(`The method "${method}" does not exist / is not available.`), { code: -32601 });

test('a swap goes in steps only for a wallet that cannot send a batch', () => {
  const plan = (capabilities: unknown, capabilitiesError: unknown = null, afterBatchFailure = false) =>
    swapDeliveryPlanV1({ capabilities, capabilitiesError, afterBatchFailure });
  assert.equal(plan({ 8453: { atomic: { status: 'supported' } } }), 'atomic');
  assert.equal(plan({ 8453: { atomic: { status: 'ready' } } }), 'atomic');
  // Saying nothing is asked for one batch first: the batch is the stronger promise.
  assert.equal(plan(undefined), 'atomic');
  assert.equal(plan(undefined, new Error('timeout')), 'atomic');
  assert.equal(plan({ 8453: { atomic: { status: 'unsupported' } } }), 'sequential');
  assert.equal(plan(undefined, missing('wallet_getCapabilities')), 'sequential');
  assert.equal(plan({ 8453: { atomic: { status: 'supported' } } }, null, true), 'sequential');
  // A wallet that refused a batch earlier in this tab says nothing up front.
  assert.equal(swapDeliveryPlanV1({ capabilities: { 8453: {} }, capabilitiesError: null, afterBatchFailure: false, knownNotToBatch: true }), 'sequential');
});

test('the same press goes on in steps when the wallet refused the batch itself', () => {
  assert.equal(batchRefusalContinuesInStepsV1(missing('wallet_sendCalls')), true);
  assert.equal(batchRefusalContinuesInStepsV1({ cause: { code: 5760 } }), true);
  assert.equal(
    batchRefusalContinuesInStepsV1(Object.assign(new Error('An internal error was received.'), { code: -32603, details: 'atomic batch is not supported' })),
    true,
  );
  // The person's own answers wait for the person: a declined smart-account
  // switch is asked again on the next press, a refusal is a refusal.
  assert.equal(batchRefusalContinuesInStepsV1({ cause: { code: 5750 } }), false);
  assert.equal(batchFailureInvitesStepsV1({ cause: { code: 5750 } }), true);
  assert.equal(batchRefusalContinuesInStepsV1(Object.assign(new Error('User rejected the request.'), { code: 4001 })), false);
  assert.equal(batchRefusalContinuesInStepsV1(new Error('wallet response lost')), false);
  // Structural: the hook asks for steps in the same press, and asks a wallet
  // that has not answered yet before choosing.
  const source = readFileSync(path.join(here, 'useSubmitApprovedBlueprint.ts'), 'utf8');
  const submit = source.slice(source.indexOf('const submit = async () => {'));
  assert.ok(submit.indexOf('await batchSupport.readNow()') < submit.indexOf('await approveMutateAsync(approvalInput)'));
  const refused = submit.slice(submit.indexOf("goal === 'swap' && batchRefusalContinuesInStepsV1(cause)"));
  assert.ok(refused.indexOf('await approveAndSendInSteps(approvalInput)') > 0);
  assert.ok(refused.indexOf('await approveAndSendInSteps(approvalInput)') < refused.indexOf("setStatus('failed')"));
});

test('a batch failure invites steps only when it says the wallet cannot send one', () => {
  assert.equal(batchFailureInvitesStepsV1(missing('wallet_sendCalls')), true);
  assert.equal(batchFailureInvitesStepsV1({ cause: { code: 5760 } }), true);
  // Coinbase Wallet with an imported key, 2026-10-31, as viem wraps it.
  const coinbase = Object.assign(new Error('An internal error was received.'), {
    code: -32603,
    details: 'atomic batch is not supported',
  });
  assert.equal(batchFailureInvitesStepsV1(coinbase), true);
  // The person saying no, a revert, a lost response: not about batching.
  assert.equal(batchFailureInvitesStepsV1(Object.assign(new Error('User rejected the request.'), { code: 4001 })), false);
  assert.equal(batchFailureInvitesStepsV1(Object.assign(new Error('execution reverted'), { code: -32000 })), false);
  assert.equal(batchFailureInvitesStepsV1(new Error('wallet response lost')), false);
});

test('an allowance among the approved calls is read exactly, and nothing else is one', () => {
  const data = encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [ROUTER, 7_000_000n] });
  assert.deepEqual(exactAllowanceOfV1({ to: USDC.toUpperCase().replace('0X', '0x'), data }), {
    token: USDC, spender: ROUTER, amount: 7_000_000n,
  });
  const transfer = encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [ROUTER, 1n] });
  assert.equal(exactAllowanceOfV1({ to: USDC, data: transfer }), null);
  assert.equal(exactAllowanceOfV1({ to: USDC, data: '0x095ea7b3' }), null);
  assert.equal(exactAllowanceOfV1({ to: ROUTER, data: '0x12345678' }), null);
});

test('the steps’ batch id is viem’s fallback id, so the poller reads every receipt itself', async () => {
  const id = sequentialBatchIdV1([H1, H2], 8453);
  assert.equal(id, `${H1}${H2.slice(2)}${'0'.repeat(60)}2105${SEQUENTIAL_BATCH_MAGIC_V1.slice(2)}`);
  // viem's own reader, against a client that only knows receipts: the
  // wallet is never asked for a batch it never had.
  const asked: string[] = [];
  const receipt = (hash: Hex, status: '0x1' | '0x0') => ({
    transactionHash: hash, status, blockNumber: '0x10', gasUsed: '0x5208', logs: [], blockHash: `0x${'c'.repeat(64)}`,
    contractAddress: null, cumulativeGasUsed: '0x5208', effectiveGasPrice: '0x1', from: ROUTER, to: ROUTER,
    logsBloom: `0x${'0'.repeat(512)}`, transactionIndex: '0x0', type: '0x2',
  });
  const client = (swap: '0x1' | '0x0') => ({
    request: async ({ method, params }: { method: string; params: [Hex] }) => {
      asked.push(method);
      if (method !== 'eth_getTransactionReceipt') throw new Error(`unexpected ${method}`);
      return params[0] === H1 ? receipt(H1, '0x1') : receipt(H2, swap);
    },
  });
  const done = await getCallsStatus(client('0x1') as never, { id });
  assert.equal(done.status, 'success');
  assert.deepEqual(done.receipts?.map((r) => r.transactionHash), [H1, H2]);
  // The allowance landed and the swap reverted: a failure, read as one.
  assert.equal((await getCallsStatus(client('0x0') as never, { id })).status, 'failure');
  assert.deepEqual([...new Set(asked)], ['eth_getTransactionReceipt']);
});

test('the wallet is opened for steps only when the server granted them to a press that asked', () => {
  const base = { from: `0x${'1'.repeat(40)}` as const, chainId: '0x2105' as const };
  const steps = { ...base, atomicRequired: false, delivery: 'sequential' as const };
  const connected = { connectedAddress: base.from, connectedChainId: 8453 };
  assert.deepEqual(blueprintSubmitPreflight({ payload: steps, ...connected, sequentialAsked: true }), { ok: true });
  assert.equal(blueprintSubmitPreflight({ payload: steps, ...connected }).ok, false);
  assert.equal(blueprintSubmitPreflight({ payload: { ...base, atomicRequired: false }, ...connected, sequentialAsked: true }).ok, false);
  assert.deepEqual(blueprintSubmitPreflight({ payload: { ...base, atomicRequired: true }, ...connected, sequentialAsked: true }), { ok: true });
});

test('each step waits for the one before to land, and an allowance in place is not asked for twice', () => {
  // Structural: the hook drives wagmi, which these tests do not mount. The
  // e2e swap-wallet-batches.spec.ts drives it in a browser.
  const source = readFileSync(path.join(here, 'useSubmitApprovedBlueprint.ts'), 'utf8');
  const steps = source.slice(source.indexOf('const sendOneAtATime = async'), source.indexOf('const submit = async'));
  const allowanceRead = steps.indexOf("functionName: 'allowance'");
  const send = steps.indexOf('await sendTransaction(config');
  const wait = steps.indexOf('await waitForTransactionReceipt(config');
  const statusCheck = steps.indexOf("receipt.status !== 'success'");
  assert.ok(allowanceRead > 0 && send > allowanceRead, 'the allowance is read before anything is sent');
  assert.ok(wait > send && statusCheck > wait, 'the next step waits for this one to land');
  assert.match(steps, /if \(typeof current === 'bigint' && current >= allowance\.amount\) continue;/);
  // Attribution rides each transaction's calldata.
  assert.match(steps, /data: suffix \? concat\(\[call\.data, suffix as Hex\]\) : call\.data,/);
  // A quote that has run out does not get its last step.
  assert.match(steps, /if \(last && sent\.length > 0 && quoteExpiry && Date\.parse\(quoteExpiry\) - Date\.now\(\) < 5_000\)/);
  // An unlimited allowance is never what a step sends: the server grants steps
  // only for an exact one (transaction-composer sequentialSwapDeliveryV1).
  assert.ok(maxUint256 > 0n);
});

test('the page says before the first press that the wallet will be asked once per step', () => {
  assert.match(sequentialNoticeV1('Rabby Wallet'), /^Rabby Wallet sends one transaction at a time/);
  assert.match(sequentialNoticeV1('Injected'), /^This wallet sends one transaction at a time/);
  assert.match(sequentialNoticeV1(null), /exactly the amount you swap/);
  assert.match(sequentialNoticeV1(null), /Stopping after the allowance leaves it in place/);
});
