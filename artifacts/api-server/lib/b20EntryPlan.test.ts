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
import {
  buildEntryBlueprintV1,
  revalidateControlsV1,
  revalidateQuoteV1,
  runEntryKernelV1,
  verifyEntrySimulationV1,
  type EntryControlStateV1,
  type FreshEntryQuoteV1,
} from './b20EntryPlan.js';
import { routeHashV1 } from './opportunityClearance.js';

function packageFileV1(relative: string): string {
  const cwd = process.cwd();
  return cwd.endsWith(`${path.sep}artifacts${path.sep}api-server`)
    ? path.join(cwd, relative)
    : path.join(cwd, 'artifacts/api-server', relative);
}

const USDC = OPPORTUNITY_QUOTE_ASSET_V1;
const TOKEN = '0xb200000000000000000000578f3ae29d9e6e0101';
const WALLET = '0x1111111111111111111111111111111111111111';
const OTHER_WALLET = '0x2222222222222222222222222222222222222222';
const FACTORY = '0x420dd381b31aef6683db6b902084cb0ffece40da';
const ROUTER = '0xcf77a3ba9a5ca399b7c97c74d54e5b1beb874e43';
const NOW = new Date('2026-08-03T12:00:00.000Z');
const DEADLINE = BigInt(Math.floor(NOW.getTime() / 1000)) + 300n;

const route = [{ from: USDC, to: TOKEN, stable: false, factory: FACTORY }] as const;
const otherRoute = [{ from: USDC, to: TOKEN, stable: true, factory: FACTORY }] as const;

const CONTROL_HASH = `0x${'a'.repeat(64)}`;

function clearance(overrides: Partial<B20OpportunityClearanceV1> = {}): B20OpportunityClearanceV1 {
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
    exitRouteHash: routeHashV1(otherRoute),
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
    ...overrides,
  });
}

const controls = (overrides: Partial<EntryControlStateV1> = {}): EntryControlStateV1 => ({
  factoryConfirmed: true,
  transfersPaused: false,
  transferPolicyActive: false,
  controlsFullyRead: true,
  snapshotHash: CONTROL_HASH,
  blockNumber: '49450050',
  ...overrides,
});

const fresh = (overrides: Partial<FreshEntryQuoteV1> = {}): FreshEntryQuoteV1 => ({
  route,
  outputAtomic: '4200000000000000000000',
  quotedAt: NOW,
  ...overrides,
});

const blueprint = (allowance = '0') =>
  buildEntryBlueprintV1({
    clearance: clearance(),
    fresh: fresh(),
    freshControls: controls(),
    observedAllowanceAtomic: allowance,
    deadlineSeconds: DEADLINE,
  });

describe('nothing on the entry path signs, broadcasts or takes client bytes', () => {
  const source = readFileSync(packageFileV1('lib/b20EntryPlan.ts'), 'utf8');

  test('there is no key, signer or broadcast', () => {
    for (const forbidden of [
      'privateKey',
      'PRIVATE_KEY',
      'signTransaction',
      'sendRawTransaction',
      'eth_sendTransaction',
      'wallet_sendCalls',
    ]) {
      assert.ok(!source.includes(forbidden), `must not reference ${forbidden}`);
    }
  });

  test('the calldata is encoded here, never accepted', () => {
    assert.match(source, /encodeSwapExactTokensForTokensV1/);
    assert.match(source, /encodeExactApproveV1/);
    // No path takes a `data` field from an input object.
    assert.ok(!/\bdata:\s*input\.[a-zA-Z]*\.?data\b/.test(source));
  });

  test('the allowlist is not widened to make a type fit', () => {
    assert.match(source, /Widening that allowlist to satisfy a type/);
  });
});

describe('a clearance does not survive a change in the token', () => {
  test('unchanged controls revalidate', () => {
    assert.equal(revalidateControlsV1({ cleared: { snapshotHash: CONTROL_HASH }, fresh: controls() }), null);
  });

  test('a pause invalidates preparation', () => {
    assert.equal(
      revalidateControlsV1({
        cleared: { snapshotHash: CONTROL_HASH },
        fresh: controls({ transfersPaused: true }),
      }),
      'entry_transfers_paused',
    );
  });

  test('an unreadable control is never a pass', () => {
    assert.equal(
      revalidateControlsV1({
        cleared: { snapshotHash: CONTROL_HASH },
        fresh: controls({ controlsFullyRead: false }),
      }),
      'entry_controls_unreadable',
    );
  });

  test('a token that is no longer factory-confirmed is refused', () => {
    assert.equal(
      revalidateControlsV1({
        cleared: { snapshotHash: CONTROL_HASH },
        fresh: controls({ factoryConfirmed: false }),
      }),
      'entry_not_b20',
    );
  });

  test('any material control difference invalidates, and issues nothing new', () => {
    assert.equal(
      revalidateControlsV1({
        cleared: { snapshotHash: CONTROL_HASH },
        fresh: controls({ snapshotHash: `0x${'9'.repeat(64)}` }),
      }),
      'entry_controls_changed',
    );
    // The refusal must not be a re-certification path.
    const source = readFileSync(packageFileV1('lib/b20EntryPlan.ts'), 'utf8');
    assert.match(source, /nothing is silently\s*\n?\s*\*\s*re-certified/);
  });
});

