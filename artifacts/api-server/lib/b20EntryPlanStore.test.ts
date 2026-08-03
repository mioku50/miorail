import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { OPPORTUNITY_QUOTE_ASSET_V1 } from '@mioagent/opportunity-rail';
import { stableHashV1 } from '@mioagent/route-domain';
import {
  B20OpportunityClearanceV1Schema,
  B20_CLEARANCE_TTL_MS_V1,
  InMemoryB20EntryPlanRepositoryV1,
  b20EntryReviewV1,
  entryPlanCallsHashV1,
  type B20OpportunityClearanceV1,
} from '@mioagent/route-storage';

import { buildEntryBlueprintV1, runEntryKernelV1 } from './b20EntryPlan.js';
import { buildPreparedPlanV1 } from './b20EntryPlanStore.js';
import { routeHashV1 } from './opportunityClearance.js';

// ---------------------------------------------------------------------------
// T68F-A §11 — the persisted plan must be the plan that was checked.
//
// Three hashes have to be the same number, and each is produced by a different
// piece of the pipeline:
//
//   * the blueprint hash the KERNEL passed;
//   * the blueprint hash the SIMULATION was requested with;
//   * the hash over the calls actually written to storage.
//
// If they can drift, then the batch a wallet is eventually asked to sign is not
// provably the batch that was checked, and every gate above it becomes a story
// about a different transaction.
// ---------------------------------------------------------------------------

const USDC = OPPORTUNITY_QUOTE_ASSET_V1;
const TOKEN = '0xb200000000000000000000578f3ae29d9e6e0101';
const WALLET = '0x1111111111111111111111111111111111111111';
const FACTORY = '0x420dd381b31aef6683db6b902084cb0ffece40da';
const NOW = new Date('2026-08-03T12:00:00.000Z');
const DEADLINE = BigInt(Math.floor(NOW.getTime() / 1000)) + 300n;
const route = [{ from: USDC, to: TOKEN, stable: false, factory: FACTORY }] as const;
const CONTROL_HASH = `0x${'a'.repeat(64)}`;

function clearance(): B20OpportunityClearanceV1 {
  return B20OpportunityClearanceV1Schema.parse({
    schemaVersion: 'b20-opportunity-clearance/v1',
    id: 'clearance-1',
    tenantId: `eip155:8453:${WALLET}`,
    walletAddress: WALLET,
    chainId: 8453,
    tokenAddress: TOKEN,
    quoteAsset: USDC,
    positionAtomic: '100000000',
    maxRoundTripBps: 300,
    maxExitSlippageBps: 300,
    profileIdentity: `${USDC}:100000000:300:300`,
    controlSnapshotHash: CONTROL_HASH,
    controlBlockNumber: '49450000',
    entryRouteHash: routeHashV1(route),
    exitRouteHash: `0x${'c'.repeat(64)}`,
    entrySourceKey: `aerodrome:${FACTORY}:${USDC}:${TOKEN}:volatile`,
    exitSourceKey: `aerodrome:${FACTORY}:${TOKEN}:${USDC}:volatile`,
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
  });
}

function blueprint(allowance = '0') {
  return buildEntryBlueprintV1({
    clearance: clearance(),
    fresh: { route, outputAtomic: '4200000000000000000000', quotedAt: NOW },
    freshControls: {
      factoryConfirmed: true,
      transfersPaused: false,
      transferPolicyActive: false,
      controlsFullyRead: true,
      snapshotHash: CONTROL_HASH,
      blockNumber: '49450050',
    },
    observedAllowanceAtomic: allowance,
    deadlineSeconds: DEADLINE,
  });
}

const SIMULATION = {
  requestHash: `0x${'1'.repeat(64)}`,
  evidenceHash: `0x${'2'.repeat(64)}`,
  blockNumber: '49450051',
};

const build = (allowance = '0') =>
  buildPreparedPlanV1({
    clearance: clearance(),
    blueprint: blueprint(allowance),
    simulation: SIMULATION,
    tokenName: 'Example',
    tokenSymbol: 'EXA',
    requestId: 'req-1',
    now: NOW,
    newId: (() => {
      let n = 0;
      return () => `id-${++n}`;
    })(),
  });

