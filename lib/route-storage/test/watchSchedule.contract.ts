import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import type { WatchScheduleRepositoryV1 } from '../src/watchSchedule.js';

const AAPL = '0xb200000000000000000000c2e324d24d7eecd1fb';
const NVDA = '0xb20000000000000000000078ee7ce2fe4908108c';
const COIN = '0xb200000000000000000000c85a31389d71f3ecfb';
const HOUR = 3_600;

/**
 * The contract both repositories are held to.
 *
 * Every case is a way the freshness promise could become false: a debt reset
 * by a list that grew, freshness claimed from an outage, one address checked
 * twice because two people watch it, a check recorded for an address nobody
 * watches.
 */
export function watchScheduleContractV1(
  label: string,
  open: () => Promise<{ repository: WatchScheduleRepositoryV1 }>,
): void {
  describe(`watch schedule (${label})`, () => {
    test('a new address is due immediately, because a promise starts when it is made', async () => {
      const { repository } = await open();
      const outcome = await repository.ensureScheduled({
        chainId: 8453,
        tokenAddresses: [AAPL, NVDA],
        intervalSeconds: HOUR,
        now: '2026-08-25T12:00:00.000Z',
      });
      assert.deepEqual(outcome.created, [AAPL, NVDA].sort());
      const due = await repository.dueForCheck({
        chainId: 8453,
        now: '2026-08-25T12:00:00.000Z',
        limit: 10,
      });
      assert.equal(due.length, 2);
      assert.equal(due[0]!.lastCheckedAt, null);
      assert.equal(due[0]!.lastCompletedAt, null);
    });

    test('two accounts watching one address is one schedule row', async () => {
      const { repository } = await open();
      // The caller passes the DISTINCT set. This asserts the store agrees:
      // handing it the same address twice must not produce two debts.
      await repository.ensureScheduled({
        chainId: 8453,
        tokenAddresses: [AAPL, AAPL],
        intervalSeconds: HOUR,
        now: '2026-08-25T12:00:00.000Z',
      });
      assert.equal(await repository.scheduledAddressCount({ chainId: 8453 }), 1);
    });

    test('re-promising a longer interval never resets a debt', async () => {
      const { repository } = await open();
      await repository.ensureScheduled({
        chainId: 8453,
        tokenAddresses: [AAPL],
        intervalSeconds: HOUR,
        now: '2026-08-25T10:00:00.000Z',
      });
      await repository.recordCheck({
        chainId: 8453,
        tokenAddress: AAPL,
        at: '2026-08-25T10:00:00.000Z',
        outcome: 'measured',
        intervalSeconds: HOUR,
      });
      // The list grew, so everything is re-promised at a slower pace. An
      // address already overdue must stay overdue — otherwise a growing list
      // perpetually pushes its oldest entries back to the end of the queue.
      const outcome = await repository.ensureScheduled({
        chainId: 8453,
        tokenAddresses: [AAPL, NVDA],
        intervalSeconds: 6 * HOUR,
        now: '2026-08-25T12:00:00.000Z',
      });
      assert.deepEqual(outcome.repromised, [AAPL]);
      const [row] = await repository.readSchedules({ chainId: 8453, tokenAddresses: [AAPL] });
      assert.equal(row!.intervalSeconds, 6 * HOUR);
      assert.equal(row!.nextDueAt, '2026-08-25T11:00:00.000Z');
      const due = await repository.dueForCheck({
        chainId: 8453,
        now: '2026-08-25T12:00:00.000Z',
        limit: 10,
      });
      assert.equal(due.some((entry) => entry.tokenAddress === AAPL), true);
    });

    test('a failed check moves the clock and claims no freshness', async () => {
      const { repository } = await open();
      await repository.ensureScheduled({
        chainId: 8453,
        tokenAddresses: [AAPL],
        intervalSeconds: HOUR,
        now: '2026-08-25T10:00:00.000Z',
      });
      await repository.recordCheck({
        chainId: 8453,
        tokenAddress: AAPL,
        at: '2026-08-25T10:00:00.000Z',
        outcome: 'measured',
        intervalSeconds: HOUR,
      });
      const after = await repository.recordCheck({
        chainId: 8453,
        tokenAddress: AAPL,
        at: '2026-08-25T11:00:00.000Z',
        outcome: 'measurement_failed',
        intervalSeconds: HOUR,
      });
      // The queue moved, so a broken address cannot monopolise it…
      assert.equal(after.lastCheckedAt, '2026-08-25T11:00:00.000Z');
      assert.equal(after.nextDueAt, '2026-08-25T12:00:00.000Z');
      assert.equal(after.checks, 2);
      // …and freshness did not, so no surface can read it out of an outage.
      assert.equal(after.lastCompletedAt, '2026-08-25T10:00:00.000Z');
      assert.equal(after.completedChecks, 1);
      assert.equal(after.lastOutcome, 'measurement_failed');
    });

    test('an address nobody watches any more stops costing anything', async () => {
      const { repository } = await open();
      await repository.ensureScheduled({
        chainId: 8453,
        tokenAddresses: [AAPL, NVDA],
        intervalSeconds: HOUR,
        now: '2026-08-25T12:00:00.000Z',
      });
      const outcome = await repository.ensureScheduled({
        chainId: 8453,
        tokenAddresses: [AAPL],
        intervalSeconds: HOUR,
        now: '2026-08-25T12:30:00.000Z',
      });
      assert.deepEqual(outcome.retired, [NVDA]);
      // The capacity model divides a budget by this number, so a dormant row
      // would make every promise slower than it needs to be.
      assert.equal(await repository.scheduledAddressCount({ chainId: 8453 }), 1);
    });

    test('a check for an address nobody watches is refused, never inserted', async () => {
      const { repository } = await open();
      await assert.rejects(
        repository.recordCheck({
          chainId: 8453,
          tokenAddress: COIN,
          at: '2026-08-25T12:00:00.000Z',
          outcome: 'measured',
          intervalSeconds: HOUR,
        }),
      );
      assert.equal(await repository.scheduledAddressCount({ chainId: 8453 }), 0);
    });

    test('the queue is oldest debt first, so no address starves another', async () => {
      const { repository } = await open();
      await repository.ensureScheduled({
        chainId: 8453,
        tokenAddresses: [AAPL, NVDA, COIN],
        intervalSeconds: HOUR,
        now: '2026-08-25T10:00:00.000Z',
      });
      await repository.recordCheck({
        chainId: 8453,
        tokenAddress: AAPL,
        at: '2026-08-25T10:00:00.000Z',
        outcome: 'measured',
        intervalSeconds: HOUR,
      });
      await repository.recordCheck({
        chainId: 8453,
        tokenAddress: NVDA,
        at: '2026-08-25T10:30:00.000Z',
        outcome: 'measured',
        intervalSeconds: HOUR,
      });
      const due = await repository.dueForCheck({
        chainId: 8453,
        now: '2026-08-25T12:00:00.000Z',
        limit: 10,
      });
      assert.deepEqual(
        due.map((row) => row.tokenAddress),
        // COIN has never been checked and is owed from 10:00; then AAPL at
        // 11:00; then NVDA at 11:30.
        [COIN, AAPL, NVDA],
      );
    });

    test('nothing is due before it is owed', async () => {
      const { repository } = await open();
      await repository.ensureScheduled({
        chainId: 8453,
        tokenAddresses: [AAPL],
        intervalSeconds: HOUR,
        now: '2026-08-25T12:00:00.000Z',
      });
      await repository.recordCheck({
        chainId: 8453,
        tokenAddress: AAPL,
        at: '2026-08-25T12:00:00.000Z',
        outcome: 'measured',
        intervalSeconds: HOUR,
      });
      assert.deepEqual(
        await repository.dueForCheck({ chainId: 8453, now: '2026-08-25T12:59:59.000Z', limit: 10 }),
        [],
      );
    });
  });
}
