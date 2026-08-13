import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  B20_DISCOVER_CADENCE_V1,
  B20_MEASURE_CADENCE_V1,
  WORKER_FATAL_RESULTS_V1,
  createInterruptibleWaitV1,
  nextWorkerDelayMsV1,
  runWorkerLoopV1,
  type WorkerPassSignalV1,
} from './b20WorkerLoop.js';

// ---------------------------------------------------------------------------
// T73-LIVE §1 — the cadence is the whole feature.
//
// Production sat 290,000 blocks behind head. A fixed timer cannot fix that: at
// 800 blocks a pass and a minute between them, catching up takes six hours. So
// the loop reads what the pass reported and decides whether to rest.
//
// Every one of these runs in microseconds, because the clock is injected. That
// is deliberate — a catch-up policy nobody can test is a catch-up policy nobody
// can change.
// ---------------------------------------------------------------------------

const DISCOVER = { cadence: B20_DISCOVER_CADENCE_V1, catchUpThresholdBlocks: 2_400 };

function delay(signal: WorkerPassSignalV1, consecutiveFailures = 0): number {
  return nextWorkerDelayMsV1({ signal, ...DISCOVER, consecutiveFailures });
}

describe('the loop rests only when there is nothing to chase', () => {
  test('a long way behind head, passes run back to back', () => {
    assert.equal(delay({ result: 'success', blocksBehind: 290_000 }), B20_DISCOVER_CADENCE_V1.catchUpMs);
  });

  test('caught up, it rests', () => {
    assert.equal(delay({ result: 'success', blocksBehind: 12, didWork: false }), B20_DISCOVER_CADENCE_V1.idleMs);
  });

  test('a pass that hit its own ceiling always means more work', () => {
    // Even with no blocksBehind reported — the measurement worker has none.
    assert.equal(
      delay({ result: 'budget_exhausted', budgetExhausted: true }),
      B20_DISCOVER_CADENCE_V1.catchUpMs,
    );
  });

  test('a pass that found launches comes straight back', () => {
    assert.equal(delay({ result: 'success', blocksBehind: 5, didWork: true }), B20_DISCOVER_CADENCE_V1.catchUpMs);
  });

  test('an empty confirmed range rests rather than spinning', () => {
    assert.equal(delay({ result: 'nothing_confirmed', blocksBehind: 0 }), B20_DISCOVER_CADENCE_V1.idleMs);
  });

  test('just inside the threshold rests; just outside chases', () => {
    assert.equal(delay({ result: 'success', blocksBehind: 2_400 }), B20_DISCOVER_CADENCE_V1.idleMs);
    assert.equal(delay({ result: 'success', blocksBehind: 2_401 }), B20_DISCOVER_CADENCE_V1.catchUpMs);
  });
});

describe('a lease held elsewhere is the lock working, not a failure', () => {
  test('it comes back promptly rather than backing off', () => {
    const ms = delay({ result: 'run_already_active' });
    assert.ok(ms > B20_DISCOVER_CADENCE_V1.catchUpMs, 'not a tight loop against another worker');
    assert.ok(ms < B20_DISCOVER_CADENCE_V1.backoffMs, 'and not a sulk — that worker may die mid-pass');
  });

  test('it never counts as a failure, so it cannot drive the backoff up', async () => {
    const delays: number[] = [];
    await runWorkerLoopV1({
      pass: async () => ({ result: 'run_already_active' }),
      ...DISCOVER,
      wait: async (ms) => { delays.push(ms); },
      shouldContinue: () => true,
      log: () => {},
      maxPasses: 5,
    });
    assert.equal(new Set(delays).size, 1, 'a constant cadence, not an escalating one');
  });
});

describe('a provider that is down is not hammered', () => {
  test('the backoff doubles and then stops doubling', () => {
    assert.equal(delay({ result: 'endpoint_unavailable' }, 1), B20_DISCOVER_CADENCE_V1.backoffMs);
    assert.equal(delay({ result: 'endpoint_unavailable' }, 2), B20_DISCOVER_CADENCE_V1.backoffMs * 2);
    // Capped, so a provider that is down for an hour is not retried in a year.
    assert.equal(delay({ result: 'endpoint_unavailable' }, 30), B20_DISCOVER_CADENCE_V1.maxBackoffMs);
  });

  test('one good pass clears the backoff', async () => {
    const results = ['endpoint_unavailable', 'endpoint_unavailable', 'success', 'endpoint_unavailable'];
    const delays: number[] = [];
    let index = 0;
    await runWorkerLoopV1({
      pass: async () => ({ result: results[index++]!, blocksBehind: 0 }),
      ...DISCOVER,
      wait: async (ms) => { delays.push(ms); },
      shouldContinue: () => true,
      log: () => {},
      maxPasses: 4,
    });
    assert.equal(delays[0], B20_DISCOVER_CADENCE_V1.backoffMs);
    assert.equal(delays[1], B20_DISCOVER_CADENCE_V1.backoffMs * 2);
    assert.equal(delays[2], B20_DISCOVER_CADENCE_V1.idleMs);
    // Back to the FIRST step, not the third. A transient blip must not leave
    // the worker permanently slow.
    assert.equal(delays[3], B20_DISCOVER_CADENCE_V1.backoffMs);
  });
});

