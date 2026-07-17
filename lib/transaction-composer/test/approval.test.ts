import assert from 'node:assert/strict';
import test from 'node:test';
import { hashApprovedCallsV1 } from '@mioagent/route-domain';
import { TransactionComposerBindingError } from '../src/coordinator.js';
import { approveExecutionBlueprintV1, routeProofIdV1 } from '../src/approval.js';
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
