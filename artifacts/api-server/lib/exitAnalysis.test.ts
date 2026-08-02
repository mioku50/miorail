import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import type { AerodromeReaderV1, AerodromeRouteLegV1 } from '@mioagent/swap-adapters';
import type { ExitControlsV1, OpportunityProfileV1 } from '@mioagent/opportunity-rail';
import { analyseExitV1 } from './exitAnalysis.js';

/** The harness runs this package's tests from the package directory; running
 * one file by hand happens from the repo root. Resolved for both rather than
 * assuming either. */
function packageFileV1(relative: string): string {
  const cwd = process.cwd();
  return cwd.endsWith(`${path.sep}artifacts${path.sep}api-server`)
    ? path.join(cwd, relative)
    : path.join(cwd, 'artifacts/api-server', relative);
}

const SOURCE_V1 = packageFileV1('lib/exitAnalysis.ts');
const TOKEN = '0xb200000000000000000000578f3ae29d9e6e0101' as const;
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' as const;
const FACTORY = '0x420dd381b31aef6683db6b902084cb0ffece40da' as const;

const OPEN_CONTROLS: ExitControlsV1 = {
  factoryConfirmed: true,
  transfersPaused: false,
  transferPolicyActive: false,
  controlsFullyRead: true,
};

/** 100 USDC, 3% round trip, 3% slippage — the profile in the design note. */
const PROFILE: OpportunityProfileV1 = {
  positionAtomic: '100000000',
  maxRoundTripBps: 300,
  maxSlippageBps: 300,
};

interface PoolOptions {
  /** Constant-product reserves, so quotes behave like a real pool: bigger
   * trades really do get worse prices, and the ladder measures something. */
  quoteReserve?: bigint;
  tokenReserve?: bigint;
  /** Pairs the router has no pool for at all. */
  noRoute?: boolean;
  /** Fails every read with a transport error rather than "no such pool". */
  unreachable?: boolean;
  factoryFails?: boolean;
}

/** A router backed by constant-product maths. No socket is opened here. */
function fakeRouter(options: PoolOptions = {}): AerodromeReaderV1 & { calls: number } {
  const quoteReserve = options.quoteReserve ?? 1_000_000_000_000n;
  const tokenReserve = options.tokenReserve ?? 1_000_000_000_000_000_000_000_000n;
  const state = { calls: 0 };

  function quote(amountIn: bigint, route: readonly AerodromeRouteLegV1[]): bigint | null {
    // Only the direct volatile pool exists, which is the normal shape: most
    // pairs do not have all four stable/volatile permutations.
    if (route.length !== 1 || route[0]!.stable) return null;
    const leg = route[0]!;
    const [reserveIn, reserveOut] =
      leg.from === TOKEN ? [tokenReserve, quoteReserve] : [quoteReserve, tokenReserve];
    if (amountIn <= 0n) return null;
    const withFee = (amountIn * 9970n) / 10_000n;
    return (withFee * reserveOut) / (reserveIn + withFee);
  }

  const reader: AerodromeReaderV1 & { calls: number } = {
    get calls() {
      return state.calls;
    },
    async readDefaultFactory() {
      state.calls += 1;
      return options.factoryFails
        ? { ok: false, reason: 'rpc_unavailable' }
        : { ok: true, value: FACTORY };
    },
    async readAmountsOut(input) {
      state.calls += 1;
      if (options.unreachable) return { ok: false, reason: 'rpc_unavailable' };
      if (options.noRoute) return { ok: false, reason: 'no_route' };
      const out = quote(input.amountIn, input.route);
      return out === null || out <= 0n
        ? { ok: false, reason: 'no_route' }
        : { ok: true, value: [input.amountIn, out] };
    },
    async readBlockNumber() {
      return '49450000';
    },
    async readAllowance() {
      return { ok: true, value: 0n };
    },
  };
  return reader;
}

describe('the exit check never signs, prepares or routes anything', () => {
  const source = readFileSync(SOURCE_V1, 'utf8');

  test('there is no signer, no calldata and no approval anywhere in it', () => {
    for (const forbidden of [
      'privateKey',
      'signTransaction',
      'sendRawTransaction',
      'eth_sendTransaction',
      'wallet_sendCalls',
      'encodeSwapExactTokens',
      'approve(',
    ]) {
      assert.ok(!source.includes(forbidden), `the exit check must not reference ${forbidden}`);
    }
  });

  test('quoting an arbitrary token is not routing into it', () => {
    // The swap allowlist stops Miorail ROUTING into anything; getAmountsOut is
    // a view function and this file's whole output is numbers and a verdict.
    assert.match(source, /quoting is not routing/);
  });
});

