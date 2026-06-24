import { describe, it, after } from 'node:test';
import assert from 'node:assert';
import { db, client } from './index';

import {
  users,
  userSettings,
  actions,
  workflows,
  chats,
  apiCache,
  appMeta,
  recommendationExecutions,
  x402Receipts,
} from './index';

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

  it('should export the workflows schema', () => {
    assert.ok(workflows, 'workflows schema should be defined');
  });

  it('should export the chats schema', () => {
    assert.ok(chats, 'chats schema should be defined');
  });

  it('should export the apiCache schema', () => {
    assert.ok(apiCache, 'apiCache schema should be defined');
  });

  it('should export the appMeta schema', () => {
    assert.ok(appMeta, 'appMeta schema should be defined');
  });

  it('should export the recommendationExecutions schema', () => {
    assert.ok(recommendationExecutions, 'recommendationExecutions schema should be defined');
  });

  it('should export the x402Receipts schema', () => {
    assert.ok(x402Receipts, 'x402Receipts schema should be defined');
  });

  after(async () => {
    await client.end();
  });
});
