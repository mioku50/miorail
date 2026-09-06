import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CONSOLE_STAGES_V1,
  activeStageStepV1,
  adaptersFromStatusV1,
  chainLabelV1,
  completeStageV1,
  commerceCheckoutAvailableV1,
  comparingProgressV1,
  comparingTransportFailureV1,
  coverageFromStatusV1,
  deriveStageTimingsV1,
  dispatchRouteFamilyV1,
  emptyStageClockV1,
  formatStageDurationV1,
  haltStageRailV1,
  providerConstrainedGoalV1,
  providerConstraintResolutionV1,
  routeFamilyForGoalV1,
  stageDurationMsV1,
  startStageV1,
  swapPrepareNoticeV1,
  swapPrepareRequestFailedNoticeV1,
  swapTerminalFailureV1,
  stepperFromClockV1,
} from '../src/console/consoleFlow';

// ---------------------------------------------------------------------------
// T63D — the flow's mechanics. A timing is a measured interval or it is not a
// timing; a family is dispatched to its own engine; coverage comes from the
// server's flags, never from a front-end constant.
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));

describe('stage timings are measured, never asserted', () => {
  test('a completed stage reports its real duration', () => {
    let clock = emptyStageClockV1();
    clock = startStageV1(clock, 'intent', 1_000);
    clock = completeStageV1(clock, 'intent', 1_200);
    assert.equal(stageDurationMsV1(clock, 'intent'), 200);
    assert.equal(deriveStageTimingsV1(clock)[0], '0.2s');

    clock = startStageV1(clock, 'candidates', 1_200);
    clock = completeStageV1(clock, 'candidates', 2_600);
    assert.equal(deriveStageTimingsV1(clock)[1], '1.4s');
  });

  test('a running stage says waiting and an untouched stage says em dash', () => {
    let clock = emptyStageClockV1();
    clock = startStageV1(clock, 'intent', 0);
    clock = completeStageV1(clock, 'intent', 100);
    clock = startStageV1(clock, 'candidates', 100);
    const timings = deriveStageTimingsV1(clock);
    assert.equal(timings[0], '0.1s');
    assert.equal(timings[1], 'waiting');
    assert.equal(timings[2], '—');
    assert.equal(timings.length, CONSOLE_STAGES_V1.length);
  });

  test('no state word can reach the timing column', () => {
    let clock = emptyStageClockV1();
    for (const [index, stage] of CONSOLE_STAGES_V1.entries()) {
      clock = startStageV1(clock, stage, index * 1_000);
      clock = completeStageV1(clock, stage, index * 1_000 + 500);
    }
    for (const timing of deriveStageTimingsV1(clock)) {
      assert.equal(/parsed|quoted|ready|scored|sources/.test(timing), false, `state word in timing: ${timing}`);
      assert.match(timing, /^(\d+\.\d s?|\d+\.\ds|\d+m \d+s|waiting|—)$/);
    }
  });

  test('marks are idempotent — a re-render cannot stretch a measured window', () => {
    let clock = emptyStageClockV1();
    clock = startStageV1(clock, 'intent', 1_000);
    clock = startStageV1(clock, 'intent', 5_000);
    clock = completeStageV1(clock, 'intent', 1_400);
    clock = completeStageV1(clock, 'intent', 9_000);
    assert.equal(stageDurationMsV1(clock, 'intent'), 400);
  });

  test('a completion without a start stays unmeasured rather than back-dated', () => {
    const clock = completeStageV1(emptyStageClockV1(), 'simulation', 5_000);
    assert.equal(stageDurationMsV1(clock, 'simulation'), null);
    assert.equal(deriveStageTimingsV1(clock)[3], '—');
  });

  test('durations format sub-second, seconds and minutes', () => {
    assert.equal(formatStageDurationV1(200), '0.2s');
    assert.equal(formatStageDurationV1(1_400), '1.4s');
    assert.equal(formatStageDurationV1(65_000), '1m 5s');
  });

  test('the rail position is derived from the clock, so it cannot disagree', () => {
    let clock = emptyStageClockV1();
    assert.equal(activeStageStepV1(clock), 0);
    clock = startStageV1(clock, 'intent', 0);
    clock = completeStageV1(clock, 'intent', 100);
    clock = startStageV1(clock, 'candidates', 100);
    assert.equal(activeStageStepV1(clock), 2);

    const steps = stepperFromClockV1(clock);
    assert.equal(steps.length, 8);
    assert.deepEqual(steps.map((step) => step.state).slice(0, 3), ['done', 'now', 'todo']);
    assert.equal(steps[1].timing, 'waiting');
  });
});

