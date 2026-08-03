import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  B20PreparedEntryPlanV1Schema,
  B20_ENTRY_EXECUTION_FAMILY_V1,
  entryPlanCallsHashV1,
  type B20PreparedEntryPlanV1,
} from '@mioagent/route-storage';

import {
  assetsMatchPlanV1,
  reconcileEntryV1,
  reconciliationEvidenceHashV1,
  type ObservedAssetChangeV1,
} from './b20EntryReconcile.js';

// ---------------------------------------------------------------------------
// T68F-B §9/§10 — what actually happened.
//
// Two questions, never conflated: did the batch execute, and did it do what the
// plan said. Confusing them is how a product tells somebody "your entry
// succeeded" because a transaction confirmed, when what confirmed was an
// approval and no token ever arrived.
// ---------------------------------------------------------------------------

const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const ROUTER = '0xcf77a3ba9a5ca399b7c97c74d54e5b1beb874e43';
const TOKEN = '0xb200000000000000000000578f3ae29d9e6e0101';
const OTHER_TOKEN = '0xb200000000000000000000578f3ae29d9e6e0999';
const WALLET = '0x1111111111111111111111111111111111111111';
const OTHER_WALLET = '0x2222222222222222222222222222222222222222';
const NOW = new Date('2026-08-03T12:00:00.000Z');
const DEADLINE = String(Math.floor(NOW.getTime() / 1000) + 300);

const calls = [
  {
    index: 0,
    callType: 'approval' as const,
    to: USDC,
    data: '0x095ea7b3',
    valueWei: '0' as const,
    amountAtomic: '100000000',
    recipient: null,
    spender: ROUTER,
  },
  {
    index: 1,
    callType: 'swap' as const,
    to: ROUTER,
    data: '0x38ed1739',
    valueWei: '0' as const,
    amountAtomic: '100000000',
    recipient: WALLET,
    spender: null,
  },
];

function plan(overrides: Record<string, unknown> = {}): B20PreparedEntryPlanV1 {
  return B20PreparedEntryPlanV1Schema.parse({
    schemaVersion: 'b20-prepared-entry-plan/v1',
    executionFamily: B20_ENTRY_EXECUTION_FAMILY_V1,
    id: 'plan-1',
    tenantId: `eip155:8453:${WALLET}`,
    walletAddress: WALLET,
    chainId: 8453,
    clearanceId: 'clearance-1',
    clearanceHash: `0x${'c'.repeat(64)}`,
    profileIdentity: `${USDC}:100000000:300:300`,
    tokenAddress: TOKEN,
    tokenName: 'Example',
    tokenSymbol: 'EXA',
    quoteAsset: USDC,
    positionAtomic: '100000000',
    entryProviderId: 'aerodrome',
    entrySourceKey: `aerodrome:${'0x' + 'f'.repeat(40)}:${USDC}:${TOKEN}:volatile`,
    entryRouteHash: `0x${'b'.repeat(64)}`,
    blueprintHash: `0x${'d'.repeat(64)}`,
    callsHash: entryPlanCallsHashV1(calls),
    freshQuoteHash: `0x${'9'.repeat(64)}`,
    certificationControlSnapshotHash: `0x${'a'.repeat(64)}`,
    prepareControlSnapshotHash: `0x${'a'.repeat(64)}`,
    certificationSimulationEvidenceHash: `0x${'e'.repeat(64)}`,
    prepareSimulationEvidenceHash: `0x${'2'.repeat(64)}`,
    expectedOutputAtomic: '4200000000000000000000',
    minimumOutputAtomic: '4074000000000000000000',
    deadlineSeconds: DEADLINE,
    coverage: 'partial',
    viableRouteConfirmed: true,
    bestRouteConfirmed: false,
    certificationRoundTripBps: 100,
    certificationBlockNumber: '49450000',
    prepareControlBlockNumber: '49450050',
    prepareSimulationBlockNumber: '49450051',
    clearanceCreatedAt: NOW.toISOString(),
    clearanceExpiresAt: new Date(NOW.getTime() + 600_000).toISOString(),
    calls,
    lifecycle: 'prepared',
    submissionId: null,
    requestId: 'req-1',
    createdAt: NOW.toISOString(),
    expiresAt: new Date(Number(DEADLINE) * 1000).toISOString(),
    ...overrides,
  });
}

