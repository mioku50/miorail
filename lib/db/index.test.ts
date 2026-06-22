import { describe, it } from 'node:test';
import assert from 'node:assert';
import { db } from './index';

describe('db connection', () => {
  it('should export the db client', () => {
    assert.ok(db, 'db client should be defined');
    // Ensure we are exporting methods expected from a drizzle instance
    assert.ok(typeof db.select === 'function', 'db should have select method');
    assert.ok(typeof db.insert === 'function', 'db should have insert method');
  });
});
