import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  B20_WATCHLIST_CAPACITY_V1,
  InMemoryB20WatchlistRepositoryV1,
  b20SweepOutcomeFromDetectionV1,
  b20WatchlistAddEffectV1,
  b20WatchlistIdV1,
  type B20WatchlistEntryV1,
} from '../src/index.js';
import { RouteStorageConflictError } from '../src/types.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const USER = 'eip155:8453:0x1111111111111111111111111111111111111111';
const OTHER = 'eip155:8453:0x2222222222222222222222222222222222222222';
const TOKEN = '0xb2000000000000000000007bf6d5cbb0e24cb301';
const TOKEN_TWO = '0xb2000000000000000000007bf6d5cbb0e24cb302';
const NOW = new Date('2026-08-02T12:00:00.000Z');

function address(index: number): string {
  return `0x${index.toString(16).padStart(40, '0')}`;
}

describe('the add decision is one function, so the fake cannot be kinder than the database', () => {
  const entry = (): B20WatchlistEntryV1 => ({
    id: 'x',
    userId: USER,
    chainId: 8453,
    tokenAddress: TOKEN,
    createdAt: NOW.toISOString(),
    lastSweptAt: null,
    lastOutcome: null,
  });

  test('an address already watched returns the existing row rather than a second one', () => {
    // A double-click must not become two recurring on-chain reads, forever.
    assert.deepEqual(b20WatchlistAddEffectV1({ existing: entry(), currentCount: 1 }), {
      effect: 'return_existing',
    });
  });

  test('a full list refuses, and the reason names the cap', () => {
    const decision = b20WatchlistAddEffectV1({
      existing: null,
      currentCount: B20_WATCHLIST_CAPACITY_V1,
    });
    assert.equal(decision.effect, 'at_capacity');
    if (decision.effect === 'at_capacity') {
      assert.match(decision.reason, new RegExp(String(B20_WATCHLIST_CAPACITY_V1)));
    }
  });

  test('a full list still accepts a token it already holds', () => {
    // Otherwise a user at the cap could not re-add a token they never removed,
    // which is what an idempotent add looks like from a second tab.
    assert.deepEqual(
      b20WatchlistAddEffectV1({ existing: entry(), currentCount: B20_WATCHLIST_CAPACITY_V1 }),
      { effect: 'return_existing' },
    );
  });
});