describe('route family dispatch', () => {
  test('recognises swap, earn and commerce goals in both languages', () => {
    assert.equal(routeFamilyForGoalV1('Swap 100 USDC to ETH'), 'swap');
    assert.equal(routeFamilyForGoalV1('Обменять 100 USDC на ETH'), 'swap');
    assert.equal(routeFamilyForGoalV1('Earn yield on 500 USDC'), 'earn');
    assert.equal(routeFamilyForGoalV1('Разместить 500 USDC под доходность'), 'earn');
    assert.equal(routeFamilyForGoalV1('Deposit 250 USDC into Moonwell'), 'earn');
    assert.equal(routeFamilyForGoalV1('Show YO Protocol vaults on Base'), 'earn');
    assert.equal(routeFamilyForGoalV1('Buy a gift card'), 'commerce');
    assert.equal(routeFamilyForGoalV1('Find a 25 USD Amazon US gift card on Bitrefill'), 'commerce');
    assert.equal(routeFamilyForGoalV1(''), 'unknown');
  });

  test('a token buy is a swap even when it uses the same verb as commerce', () => {
    for (const goal of [
      'Buy this Flaunch token with 0.001 ETH',
      'Buy BRETT with 50 USDC',
      'Buy DEGEN with ETH',
      'Купить BRETT за 50 USDC',
    ]) {
      assert.equal(routeFamilyForGoalV1(goal), 'swap', goal);
    }
  });

  test('an earn goal never reaches the swap engine', () => {
    const flags = { routeIntelligenceV1: true, earnRouteV1: true };
    assert.equal(dispatchRouteFamilyV1('Earn yield on 500 USDC', flags).engine, 'earn');
    assert.equal(dispatchRouteFamilyV1('Swap 100 USDC to ETH', flags).engine, 'swap');
    // Mixed wording resolves to earn — the earn engine owns its own swap leg.
    assert.equal(dispatchRouteFamilyV1('Swap USDC into a yield position', flags).engine, 'earn');
  });

  test('Earn is NOT called ready while its gate is off — and swaps still work', () => {
    const flags = { routeIntelligenceV1: true, earnRouteV1: false };
    const earn = dispatchRouteFamilyV1('Earn yield on 500 USDC', flags);
    assert.equal(earn.engine, null);
    assert.match(String(earn.blockedReason), /Earn routing is off/);
    assert.match(String(earn.blockedReason), /Swap routes still compare normally/);
    assert.equal(dispatchRouteFamilyV1('Swap 100 USDC to ETH', flags).engine, 'swap');
  });

  test('liquidity-provider goals get an explicit Routes gap instead of an empty run', () => {
    const flags = { routeIntelligenceV1: true, earnRouteV1: true };
    const hydrex = dispatchRouteFamilyV1('Show my Hydrex liquidity positions', flags);
    assert.equal(hydrex.engine, null);
    assert.match(hydrex.blockedReason || '', /Liquidity Routes family/);
    const balancer = dispatchRouteFamilyV1('Add 100 USDC liquidity on Balancer', flags);
    assert.equal(balancer.engine, null);
    assert.match(balancer.blockedReason || '', /Safety Kernel and proof gates/);
  });

  test('with route intelligence off nothing runs, and the reason names the gate', () => {
    const dispatch = dispatchRouteFamilyV1('Swap 100 USDC to ETH', { routeIntelligenceV1: false, earnRouteV1: true });
    assert.equal(dispatch.engine, null);
    assert.match(String(dispatch.blockedReason), /Route intelligence is off/);
  });

  test('commerce is NOT called ready while its gate is off', () => {
    const dispatch = dispatchRouteFamilyV1('Buy a gift card', { routeIntelligenceV1: true, earnRouteV1: true });
    assert.equal(dispatch.engine, null);
    assert.match(String(dispatch.blockedReason), /Commerce routing is off/);
  });

  test('a commerce goal reaches the commerce engine once its gate is on', () => {
    const flags = { routeIntelligenceV1: true, earnRouteV1: true, commerceRouteV1: true };
    assert.equal(dispatchRouteFamilyV1('Buy a Steam gift card for $25', flags).engine, 'commerce');
    // Comparing is not buying: the checkout gate is separate and stays off.
    const checkout = commerceCheckoutAvailableV1(flags);
    assert.equal(checkout.available, false);
    assert.match(String(checkout.reason), /Checkout is off/);
    assert.equal(
      commerceCheckoutAvailableV1({ ...flags, commerceExecutionV1: true }).available,
      true,
    );
  });
});

