import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  B20OpportunityClearanceV1Schema,
  B20PreparedEntryPlanV1Schema,
  B20_CLEARANCE_TTL_MS_V1,
  B20_ENTRY_EXECUTION_FAMILY_V1,
  entryPlanCallsHashV1,
  type B20OpportunityClearanceV1,
  type B20PreparedEntryPlanV1,
} from '@mioagent/route-storage';

import {
  CONTROL_FRESHNESS_MS_V1,
  entryWalletPayloadV1,
  submitGateRefusalV1,
} from './b20EntrySubmitGate.js';

// ---------------------------------------------------------------------------
// T68F-B §3 — the last check before a wallet opens.
//
// Every assertion here is about the same idea: the thing the wallet is asked to
// sign must be provably the thing that was checked, and nothing a browser sends
// may influence it.
// ---------------------------------------------------------------------------

const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const ROUTER = '0xcf77a3ba9a5ca399b7c97c74d54e5b1beb874e43';
const TOKEN = '0xb200000000000000000000578f3ae29d9e6e0101';
const WALLET = '0x1111111111111111111111111111111111111111';
const OTHER_WALLET = '0x2222222222222222222222222222222222222222';
const TENANT = `eip155:8453:${WALLET}`;
const NOW = new Date('2026-08-03T12:00:00.000Z');
const DEADLINE = String(Math.floor(NOW.getTime() / 1000) + 300);
const PROFILE = `${USDC}:100000000:300:300`;

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
    tenantId: TENANT,
    walletAddress: WALLET,
    chainId: 8453,
    clearanceId: 'clearance-1',
    clearanceHash: `0x${'c'.repeat(64)}`,
    profileIdentity: PROFILE,
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
    clearanceExpiresAt: new Date(NOW.getTime() + B20_CLEARANCE_TTL_MS_V1).toISOString(),
    calls,
    lifecycle: 'prepared',
    submissionId: null,
    requestId: 'req-1',
    createdAt: NOW.toISOString(),
    expiresAt: new Date(Number(DEADLINE) * 1000).toISOString(),
    ...overrides,
  });
}

function clearance(overrides: Record<string, unknown> = {}): B20OpportunityClearanceV1 {
  return B20OpportunityClearanceV1Schema.parse({
    schemaVersion: 'b20-opportunity-clearance/v1',
    id: 'clearance-1',
    tenantId: TENANT,
    walletAddress: WALLET,
    chainId: 8453,
    tokenAddress: TOKEN,
    quoteAsset: USDC,
    positionAtomic: '100000000',
    maxRoundTripBps: 300,
    maxExitSlippageBps: 300,
    profileIdentity: PROFILE,
    controlSnapshotHash: `0x${'a'.repeat(64)}`,
    controlBlockNumber: '49450000',
    entryRouteHash: `0x${'b'.repeat(64)}`,
    exitRouteHash: `0x${'c'.repeat(64)}`,
    entrySourceKey: `aerodrome:0xfac:${USDC}:${TOKEN}:volatile`,
    exitSourceKey: `aerodrome:0xfac:${TOKEN}:${USDC}:volatile`,
    simulationRequestHash: `0x${'d'.repeat(64)}`,
    simulationEvidenceHash: `0x${'e'.repeat(64)}`,
    simulationBlockNumber: '49450001',
    entryProvider: 'aerodrome',
    viability: 'qualified',
    coverage: 'partial',
    viableRouteConfirmed: true,
    bestRouteConfirmed: false,
    simulatedReturnedAtomic: '99000000',
    simulatedAcquiredAtomic: '4200000000000000000000',
    simulatedRoundTripBps: 100,
    createdAt: NOW.toISOString(),
    expiresAt: new Date(NOW.getTime() + B20_CLEARANCE_TTL_MS_V1).toISOString(),
    ...overrides,
  });
}

const gate = (overrides: Record<string, unknown> = {}) =>
  submitGateRefusalV1({
    plan: plan(),
    clearance: clearance(),
    walletAddress: WALLET,
    tenantId: TENANT,
    chainId: 8453,
    profileIdentity: PROFILE,
    hasLiveAttempt: false,
    now: NOW,
    controlsReadAt: NOW,
    ...overrides,
  } as never);

