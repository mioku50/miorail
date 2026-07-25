import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  CONSOLE_STAGES_V1,
  activeStageStepV1,
  adaptersFromStatusV1,
  chainLabelV1,
  completeStageV1,
  commerceCheckoutAvailableV1,
  coverageFromStatusV1,
  deriveStageTimingsV1,
  dispatchRouteFamilyV1,
  emptyStageClockV1,
  formatStageDurationV1,
  routeFamilyForGoalV1,
  stageDurationMsV1,
  startStageV1,
  stepperFromClockV1,
} from '../src/console/consoleFlow';

// ---------------------------------------------------------------------------
// T63D — the flow's mechanics. A timing is a measured interval or it is not a
// timing; a family is dispatched to its own engine; coverage comes from the
// server's flags, never from a front-end constant.
// ---------------------------------------------------------------------------

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
    assert.equal(routeFamilyForGoalV1('Buy a gift card'), 'commerce');
    assert.equal(routeFamilyForGoalV1(''), 'unknown');
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

    const during = adaptersFromStatusV1(allOn);
    assert.equal(during.find((row) => row.name === 'Uniswap')?.state, 'live');
    assert.equal(during.find((row) => row.name === 'o1.exchange')?.state, 'planned');

    const after = adaptersFromStatusV1(allOn, [{ name: 'KyberSwap' }], [{ name: 'Uniswap' }]);
    assert.deepEqual(after, [
      { name: 'KyberSwap', state: 'live' },
      { name: 'Uniswap', state: 'not_connected' },
    ]);
  });

  test('the chain label comes from the reported chain id', () => {
    assert.equal(chainLabelV1(8453), 'Base mainnet · 8453');
    assert.equal(chainLabelV1(84532), 'Base Sepolia · 84532');
    assert.equal(chainLabelV1(undefined), 'chain unknown');
  });
});
