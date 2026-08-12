import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  B20EntrySubmissionAttemptV1Schema,
  B20PreparedEntryPlanV1Schema,
  B20_ENTRY_EXECUTION_FAMILY_V1,
  InMemoryB20EntryRouteProofRepositoryV1,
  appendB20EntryProofEventIfNewV1,
  b20EntryApprovedCallsHashV1,
  buildPendingB20EntryRouteProofV1,
  entryPlanCallsHashV1,
  projectB20EntryRouteProofV1,
} from '../src/index.js';

const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const ROUTER = '0xcf77a3ba9a5ca399b7c97c74d54e5b1beb874e43';
const TOKEN = '0xb200000000000000000000578f3ae29d9e6e0101';
const WALLET = '0x1111111111111111111111111111111111111111';
const TENANT = `eip155:8453:${WALLET}`;
const NOW = new Date('2026-08-12T12:00:00.000Z');
const TX = `0x${'7'.repeat(64)}`;

const calls = [
  { index: 0, callType: 'approval' as const, to: USDC, data: '0x095ea7b3', valueWei: '0' as const, amountAtomic: '100000000', recipient: null, spender: ROUTER },
  { index: 1, callType: 'swap' as const, to: ROUTER, data: '0x38ed1739', valueWei: '0' as const, amountAtomic: '100000000', recipient: WALLET, spender: null },
];

const plan = B20PreparedEntryPlanV1Schema.parse({
  schemaVersion: 'b20-prepared-entry-plan/v1', executionFamily: B20_ENTRY_EXECUTION_FAMILY_V1,
  id: 'plan-1', tenantId: TENANT, walletAddress: WALLET, chainId: 8453,
  clearanceId: 'clearance-1', clearanceHash: `0x${'c'.repeat(64)}`,
  profileIdentity: `${USDC}:100000000:300:300`, tokenAddress: TOKEN,
  tokenName: 'Example', tokenSymbol: 'EXA', tokenDecimals: 18, quoteAsset: USDC,
  positionAtomic: '100000000', entryProviderId: 'aerodrome',
  entrySourceKey: `aerodrome:${'0x' + 'f'.repeat(40)}:${USDC}:${TOKEN}:volatile`,
  entryRouteHash: `0x${'b'.repeat(64)}`, blueprintHash: `0x${'d'.repeat(64)}`,
  callsHash: entryPlanCallsHashV1(calls), freshQuoteHash: `0x${'9'.repeat(64)}`,
  certificationControlSnapshotHash: `0x${'a'.repeat(64)}`,
  prepareControlSnapshotHash: `0x${'a'.repeat(64)}`,
  certificationSimulationEvidenceHash: `0x${'e'.repeat(64)}`,
  prepareSimulationEvidenceHash: `0x${'2'.repeat(64)}`, prepareSimulationGasUsed: '210000',
  expectedOutputAtomic: '4200000000000000000000', minimumOutputAtomic: '4074000000000000000000',
  deadlineSeconds: String(Math.floor(NOW.getTime() / 1000) + 300), coverage: 'partial',
  viableRouteConfirmed: true, bestRouteConfirmed: false, certificationRoundTripBps: 100,
  certificationBlockNumber: '49450000', prepareControlBlockNumber: '49450050',
  prepareSimulationBlockNumber: '49450051', clearanceCreatedAt: NOW.toISOString(),
  clearanceExpiresAt: new Date(NOW.getTime() + 600_000).toISOString(), calls,
  lifecycle: 'prepared', submissionId: null, requestId: 'req-1', createdAt: NOW.toISOString(),
  expiresAt: new Date(NOW.getTime() + 300_000).toISOString(),
});

function attempt(terminal = false) {
  return B20EntrySubmissionAttemptV1Schema.parse({
    schemaVersion: 'b20-entry-submission/v1', id: 'attempt-1', tenantId: TENANT,
    walletAddress: WALLET, chainId: 8453, planId: plan.id, clearanceId: plan.clearanceId,
    submittedCallsHash: plan.callsHash, batchId: 'batch-1',
    status: terminal ? 'terminal' : 'submitted', terminalOutcome: terminal ? 'entry_succeeded' : null,
    errorCode: null, submittedAt: NOW.toISOString(), transactionHashes: terminal ? [TX] : [],
    receipts: terminal ? [{ transactionHash: TX, status: 'success', blockNumber: '49450100', gasUsed: '190000' }] : [],
    reconciliation: terminal ? {
      spentAtomic: '100000000', receivedAtomic: '4200000000000000000000',
      confirmedBlockNumber: '49450100', transactionHashes: [TX], evidenceHash: `0x${'6'.repeat(64)}`,
    } : null,
    createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
  });
}

describe('B20 uses the canonical RouteProofV1 language', () => {
  test('the same plan always yields the same proof id, lineage hashes and approved-calls hash', () => {
    const first = buildPendingB20EntryRouteProofV1({ plan, attempt: attempt(), now: NOW });
    const second = buildPendingB20EntryRouteProofV1({ plan, attempt: attempt(), now: NOW });
    assert.deepEqual(second, first);
    assert.equal(first.approvedCallsHash, b20EntryApprovedCallsHashV1(plan));
    assert.equal(first.estimatedGas.gasUnits, '210000');
  });

  test('reconciliation completes the same proof and records actual assets and gas', () => {
    const pending = buildPendingB20EntryRouteProofV1({ plan, attempt: attempt(), now: NOW });
    const completed = projectB20EntryRouteProofV1({
      proof: pending, plan, attempt: attempt(true), now: new Date(NOW.getTime() + 1_000),
    });
    assert.equal(completed.finalStatus, 'completed');
    assert.equal(completed.reconciliationState, 'matched');
    assert.equal(completed.actualResult?.outputAmountAtomic, plan.expectedOutputAtomic);
    assert.equal(completed.actualGas?.gasUnits, '190000');
    assert.deepEqual(completed.transactionHashes, [TX]);
  });

  test('the event history is append-only and byte-identical retries are idempotent', async () => {
    const repository = new InMemoryB20EntryRouteProofRepositoryV1();
    const submitted = attempt();
    const proof = buildPendingB20EntryRouteProofV1({ plan, attempt: submitted, now: NOW });
    await repository.upsertProof({ plan, attempt: submitted, proof });
    const once = await appendB20EntryProofEventIfNewV1({
      repository, proof, existingEvents: [], eventType: 'calls_approved', payload: { planId: plan.id }, now: NOW,
    });
    const twice = await appendB20EntryProofEventIfNewV1({
      repository, proof, existingEvents: once, eventType: 'calls_approved', payload: { planId: plan.id }, now: NOW,
    });
    assert.equal(twice.length, 1);
    assert.equal((await repository.listEvents(proof.id, TENANT)).length, 1);
  });
});

test('migration 0037 is additive, allows retryable pre-submit attempts, and keeps one proof per attempt', async () => {
  const root = process.cwd().endsWith('lib/route-storage') ? resolve(process.cwd(), '../db') : resolve(process.cwd(), 'lib/db');
  const sql = await readFile(resolve(root, 'drizzle/0037_b20_entry_route_proofs.sql'), 'utf8');
  assert.doesNotMatch(sql, /^\s*(?:DROP\b|DELETE\s+FROM\b|TRUNCATE\b)/im);
  assert.match(sql, /b20_entry_route_proof_plan_created_idx/);
  assert.match(sql, /b20_entry_route_proof_attempt_unique/);
  assert.match(sql, /b20_entry_route_proof_event_sequence_unique/);
  assert.match(sql, /approved_calls_hash/);
});