describe('the reviewed route is the route, or there is no plan', () => {
  test('the exact cleared route revalidates', () => {
    assert.equal(
      revalidateQuoteV1({
        clearance: clearance(),
        clearedRoute: route,
        fresh: fresh(),
        profile: { quoteAsset: USDC, positionAtomic: '100000000', maxRoundTripBps: 300, maxExitSlippageBps: 300 },
        now: NOW,
      }),
      null,
    );
  });

  test('a better route is NOT substituted for the reviewed one', () => {
    // The user reviewed one route. A different one has not been through this
    // gate at all, however well it prices.
    assert.equal(
      revalidateQuoteV1({
        clearance: clearance(),
        clearedRoute: route,
        fresh: fresh({ route: otherRoute }),
        profile: { quoteAsset: USDC, positionAtomic: '100000000', maxRoundTripBps: 300, maxExitSlippageBps: 300 },
        now: NOW,
      }),
      'entry_route_substituted',
    );
  });

  test('a route that no longer prices requires a new evaluation', () => {
    assert.equal(
      revalidateQuoteV1({
        clearance: clearance(),
        clearedRoute: route,
        fresh: null,
        profile: { quoteAsset: USDC, positionAtomic: '100000000', maxRoundTripBps: 300, maxExitSlippageBps: 300 },
        now: NOW,
      }),
      'entry_plan_stale',
    );
  });

  test('a stale quote is not prepared', () => {
    assert.equal(
      revalidateQuoteV1({
        clearance: clearance(),
        clearedRoute: route,
        fresh: fresh({ quotedAt: new Date(NOW.getTime() - 60_000) }),
        profile: { quoteAsset: USDC, positionAtomic: '100000000', maxRoundTripBps: 300, maxExitSlippageBps: 300 },
        now: NOW,
      }),
      'entry_quote_expired',
    );
  });
});

describe('the blueprint is exact, bounded and deterministic', () => {
  test('the approval is the exact position, to the pinned router', () => {
    const plan = blueprint('0');
    const approval = plan.calls.find((call) => call.callType === 'approval');
    assert.ok(approval);
    assert.equal(approval!.to, USDC);
    assert.equal(approval!.spender, ROUTER);
    assert.equal(approval!.amountAtomic, '100000000');
    // There is no unlimited variant anywhere on this path.
    assert.ok(!approval!.data.includes('f'.repeat(64)));
  });

  test('a standing allowance means no approval call at all', () => {
    // An approval nobody needs is a state change nobody asked for.
    const plan = blueprint('100000000');
    assert.equal(plan.calls.filter((call) => call.callType === 'approval').length, 0);
    assert.equal(plan.calls.length, 1);
  });

  test('the recipient is always the authenticated wallet', () => {
    const swap = blueprint().calls.find((call) => call.callType === 'swap');
    assert.equal(swap!.recipient, WALLET);
  });

  test('no call carries native value', () => {
    assert.ok(blueprint().calls.every((call) => call.valueWei === '0'));
  });

  test('the same inputs produce the same hash, which is what makes it idempotent', () => {
    assert.equal(blueprint().blueprintHash, blueprint().blueprintHash);
    const other = buildEntryBlueprintV1({
      clearance: clearance(),
      fresh: fresh({ outputAtomic: '4100000000000000000000' }),
      freshControls: controls(),
      observedAllowanceAtomic: '0',
      deadlineSeconds: DEADLINE,
    });
    assert.notEqual(blueprint().blueprintHash, other.blueprintHash);
  });

  test('it carries both control readings, because they are two facts', () => {
    const plan = blueprint();
    assert.equal(plan.certifiedControlSnapshotHash, CONTROL_HASH);
    assert.equal(plan.prepareControlSnapshotHash, CONTROL_HASH);
    assert.equal(plan.prepareControlBlockNumber, '49450050');
    assert.equal(plan.coverage, 'partial');
    assert.equal(plan.viableRouteConfirmed, true);
    assert.equal(plan.bestRouteConfirmed, false);
  });
});

