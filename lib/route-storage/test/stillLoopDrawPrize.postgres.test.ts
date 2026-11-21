import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test, { after, before, describe } from 'node:test';

import postgres from 'postgres';

import type { SqlTemplateExecutor } from '../src/types.js';
import { createDatabaseStillLoopDrawRepositoryV1, recordLoopPrizesV1 } from '../src/stillLoopDraws.js';

// ---------------------------------------------------------------------------
// The prize write against real Postgres (audit, 2026-11-18): two runs at once
// for two draws, with one transfer that pays one prize, must record it once.
// It DROPS the draw tables, so it runs only against a throwaway local database.
//
//   MIOAGENT_MIGRATION_TEST_URL=postgres://postgres:x@127.0.0.1:55437/t \
//     npx tsx --test lib/route-storage/test/stillLoopDrawPrize.postgres.test.ts
// ---------------------------------------------------------------------------

const url = process.env.MIOAGENT_MIGRATION_TEST_URL?.trim();
const throwaway = Boolean(url && /(localhost|127\.0\.0\.1)/.test(url) && !/neon|amazonaws/i.test(url));

let sql: ReturnType<typeof postgres> | null = null;

function drizzleDir(): string {
  const cwd = process.cwd();
  if (cwd.endsWith('lib/route-storage')) return resolve(cwd, '..', 'db', 'drizzle');
  return resolve(cwd, 'lib', 'db', 'drizzle');
}

// Synthetic wallets and transactions: nothing here is anyone's.
const WINNER = `0x${'a'.repeat(40)}`;
const TX = `0x${'1'.repeat(64)}`;
const FIVE = 5_000_000n;

const executorOf = (runner: (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>): SqlTemplateExecutor =>
  async (strings, ...values) => (await runner(strings, ...values)) as Record<string, unknown>[];

const transaction = <T>(work: (tx: SqlTemplateExecutor) => Promise<T>): Promise<T> =>
  sql!.begin((tx) => work(executorOf(tx as unknown as (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>))) as Promise<T>;

/**
 * Two transaction runners that force the race: the first, once it has read every draw's payouts, waits up to
 * 300 ms for the second to read them too. With the lock the second cannot get there and the wait runs out;
 * without it both read "unpaid", and both would write.
 */
function racingTransactions(): [typeof transaction, typeof transaction] {
  let secondRead: () => void = () => {};
  const second = new Promise<void>((done) => { secondRead = done; });
  const runner = (first: boolean) => <T>(work: (tx: SqlTemplateExecutor) => Promise<T>): Promise<T> =>
    transaction((tx) => work(async (strings, ...values) => {
      const rows = await tx(strings, ...values);
      if (strings.join('?').includes('ORDER BY closes_at')) {
        if (first) await Promise.race([second, new Promise((done) => setTimeout(done, 300))]);
        else secondRead();
      }
      return rows;
    }));
  return [runner(true), runner(false)];
}

before(async () => {
  if (!throwaway) return;
  sql = postgres(url!, { max: 4, prepare: false, onnotice: () => {} });
  await sql.unsafe('DROP TABLE IF EXISTS still_loop_draws, still_loop_free_entries, still_loop_entries CASCADE');
  for (const file of ['0103_still_loop_draws.sql', '0104_still_loop_draw_entries.sql']) {
    await sql.unsafe((await readFile(resolve(drizzleDir(), file), 'utf8')).replaceAll('--> statement-breakpoint', ''));
  }
});

after(async () => {
  await sql?.end({ timeout: 5 });
});

/** Two drawn draws, each won by the same wallet, its only entry. */
async function twoDrawsWonByOneWallet(): Promise<void> {
  await sql!.unsafe('TRUNCATE still_loop_draws, still_loop_entries');
  const repository = createDatabaseStillLoopDrawRepositoryV1(executorOf(sql! as unknown as (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>));
  for (const [drawId, opensAt, closesAt] of [
    ['2026-11-28', '2026-11-21T00:00:00.000Z', '2026-11-28T18:00:00.000Z'],
    ['2026-12-03', '2026-11-28T18:00:00.000Z', '2026-12-03T18:00:00.000Z'],
  ] as const) {
    const lockedAt = new Date(Date.parse(closesAt) + 31_000);
    await repository.lock({
      drawId, opensAt, closesAt, prizeAtomic: FIVE.toString(), winnerCount: 1, lockedAt, entriesHash: `0x${'c'.repeat(64)}`,
      entries: [{ label: 'Entry AAAAAA', walletAddress: WINNER, kind: 'free', loopNo: null, enteredAt: opensAt }],
    });
    await repository.drawn({ drawId, block: { number: '59000000', hash: `0x${'d'.repeat(64)}`, time: new Date(lockedAt.getTime() + 300_000).toISOString() },
      winnerNos: [1], at: new Date(lockedAt.getTime() + 400_000) });
  }
}

if (!throwaway) {
  describe('postgres Loop prize write', () => {
    test('skipped: set MIOAGENT_MIGRATION_TEST_URL to a throwaway local database', () => {});
  });
} else {
  describe('postgres Loop prize write', () => {
    test('one transfer that pays one prize is recorded once, though two draws claim it at the same moment', async () => {
      await twoDrawsWonByOneWallet();
      const at = new Date('2026-12-04T10:00:00.000Z');
      const sent = new Map([[WINNER, FIVE]]);
      const [firstRunner, secondRunner] = racingTransactions();
      const [first, second] = await Promise.all([
        recordLoopPrizesV1({ transaction: firstRunner, drawId: '2026-11-28', paidTx: TX, sent, prize: FIVE, at }),
        new Promise((done) => setTimeout(done, 50)).then(() =>
          recordLoopPrizesV1({ transaction: secondRunner, drawId: '2026-12-03', paidTx: TX, sent, prize: FIVE, at })),
      ]);
      assert.equal(first!.recorded.length + second!.recorded.length, 1, JSON.stringify([first, second]));
      const rows = await sql!`SELECT draw_id, payouts FROM still_loop_draws ORDER BY draw_id`;
      assert.equal(rows.reduce((total, row) => total + (row.payouts as unknown[]).length, 0), 1);
    });

    test('a transfer of both prizes pays both, and a second run writes nothing more', async () => {
      await twoDrawsWonByOneWallet();
      const at = new Date('2026-12-04T10:00:00.000Z');
      const sent = new Map([[WINNER, 2n * FIVE]]);
      const runs = await Promise.all(['2026-11-28', '2026-12-03'].map((drawId) =>
        recordLoopPrizesV1({ transaction, drawId, paidTx: TX, sent, prize: FIVE, at })));
      assert.deepEqual(runs.map((run) => run.recorded), [[1], [1]]);
      const again = await recordLoopPrizesV1({ transaction, drawId: '2026-11-28', paidTx: TX, sent, prize: FIVE, at });
      assert.deepEqual(again, { covered: [], recorded: [] });
    });
  });
}
