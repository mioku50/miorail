import assert from 'node:assert/strict';
import test from 'node:test';
import session from 'express-session';

import { sessionStoreV1 } from './postgresSessionStore.js';

test('unit tests use an isolated in-memory browser session store', () => {
  assert.ok(sessionStoreV1({ NODE_ENV: 'test' }) instanceof session.MemoryStore);
});

test('production cannot silently fall back to deployment-local memory', () => {
  assert.throws(
    () => sessionStoreV1({ NODE_ENV: 'production' }),
    /DATABASE_URL is required for persistent production sessions/,
  );
});
