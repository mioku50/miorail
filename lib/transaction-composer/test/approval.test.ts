import assert from 'node:assert/strict';
import test from 'node:test';
import { hashApprovedCallsV1 } from '@mioagent/route-domain';
import { TransactionComposerBindingError } from '../src/coordinator.js';
import { encodeFunctionData, erc20Abi, maxUint256 } from 'viem';
import { approveExecutionBlueprintV1, routeProofIdV1, sequentialSwapDeliveryV1, type ApprovedBlueprintPayloadV1 } from '../src/approval.js';
import { NOW, TENANT, WALLET, failingContractSecurity, passingContractSecurity } from './fixtures.js';
import { approveInput, seededBlueprint } from './t57-fixtures.js';

test('approve: transitions the blueprint, opens a pending proof, and returns the exact wallet payload', async () => {
  const seeded = await seededBlueprint();
  const deps = { repository: seeded.repository, contractSecurity: passingContractSecurity() };
  const result = await approveExecutionBlueprintV1(deps, approveInput(seeded));

  assert.equal(result.outcome, 'approved');
  if (result.outcome !== 'approved') return;
  assert.equal(result.lifecycle, 'approved');
  const expectedCallsHash = hashApprovedCallsV1(seeded.blueprint.calls);
  assert.deepEqual(result.payload, {
    blueprintId: seeded.blueprint.id,
    blueprintHash: seeded.blueprint.blueprintHash,
    approvedCallsHash: expectedCallsHash,
    chainId: '0x2105',
    from: WALLET,
    calls: seeded.blueprint.calls.map((call) => ({
      to: call.to,
      value: `0x${BigInt(call.valueWei).toString(16)}`,
      data: call.data,
    })),
    atomicRequired: true,
  });

  const [stored] = await seeded.repository.listBlueprints(seeded.scenario.intent.id, TENANT);
  assert.equal(stored!.blueprint.status, 'approved');
  assert.equal(stored!.blueprint.approvedCallsHash, expectedCallsHash);
  // Content hash is invariant under approval by design.
  assert.equal(stored!.blueprint.blueprintHash, seeded.blueprint.blueprintHash);

  const proofId = routeProofIdV1(seeded.blueprint.id);
  const proof = await seeded.repository.getProofProjection(proofId, TENANT);
  assert.ok(proof);
  assert.equal(proof.finalStatus, 'pending');
  assert.equal(proof.reconciliationState, 'pending');
  assert.deepEqual(proof.approvedCalls, seeded.blueprint.calls);
  assert.deepEqual(proof.transactionHashes, []);
  assert.deepEqual(proof.receipts, []);
  assert.equal(proof.actualResult, null);
  assert.equal(proof.actualGas, null);
  assert.equal(proof.approvedCallsHash, expectedCallsHash);
  assert.equal(proof.estimatedGas.gasUnits, seeded.scenario.uniswap.candidate.estimatedGas.gasUnits);

  const events = await seeded.repository.listProofEvents(proofId, TENANT);
  assert.equal(events.length, 1);
  assert.equal(events[0]!.eventType, 'calls_approved');
  assert.equal(events[0]!.eventIndex, 0);
  assert.equal(events[0]!.previousEventHash, null);
  assert.deepEqual(events[0]!.payload, {
    blueprintId: seeded.blueprint.id,
    blueprintHash: seeded.blueprint.blueprintHash,
    approvedCallsHash: expectedCallsHash,
  });
});

test('approve: a retry returns a byte-identical payload without duplicating proofs or events', async () => {
  const seeded = await seededBlueprint();
  const deps = { repository: seeded.repository, contractSecurity: passingContractSecurity() };
  const first = await approveExecutionBlueprintV1(deps, approveInput(seeded));
  const second = await approveExecutionBlueprintV1(
    deps,
    approveInput(seeded, { now: new Date(NOW.getTime() + 30_000) }),
  );
  assert.equal(first.outcome, 'approved');
  assert.equal(second.outcome, 'approved');
  if (first.outcome !== 'approved' || second.outcome !== 'approved') return;
  assert.equal(JSON.stringify(second.payload), JSON.stringify(first.payload));

  const proofId = routeProofIdV1(seeded.blueprint.id);
  const events = await seeded.repository.listProofEvents(proofId, TENANT);
  assert.equal(events.length, 1);
});

test('approve: an expired blueprint returns expired and is never mutated', async () => {
  const seeded = await seededBlueprint({
    createdAt: new Date(NOW.getTime() - 10 * 60_000),
    quoteExpiry: new Date(NOW.getTime() - 1_000).toISOString(),
  });
  const deps = { repository: seeded.repository, contractSecurity: passingContractSecurity() };
  const result = await approveExecutionBlueprintV1(deps, approveInput(seeded));
  assert.equal(result.outcome, 'expired');
  const [stored] = await seeded.repository.listBlueprints(seeded.scenario.intent.id, TENANT);
  assert.equal(stored!.blueprint.status, 'ready_for_review');
  assert.equal(await seeded.repository.getProofProjection(routeProofIdV1(seeded.blueprint.id), TENANT), null);
});