describe('coverage and adapters come from the server, not the front end', () => {
  const allOn = {
    productMigration: { routeIntelligenceV1: true, paidIntelligence: true, earnRouteV1: true },
  };
  const allOff = {
    productMigration: { routeIntelligenceV1: false, paidIntelligence: false, earnRouteV1: false },
  };

  test('every capability follows its own gate', () => {
    const on = coverageFromStatusV1(allOn);
    assert.equal(on.find((row) => row.action === 'Swap on Base')?.state, 'ready');
    assert.equal(on.find((row) => row.action.startsWith('Earn'))?.state, 'ready');
    assert.equal(on.find((row) => row.action === 'Transaction simulation')?.state, 'ready');

    const off = coverageFromStatusV1(allOff);
    for (const row of off) {
      assert.equal(row.state, 'off', `${row.action} must be off when its gate is off`);
      assert.equal(row.percent, 0);
      assert.equal(row.available, false);
    }
    // …and the row explains which switch is off rather than disappearing.
    assert.match(String(off.find((row) => row.action.startsWith('Earn'))?.sources), /earn gate is off/);
  });

  test('capabilities with no adapter stay off regardless of the flags', () => {
    for (const row of coverageFromStatusV1(allOn)) {
      if (row.action === 'MEV-protected swap' || row.action.includes('bridge')) {
        assert.equal(row.state, 'off');
        assert.match(row.sources, /no approved/);
      }
    }
  });

  test('commerce coverage distinguishes comparing from buying', () => {
    const compareOnly = coverageFromStatusV1({
      productMigration: { routeIntelligenceV1: true, paidIntelligence: false, earnRouteV1: false, commerceRouteV1: true },
    });
    const row = compareOnly.find((entry) => entry.action.startsWith('Commerce'));
    assert.equal(row?.state, 'building');
    assert.match(String(row?.sources), /compare only/);

    const full = coverageFromStatusV1({
      productMigration: {
        routeIntelligenceV1: true,
        paidIntelligence: false,
        earnRouteV1: false,
        commerceRouteV1: true,
        commerceExecutionV1: true,
      },
    });
    assert.equal(full.find((entry) => entry.action.startsWith('Commerce'))?.state, 'ready');
  });

  test('adapters reflect the gates before a run, and the real answers after one', () => {
    const before = adaptersFromStatusV1(allOff);
    assert.equal(before.every((row) => row.state !== 'live'), true, 'nothing is live while the gates are off');
    // T64.3.1: a gate that is off is DISABLED. Reporting it as "not connected"
    // sent an operator looking for a broken RPC that was never broken.
    assert.equal(before.find((row) => row.name === 'Moonwell')?.state, 'disabled');
    assert.equal(before.find((row) => row.name === 'Morpho')?.state, 'disabled');
    assert.equal(before.find((row) => row.name === 'YO')?.state, 'disabled');

    const during = adaptersFromStatusV1(allOn);
    assert.equal(during.find((row) => row.name === 'Uniswap')?.state, 'live');
    assert.equal(during.find((row) => row.name === 'Balancer')?.state, 'live');
    assert.equal(during.find((row) => row.name === 'Hydrex')?.state, 'live');
    assert.equal(during.find((row) => row.name === 'o1.exchange')?.state, 'live');
    assert.equal(during.find((row) => row.name === 'YO')?.state, 'live');

    // T67E §5: a run REFINES the rail, it does not replace it. This used to
    // assert the replacement — `after` was exactly two rows — which meant that
    // during a swap comparison Moonwell, Morpho, Bitrefill, OpenSea, Venice and
    // o1.exchange vanished from a panel titled "Route adapters". The rail
    // stopped being a source of truth precisely when it was being consulted.
    const after = adaptersFromStatusV1(allOn, [{ name: 'KyberSwap' }], [{ name: 'Uniswap' }]);
    assert.equal(after.find((row) => row.name === 'KyberSwap')?.state, 'live');
    // Asked on this run and it failed: `degraded`, which says it is switched on
    // and currently failing. `disabled` is a switch and must never wear it.
    assert.equal(after.find((row) => row.name === 'Uniswap')?.state, 'degraded');
    // Everything else keeps the state its gate gives it.
    assert.equal(after.find((row) => row.name === 'Moonwell')?.state, 'live');
    assert.equal(after.find((row) => row.name === 'Balancer')?.state, 'live');
    assert.equal(after.find((row) => row.name === 'Hydrex')?.state, 'live');
    assert.equal(after.find((row) => row.name === 'o1.exchange')?.state, 'live');
    assert.equal(after.find((row) => row.name === 'YO')?.state, 'live');
    assert.equal(after.length, before.length, 'a run must not shorten the rail');
  });

  test('the chain label comes from the reported chain id', () => {
    assert.equal(chainLabelV1(8453), 'Base mainnet · 8453');
    assert.equal(chainLabelV1(84532), 'Base Sepolia · 84532');
    assert.equal(chainLabelV1(undefined), 'chain unknown');
  });
});

