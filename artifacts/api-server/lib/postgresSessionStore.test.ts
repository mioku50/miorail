import assert from 'node:assert/strict';
import test from 'node:test';
import session from 'express-session';

import { PostgresSessionStoreV1, sessionStoreV1 } from './postgresSessionStore.js';

test('unit tests use an isolated in-memory browser session store', () => {
  assert.ok(sessionStoreV1({ NODE_ENV: 'test' }) instanceof session.MemoryStore);
});

function memoryDatabase(now: () => number) {
  const rows = new Map<string, { data: session.SessionData; expires: number }>();
  let cleanupCalls = 0;
  let failCleanup = false;
  const sql = async (parts: TemplateStringsArray, ...values: unknown[]) => {
    const query = parts.join('?').replace(/\s+/g, ' ').trim();
    if (query.startsWith('INSERT INTO web_sessions')) {
      rows.set(String(values[0]), { data: JSON.parse(String(values[1])), expires: (values[2] as Date).getTime() });
      return [];
    }
    if (query.startsWith('SELECT session')) {
      const row = rows.get(String(values[0]));
      const visible = row && (!query.includes('expires_at > now()') || row.expires > now());
      return visible ? [{ session: row!.data }] : [];
    }
    if (query === 'DELETE FROM web_sessions WHERE expires_at < now()') {
      cleanupCalls++;
      if (failCleanup) throw new Error('private database error');
      for (const [sid, row] of rows) if (row.expires < now()) rows.delete(sid);
      return [];
    }
    throw new Error('Unexpected session query in memory fixture');
  };
  return {
    rows,
    sql: sql as unknown as ConstructorParameters<typeof PostgresSessionStoreV1>[0],
    cleanupCalls: () => cleanupCalls,
    failCleanup: (fail: boolean) => { failCleanup = fail; },
  };
}

const save = (store: PostgresSessionStoreV1, sid: string, expires: number) => new Promise<void>((resolve, reject) => {
  const cookie = new session.Cookie();
  cookie.expires = new Date(expires);
  store.set(sid, { cookie }, error => error ? reject(error) : resolve());
});
const load = (store: PostgresSessionStoreV1, sid: string) => new Promise<session.SessionData | null>((resolve, reject) => {
  store.get(sid, (error, value) => error ? reject(error) : resolve(value ?? null));
});

test('expired browser sessions are unreadable and cleanup preserves active sessions', async () => {
  const database = memoryDatabase(() => 1000);
  const store = new PostgresSessionStoreV1(database.sql);
  await save(store, 'expired-fixture', 900);
  await save(store, 'active-fixture', 2000);
  assert.equal(database.rows.size, 2);
  assert.equal(await load(store, 'expired-fixture'), null);
  assert.ok(await load(store, 'active-fixture'));
  await store.cleanupExpired();
  assert.equal(database.rows.size, 1);
  assert.ok(database.rows.has('active-fixture'));
});

test('cleanup errors reveal no database detail and a later sweep can succeed', async () => {
  const database = memoryDatabase(() => 1000);
  const store = new PostgresSessionStoreV1(database.sql);
  await save(store, 'expired-fixture', 900);
  database.failCleanup(true);
  await assert.rejects(store.cleanupExpired(), { message: 'session_store_unavailable' });
  assert.equal(database.rows.size, 1);
  database.failCleanup(false);
  await store.cleanupExpired();
  assert.equal(database.rows.size, 0);
  assert.equal(database.cleanupCalls(), 2);
});

test('overlapping cleanup requests share one in-flight database operation', async () => {
  let finish!: () => void;
  let calls = 0;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  const sql = (() => { calls++; return pending; }) as unknown as ConstructorParameters<typeof PostgresSessionStoreV1>[0];
  const store = new PostgresSessionStoreV1(sql);
  const first = store.cleanupExpired();
  const second = store.cleanupExpired();
  assert.equal(first, second);
  assert.equal(calls, 1);
  finish();
  await Promise.all([first, second]);
});

test('the hourly cleanup timer is idempotent, unreferenced and can be stopped', async (t) => {
  const database = memoryDatabase(() => 1000);
  const store = new PostgresSessionStoreV1(database.sql);
  t.after(() => store.stopCleanup());
  const scheduled = t.mock.method(globalThis, 'setInterval');
  store.startCleanup();
  store.startCleanup();
  assert.equal(scheduled.mock.callCount(), 1);
  const timer = scheduled.mock.calls[0]!;
  assert.equal(timer.arguments[1], 3_600_000);
  assert.ok(timer.result);
  assert.equal(timer.result.hasRef(), false);
  const callback = timer.arguments[0] as () => void;
  callback();
  await store.cleanupExpired();
  assert.equal(database.cleanupCalls(), 1);
  store.stopCleanup();
  store.startCleanup();
  assert.equal(scheduled.mock.callCount(), 2);
});

test('the test MemoryStore does not start a production cleanup timer', (t) => {
  const scheduled = t.mock.method(globalThis, 'setInterval');
  assert.ok(sessionStoreV1({ NODE_ENV: 'test' }) instanceof session.MemoryStore);
  assert.equal(scheduled.mock.callCount(), 0);
});

test('production cannot silently fall back to deployment-local memory', () => {
  assert.throws(
    () => sessionStoreV1({ NODE_ENV: 'production' }),
    /DATABASE_URL is required for persistent production sessions/,
  );
});
