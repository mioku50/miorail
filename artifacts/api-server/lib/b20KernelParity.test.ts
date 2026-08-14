import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { OPPORTUNITY_QUOTE_ASSET_V1 } from '@mioagent/opportunity-rail';
import {
  B20OpportunityClearanceV1Schema,
  B20_CLEARANCE_TTL_MS_V1,
  type B20OpportunityClearanceV1,
} from '@mioagent/route-storage';
import { buildEntryBlueprintV1, runEntryKernelV1, type B20EntryBlueprintV1 } from './b20EntryPlan.js';
import { routeHashV1 } from './opportunityClearance.js';

// ---------------------------------------------------------------------------
// T68F §3 — the two kernels must not drift.
//
// The B20 entry path has its own kernel because the generic one takes a
// `RouteIntentV1` and `isTrustedRouteAsset` refuses a B20 token by design.
// That is a defensible reason to fork a kernel and a terrible reason to lose a
// check: a fork is exactly where an invariant quietly stops being enforced,
// and nobody notices because both files still look thorough.
//
// So the generic kernel's check ids are read out of its SOURCE and each one is
// mapped, here, to the B20 counterpart that enforces it — with a behavioural
// test proving the B20 kernel actually blocks. A new check added to the generic
// kernel fails this file until somebody decides what it means here.
// ---------------------------------------------------------------------------

function repoFileV1(relative: string): string {
  const cwd = process.cwd();
  return cwd.endsWith(`${path.sep}artifacts${path.sep}api-server`)
    ? path.join(cwd, '../..', relative)
    : path.join(cwd, relative);
}

const USDC = OPPORTUNITY_QUOTE_ASSET_V1;
const TOKEN = '0xb200000000000000000000578f3ae29d9e6e0101';
const WALLET = '0x1111111111111111111111111111111111111111';
const OTHER_WALLET = '0x2222222222222222222222222222222222222222';
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

function plan(): B20EntryBlueprintV1 {
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
    observedAllowanceAtomic: '0',
    deadlineSeconds: DEADLINE,
  });
}

const run = (blueprint: B20EntryBlueprintV1, overrides: { wallet?: string; now?: Date } = {}) =>
  runEntryKernelV1({
    blueprint,
    walletAddress: overrides.wallet ?? WALLET,
    clearance: clearance(),
    now: overrides.now ?? NOW,
  });

/**
 * Every invariant the generic kernel enforces, and where it lives here.
 *
 * `enforcedBy: null` is a DELIBERATE difference and must carry a reason. It is
 * not an escape hatch — the reason is read by a human in review, and a new one
 * appearing is the signal that somebody decided a check does not apply.
 */
const PARITY_V1: Record<string, { enforcedBy: string[] | null; why: string }> = {
  base_chain_pinned: { enforcedBy: ['chain_is_base_mainnet'], why: 'Base mainnet only, both paths.' },
  tenant_wallet_binding: {
    enforcedBy: ['wallet_matches_session'],
    why: 'The plan must name the authenticated wallet.',
  },
  recipient_is_wallet: {
    enforcedBy: ['recipient_is_authenticated_wallet'],
    why: 'The token must land in the wallet that signed for it.',
  },
  call_order_and_count: {
    enforcedBy: ['call_order_is_dense', 'exactly_one_swap', 'at_most_one_approval'],
    why: 'A reordered or padded batch is a different transaction.',
  },
  input_amount_matches_intent: {
    enforcedBy: ['position_matches_profile'],
    why: 'The profile position is this path’s intent amount.',
  },
  quote_deadline_unexpired: {
    enforcedBy: ['deadline_is_in_the_future', 'clearance_still_live'],
    why: 'Both the swap deadline and the clearance must still be live.',
  },
  provider_guard_aerodrome: {
    enforcedBy: [
      'swap_targets_pinned_router',
      'approval_spender_is_pinned_router',
      'route_matches_clearance',
    ],
    why: 'Router and factory pins, and the exact cleared route.',
  },
  linkage_hashes_present: {
    enforcedBy: ['token_matches_clearance', 'profile_matches_clearance'],
    why: 'The plan is bound to the clearance that justifies it.',
  },
  simulation_evidence: {
    enforcedBy: null,
    why: 'Enforced one layer out by verifyEntrySimulationV1, which the runner calls after the kernel and before any call is returned. A kernel check would duplicate it against evidence the kernel does not hold.',
  },
  contract_token_security: {
    enforcedBy: null,
    why: 'The generic path requires a GoPlus verdict on an ERC-20. A B20 token is a precompile that no scanner indexes; the B20 control read plus the clearance is this path’s equivalent, and it runs before the kernel rather than inside it.',
  },
  provider_guard_uniswap: { enforcedBy: null, why: 'Aerodrome only on this path.' },
  provider_guard_kyberswap: { enforcedBy: null, why: 'Aerodrome only on this path.' },
  provider_guard_balancer: {
    enforcedBy: null,
    why: 'The B20 entry blueprint is built from its exact cleared Aerodrome route; Balancer calls are not valid on this path.',
  },
  provider_contract_pin_hydrex: {
    enforcedBy: null,
    why: 'Hydrex proxy and implementation pins do not apply to the exact cleared Aerodrome-only B20 entry blueprint.',
  },
  provider_guard_hydrex: {
    enforcedBy: null,
    why: 'Hydrex outer and nested calldata are never accepted by the Aerodrome-only B20 entry blueprint.',
  },
  provider_contract_pin_o1: {
    enforcedBy: null,
    why: 'o1 proxy, admin and implementation pins do not apply to the exact cleared Aerodrome-only B20 entry blueprint.',
  },
  provider_guard_o1: {
    enforcedBy: null,
    why: 'o1 calldata and RLP routes are never accepted by the Aerodrome-only B20 entry blueprint.',
  },
};