// --- T64.3.1 — Comparing shows one family and always ends -------------------

describe('Comparing is route-family aware and terminal', () => {
  const ALL_ADAPTERS = [
    { name: 'Uniswap', label: 'live', live: true, usable: true },
    { name: 'KyberSwap', label: 'live', live: true, usable: true },
    { name: 'Aerodrome', label: 'live', live: true, usable: true },
    { name: 'Balancer', label: 'live', live: true, usable: true },
    { name: 'Hydrex', label: 'live', live: true, usable: true },
    { name: 'Moonwell', label: 'disabled', live: false, usable: false },
    { name: 'Morpho', label: 'disabled', live: false, usable: false },
    { name: 'YO', label: 'disabled', live: false, usable: false },
    { name: 'Alchemy simulation', label: 'live', live: true, usable: true },
    { name: 'Bitrefill', label: 'live', live: true, usable: true },
    { name: 'o1.exchange', label: 'live', live: true, usable: true },
  ];

  test('a commerce comparison lists only the commerce sources', () => {
    const rows = comparingProgressV1({
      family: 'commerce',
      adapters: ALL_ADAPTERS,
      answered: [],
      terminalReason: null,
      evidenceCount: null,
      scored: false,
    });
    assert.deepEqual(rows.map((row) => row.label), [
      'Intent extraction',
      'Bitrefill catalogue',
      'Commerce evidence',
      'Commerce scoring',
    ]);
    // A row for a source that was never called claims it was part of this
    // comparison. None of these were.
    const text = rows.map((row) => row.label).join(' ');
    for (const absent of ['Uniswap', 'KyberSwap', 'Moonwell', 'Morpho', 'o1.exchange', 'Alchemy']) {
      assert.equal(text.includes(absent), false, `${absent} must not appear in a commerce comparison`);
    }
  });

  test('Alchemy never appears while comparing — simulation runs on Review', () => {
    for (const family of ['swap', 'earn', 'commerce', 'unknown'] as const) {
      const rows = comparingProgressV1({
        family,
        adapters: ALL_ADAPTERS,
        answered: [],
        terminalReason: null,
        evidenceCount: null,
        scored: false,
      });
      assert.equal(rows.some((row) => row.label.includes('Alchemy')), false, family);
    }
  });

  test('a swap comparison lists only the swap adapters', () => {
    const rows = comparingProgressV1({
      family: 'swap',
      adapters: ALL_ADAPTERS,
      answered: ['Uniswap'],
      terminalReason: null,
      evidenceCount: 3,
      scored: true,
    });
    assert.deepEqual(rows.map((row) => row.label), [
      'Intent extraction',
      'Uniswap quote',
      'KyberSwap quote',
      'Aerodrome quote',
      'Balancer quote',
      'Hydrex quote',
      'o1.exchange quote',
      'Evidence collected',
      'Scoring against your goal',
    ]);
    assert.equal(rows.find((row) => row.label === 'Uniswap quote')?.state, 'done');
    assert.equal(rows.find((row) => row.label === 'KyberSwap quote')?.state, 'running');
    assert.equal(rows.find((row) => row.label === 'Hydrex quote')?.state, 'running');
    assert.equal(rows.find((row) => row.label === 'o1.exchange quote')?.state, 'running');
    assert.equal(rows.find((row) => row.label === 'Evidence collected')?.value, '3 sources');
  });

  test('an earn comparison lists YO before a candidate arrives', () => {
    const rows = comparingProgressV1({
      family: 'earn',
      adapters: ALL_ADAPTERS,
      answered: [],
      terminalReason: null,
      evidenceCount: null,
      scored: false,
    });
    assert.deepEqual(rows.map((row) => row.label), [
      'Intent extraction',
      'Moonwell rates',
      'Morpho rates',
      'YO rates',
      'Evidence collected',
      'Scoring against your goal',
    ]);
  });

  test('an explicit candidate click preserves the goal and adds only the provider constraint', () => {
    assert.equal(
      providerConstrainedGoalV1(
        'Swap 12497.607736 0x940181a94A35A4569E4529A3CDfB74e38FD98631 to USDC.',
        'Hydrex',
      ),
      'Swap 12497.607736 0x940181a94A35A4569E4529A3CDfB74e38FD98631 to USDC. Use Hydrex only.',
    );
    assert.equal(
      providerConstrainedGoalV1(
        'Swap 12497.607736 MIO to USDC. Use Hydrex only. Use Hydrex only.',
        'Hydrex',
      ),
      'Swap 12497.607736 MIO to USDC. Use Hydrex only.',
    );
  });

  test('a provider already constrained without a card is blocked instead of offered again', () => {
    assert.deepEqual(
      providerConstraintResolutionV1({
        hasProjection: true,
        routeCardHash: null,
        protocolConstraint: { mode: 'any', protocols: [] },
        providerDisplayName: 'Hydrex',
      }),
      { needsConstraint: true, blockedReason: null },
    );
    const constrained = providerConstraintResolutionV1({
      hasProjection: true,
      routeCardHash: null,
      protocolConstraint: { mode: 'include_only', protocols: ['hydrex'] },
      providerDisplayName: 'Hydrex',
    });
    assert.equal(constrained.needsConstraint, false);
    assert.match(constrained.blockedReason ?? '', /already the only requested provider/);
    assert.match(
      constrained.blockedReason ?? '',
      /choosing Hydrex again cannot change the evidence/,
    );
  });

  test('a terminal reason stops EVERY spinner', () => {
    const rows = comparingProgressV1({
      family: 'commerce',
      adapters: ALL_ADAPTERS,
      answered: [],
      terminalReason: 'Say the card value, for example “$5”.',
      terminalStage: 'market',
      evidenceCount: null,
      scored: false,
    });
    assert.equal(rows.some((row) => row.state === 'running'), false, 'nothing may keep spinning after the run ends');
    assert.equal(rows.some((row) => row.state === 'pending'), false, 'nothing may stay pending after the run ends');
    // Extraction is `done`: the market WAS asked, which means the goal was
    // read. Every stage after it failed.
    assert.equal(rows.find((row) => row.label === 'Intent extraction')?.state, 'done');
    assert.equal(
      rows.filter((row) => row.label !== 'Intent extraction').every((row) => row.state === 'failed'),
      true,
    );
    assert.equal(rows.find((row) => row.label === 'Bitrefill catalogue')?.value, 'not reached');
  });

  // 2026-09-06. Our own language model answered 429 with a ZERO allowance, so
  // no goal was ever read into an intent and no venue was called — and this
  // rail drew every adapter "failed / not reached" with 0 sources, which two
  // readers took to mean the pair could not be routed on Base.
  test('a planner outage never draws the market as asked and empty', () => {
    const rows = comparingProgressV1({
      family: 'swap',
      adapters: [
        { name: 'Uniswap', label: 'live', live: true, usable: true },
        { name: 'KyberSwap', label: 'live', live: true, usable: true },
      ],
      answered: [],
      terminalReason: 'Miorail’s own language model did not answer.',
      terminalStage: 'planner',
      evidenceCount: null,
      scored: false,
    });
    const intent = rows.find((row) => row.label === 'Intent extraction')!;
    assert.equal(intent.state, 'failed', 'the stage that actually failed is ours');
    assert.equal(intent.value, 'planner unavailable');
    for (const label of ['Uniswap quote', 'KyberSwap quote']) {
      const row = rows.find((item) => item.label === label)!;
      assert.equal(row.state, 'skipped', `${label} was never called`);
      assert.equal(row.value, 'not asked');
      assert.notEqual(row.value, 'not reached', 'not reached claims we tried');
    }
    // Nothing may still read as working, and nothing may read as a finding.
    assert.equal(rows.some((row) => row.state === 'running' || row.state === 'pending'), false);
    assert.equal(
      rows.filter((row) => row.state === 'failed').length,
      1,
      'exactly one stage failed, and it was ours',
    );
  });

  // A question we asked and a pair we do not support are extraction WORKING.
  // Marking that stage failed was a second small lie in the same rail.
  test('a question the server asked leaves extraction done and the venues unasked', () => {
    const rows = comparingProgressV1({
      family: 'swap',
      adapters: [{ name: 'Uniswap', label: 'live', live: true, usable: true }],
      answered: [],
      terminalReason: 'What exact amount should be swapped?',
      terminalStage: 'intent',
      evidenceCount: null,
      scored: false,
    });
    const intent = rows.find((row) => row.label === 'Intent extraction')!;
    assert.equal(intent.state, 'done');
    assert.equal(intent.value, 'swap');
    assert.equal(rows.find((row) => row.label === 'Uniswap quote')?.state, 'skipped');
    assert.equal(rows.some((row) => row.state === 'failed'), false, 'nothing failed — we asked a question');
  });

  test('the server’s own fault code becomes a card that names us', () => {
    const ours = comparingTransportFailureV1({
      message:
        'route_planner_unavailable: Miorail’s own language model did not answer, so your goal was never read.',
    })!;
    assert.equal(ours.stage, 'planner');
    assert.equal(ours.title, 'Miorail could not read your goal');
    // The code is an identifier for an operator, not a sentence for a reader.
    assert.doesNotMatch(ours.detail, /route_planner_unavailable/);
    assert.match(ours.detail, /language model did not answer/);

    const unknown = comparingTransportFailureV1({ message: 'API error: 502 Bad Gateway' })!;
    assert.equal(unknown.stage, 'intent', 'an unclassified failure claims nothing about the venues');
    assert.match(unknown.detail, /Nothing was signed or spent\./);
    assert.equal(comparingTransportFailureV1(null), null);
  });

  test('an unstated stage never claims the market answered', () => {
    const rows = comparingProgressV1({
      family: 'swap',
      adapters: [{ name: 'Uniswap', label: 'live', live: true, usable: true }],
      answered: [],
      terminalReason: 'something went wrong',
      evidenceCount: null,
      scored: false,
    });
    assert.equal(rows.find((row) => row.label === 'Uniswap quote')?.value, 'not asked');
  });

  test('a catalogue that answered with no match is never shown as not reached', () => {
    const rows = comparingProgressV1({
      family: 'commerce',
      adapters: ALL_ADAPTERS,
      answered: ['Bitrefill'],
      answeredDetails: { Bitrefill: 'reached / no matching product' },
      terminalReason: 'Product not found',
      evidenceCount: null,
      scored: false,
    });
    const bitrefill = rows.find((row) => row.label === 'Bitrefill catalogue');
    assert.equal(bitrefill?.state, 'done');
    assert.equal(bitrefill?.value, 'reached / no matching product');
  });

  test('a disabled adapter states the reason instead of spinning', () => {
    const rows = comparingProgressV1({
      family: 'earn',
      adapters: ALL_ADAPTERS,
      answered: [],
      terminalReason: null,
      evidenceCount: null,
      scored: false,
    });
    const moonwell = rows.find((row) => row.label === 'Moonwell rates');
    assert.equal(moonwell?.state, 'failed');
    assert.equal(moonwell?.value, 'disabled');
  });

  test('an unrecognised goal produces no adapter rows at all', () => {
    const rows = comparingProgressV1({
      family: 'unknown',
      adapters: ALL_ADAPTERS,
      answered: [],
      terminalReason: 'Say what you want to do.',
      evidenceCount: null,
      scored: false,
    });
    assert.deepEqual(rows.map((row) => row.label), ['Intent extraction', 'Evidence collected', 'Scoring against your goal']);
  });
});