describe('the in-memory watchlist', () => {
  test('adding twice is one row', async () => {
    const repository = new InMemoryB20WatchlistRepositoryV1();
    const first = await repository.addToken({ userId: USER, tokenAddress: TOKEN, now: NOW });
    const second = await repository.addToken({ userId: USER, tokenAddress: TOKEN.toUpperCase(), now: NOW });
    assert.equal(first.id, second.id);
    assert.equal((await repository.listForUser(USER)).length, 1);
  });

  test('the cap is per account, not global', async () => {
    const repository = new InMemoryB20WatchlistRepositoryV1();
    for (let index = 1; index <= B20_WATCHLIST_CAPACITY_V1; index += 1) {
      await repository.addToken({ userId: USER, tokenAddress: address(index), now: NOW });
    }
    await assert.rejects(
      () => repository.addToken({ userId: USER, tokenAddress: address(999), now: NOW }),
      RouteStorageConflictError,
    );
    // Another account is unaffected — one user cannot fill anyone else's list.
    const other = await repository.addToken({ userId: OTHER, tokenAddress: address(999), now: NOW });
    assert.equal(other.userId, OTHER);
  });

  test('one account never sees another’s list', async () => {
    const repository = new InMemoryB20WatchlistRepositoryV1();
    await repository.addToken({ userId: USER, tokenAddress: TOKEN, now: NOW });
    assert.deepEqual(await repository.listForUser(OTHER), []);
  });

  test('removing something that is not there is not an error', async () => {
    // Two tabs must not turn one removal into a failure.
    const repository = new InMemoryB20WatchlistRepositoryV1();
    assert.equal(await repository.removeToken(USER, TOKEN), false);
  });

  test('a never-read token outranks one read long ago', async () => {
    // NULLS FIRST is the whole ordering. A token somebody just added has no
    // reading at all, and showing them nothing for it is the worst outcome.
    const repository = new InMemoryB20WatchlistRepositoryV1();
    await repository.addToken({ userId: USER, tokenAddress: TOKEN, now: NOW });
    await repository.addToken({ userId: USER, tokenAddress: TOKEN_TWO, now: new Date(NOW.getTime() + 1) });
    await repository.recordSweep({
      id: b20WatchlistIdV1(USER, TOKEN),
      at: new Date('2020-01-01T00:00:00.000Z'),
      outcome: 'read',
    });
    const due = await repository.dueForSweep({ limit: 10, sweptBefore: new Date('2026-08-02T11:00:00.000Z') });
    assert.deepEqual(due.map((row) => row.tokenAddress), [TOKEN_TWO, TOKEN]);
  });

  test('a token read recently is left alone', async () => {
    const repository = new InMemoryB20WatchlistRepositoryV1();
    await repository.addToken({ userId: USER, tokenAddress: TOKEN, now: NOW });
    await repository.recordSweep({ id: b20WatchlistIdV1(USER, TOKEN), at: NOW, outcome: 'read' });
    const due = await repository.dueForSweep({
      limit: 10,
      sweptBefore: new Date(NOW.getTime() - 60_000),
    });
    assert.deepEqual(due, []);
  });

  test('the sweep queue crosses accounts, because a background run has no user', async () => {
    const repository = new InMemoryB20WatchlistRepositoryV1();
    await repository.addToken({ userId: USER, tokenAddress: TOKEN, now: NOW });
    await repository.addToken({ userId: OTHER, tokenAddress: TOKEN_TWO, now: NOW });
    const due = await repository.dueForSweep({ limit: 10, sweptBefore: NOW });
    assert.deepEqual(new Set(due.map((row) => row.userId)), new Set([USER, OTHER]));
    // The tenant travels WITH the row, so the writes that follow are still
    // per-tenant rather than re-derived from something ambient.
    for (const row of due) assert.ok(row.userId.startsWith('eip155:8453:'));
  });

  test('recording against a token removed mid-run is not an error', async () => {
    const repository = new InMemoryB20WatchlistRepositoryV1();
    await repository.recordSweep({ id: b20WatchlistIdV1(USER, TOKEN), at: NOW, outcome: 'read' });
    assert.deepEqual(await repository.listForUser(USER), []);
  });

  test('a reading and its outcome are written together', async () => {
    // The database has a CHECK for this pair; the fake must not be able to
    // produce a state Postgres would refuse.
    const repository = new InMemoryB20WatchlistRepositoryV1();
    await repository.addToken({ userId: USER, tokenAddress: TOKEN, now: NOW });
    const before = (await repository.listForUser(USER))[0]!;
    assert.equal(before.lastSweptAt, null);
    assert.equal(before.lastOutcome, null);
    await repository.recordSweep({ id: before.id, at: NOW, outcome: 'not_b20' });
    const after = (await repository.listForUser(USER))[0]!;
    assert.ok(after.lastSweptAt);
    assert.equal(after.lastOutcome, 'not_b20');
  });
});

describe('an outcome is not a verdict', () => {
  test('not_b20 is its own outcome, never a failure', () => {
    // Most addresses are not B20. Folding that into `unreadable` would teach a
    // reader to ignore the failures that matter.
    assert.equal(b20SweepOutcomeFromDetectionV1('not_b20'), 'not_b20');
    assert.equal(b20SweepOutcomeFromDetectionV1('b20'), 'read');
    assert.equal(b20SweepOutcomeFromDetectionV1('b20_uninitialised'), 'read');
    assert.equal(b20SweepOutcomeFromDetectionV1('rpc_failure'), 'unreadable');
    assert.equal(b20SweepOutcomeFromDetectionV1('unavailable_at_block'), 'unreadable');
  });

  test('an outcome this code has never seen is unreadable, not read', () => {
    assert.equal(b20SweepOutcomeFromDetectionV1('something_new'), 'unreadable');
  });
});

describe('the two implementations agree with the schema', () => {
  const migration = readFileSync(
    path.join(here, '../../db/drizzle/0024_t68_b20_watchlist.sql'),
    'utf8',
  );

  test('the database refuses a half-written sweep result', () => {
    assert.match(migration, /b20_watchlist_sweep_pair_check/);
    assert.match(migration, /"last_swept_at" IS NULL AND "last_outcome" IS NULL/);
  });

  test('one row per account per token is the index, not a convention', () => {
    assert.match(migration, /CREATE UNIQUE INDEX "b20_watchlist_user_token_unique"/);
  });

  test('the sweep queue is indexed the way it is queried', () => {
    assert.match(migration, /"last_swept_at" ASC NULLS FIRST/);
  });

  test('the schema has nowhere to put a score', () => {
    // The absence is the point: a table with no column for a number cannot
    // grow one by accident.
    assert.ok(!/score|rating|verdict|risk/i.test(migration.replace(/^--.*$/gm, '')));
  });

  test('the cap is not in the schema, and the code says why', () => {
    // SQL cannot express "at most N rows per user" in a CHECK, so it lives in
    // one function both repositories call.
    assert.match(migration, /SQL cannot express "at most N rows[\s\S]{0,12}per user"/);
  });
});
