import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { OPPORTUNITY_QUOTE_ASSET_V1, type OpportunityProfileV2 } from '@mioagent/opportunity-rail';
import {
  buildClearanceV1,
  certifyOpportunityV1,
  entryProbeOutputV1,
  routeHashV1,
  unmeasuredFromSimulationV1,
  type SimulationOutcomeLikeV1,
} from './opportunityClearance.js';
import { opportunityBlueprintCallsV1, OpportunityBlueprintError } from './opportunitySimulation.js';

/** The harness runs this package's tests from the package directory; running
 * one file by hand happens from the repo root. Resolved for both rather than
 * assuming either. */
function packageFileV1(relative: string): string {
  const cwd = process.cwd();
  return cwd.endsWith(`${path.sep}artifacts${path.sep}api-server`)
    ? path.join(cwd, relative)
    : path.join(cwd, 'artifacts/api-server', relative);
}

const SOURCES_V1 = [
  packageFileV1('lib/opportunityClearance.ts'),
  packageFileV1('lib/opportunitySimulation.ts'),
];
const TOKEN = '0xb200000000000000000000578f3ae29d9e6e0101';
const USDC = OPPORTUNITY_QUOTE_ASSET_V1;
const WALLET = '0x1111111111111111111111111111111111111111';
const FACTORY = '0x420dd381b31aef6683db6b902084cb0ffece40da';
const NOW = new Date('2026-08-03T12:00:00.000Z');

const PROFILE: OpportunityProfileV2 = {
  quoteAsset: USDC,
  positionAtomic: '100000000',
  maxRoundTripBps: 300,
  maxExitSlippageBps: 300,
};

const entryRoute = [{ from: USDC, to: TOKEN, stable: false, factory: FACTORY }] as const;
const exitRoute = [{ from: TOKEN, to: USDC, stable: false, factory: FACTORY }] as const;

function roundTrip(overrides: Partial<SimulationOutcomeLikeV1> = {}): SimulationOutcomeLikeV1 {
  return {
    ok: true,
    blockNumber: 49450001,
    calls: [0, 1, 2, 3].map((index) => ({ index, status: 'success' as const })),
    assetChangesAvailable: true,
    assetChanges: [
      { token: USDC, direction: 'out', amountAtomic: '100000000', callIndex: 1 },
      { token: TOKEN, direction: 'in', amountAtomic: '4200000000000000000000', callIndex: 1 },
      { token: TOKEN, direction: 'out', amountAtomic: '4200000000000000000000', callIndex: 3 },
      { token: USDC, direction: 'in', amountAtomic: '99000000', callIndex: 3 },
    ],
    ...overrides,
  };
}

const certify = (overrides: Partial<SimulationOutcomeLikeV1> = {}, answered = 6) =>
  certifyOpportunityV1({
    profile: PROFILE,
    tokenAddress: TOKEN,
    roundTrip: roundTrip(overrides),
    candidatesTotal: 6,
    candidatesAnswered: answered,
  });

describe('nothing in this path can sign, broadcast or take client calldata', () => {
  test('there is no key, signer or send anywhere in the module', () => {
    for (const source of SOURCES_V1.map((file) => readFileSync(file, 'utf8'))) {
      for (const forbidden of [
        'privateKey',
        'PRIVATE_KEY',
        'signTransaction',
        'sendRawTransaction',
        'eth_sendTransaction',
        'wallet_sendCalls',
        'stateOverride',
        'stateDiff',
      ]) {
        assert.ok(!source.includes(forbidden), `must not reference ${forbidden}`);
      }
    }
  });

  test('the blueprint takes routes and a wallet, never calldata', () => {
    const source = readFileSync(SOURCES_V1[1]!, 'utf8');
    // If a caller could hand in `data`, the simulation would be proving
    // something about bytes the server never derived.
    assert.ok(!/\bdata\s*:\s*input\./.test(source));
    assert.match(source, /encodeSwapExactTokensForTokensV1/);
    assert.match(source, /encodeExactApproveV1/);
  });

  test('the recipient is always the authenticated wallet', () => {
    const source = readFileSync(SOURCES_V1[1]!, 'utf8');
    assert.match(source, /There is no other allowed value/);
  });
});