const GOOD: ObservedAssetChangeV1[] = [
  { token: USDC, direction: 'out', amountAtomic: '100000000', counterparty: ROUTER },
  { token: TOKEN, direction: 'in', amountAtomic: '4200000000000000000000', counterparty: WALLET },
];

const confirmed = (changes: ObservedAssetChangeV1[] | null, attempts = 0) =>
  reconcileEntryV1({
    plan: plan(),
    status: 'confirmed',
    assetChanges: changes,
    transactionHashes: [`0x${'1'.repeat(64)}`],
    blockNumber: '49450100',
    attempts,
  });

describe('a confirmed batch is not the same thing as a completed entry', () => {
  test('an approval that confirmed on its own is not success', () => {
    // The single most dangerous false positive in this whole feature.
    const verdict = confirmed([
      { token: USDC, direction: 'out', amountAtomic: '0', counterparty: ROUTER },
    ]);
    assert.equal(verdict.state, 'terminal');
    assert.notEqual(verdict.state === 'terminal' && verdict.outcome, 'entry_succeeded');
    assert.equal(verdict.state === 'terminal' && verdict.outcome, 'reconciliation_required');
  });

  test('the wrong token arriving fails reconciliation', () => {
    const verdict = confirmed([
      { token: USDC, direction: 'out', amountAtomic: '100000000', counterparty: ROUTER },
      { token: OTHER_TOKEN, direction: 'in', amountAtomic: '999', counterparty: WALLET },
    ]);
    assert.equal(verdict.state === 'terminal' && verdict.outcome, 'reconciliation_required');
    assert.equal(verdict.state === 'terminal' && verdict.errorCode, 'wrong_token_received');
  });

  test('the token landing in another wallet fails reconciliation', () => {
    const verdict = confirmed([
      { token: USDC, direction: 'out', amountAtomic: '100000000', counterparty: ROUTER },
      {
        token: TOKEN,
        direction: 'in',
        amountAtomic: '4200000000000000000000',
        counterparty: OTHER_WALLET,
      },
    ]);
    assert.equal(verdict.state === 'terminal' && verdict.errorCode, 'another_recipient');
  });

  test('spending more than the profile allowed fails, even with a good output', () => {
    const verdict = confirmed([
      { token: USDC, direction: 'out', amountAtomic: '500000000', counterparty: ROUTER },
      { token: TOKEN, direction: 'in', amountAtomic: '4200000000000000000000', counterparty: WALLET },
    ]);
    assert.equal(verdict.state === 'terminal' && verdict.errorCode, 'spend_above_profile');
  });

  test('receiving less than the minimum fails', () => {
    const verdict = confirmed([
      { token: USDC, direction: 'out', amountAtomic: '100000000', counterparty: ROUTER },
      { token: TOKEN, direction: 'in', amountAtomic: '4000000000000000000000', counterparty: WALLET },
    ]);
    assert.equal(verdict.state === 'terminal' && verdict.errorCode, 'output_below_minimum');
  });

  test('a real entry succeeds, and records what actually arrived', () => {
    const verdict = confirmed(GOOD);
    assert.equal(verdict.state, 'terminal');
    if (verdict.state !== 'terminal') return;
    assert.equal(verdict.outcome, 'entry_succeeded');
    assert.equal(verdict.reconciliation?.spentAtomic, '100000000');
    assert.equal(verdict.reconciliation?.receivedAtomic, '4200000000000000000000');
    assert.equal(verdict.reconciliation?.confirmedBlockNumber, '49450100');
    assert.deepEqual(verdict.reconciliation?.transactionHashes, [`0x${'1'.repeat(64)}`]);
    assert.match(verdict.reconciliation!.evidenceHash, /^0x[0-9a-f]{64}$/);
  });

  test('exactly the minimum is a success, not a near miss', () => {
    const verdict = confirmed([
      { token: USDC, direction: 'out', amountAtomic: '100000000', counterparty: ROUTER },
      { token: TOKEN, direction: 'in', amountAtomic: '4074000000000000000000', counterparty: WALLET },
    ]);
    assert.equal(verdict.state === 'terminal' && verdict.outcome, 'entry_succeeded');
  });

  test('a recipient the provider does not name is not proof it was the wallet', () => {
    // Absent is absent. It is accepted only because the swap call itself pins
    // the recipient and the kernel already checked it.
    const verdict = confirmed([
      { token: USDC, direction: 'out', amountAtomic: '100000000', counterparty: null },
      { token: TOKEN, direction: 'in', amountAtomic: '4200000000000000000000', counterparty: null },
    ]);
    assert.equal(verdict.state === 'terminal' && verdict.outcome, 'entry_succeeded');
  });
});