test('approve: rejects an altered blueprintHash', async () => {
  const seeded = await seededBlueprint();
  const deps = { repository: seeded.repository, contractSecurity: passingContractSecurity() };
  await assert.rejects(
    approveExecutionBlueprintV1(deps, approveInput(seeded, { blueprintHash: `0x${'9'.repeat(64)}` })),
    TransactionComposerBindingError,
  );
});

test('approve: rejects a foreign tenant and a mismatched wallet', async () => {
  const seeded = await seededBlueprint();
  const deps = { repository: seeded.repository, contractSecurity: passingContractSecurity() };
  await assert.rejects(
    approveExecutionBlueprintV1(deps, approveInput(seeded, { tenantId: 'other-tenant' })),
    TransactionComposerBindingError,
  );
  await assert.rejects(
    approveExecutionBlueprintV1(
      deps,
      approveInput(seeded, { walletAddress: '0x2222222222222222222222222222222222222222' }),
    ),
    TransactionComposerBindingError,
  );
});

test('approve: a Safety Kernel block at re-validation leaves the blueprint unapproved', async () => {
  const seeded = await seededBlueprint();
  const deps = { repository: seeded.repository, contractSecurity: failingContractSecurity() };
  const result = await approveExecutionBlueprintV1(deps, approveInput(seeded));
  assert.equal(result.outcome, 'blocked');
  if (result.outcome !== 'blocked') return;
  assert.equal(result.safety.verdict, 'blocked');
  assert.ok(result.safety.checks.some((check) => check.id === 'contract_token_security' && check.status === 'failed'));

  const [stored] = await seeded.repository.listBlueprints(seeded.scenario.intent.id, TENANT);
  assert.equal(stored!.blueprint.status, 'ready_for_review');
  assert.equal(stored!.blueprint.approvedCallsHash, null);
  assert.equal(await seeded.repository.getProofProjection(routeProofIdV1(seeded.blueprint.id), TENANT), null);
});

test('approve: the persisted approved blueprint remains schema-valid on read-back', async () => {
  const seeded = await seededBlueprint();
  const deps = { repository: seeded.repository, contractSecurity: passingContractSecurity() };
  const result = await approveExecutionBlueprintV1(deps, approveInput(seeded));
  assert.equal(result.outcome, 'approved');
  // listBlueprints re-parses via ExecutionBlueprintV1Schema — a corrupt persist
  // would throw here instead of returning.
  const [stored] = await seeded.repository.listBlueprints(seeded.scenario.intent.id, TENANT);
  assert.equal(stored!.blueprint.status, 'approved');
  assert.equal(stored!.blueprint.updatedAt, NOW.toISOString());
});

// ---------------------------------------------------------------------------
// One transaction at a time, for a wallet that cannot send a batch (operator,
// 2026-10-31). Granted only where order alone keeps the batch's promise.
// ---------------------------------------------------------------------------

test('steps are granted for the swap alone, or one exact allowance to the swap’s own contract and then the swap', () => {
  const router = `0x${'6'.repeat(40)}` as const;
  const usdc = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' as const;
  const approve = (spender: `0x${string}`, amount: bigint, value: `0x${string}` = '0x0') => ({
    to: usdc, value, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [spender, amount] }),
  });
  const swap = { to: router, value: '0x0' as const, data: '0x12345678' as const };
  const payload = (calls: ApprovedBlueprintPayloadV1['calls']): ApprovedBlueprintPayloadV1 => ({
    blueprintId: 'bp', blueprintHash: `0x${'1'.repeat(64)}`, approvedCallsHash: `0x${'2'.repeat(64)}`,
    chainId: '0x2105', from: WALLET as `0x${string}`, calls, atomicRequired: true,
  });
  const granted = sequentialSwapDeliveryV1(payload([approve(router, 7_000_000n), swap]));
  assert.deepEqual(granted, { ...payload([approve(router, 7_000_000n), swap]), atomicRequired: false, delivery: 'sequential' });
  assert.equal(sequentialSwapDeliveryV1(payload([{ ...swap, value: '0x2386f26fc10000' }]))?.delivery, 'sequential');
  for (const calls of [
    [approve(router, maxUint256), swap],
    [approve(`0x${'7'.repeat(40)}`, 7_000_000n), swap],
    [approve(router, 0n), swap],
    [approve(router, 7_000_000n, '0x1'), swap],
    [{ ...swap, to: usdc, data: '0x095ea7b3' as const }, swap],
    [approve(router, 7_000_000n), approve(router, 7_000_000n), swap],
    [swap, approve(router, 7_000_000n)],
  ]) {
    assert.equal(sequentialSwapDeliveryV1(payload(calls as ApprovedBlueprintPayloadV1['calls'])), null);
  }
});