describe('the kernel blocks the whole plan or none of it', () => {
  const run = (plan = blueprint(), overrides: { wallet?: string; clearance?: B20OpportunityClearanceV1; now?: Date } = {}) =>
    runEntryKernelV1({
      blueprint: plan,
      walletAddress: overrides.wallet ?? WALLET,
      clearance: overrides.clearance ?? clearance(),
      now: overrides.now ?? NOW,
    });

  test('a clean plan is allowed', () => {
    const result = run();
    assert.equal(result.verdict, 'allowed', JSON.stringify(result.checks.filter((c) => c.status === 'failed')));
  });

  test('another wallet is blocked', () => {
    assert.equal(run(blueprint(), { wallet: OTHER_WALLET }).verdict, 'blocked');
  });

  test('a substituted route is blocked and named', () => {
    const plan = { ...blueprint(), entryRouteHash: routeHashV1(otherRoute) };
    const result = run(plan);
    assert.equal(result.verdict, 'blocked');
    assert.equal(result.blockedReason, 'entry_route_substituted');
  });

  test('a spend above the approved position is blocked', () => {
    const plan = { ...blueprint(), positionAtomic: '500000000' };
    const result = run(plan);
    assert.equal(result.verdict, 'blocked');
    assert.equal(result.blockedReason, 'entry_spend_exceeds_profile');
  });

  test('an expired clearance blocks at the kernel too, not only at the gate', () => {
    const result = run(blueprint(), { now: new Date(NOW.getTime() + B20_CLEARANCE_TTL_MS_V1 + 1) });
    assert.equal(result.verdict, 'blocked');
  });

  test('an unbounded minimum is blocked', () => {
    const plan = { ...blueprint(), minimumOutputAtomic: '0' };
    assert.equal(run(plan).verdict, 'blocked');
  });

  test('a swap to another recipient is blocked', () => {
    const plan = blueprint();
    const swapIndex = plan.calls.findIndex((call) => call.callType === 'swap');
    plan.calls[swapIndex] = { ...plan.calls[swapIndex]!, recipient: OTHER_WALLET };
    assert.equal(run(plan).verdict, 'blocked');
  });
});

describe('the exact calls are simulated, and a clearance does not replace it', () => {
  const simulated = (overrides: Record<string, unknown> = {}) =>
    verifyEntrySimulationV1({
      blueprint: blueprint(),
      simulation: {
        ok: true,
        calls: blueprint().calls.map((call) => ({ index: call.index, status: 'success' as const })),
        assetChangesAvailable: true,
        assetChanges: [
          { token: USDC, direction: 'out', amountAtomic: '100000000', callIndex: 1 },
          { token: TOKEN, direction: 'in', amountAtomic: '4200000000000000000000', callIndex: 1 },
        ],
        ...overrides,
      },
    });

  test('a matching simulation passes', () => {
    assert.equal(simulated(), null);
  });

  test('an unavailable simulation exposes no wallet action', () => {
    assert.equal(simulated({ ok: false }), 'entry_simulation_unavailable');
  });

  test('a revert exposes no wallet action', () => {
    assert.equal(
      simulated({
        calls: [
          { index: 0, status: 'success' as const },
          { index: 1, status: 'reverted' as const },
        ],
      }),
      'entry_simulation_reverted',
    );
  });

  test('a spend above the profile exposes no wallet action', () => {
    assert.equal(
      simulated({
        assetChanges: [
          { token: USDC, direction: 'out', amountAtomic: '200000000', callIndex: 1 },
          { token: TOKEN, direction: 'in', amountAtomic: '4200000000000000000000', callIndex: 1 },
        ],
      }),
      'entry_spend_exceeds_profile',
    );
  });

  test('acquiring a different token exposes no wallet action', () => {
    assert.equal(
      simulated({
        assetChanges: [
          { token: USDC, direction: 'out', amountAtomic: '100000000', callIndex: 1 },
          { token: OTHER_WALLET, direction: 'in', amountAtomic: '4200000000000000000000', callIndex: 1 },
        ],
      }),
      'entry_simulation_unavailable',
    );
  });

  test('undecodable movements are never read as a pass', () => {
    assert.equal(simulated({ assetChangesAvailable: false }), 'entry_simulation_unavailable');
  });
});