describe('a provider that cannot answer has told us nothing about the chain', () => {
  const unresolved = (status: 'unknown' | 'unavailable', attempts: number) =>
    reconcileEntryV1({
      plan: plan(),
      status,
      assetChanges: null,
      transactionHashes: [],
      blockNumber: null,
      attempts,
      maxAttempts: 3,
    });

  test('a transient failure keeps reconciling — it never becomes a revert', () => {
    // The rule this whole module is shaped around.
    assert.equal(unresolved('unavailable', 0).state, 'reconciling');
    assert.equal(unresolved('unknown', 2).state, 'reconciling');
  });

  test('after enough silence it says unresolved, honestly, and still not reverted', () => {
    const verdict = unresolved('unavailable', 3);
    assert.equal(verdict.state, 'terminal');
    if (verdict.state !== 'terminal') return;
    assert.equal(verdict.outcome, 'submitted_unknown');
    assert.notEqual(verdict.outcome as string, 'entry_reverted');
    assert.equal(verdict.errorCode, 'status_provider_unavailable');
    assert.equal(verdict.reconciliation, null);
  });

  test('only the chain saying so produces entry_reverted', () => {
    const verdict = reconcileEntryV1({
      plan: plan(),
      status: 'reverted',
      assetChanges: null,
      transactionHashes: [],
      blockNumber: null,
    });
    assert.equal(verdict.state === 'terminal' && verdict.outcome, 'entry_reverted');
  });

  test('pending stays pending', () => {
    assert.equal(
      reconcileEntryV1({
        plan: plan(),
        status: 'pending',
        assetChanges: null,
        transactionHashes: [],
        blockNumber: null,
      }).state,
      'pending',
    );
  });

  test('a confirmed batch with unreadable asset changes is not a success', () => {
    assert.equal(confirmed(null, 0).state, 'reconciling');
    const exhausted = reconcileEntryV1({
      plan: plan(),
      status: 'confirmed',
      assetChanges: null,
      transactionHashes: [],
      blockNumber: null,
      attempts: 99,
    });
    assert.equal(exhausted.state === 'terminal' && exhausted.outcome, 'reconciliation_required');
  });
});

describe('the evidence hash is derived from what this server checked', () => {
  test('it changes when any observed fact changes', () => {
    const base = {
      planId: 'plan-1',
      callsHash: `0x${'8'.repeat(64)}`,
      spentAtomic: '100000000',
      receivedAtomic: '4200000000000000000000',
      blockNumber: '49450100',
      transactionHashes: [`0x${'1'.repeat(64)}`],
    };
    const first = reconciliationEvidenceHashV1(base);
    assert.equal(first, reconciliationEvidenceHashV1({ ...base }));
    assert.notEqual(first, reconciliationEvidenceHashV1({ ...base, receivedAtomic: '1' }));
    assert.notEqual(first, reconciliationEvidenceHashV1({ ...base, blockNumber: '49450101' }));
  });

  test('hash ordering does not depend on the order transactions were reported', () => {
    const a = `0x${'1'.repeat(64)}`;
    const b = `0x${'2'.repeat(64)}`;
    const base = {
      planId: 'plan-1',
      callsHash: `0x${'8'.repeat(64)}`,
      spentAtomic: '1',
      receivedAtomic: '1',
      blockNumber: null,
    };
    assert.equal(
      reconciliationEvidenceHashV1({ ...base, transactionHashes: [a, b] }),
      reconciliationEvidenceHashV1({ ...base, transactionHashes: [b, a] }),
    );
  });
});

describe('the matcher is explicit about every refusal', () => {
  test('no quote asset leaving the wallet is not a purchase', () => {
    const matched = assetsMatchPlanV1({
      plan: plan(),
      changes: [
        { token: TOKEN, direction: 'in', amountAtomic: '4200000000000000000000', counterparty: WALLET },
      ],
    });
    assert.equal(matched.ok, false);
    assert.equal(matched.ok === false && matched.reason, 'no_quote_asset_spent');
  });

  test('nothing received at all is named as such', () => {
    const matched = assetsMatchPlanV1({
      plan: plan(),
      changes: [{ token: USDC, direction: 'out', amountAtomic: '100000000', counterparty: ROUTER }],
    });
    assert.equal(matched.ok === false && matched.reason, 'no_token_received');
  });
});