describe('the gate opens only for a plan that is still exactly what was checked', () => {
  test('an untouched plan passes', () => {
    assert.equal(gate(), null);
  });

  test('a plan edited in the database is caught by the same line as a tampered request', () => {
    // The calls hash is RECOMPUTED from the stored bytes, never read from a
    // column, so a row somebody edited fails here too.
    const tampered = plan();
    tampered.calls[1] = { ...tampered.calls[1]!, data: '0xdeadbeef' };
    assert.equal(gate({ plan: tampered }), 'entry_plan_calls_tampered');
  });

  test('reordering the calls blocks submission', () => {
    const reordered = plan();
    reordered.calls = [reordered.calls[1]!, reordered.calls[0]!];
    assert.equal(gate({ plan: reordered }), 'entry_plan_calls_tampered');
  });

  test('removing a call blocks submission', () => {
    const shortened = plan();
    shortened.calls = [shortened.calls[0]!];
    assert.equal(gate({ plan: shortened }), 'entry_plan_calls_tampered');
  });

  test('another wallet is refused, and another tenant is simply not found', () => {
    assert.equal(gate({ walletAddress: OTHER_WALLET }), 'entry_plan_wallet_mismatch');
    assert.equal(gate({ tenantId: 'eip155:8453:someone-else' }), 'entry_plan_not_found');
    assert.equal(gate({ plan: null }), 'entry_plan_not_found');
  });

  test('an expired plan is refused rather than silently rebuilt', () => {
    assert.equal(
      gate({ now: new Date(Number(DEADLINE) * 1000 + 1) }),
      'entry_plan_expired',
    );
  });

  test('an expired clearance is refused, and named as the clearance', () => {
    assert.equal(
      gate({
        clearance: clearance({
          // A clearance must outlive its own creation, so the whole window is
          // moved into the past rather than inverted.
          createdAt: new Date(NOW.getTime() - 60_000).toISOString(),
          expiresAt: new Date(NOW.getTime() - 1).toISOString(),
        }),
        now: NOW,
      }),
      'entry_plan_clearance_expired',
    );
  });

  test('a clearance that no longer agrees with the plan is refused', () => {
    assert.equal(gate({ clearance: null }), 'entry_plan_clearance_mismatch');
    assert.equal(
      gate({ clearance: clearance({ entryRouteHash: `0x${'0'.repeat(64)}` }) }),
      'entry_plan_clearance_mismatch',
    );
  });

  test('a restated profile that differs is refused', () => {
    assert.equal(gate({ profileIdentity: `${USDC}:500000000:300:300` }), 'entry_plan_profile_mismatch');
  });

  test('another chain is refused', () => {
    assert.equal(gate({ chainId: 84532 }), 'entry_plan_chain_mismatch');
  });

  test('a plan of another execution family is refused', () => {
    const foreign = { ...plan(), executionFamily: 'swap' } as never;
    assert.equal(gate({ plan: foreign }), 'entry_plan_wrong_family');
  });

  test('a live attempt blocks a second wallet action before anything else', () => {
    // Checked early on purpose: a second batch is the failure that costs money.
    assert.equal(gate({ hasLiveAttempt: true }), 'entry_plan_already_submitted');
    assert.equal(
      gate({ hasLiveAttempt: true, now: new Date(Number(DEADLINE) * 1000 + 1) }),
      'entry_plan_already_submitted',
    );
  });

  test('a plan past `prepared` cannot be submitted again', () => {
    assert.equal(
      gate({ plan: { ...plan(), lifecycle: 'submitted', submissionId: 'attempt-1' } as never }),
      'entry_plan_wrong_lifecycle',
    );
  });

  test('controls that were read too long ago fail closed', () => {
    assert.equal(
      gate({ controlsReadAt: new Date(NOW.getTime() - CONTROL_FRESHNESS_MS_V1 - 1) }),
      'entry_plan_controls_stale',
    );
    assert.equal(gate({ controlsReadAt: null }), 'entry_plan_controls_stale');
  });
});

describe('the wallet payload is built from stored bytes and nothing else', () => {
  test('it byte-matches the persisted calls', () => {
    const source = plan();
    const payload = entryWalletPayloadV1(source);
    assert.equal(payload.calls.length, source.calls.length);
    for (const [index, call] of payload.calls.entries()) {
      assert.equal(call.to, source.calls[index]!.to);
      assert.equal(call.data, source.calls[index]!.data);
    }
    assert.equal(payload.approvedCallsHash, source.callsHash);
    assert.equal(payload.blueprintHash, source.blueprintHash);
  });

  test('it is pinned to Base mainnet and to the authenticated wallet', () => {
    const payload = entryWalletPayloadV1(plan());
    assert.equal(payload.chainId, '0x2105');
    assert.equal(payload.from, WALLET);
  });

  test('approval and swap must land together', () => {
    // An approval that executed without its swap is a standing allowance
    // nobody asked for.
    assert.equal(entryWalletPayloadV1(plan()).atomicRequired, true);
  });

  test('no call ever carries native value', () => {
    for (const call of entryWalletPayloadV1(plan()).calls) assert.equal(call.value, '0x0');
  });

  test('a plan whose allowance sufficed sends only the swap', () => {
    const single = plan({ calls: [{ ...calls[1]!, index: 0 }] });
    const payload = entryWalletPayloadV1({
      ...single,
      callsHash: entryPlanCallsHashV1(single.calls),
    });
    assert.equal(payload.calls.length, 1);
    assert.equal(payload.calls[0]!.to, ROUTER);
  });

  test('the approval, when present, is exactly the position', () => {
    const source = plan();
    assert.equal(source.calls[0]!.amountAtomic, source.positionAtomic);
  });
});