describe('the blueprint is four calls in one order', () => {
  const legs = {
    entry: { route: entryRoute, amountInAtomic: '100000000', quotedOutAtomic: '4200000000000000000000' },
    exit: { route: exitRoute, amountInAtomic: '4200000000000000000000', quotedOutAtomic: '99000000' },
  };

  test('approve, enter, approve, exit', () => {
    const calls = opportunityBlueprintCallsV1({
      wallet: WALLET,
      tokenAddress: TOKEN,
      profile: PROFILE,
      entry: legs.entry,
      exit: legs.exit,
      deadlineSeconds: 1_800_000_000n,
    });
    assert.equal(calls.length, 4);
    assert.deepEqual(
      calls.map((call) => call.callType),
      ['approval', 'swap', 'approval', 'swap'],
    );
    // The approvals are for the exact input amounts, to the pinned Router.
    assert.equal(calls[0]!.to, USDC);
    assert.equal(calls[0]!.amountAtomic, '100000000');
    assert.equal(calls[2]!.to, TOKEN);
    assert.equal(calls[2]!.amountAtomic, '4200000000000000000000');
  });

  test('the entry probe is two calls, because the exit amount is not known yet', () => {
    const calls = opportunityBlueprintCallsV1({
      wallet: WALLET,
      tokenAddress: TOKEN,
      profile: PROFILE,
      entry: legs.entry,
      deadlineSeconds: 1_800_000_000n,
    });
    assert.equal(calls.length, 2);
  });

  test('an entry that does not spend the profile position is refused', () => {
    assert.throws(
      () =>
        opportunityBlueprintCallsV1({
          wallet: WALLET,
          tokenAddress: TOKEN,
          profile: PROFILE,
          entry: { ...legs.entry, amountInAtomic: '99000000' },
          deadlineSeconds: 1_800_000_000n,
        }),
      OpportunityBlueprintError,
    );
  });
});

describe('only a sequential simulation may certify', () => {
  test('a clean round trip under tolerance qualifies', () => {
    const result = certify();
    assert.deepEqual(result.outcome, { viability: 'qualified' });
    assert.equal(result.simulatedRoundTripBps, 100);
    assert.equal(result.simulationBlockNumber, '49450001');
  });

  test('a simulated round trip over the user’s own limit is a sound rejection', () => {
    const result = certifyOpportunityV1({
      profile: { ...PROFILE, maxRoundTripBps: 50 },
      tokenAddress: TOKEN,
      roundTrip: roundTrip(),
      candidatesTotal: 6,
      candidatesAnswered: 6,
    });
    assert.deepEqual(result.outcome, {
      viability: 'rejected',
      reason: 'simulated_round_trip_above_tolerance',
    });
    // The measurement is still reported: a user is owed the number that
    // rejected them.
    assert.equal(result.simulatedRoundTripBps, 100);
  });

  test('a revert is a rejection about the transaction, not missing evidence', () => {
    const result = certify({
      calls: [
        { index: 0, status: 'success' as const },
        { index: 1, status: 'success' as const },
        { index: 2, status: 'success' as const },
        { index: 3, status: 'reverted' as const },
      ],
    });
    assert.deepEqual(result.outcome, { viability: 'rejected', reason: 'simulation_reverted' });
  });

  test('an exit that sold something other than the entry’s output certifies nothing', () => {
    const result = certify({
      assetChanges: [
        { token: USDC, direction: 'out', amountAtomic: '100000000', callIndex: 1 },
        { token: TOKEN, direction: 'in', amountAtomic: '4200000000000000000000', callIndex: 1 },
        { token: TOKEN, direction: 'out', amountAtomic: '4100000000000000000000', callIndex: 3 },
        { token: USDC, direction: 'in', amountAtomic: '99000000', callIndex: 3 },
      ],
    });
    assert.deepEqual(result.outcome, { viability: 'unmeasured', reason: 'simulation_undecodable' });
  });
});