describe('the two kernels enforce the same invariants', () => {
  const genericSource = readFileSync(
    repoFileV1('lib/transaction-composer/src/safetyKernel.ts'),
    'utf8',
  );
  const genericIds = [...new Set([...genericSource.matchAll(/check\(\s*'([^']+)'/g)].map((m) => m[1]!))];

  test('every generic check is either mapped or deliberately excluded with a reason', () => {
    for (const id of genericIds) {
      const entry = PARITY_V1[id];
      assert.ok(entry, `the generic kernel gained "${id}" and nobody decided what it means for B20`);
      assert.ok(entry.why.length > 20, `"${id}" needs a real reason, not a placeholder`);
    }
  });

  test('the parity table names no check the generic kernel does not have', () => {
    // A stale mapping is as misleading as a missing one.
    for (const id of Object.keys(PARITY_V1)) {
      assert.ok(genericIds.includes(id), `"${id}" is no longer a generic kernel check`);
    }
  });

  test('every mapped counterpart actually exists in the B20 kernel', () => {
    const result = run(plan());
    const b20Ids = new Set(result.checks.map((check) => check.id));
    for (const [id, entry] of Object.entries(PARITY_V1)) {
      if (!entry.enforcedBy) continue;
      for (const counterpart of entry.enforcedBy) {
        assert.ok(b20Ids.has(counterpart), `"${id}" maps to "${counterpart}", which the B20 kernel does not run`);
      }
    }
  });
});

describe('each shared invariant actually blocks, not merely reports', () => {
  test('a wrong chain blocks', () => {
    assert.equal(run({ ...plan(), chainId: 84532 as never }).verdict, 'blocked');
  });

  test('another wallet blocks', () => {
    assert.equal(run(plan(), { wallet: OTHER_WALLET }).verdict, 'blocked');
  });

  test('another recipient blocks', () => {
    const blueprint = plan();
    const index = blueprint.calls.findIndex((call) => call.callType === 'swap');
    blueprint.calls[index] = { ...blueprint.calls[index]!, recipient: OTHER_WALLET };
    assert.equal(run(blueprint).verdict, 'blocked');
  });

  test('another router blocks', () => {
    const blueprint = plan();
    const index = blueprint.calls.findIndex((call) => call.callType === 'swap');
    blueprint.calls[index] = { ...blueprint.calls[index]!, to: OTHER_WALLET };
    assert.equal(run(blueprint).verdict, 'blocked');
  });

  test('another spender on the approval blocks', () => {
    const blueprint = plan();
    const index = blueprint.calls.findIndex((call) => call.callType === 'approval');
    blueprint.calls[index] = { ...blueprint.calls[index]!, spender: OTHER_WALLET };
    assert.equal(run(blueprint).verdict, 'blocked');
  });

  test('an approval above the exact position blocks', () => {
    const blueprint = plan();
    const index = blueprint.calls.findIndex((call) => call.callType === 'approval');
    blueprint.calls[index] = { ...blueprint.calls[index]!, amountAtomic: '999000000' };
    assert.equal(run(blueprint).verdict, 'blocked');
  });

  test('a reordered batch blocks', () => {
    const blueprint = plan();
    blueprint.calls = [blueprint.calls[1]!, blueprint.calls[0]!];
    assert.equal(run(blueprint).verdict, 'blocked');
  });

  test('a second swap blocks', () => {
    const blueprint = plan();
    blueprint.calls = [...blueprint.calls, { ...blueprint.calls[1]!, index: 2 }];
    assert.equal(run(blueprint).verdict, 'blocked');
  });

  test('native value on any call blocks', () => {
    const blueprint = plan();
    blueprint.calls[0] = { ...blueprint.calls[0]!, valueWei: '1' };
    assert.equal(run(blueprint).verdict, 'blocked');
  });

  test('an expired deadline blocks', () => {
    assert.equal(run({ ...plan(), deadlineSeconds: '1' }).verdict, 'blocked');
  });

  test('an unbounded minimum blocks', () => {
    assert.equal(run({ ...plan(), minimumOutputAtomic: '0' }).verdict, 'blocked');
  });

  test('a substituted route blocks', () => {
    assert.equal(run({ ...plan(), entryRouteHash: `0x${'f'.repeat(64)}` }).verdict, 'blocked');
  });

  test('a spend above the profile blocks', () => {
    assert.equal(run({ ...plan(), positionAtomic: '500000000' }).verdict, 'blocked');
  });

  test('an expired clearance blocks', () => {
    assert.equal(
      run(plan(), { now: new Date(NOW.getTime() + B20_CLEARANCE_TTL_MS_V1 + 1) }).verdict,
      'blocked',
    );
  });

  test('the untouched plan is the only thing that passes', () => {
    assert.equal(run(plan()).verdict, 'allowed');
  });
});