test('a halted rail no longer points at a stage that stopped', () => {
  const halted = haltStageRailV1([
    { name: 'Intent', state: 'done', timing: '0.1s' },
    { name: 'Candidates', state: 'done', timing: '1.2s' },
    { name: 'Evidence', state: 'now', timing: '—' },
    { name: 'Score', state: 'todo', timing: '—' },
  ]);
  assert.equal(halted.some((step) => step.state === 'now'), false);
  assert.deepEqual(halted.map((step) => step.state), ['done', 'done', 'todo', 'todo']);
});

describe('a swap that the server answered with a question is terminal', () => {
  // The bug: swap was the only family with no terminal branch, in BOTH
  // consoles. "swap my $mio token" came back `needs_clarification`, the
  // mutation finished, no projection existed and nothing had thrown — so the
  // Comparing screen kept its adapter rows spinning, forever.
  test('needs_clarification carries the server’s own sentence', () => {
    const failure = swapTerminalFailureV1({
      outcome: 'needs_clarification',
      clarification: { message: 'How much MIO do you want to swap?' },
    });
    assert.ok(failure);
    assert.equal(failure!.title, 'This goal needs one more detail');
    // Not a generic "could not route this": the server named the missing
    // field, and that is the user's next move.
    assert.equal(failure!.detail, 'How much MIO do you want to swap?');
  });

  test('a rejection lists every issue, not just the first', () => {
    // A goal can be short an amount AND name an asset Miorail will not route.
    // Fixing one leaves the other, and a user told only about the first would
    // fix it and hit the same wall.
    const failure = swapTerminalFailureV1({
      outcome: 'rejected',
      issues: [{ message: 'An amount is required.' }, { message: 'MIO is not a routable asset.' }],
    });
    assert.ok(failure);
    assert.match(failure!.detail, /An amount is required\./);
    assert.match(failure!.detail, /MIO is not a routable asset\./);
  });

  test('an evaluated run is not a failure', () => {
    assert.equal(swapTerminalFailureV1({ outcome: 'evaluated' }), null);
    assert.equal(swapTerminalFailureV1(null), null);
    assert.equal(swapTerminalFailureV1(undefined), null);
  });

  test('both consoles consult it, so neither can lose the branch again', () => {
    for (const file of [
      '../../../artifacts/interface/src/features/console/RouteIntelligenceConsole.tsx',
      '../../../artifacts/miniapp/app/components/MiniConsole.tsx',
    ]) {
      const source = readFileSync(path.join(here, file), 'utf8');
      assert.match(source, /swapTerminalFailureV1/, file);
    }
  });

  test('a terminal run stops the adapter rows rather than spinning', () => {
    const rows = comparingProgressV1({
      family: 'swap',
      adapters: [
        { name: 'Uniswap', label: 'live', live: true, usable: true },
        { name: 'KyberSwap', label: 'live', live: true, usable: true },
      ],
      answered: [],
      terminalReason: 'How much MIO do you want to swap?',
      evidenceCount: null,
      scored: false,
    });
    // Every row is resolved. Not one of them may still read as running or as
    // waiting — `skipped` is resolved: the run ended before that stage.
    assert.equal(rows.some((row) => row.state === 'running'), false, JSON.stringify(rows));
    assert.ok(rows.every((row) => ['failed', 'done', 'skipped'].includes(row.state)));
  });
});