test('steps are granted for Uniswap’s Permit2 allowances: exact, ending, for the swap’s own contract', () => {
  // 2026-11-11: a wallet that cannot send a batch pressed Review on a Uniswap route for NVDAc and was told
  // "These calls can only be sent together". The calls were Permit2.approve(USDC, router, exactly 2 USDC,
  // the quote's own deadline) and the swap: an allowance as exact as the ERC-20 one, and one that ends.
  const router = '0x6ff5693b99212da76ad316178a184ab56d299b43' as const;
  const permit2 = '0x000000000022d473030f116ddee9f6b43ac78ba3' as const;
  const usdc = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' as const;
  const other = `0x${'7'.repeat(40)}` as const;
  const PERMIT2_ABI = [{
    type: 'function', name: 'approve', stateMutability: 'nonpayable', outputs: [],
    inputs: [{ name: 'token', type: 'address' }, { name: 'spender', type: 'address' }, { name: 'amount', type: 'uint160' }, { name: 'expiration', type: 'uint48' }],
  }] as const;
  const EXPIRES = 1_794_423_000;
  const viaPermit2 = (over: { token?: `0x${string}`; spender?: `0x${string}`; amount?: bigint; expiration?: number; to?: `0x${string}`; value?: `0x${string}` } = {}) => ({
    to: over.to ?? permit2, value: over.value ?? ('0x0' as const),
    data: encodeFunctionData({ abi: PERMIT2_ABI, functionName: 'approve', args: [over.token ?? usdc, over.spender ?? router, over.amount ?? 2_000_000n, over.expiration ?? EXPIRES] }),
  });
  const toPermit2 = (amount = 2_000_000n, spender: `0x${string}` = permit2, token: `0x${string}` = usdc) => ({
    to: token, value: '0x0' as const, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [spender, amount] }),
  });
  const swap = { to: router, value: '0x0' as const, data: '0x3593564c' as const };
  const payload = (calls: ApprovedBlueprintPayloadV1['calls']): ApprovedBlueprintPayloadV1 => ({
    blueprintId: 'bp', blueprintHash: `0x${'1'.repeat(64)}`, approvedCallsHash: `0x${'2'.repeat(64)}`,
    chainId: '0x2105', from: WALLET as `0x${string}`, calls, atomicRequired: true,
  });
  const ask = (calls: unknown[]) => sequentialSwapDeliveryV1(payload(calls as ApprovedBlueprintPayloadV1['calls']));

  // A wallet that already lets Permit2 move the token: two steps.
  assert.deepEqual(ask([viaPermit2(), swap]), { ...payload([viaPermit2(), swap]), atomicRequired: false, delivery: 'sequential' });
  // A wallet that never used Permit2: three, and the calls are returned as they were approved.
  assert.deepEqual(ask([toPermit2(), viaPermit2(), swap])?.calls, [toPermit2(), viaPermit2(), swap]);

  const refused: Array<[string, unknown[]]> = [
    ['a Permit2 allowance for another contract than the swap’s', [viaPermit2({ spender: other }), swap]],
    ['an unlimited Permit2 allowance', [viaPermit2({ amount: (1n << 160n) - 1n }), swap]],
    ['a Permit2 allowance of nothing', [viaPermit2({ amount: 0n }), swap]],
    ['a Permit2 allowance that never ends', [viaPermit2({ expiration: 281_474_976_710_655 }), swap]],
    ['a Permit2 allowance with no end stated', [viaPermit2({ expiration: 0 }), swap]],
    ['the same bytes sent to a contract that is not Permit2', [viaPermit2({ to: other }), swap]],
    ['ETH sent along with the allowance', [viaPermit2({ value: '0x1' }), swap]],
    ['three calls whose first lets somebody else move the token', [toPermit2(2_000_000n, other), viaPermit2(), swap]],
    ['three calls whose first is unlimited', [toPermit2(maxUint256), viaPermit2(), swap]],
    ['three calls with two different amounts', [toPermit2(3_000_000n), viaPermit2(), swap]],
    ['three calls about two different tokens', [toPermit2(2_000_000n, permit2, other), viaPermit2(), swap]],
    ['three calls in another order', [viaPermit2(), toPermit2(), swap]],
    ['four calls', [toPermit2(), viaPermit2(), viaPermit2(), swap]],
    ['no calls', []],
  ];
  for (const [label, calls] of refused) assert.equal(ask(calls), null, label);
});
