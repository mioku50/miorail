import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';

import postgres from 'postgres';

import {
  holdCashExitLineupLockV1,
  waitOutCashExitLineupLockV1,
  type CashExitLockTransactionV1,
} from '../src/cashExitLineupLock.js';

// ---------------------------------------------------------------------------
// The lineup pass's lock against real Postgres: an advisory lock touches no
// table, but it only means anything on a real server.
//
//   MIOAGENT_MIGRATION_TEST_URL=postgres://postgres:x@127.0.0.1:55437/t \
//     npx tsx --test lib/route-storage/test/cashExitLineupLock.postgres.test.ts
// ---------------------------------------------------------------------------

const url = process.env.MIOAGENT_MIGRATION_TEST_URL?.trim();
const throwaway = Boolean(url && /(localhost|127\.0\.0\.1)/.test(url) && !/neon|amazonaws/i.test(url));

let sql: ReturnType<typeof postgres> | null = null;

before(() => {
  if (!throwaway) return;
  // Two passes, two connections, as on the server.
  sql = postgres(url!, { max: 3, prepare: false, onnotice: () => {} });
});

after(async () => {
  await sql?.end({ timeout: 5 });
});

/** The production shape: one connection per transaction (lib/db withDatabaseTransaction). */
const transaction: CashExitLockTransactionV1 = (work) =>
  sql!.begin(async (tx) => work(async (strings, ...values) => (await tx(strings, ...(values as never[]))) as unknown as Record<string, unknown>[])) as never;

describe('the reopen lineup pass goes first (Postgres)', { skip: !throwaway }, () => {
  test('nobody holds it: the hourly pass does not wait', async () => {
    const pause = await waitOutCashExitLineupLockV1(transaction, 2_000);
    assert.equal(pause.timedOut, false);
    assert.ok(pause.waitedMs < 1_000, `waited ${pause.waitedMs} ms`);
  });

  test('held: the hourly pass waits until it is let go, and only that long', async () => {
    const release = await holdCashExitLineupLockV1(transaction);
    const started = Date.now();
    const waiting = waitOutCashExitLineupLockV1(transaction, 10_000);
    await new Promise((resolve) => setTimeout(resolve, 400));
    await release();
    const pause = await waiting;
    assert.equal(pause.timedOut, false);
    assert.ok(Date.now() - started >= 400, 'it waited for the release');
    assert.ok(pause.waitedMs < 5_000, `waited ${pause.waitedMs} ms`);
  });

  test('held too long: the hourly pass stops waiting and says so', async () => {
    const release = await holdCashExitLineupLockV1(transaction);
    try {
      const pause = await waitOutCashExitLineupLockV1(transaction, 300);
      assert.equal(pause.timedOut, true);
      assert.ok(pause.waitedMs >= 250 && pause.waitedMs < 5_000, `waited ${pause.waitedMs} ms`);
    } finally {
      await release();
    }
    // Let go: the next wait is immediate again.
    assert.equal((await waitOutCashExitLineupLockV1(transaction, 2_000)).timedOut, false);
  });

  test('a second lineup pass waits for the first', async () => {
    const first = await holdCashExitLineupLockV1(transaction);
    let secondHeld = false;
    const second = holdCashExitLineupLockV1(transaction).then((release) => {
      secondHeld = true;
      return release;
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(secondHeld, false);
    await first();
    const releaseSecond = await second;
    assert.equal(secondHeld, true);
    await releaseSecond();
  });
});
