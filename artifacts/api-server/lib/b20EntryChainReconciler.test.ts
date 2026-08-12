import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { encodeAbiParameters, encodeEventTopics, erc20Abi, parseAbiParameters } from 'viem';
import {
  B20EntrySubmissionAttemptV1Schema,
  B20PreparedEntryPlanV1Schema,
  B20_ENTRY_EXECUTION_FAMILY_V1,
  InMemoryB20EntryRouteProofRepositoryV1,
  InMemoryB20EntrySubmissionRepositoryV1,
  buildPendingB20EntryRouteProofV1,
  entryPlanCallsHashV1,
} from '@mioagent/route-storage';
import type { BaseReceiptReader, VerifiedReceiptSourceV1 } from '@mioagent/route-proof';
import { ensureB20EntryRouteProofV1 } from './b20EntryRouteProof.js';
import { b20AssetChangesFromReceiptLogsV1, reconcileB20EntryFromBaseV1 } from './b20EntryChainReconciler.js';

const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const TOKEN = '0xb200000000000000000000578f3ae29d9e6e0101';
const ROUTER = '0xcf77a3ba9a5ca399b7c97c74d54e5b1beb874e43';
const WALLET = '0x1111111111111111111111111111111111111111';
const TENANT = `eip155:8453:${WALLET}`;
const TX = `0x${'7'.repeat(64)}` as const;
const NOW = new Date('2026-08-12T12:00:00.000Z');
const calls = [
  { index: 0, callType: 'approval' as const, to: USDC, data: '0x095ea7b3', valueWei: '0' as const, amountAtomic: '100000000', recipient: null, spender: ROUTER },
  { index: 1, callType: 'swap' as const, to: ROUTER, data: '0x38ed1739', valueWei: '0' as const, amountAtomic: '100000000', recipient: WALLET, spender: null },
];
const plan = B20PreparedEntryPlanV1Schema.parse({
  schemaVersion: 'b20-prepared-entry-plan/v1', executionFamily: B20_ENTRY_EXECUTION_FAMILY_V1,
  id: 'plan-chain-1', tenantId: TENANT, walletAddress: WALLET, chainId: 8453,
  clearanceId: 'clearance-1', clearanceHash: `0x${'c'.repeat(64)}`,
  profileIdentity: `${USDC}:100000000:300:300`, tokenAddress: TOKEN,
  tokenName: 'Example', tokenSymbol: 'EXA', tokenDecimals: 18, quoteAsset: USDC,
  positionAtomic: '100000000', entryProviderId: 'aerodrome',
  entrySourceKey: `aerodrome:${'0x' + 'f'.repeat(40)}:${USDC}:${TOKEN}:volatile`,
  entryRouteHash: `0x${'b'.repeat(64)}`, blueprintHash: `0x${'d'.repeat(64)}`,
  callsHash: entryPlanCallsHashV1(calls), freshQuoteHash: `0x${'9'.repeat(64)}`,
  certificationControlSnapshotHash: `0x${'a'.repeat(64)}`, prepareControlSnapshotHash: `0x${'a'.repeat(64)}`,
  certificationSimulationEvidenceHash: `0x${'e'.repeat(64)}`, prepareSimulationEvidenceHash: `0x${'2'.repeat(64)}`,
  prepareSimulationGasUsed: '210000', expectedOutputAtomic: '4200000000000000000000',
  minimumOutputAtomic: '4074000000000000000000', deadlineSeconds: String(Math.floor(NOW.getTime() / 1000) + 300),
  coverage: 'partial', viableRouteConfirmed: true, bestRouteConfirmed: false,
  certificationRoundTripBps: 100, certificationBlockNumber: '49450000',
  prepareControlBlockNumber: '49450050', prepareSimulationBlockNumber: '49450051',
  clearanceCreatedAt: NOW.toISOString(), clearanceExpiresAt: new Date(NOW.getTime() + 600_000).toISOString(),
  calls, lifecycle: 'prepared', submissionId: null, requestId: 'req-1', createdAt: NOW.toISOString(),
  expiresAt: new Date(NOW.getTime() + 300_000).toISOString(),
});

function transfer(token: string, from: string, to: string, amount: bigint) {
  return {
    address: token,
    topics: encodeEventTopics({
      abi: erc20Abi,
      eventName: 'Transfer',
      args: { from: from as `0x${string}`, to: to as `0x${string}` },
    }) as readonly string[],
    data: encodeAbiParameters(parseAbiParameters('uint256'), [amount]),
  };
}

function source(overrides: Partial<VerifiedReceiptSourceV1> = {}): VerifiedReceiptSourceV1 {
  return {
    transactionHash: TX,
    status: 'success',
    blockNumber: 49_450_100n,
    gasUsed: 190_000n,
    effectiveGasPriceWei: 1_000_000n,
    logs: [
      transfer(USDC, WALLET, ROUTER, 100_000_000n),
      transfer(TOKEN, ROUTER, WALLET, 4_200_000_000_000_000_000_000n),
    ],
    ...overrides,
  };
}