describe('the loop stops for the things another pass cannot fix', () => {
  test('a stop wakes a worker already inside provider backoff', async () => {
    let running = true;
    const interruptibleWait = createInterruptibleWaitV1();
    const loop = runWorkerLoopV1({
      pass: async () => ({ result: 'endpoint_unavailable' }),
      ...DISCOVER,
      wait: interruptibleWait.wait,
      shouldContinue: () => running,
      log: () => {},
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    running = false;
    interruptibleWait.wake();
    const summary = await loop;
    assert.equal(summary.passes, 1);
    assert.equal(summary.stoppedBecause, 'signal');
  });

  for (const result of WORKER_FATAL_RESULTS_V1) {
    test(`${result} exits rather than retrying forever`, async () => {
      let passes = 0;
      const summary = await runWorkerLoopV1({
        pass: async () => {
          passes += 1;
          return { result };
        },
        ...DISCOVER,
        wait: async () => { throw new Error('a fatal result must not sleep'); },
        shouldContinue: () => true,
        log: () => {},
      });
      assert.equal(passes, 1);
      assert.equal(summary.stoppedBecause, 'fatal');
      assert.equal(summary.lastResult, result);
    });
  }

  test('a stop signal ends the loop after the pass in flight, never mid-pass', async () => {
    let running = true;
    let passes = 0;
    const summary = await runWorkerLoopV1({
      pass: async () => {
        passes += 1;
        // Arrives while a pass is running, which is when SIGTERM actually lands.
        running = false;
        return { result: 'success', blocksBehind: 0 };
      },
      ...DISCOVER,
      wait: async () => { throw new Error('a stopping loop must not sleep'); },
      shouldContinue: () => running,
      log: () => {},
    });
    assert.equal(passes, 1, 'the pass completed');
    assert.equal(summary.stoppedBecause, 'signal');
  });

  test('passes never overlap — the loop awaits each one', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    await runWorkerLoopV1({
      pass: async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 1));
        inFlight -= 1;
        return { result: 'success', blocksBehind: 0 };
      },
      ...DISCOVER,
      wait: async () => {},
      shouldContinue: () => true,
      log: () => {},
      maxPasses: 4,
    });
    assert.equal(maxInFlight, 1);
  });
});

describe('measurement rests longer than discovery, because it costs more', () => {
  test('every measurement cadence is slower than the matching discovery one', () => {
    assert.ok(B20_MEASURE_CADENCE_V1.catchUpMs > B20_DISCOVER_CADENCE_V1.catchUpMs);
    assert.ok(B20_MEASURE_CADENCE_V1.idleMs > B20_DISCOVER_CADENCE_V1.idleMs);
  });

  test('measurement still chases its own budget ceiling', () => {
    assert.equal(
      nextWorkerDelayMsV1({
        signal: { result: 'budget_exhausted', budgetExhausted: true },
        cadence: B20_MEASURE_CADENCE_V1,
        consecutiveFailures: 0,
        // No cursor, so no blocks to be behind.
        catchUpThresholdBlocks: Number.POSITIVE_INFINITY,
      }),
      B20_MEASURE_CADENCE_V1.catchUpMs,
    );
  });

  test('nothing eligible means rest, not spin', () => {
    assert.equal(
      nextWorkerDelayMsV1({
        signal: { result: 'nothing_eligible', didWork: false },
        cadence: B20_MEASURE_CADENCE_V1,
        consecutiveFailures: 0,
        catchUpThresholdBlocks: Number.POSITIVE_INFINITY,
      }),
      B20_MEASURE_CADENCE_V1.idleMs,
    );
  });

  test('§3 — a re-measure that wrote observations comes back sooner, so 24h pairs can form', () => {
    assert.equal(
      nextWorkerDelayMsV1({
        signal: { result: 'success', didWork: true },
        cadence: B20_MEASURE_CADENCE_V1,
        consecutiveFailures: 0,
        catchUpThresholdBlocks: Number.POSITIVE_INFINITY,
      }),
      B20_MEASURE_CADENCE_V1.catchUpMs,
    );
  });
});

describe('the log says what happened without saying where', () => {
  test('every entry is counts and categories only', async () => {
    const entries: Record<string, unknown>[] = [];
    await runWorkerLoopV1({
      pass: async () => ({ result: 'endpoint_unavailable' }),
      ...DISCOVER,
      wait: async () => {},
      shouldContinue: () => true,
      log: (entry) => entries.push(entry),
      maxPasses: 2,
    });
    assert.equal(entries.length, 2);
    for (const entry of entries) {
      assert.deepEqual(Object.keys(entry).sort(), ['consecutiveFailures', 'delayMs', 'event', 'result']);
      assert.ok(!JSON.stringify(entry).includes('http'));
    }
  });
});
