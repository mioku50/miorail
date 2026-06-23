import test from 'node:test';
import assert from 'node:assert';
import request from 'supertest';
import { app } from '../app';
import { mock } from 'node:test';
import { db } from '@mioagent/db';

test('Actions API', async (t) => {
  await t.test('GET /api/actions returns actions', async () => {
    const mockSelect = mock.fn(() => ({
      from: mock.fn(() => ({
        where: mock.fn(() => ({
          orderBy: mock.fn(() => ({
            limit: mock.fn(async () => [
              {
                id: 'action-1',
                userId: 'default-user',
                kind: 'test-action',
                status: 'pending',
                suggestedPrompt: 'Do it',
                tokens: ['token1'],
                createdAt: new Date('2024-01-01T00:00:00Z'),
                updatedAt: new Date('2024-01-01T00:00:00Z'),
              }
            ]),
          })),
        })),
      })),
    }));

    mock.method(db, 'select', mockSelect);

    const response = await request(app).get('/api/actions');
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.actions.length, 1);
    assert.strictEqual(response.body.actions[0].id, 'action-1');

    mock.restoreAll();
  });

  await t.test('POST /api/actions/:actionId/execute executes action', async () => {
    const mockUpdate = mock.fn(() => ({
      set: mock.fn(() => ({
        where: mock.fn(async () => []),
      })),
    }));

    mock.method(db, 'update', mockUpdate);

    const response = await request(app).post('/api/actions/action-1/execute');
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.success, true);

    mock.restoreAll();
  });

  await t.test('POST /api/actions/:actionId/dismiss dismisses action', async () => {
    const mockUpdate = mock.fn(() => ({
      set: mock.fn(() => ({
        where: mock.fn(async () => []),
      })),
    }));

    mock.method(db, 'update', mockUpdate);

    const response = await request(app).post('/api/actions/action-1/dismiss');
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.success, true);

    mock.restoreAll();
  });
});