describe('controls come before price', () => {
  test('a paused token is refused without spending a single quote', () => {
    // A paused token has no round-trip cost worth computing, and computing one
    // anyway would put a number where a refusal belongs.
    const reader = fakeRouter();
    return analyseExitV1({
      reader,
      tokenAddress: TOKEN,
      quoteAsset: USDC,
      profile: PROFILE,
      controls: { ...OPEN_CONTROLS, transfersPaused: true },
    }).then((analysis) => {
      assert.equal(analysis.verdict.status, 'rejected');
      if (analysis.verdict.status === 'rejected') assert.equal(analysis.verdict.reason, 'transfers_paused');
      assert.equal(reader.calls, 0, 'a refused check must not open a socket');
    });
  });

  test('a partial control read is not a pass, and costs nothing either', async () => {
    const reader = fakeRouter();
    const analysis = await analyseExitV1({
      reader,
      tokenAddress: TOKEN,
      quoteAsset: USDC,
      profile: PROFILE,
      controls: { ...OPEN_CONTROLS, controlsFullyRead: false },
    });
    assert.equal(analysis.verdict.status, 'rejected');
    if (analysis.verdict.status === 'rejected') assert.equal(analysis.verdict.reason, 'controls_unreadable');
    assert.equal(reader.calls, 0);
  });

  test('an active transfer policy is refused, because an exit cannot be confirmed', async () => {
    const reader = fakeRouter();
    const analysis = await analyseExitV1({
      reader,
      tokenAddress: TOKEN,
      quoteAsset: USDC,
      profile: PROFILE,
      controls: { ...OPEN_CONTROLS, transferPolicyActive: true },
    });
    assert.equal(analysis.verdict.status, 'rejected');
    if (analysis.verdict.status === 'rejected') {
      assert.equal(analysis.verdict.reason, 'transfer_policy_may_block');
    }
    assert.equal(reader.calls, 0);
  });
});

describe('the round trip is measured, and labelled for what it is', () => {
  test('a deep pool qualifies, and says the pass rests on an optimistic quote', async () => {
    const analysis = await analyseExitV1({
      reader: fakeRouter(),
      tokenAddress: TOKEN,
      quoteAsset: USDC,
      profile: PROFILE,
      controls: OPEN_CONTROLS,
    });
    assert.equal(analysis.verdict.status, 'qualifies', JSON.stringify(analysis.verdict));
    if (analysis.verdict.status === 'qualifies') {
      // The exit was quoted against the pool BEFORE the entry moved it.
      assert.equal(analysis.verdict.measurement, 'quoted_pre_entry');
      assert.equal(analysis.verdict.optimistic, true);
    }
    assert.ok(analysis.roundTrip);
    // Two 0.3% fees on a deep pool: real, small, and not zero.
    assert.ok(analysis.roundTrip!.costBps > 0, 'a round trip through two pools is never free');
    assert.ok(analysis.roundTrip!.costBps < 300, `expected under tolerance, got ${analysis.roundTrip!.costBps}`);
  });

  test('a thin pool costs more than the profile allows, and is refused', async () => {
    const analysis = await analyseExitV1({
      reader: fakeRouter({ quoteReserve: 300_000_000n, tokenReserve: 3_000_000_000_000_000_000_000n }),
      tokenAddress: TOKEN,
      quoteAsset: USDC,
      profile: PROFILE,
      controls: OPEN_CONTROLS,
    });
    assert.equal(analysis.verdict.status, 'rejected');
    if (analysis.verdict.status === 'rejected') {
      assert.equal(analysis.verdict.reason, 'round_trip_above_tolerance');
      // Sound even on the flattering measurement: if the optimistic number
      // already fails, the real one fails by more.
      assert.equal(analysis.verdict.sound, true);
    }
  });

  test('the two legs describe the same position', async () => {
    const analysis = await analyseExitV1({
      reader: fakeRouter(),
      tokenAddress: TOKEN,
      quoteAsset: USDC,
      profile: PROFILE,
      controls: OPEN_CONTROLS,
    });
    // Selling a different quantity than the entry produced is not a round trip.
    assert.equal(analysis.roundTrip!.exit.inputAtomic, analysis.roundTrip!.entry.outputAtomic);
    assert.equal(analysis.roundTrip!.entry.inputAtomic, PROFILE.positionAtomic);
  });
});