describe('prepare answers 200 with three refusals the console used to drop', () => {
  test('each refusal becomes a sentence, carried from the server', () => {
    assert.deepEqual(
      swapPrepareNoticeV1({
        outcome: 'refresh_required',
        reason: 'quote_expired',
        detail: 'The quote behind this Route Card expired.',
      }),
      {
        title: 'This route needs comparing again',
        detail: 'The quote behind this Route Card expired.',
        // An expired comparison is the one refusal a new comparison fixes, so
        // the screen may offer it. Without this the user went "back" to the
        // same expired card and was refused again.
        canCompareAgain: true,
      },
    );
    assert.deepEqual(
      swapPrepareNoticeV1({
        outcome: 'unsupported',
        reason: 'unsupported_pair',
        detail: 'This pair cannot be prepared.',
      }),
      { title: 'Miorail cannot prepare this route', detail: 'This pair cannot be prepared.' },
    );
    assert.deepEqual(
      swapPrepareNoticeV1({ outcome: 'blocked', safety: { blockedReason: 'Recipient is not your wallet.' } }),
      {
        title: 'The Safety Kernel refused this transaction',
        detail: 'Recipient is not your wallet.',
      },
    );
    // Neither of those two carries the offer: comparing again cannot change an
    // unsupported pair or a Safety Kernel verdict.
    assert.equal(
      swapPrepareNoticeV1({ outcome: 'unsupported', reason: 'unsupported_pair', detail: 'x' })?.canCompareAgain,
      undefined,
    );
    assert.equal(
      swapPrepareNoticeV1({ outcome: 'blocked', safety: { blockedReason: 'x' } })?.canCompareAgain,
      undefined,
    );
  });

  test('a prepared route has no notice, and neither does an absent response', () => {
    assert.equal(swapPrepareNoticeV1({ outcome: 'prepared' }), null);
    assert.equal(swapPrepareNoticeV1(null), null);
    assert.equal(swapPrepareNoticeV1(undefined), null);
  });

  test('a blocked verdict without a reason still says something', () => {
    // The schema refuses a blocked result with a null reason, so this is the
    // shape no server should send — and an empty warning box is worse than a
    // general one.
    const notice = swapPrepareNoticeV1({ outcome: 'blocked', safety: { blockedReason: null } });
    assert.equal(notice?.title, 'The Safety Kernel refused this transaction');
    assert.match(notice?.detail ?? '', /safety check/i);
  });
});

describe('a prepare that never answered still explains itself', () => {
  test('a failed request produces a notice, because there is no body to map', () => {
    // Third instance of the same class in one day: the server answered 500,
    // `swapPrepareNoticeV1` correctly saw no body, and Review rendered its
    // empty shell — zero calls, every check "not confirmed", a disabled
    // button — with the simulation sentence as the only text on screen.
    const notice = swapPrepareRequestFailedNoticeV1();
    assert.equal(notice.title, 'Miorail could not prepare this route');
    assert.match(notice.detail, /[Nn]othing was signed/);
    // A server-side failure is worth retrying with a fresh comparison.
    assert.equal(notice.canCompareAgain, true);
  });
});