describe('an operational failure is never a finding about the token', () => {
  test('a wallet without the probe balance is unmeasured, and says so', () => {
    const result = certify({ ok: false, errorCode: 'provider_insufficient_funds' });
    assert.deepEqual(result.outcome, {
      viability: 'unmeasured',
      reason: 'insufficient_probe_balance',
    });
  });

  test('a silent provider is unmeasured, not "no route"', () => {
    assert.equal(unmeasuredFromSimulationV1('provider_timeout'), 'simulation_unavailable');
    assert.equal(unmeasuredFromSimulationV1('provider_rate_limited'), 'simulation_unavailable');
    assert.equal(unmeasuredFromSimulationV1(undefined), 'simulation_unavailable');
  });

  test('a schema mismatch is undecodable evidence, not a bad token', () => {
    assert.equal(unmeasuredFromSimulationV1('provider_invalid_schema'), 'simulation_undecodable');
    assert.equal(
      unmeasuredFromSimulationV1('provider_call_count_mismatch'),
      'simulation_undecodable',
    );
  });

  test('a reverted entry probe is a rejection; a silent one is not', () => {
    assert.deepEqual(
      entryProbeOutputV1(TOKEN, {
        ok: true,
        calls: [
          { index: 0, status: 'success' },
          { index: 1, status: 'reverted' },
        ],
        assetChangesAvailable: true,
        assetChanges: [],
      }),
      { status: 'rejected', reason: 'simulation_reverted' },
    );
    assert.deepEqual(
      entryProbeOutputV1(TOKEN, { ok: false, errorCode: 'provider_timeout' }),
      { status: 'unmeasured', reason: 'simulation_unavailable' },
    );
  });
});

describe('viability and best-route coverage stay separate', () => {
  test('a proven route with silent alternatives is viable, not best', () => {
    const result = certify({}, 4);
    assert.equal(result.outcome.viability, 'qualified');
    assert.equal(result.coverage.viableRouteConfirmed, true);
    assert.equal(result.coverage.bestRouteConfirmed, false);
    assert.equal(result.coverage.coverage, 'partial');
  });

  test('nothing proven plus a degraded search confirms nothing', () => {
    const result = certify({ ok: false, errorCode: 'provider_timeout' }, 4);
    assert.equal(result.outcome.viability, 'unmeasured');
    assert.equal(result.coverage.viableRouteConfirmed, false);
    assert.equal(result.coverage.bestRouteConfirmed, false);
  });
});

describe('a clearance records only what was proven', () => {
  const build = (certified = certify()) =>
    buildClearanceV1({
      id: 'clearance-1',
      tenantId: `eip155:8453:${WALLET}`,
      walletAddress: WALLET,
      tokenAddress: TOKEN,
      profile: PROFILE,
      controlSnapshotHash: `0x${'a'.repeat(64)}`,
      controlBlockNumber: '49450000',
      entryRoute,
      exitRoute,
      calls: opportunityBlueprintCallsV1({
        wallet: WALLET,
        tokenAddress: TOKEN,
        profile: PROFILE,
        entry: { route: entryRoute, amountInAtomic: '100000000', quotedOutAtomic: '4200000000000000000000' },
        exit: { route: exitRoute, amountInAtomic: '4200000000000000000000', quotedOutAtomic: '99000000' },
        deadlineSeconds: 1_800_000_000n,
      }),
      simulationEvidenceHash: `0x${'e'.repeat(64)}`,
      certified,
      now: NOW,
    });

  test('it carries the exact profile that was evaluated', () => {
    const clearance = build();
    assert.equal(clearance.positionAtomic, '100000000');
    assert.equal(clearance.profileIdentity, `${USDC}:100000000:300:300`);
  });

  test('it expires, and the expiry is in the record', () => {
    const clearance = build();
    assert.ok(Date.parse(clearance.expiresAt) > Date.parse(clearance.createdAt));
  });

  test('anything but qualified refuses to become a clearance', () => {
    assert.throws(() => build(certify({ ok: false, errorCode: 'provider_timeout' })));
  });

  test('a different route is a different hash, so a re-route cannot reuse it', () => {
    assert.notEqual(routeHashV1(entryRoute), routeHashV1(exitRoute));
    assert.notEqual(
      routeHashV1(entryRoute),
      routeHashV1([{ from: USDC, to: TOKEN, stable: true, factory: FACTORY }]),
    );
  });

  test('the calls are hashed, never carried', () => {
    const serialised = JSON.stringify(build());
    assert.ok(!/0xa9059cbb|0x095ea7b3/.test(serialised), 'no calldata in a clearance');
    assert.equal(/https?:\/\//.test(serialised), false);
  });
});