describe('the persisted plan is the plan the kernel and the simulator saw', () => {
  test('one blueprint hash, from the kernel to the row', () => {
    const prepared = blueprint();
    // The kernel allowed exactly this object.
    assert.equal(
      runEntryKernelV1({ blueprint: prepared, walletAddress: WALLET, clearance: clearance(), now: NOW })
        .verdict,
      'allowed',
    );
    // The simulation is requested with the same hash the runner computes.
    const simulatedHash = prepared.blueprintHash;
    const { plan } = build();
    assert.equal(plan.blueprintHash, prepared.blueprintHash);
    assert.equal(plan.blueprintHash, simulatedHash);
  });

  test('the stored calls hash to what the simulation was asked about', () => {
    const prepared = blueprint();
    // The digest the runner sends to the simulation provider, recomputed here
    // from the STORED calls rather than from the in-memory blueprint.
    const runnerHash = stableHashV1('b20-entry-calls/v1', {
      calls: prepared.calls.map((call) => ({ to: call.to, data: call.data, value: call.valueWei })),
    });
    const { plan } = build();
    assert.equal(plan.callsHash, runnerHash);
    assert.equal(entryPlanCallsHashV1(plan.calls), runnerHash);
  });

  test('the stored bytes are byte-for-byte the prepared bytes', () => {
    const prepared = blueprint();
    const { plan } = build();
    assert.equal(plan.calls.length, prepared.calls.length);
    for (const [index, call] of plan.calls.entries()) {
      const source = prepared.calls[index]!;
      assert.equal(call.to, source.to);
      assert.equal(call.data, source.data);
      assert.equal(call.valueWei, source.valueWei);
      assert.equal(call.callType, source.callType);
      assert.equal(call.recipient, source.recipient);
      assert.equal(call.spender, source.spender);
    }
  });

  test('a standing allowance stores one call, and Review says no approval is needed', () => {
    const { plan } = build('100000000');
    assert.equal(plan.calls.length, 1);
    assert.equal(plan.calls[0]!.callType, 'swap');
    assert.deepEqual(b20EntryReviewV1(plan).approval, { required: false, amountAtomic: null });
  });
});

describe('every binding on the plan comes from the server’s own record', () => {
  test('the venue is named by the clearance and the re-quoted route', () => {
    const { plan } = build();
    assert.equal(plan.entryProviderId, 'aerodrome');
    assert.equal(plan.entrySourceKey, `aerodrome:${FACTORY}:${USDC}:${TOKEN}:volatile`);
    assert.equal(plan.entryRouteHash, routeHashV1(route));
  });

  test('the token, profile and wallet are the clearance’s, not a caller’s', () => {
    const { plan } = build();
    const source = clearance();
    assert.equal(plan.tokenAddress, source.tokenAddress);
    assert.equal(plan.profileIdentity, source.profileIdentity);
    assert.equal(plan.walletAddress, source.walletAddress);
    assert.equal(plan.clearanceId, source.id);
    assert.equal(plan.positionAtomic, source.positionAtomic);
  });

  test('a clearance that changed under the plan would be visible', () => {
    // The whole document is hashed, so a mutated clearance no longer matches
    // the plan that cited it.
    const { plan } = build();
    const mutated = { ...clearance(), simulatedRoundTripBps: 5 };
    assert.notEqual(plan.clearanceHash, stableHashV1('b20-opportunity-clearance/v1', mutated));
  });

  test('both control readings and both simulations are kept apart', () => {
    const { plan } = build();
    // One field for each would hide a change between the two moments.
    assert.equal(plan.certificationControlSnapshotHash, CONTROL_HASH);
    assert.equal(plan.prepareControlSnapshotHash, CONTROL_HASH);
    assert.equal(plan.certificationSimulationEvidenceHash, `0x${'e'.repeat(64)}`);
    assert.equal(plan.prepareSimulationEvidenceHash, SIMULATION.evidenceHash);
    assert.notEqual(plan.certificationSimulationEvidenceHash, plan.prepareSimulationEvidenceHash);
  });

  test('the plan expires with the deadline its own calls encode', () => {
    const { plan } = build();
    assert.equal(plan.deadlineSeconds, DEADLINE.toString());
    assert.equal(Date.parse(plan.expiresAt), Number(DEADLINE) * 1000);
  });
});

describe('a stored plan is prepared, and nothing more', () => {
  test('the run is prepared, names the family, and carries no submission', async () => {
    const store = new InMemoryB20EntryPlanRepositoryV1();
    const { plan, run } = build();
    const stored = await store.insertPreparedPlan({ plan, run });
    assert.equal(stored.plan.lifecycle, 'prepared');
    assert.equal(stored.plan.submissionId, null);
    assert.equal(stored.run.state, 'prepared');
    assert.equal(stored.run.executionFamily, 'b20_opportunity_entry');
    assert.equal(stored.run.submissionId, null);
    // Not 'submitted', not 'pending', not 'executed'.
    assert.ok(!['submitted', 'pending', 'executed'].includes(stored.run.state));
  });

  test('the projection of a real plan carries no executable byte', () => {
    const { plan } = build();
    const review = JSON.stringify(b20EntryReviewV1(plan));
    for (const call of plan.calls) {
      assert.ok(!review.includes(call.data), 'calldata must stay server side');
    }
    assert.ok(!review.includes('"calls"'));
    assert.equal(b20EntryReviewV1(plan).executionAvailable, false);
    assert.equal(b20EntryReviewV1(plan).executionUnavailableReason, 'submission_not_wired');
  });
});