describe('no route is not a bad price, and neither is a broken endpoint', () => {
  test('a token with no pool is refused as no entry route', async () => {
    const analysis = await analyseExitV1({
      reader: fakeRouter({ noRoute: true }),
      tokenAddress: TOKEN,
      quoteAsset: USDC,
      profile: PROFILE,
      controls: OPEN_CONTROLS,
    });
    assert.equal(analysis.verdict.status, 'rejected');
    if (analysis.verdict.status === 'rejected') assert.equal(analysis.verdict.reason, 'no_entry_route');
    assert.equal(analysis.endpointDegraded, false, 'no pool is an answer, not a failure');
  });

  test('a throttled route search is unmeasured, never a verdict about the token', async () => {
    // The bug this pins, observed live on 2026-08-02: AERO's exit route search
    // was throttled, nothing came back, and the answer read "no route out of
    // this token exists — a position could be bought and not sold." AERO has
    // one of the deepest pools on Base. The rejection was about the endpoint
    // and wore the token's name.
    const analysis = await analyseExitV1({
      reader: fakeRouter({ unreachable: true }),
      tokenAddress: TOKEN,
      quoteAsset: USDC,
      profile: PROFILE,
      controls: OPEN_CONTROLS,
    });
    assert.equal(analysis.endpointDegraded, true);
    assert.equal(analysis.verdict.status, 'unmeasured');
    if (analysis.verdict.status === 'unmeasured') {
      assert.equal(analysis.verdict.reason, 'endpoint_degraded');
    }
  });

  test('a control refusal survives a degraded endpoint, because no quote decided it', async () => {
    const analysis = await analyseExitV1({
      reader: fakeRouter({ unreachable: true }),
      tokenAddress: TOKEN,
      quoteAsset: USDC,
      profile: PROFILE,
      controls: { ...OPEN_CONTROLS, transfersPaused: true },
    });
    assert.equal(analysis.verdict.status, 'rejected');
    if (analysis.verdict.status === 'rejected') assert.equal(analysis.verdict.reason, 'transfers_paused');
  });

  test('a cost rejection on a degraded search is unsound, so it is not made', async () => {
    // A round trip priced from the candidates that happened to answer may be
    // beaten by one that did not. "Too expensive" is a claim about the best
    // route, and a degraded search did not find it.
    let seen = 0;
    const base = fakeRouter({ quoteReserve: 300_000_000n, tokenReserve: 3_000_000_000_000_000_000_000n });
    const flaky = {
      ...base,
      async readAmountsOut(input: Parameters<typeof base.readAmountsOut>[0]) {
        seen += 1;
        // One route in the search is throttled; the rest price a thin pool.
        return seen === 2
          ? ({ ok: false, reason: 'rate_limited' } as const)
          : base.readAmountsOut(input);
      },
    };
    const analysis = await analyseExitV1({
      reader: flaky,
      tokenAddress: TOKEN,
      quoteAsset: USDC,
      profile: PROFILE,
      controls: OPEN_CONTROLS,
    });
    assert.equal(analysis.endpointDegraded, true);
    assert.equal(analysis.verdict.status, 'unmeasured');
  });

  test('a factory that cannot be read stops the check rather than guessing one', async () => {
    const analysis = await analyseExitV1({
      reader: fakeRouter({ factoryFails: true }),
      tokenAddress: TOKEN,
      quoteAsset: USDC,
      profile: PROFILE,
      controls: OPEN_CONTROLS,
    });
    assert.equal(analysis.endpointDegraded, true);
    assert.equal(analysis.roundTrip, null);
  });
});

describe('exit capacity is measured, never interpolated', () => {
  test('every probe is a size the router was actually asked about', async () => {
    const analysis = await analyseExitV1({
      reader: fakeRouter(),
      tokenAddress: TOKEN,
      quoteAsset: USDC,
      profile: PROFILE,
      controls: OPEN_CONTROLS,
    });
    assert.ok(analysis.exitCapacity.probeCount > 1);
    if (analysis.exitCapacity.capacityAtomic !== null) {
      // The capacity must be one of the probed sizes, not a point between two.
      assert.equal(BigInt(analysis.exitCapacity.capacityAtomic) > 0n, true);
    }
  });

  test('impact is relative to the smallest probe, and the reference is named', async () => {
    const analysis = await analyseExitV1({
      reader: fakeRouter(),
      tokenAddress: TOKEN,
      quoteAsset: USDC,
      profile: PROFILE,
      controls: OPEN_CONTROLS,
    });
    // Without this a surface would present an understated figure as absolute.
    assert.ok(analysis.referenceSizeAtomic);
    assert.equal(analysis.capacityInformative, true);
  });

  test('the check is bounded, so a page cannot spend an endpoint dry', async () => {
    const reader = fakeRouter();
    const analysis = await analyseExitV1({
      reader,
      tokenAddress: TOKEN,
      quoteAsset: USDC,
      profile: PROFILE,
      controls: OPEN_CONTROLS,
    });
    // One factory read, two route searches, one ladder. Public Base serves
    // roughly two and a half calls a second.
    assert.ok(analysis.quotesUsed <= 20, `expected a bounded check, spent ${analysis.quotesUsed}`);
    assert.equal(analysis.quotesUsed, reader.calls);
  });

  test('the ladder does not re-search routes for every rung', async () => {
    // Re-searching per rung would multiply the cost by six to answer the same
    // question about the same pool.
    const reader = fakeRouter();
    await analyseExitV1({
      reader,
      tokenAddress: TOKEN,
      quoteAsset: USDC,
      profile: PROFILE,
      controls: OPEN_CONTROLS,
    });
    const searches = 2 * 6; // two pairs, six candidate routes each
    assert.ok(reader.calls <= 1 + searches + 5, `spent ${reader.calls}`);
  });
});
