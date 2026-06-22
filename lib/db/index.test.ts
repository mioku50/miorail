import { describe, it } from 'node:test';
import assert from 'node:assert';
import { db } from './index';

import { users, userSettings, actions } from './index';

describe('db connection', () => {
  it('should export the db client', () => {
    assert.ok(db, 'db client should be defined');
    // Ensure we are exporting methods expected from a drizzle instance
    assert.ok(typeof db.select === 'function', 'db should have select method');
    assert.ok(typeof db.insert === 'function', 'db should have insert method');
  });

  it('should export the users schema', () => {
    assert.ok(users, 'users schema should be defined');
  });

  it('should export the userSettings schema', () => {
    assert.ok(userSettings, 'userSettings schema should be defined');
  });

  it('should export the actions schema', () => {
    assert.ok(actions, 'actions schema should be defined');
  });
});