function reader(value: VerifiedReceiptSourceV1 | null): BaseReceiptReader {
  return { async getTransactionReceipt() { return value; } };
}

async function seeded() {
  const submissions = new InMemoryB20EntrySubmissionRepositoryV1();
  const proofs = new InMemoryB20EntryRouteProofRepositoryV1();
  const attempt = await submissions.createAttempt(B20EntrySubmissionAttemptV1Schema.parse({
    schemaVersion: 'b20-entry-submission/v1', id: 'attempt-chain-1', tenantId: TENANT,
    walletAddress: WALLET, chainId: 8453, planId: plan.id, clearanceId: plan.clearanceId,
    submittedCallsHash: plan.callsHash, batchId: 'batch-1', status: 'submitted', terminalOutcome: null,
    errorCode: null, submittedAt: NOW.toISOString(), transactionHashes: [], receipts: [], reconciliation: null,
    createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
  }));
  await ensureB20EntryRouteProofV1({ repository: proofs, plan, attempt, now: NOW });
  return { submissions, proofs, attempt };
}

describe('B20 server-side Base reconciliation', () => {
  test('a retry repairs a missing first proof event before calls can leave the server', async () => {
    const state = await seeded();
    const repository = new InMemoryB20EntryRouteProofRepositoryV1();
    const proof = buildPendingB20EntryRouteProofV1({ plan, attempt: state.attempt, now: NOW });
    await repository.upsertProof({ plan, attempt: state.attempt, proof });

    await ensureB20EntryRouteProofV1({ repository, plan, attempt: state.attempt, now: NOW });

    const events = await repository.listEvents(proof.id, TENANT);
    assert.deepEqual(events.map((event) => event.eventType), ['calls_approved']);
  });

  test('verified Transfer logs complete the canonical proof with factual assets and gas', async () => {
    const state = await seeded();
    const updated = await reconcileB20EntryFromBaseV1({
      ...state, plan, reader: reader(source()), transactionHashes: [TX], now: new Date(NOW.getTime() + 1_000),
    });
    assert.equal(updated.terminalOutcome, 'entry_succeeded');
    assert.equal(updated.reconciliation?.spentAtomic, '100000000');
    assert.equal(updated.reconciliation?.receivedAtomic, '4200000000000000000000');
    const proof = await state.proofs.getProofForPlan({ planId: plan.id, tenantId: TENANT, walletAddress: WALLET });
    assert.equal(proof?.finalStatus, 'completed');
    assert.equal(proof?.actualGas?.gasUnits, '190000');
    assert.deepEqual(proof?.transactionHashes, [TX]);
  });

  test('a wallet hash is only a lookup hint: unavailable receipt stays pending', async () => {
    const state = await seeded();
    const updated = await reconcileB20EntryFromBaseV1({
      ...state, plan, reader: reader(null), transactionHashes: [TX], now: new Date(NOW.getTime() + 1_000),
    });
    assert.equal(updated.status, 'reconciling');
    assert.equal(updated.terminalOutcome, null);
    const proof = await state.proofs.getProofForPlan({ planId: plan.id, tenantId: TENANT, walletAddress: WALLET });
    assert.equal(proof?.finalStatus, 'pending');
    assert.equal(proof?.receipts[0]?.status, 'unknown');
  });

  test('a verified success with no expected token movement is never a completed entry', async () => {
    const state = await seeded();
    const updated = await reconcileB20EntryFromBaseV1({
      ...state,
      plan,
      reader: reader(source({ logs: [transfer(USDC, WALLET, ROUTER, 100_000_000n)] })),
      transactionHashes: [TX],
      now: new Date(NOW.getTime() + 1_000),
    });
    assert.equal(updated.terminalOutcome, 'reconciliation_required');
    assert.equal(updated.errorCode, 'no_token_received');
    const proof = await state.proofs.getProofForPlan({ planId: plan.id, tenantId: TENANT, walletAddress: WALLET });
    assert.equal(proof?.reconciliationState, 'manual_review');
  });

  test('net movement reconstruction ignores an approval and does not double-count change', () => {
    const changes = b20AssetChangesFromReceiptLogsV1({ walletAddress: WALLET, logs: [
      transfer(USDC, WALLET, ROUTER, 100n),
      transfer(USDC, ROUTER, WALLET, 5n),
      transfer(TOKEN, ROUTER, WALLET, 500n),
    ] });
    assert.deepEqual(changes, [
      { token: USDC, direction: 'out', amountAtomic: '95' },
      { token: TOKEN, direction: 'in', amountAtomic: '500', counterparty: WALLET },
    ]);
  });
});
