import test from 'node:test';
import assert from 'node:assert';
import request from 'supertest';
import { app } from '../app';
import { mock } from 'node:test';
import { db } from '@mioagent/db';
import * as toolsModule from '@mioagent/tools';

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
                tokens: ['{"chain":"base","calls":[{"to":"0x123"}]}'],
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
    process.env.SESSION_SECRET = '00000000000000000000000000000000';

    const mockSelect = mock.fn(() => ({
      from: mock.fn(() => ({
        where: mock.fn(async () => [
          {
            id: 'action-1',
            userId: 'default-user',
            kind: 'test-action',
            status: 'pending',
            suggestedPrompt: 'Do it',
            tokens: ['{"chain":"base","calls":[{"to":"0x123"}]}'],
            createdAt: new Date('2024-01-01T00:00:00Z'),
            updatedAt: new Date('2024-01-01T00:00:00Z'),
          }
        ]),
      })),
    }));

    const mockUpdate = mock.fn(() => ({
      set: mock.fn(() => ({
        where: mock.fn(async () => []),
      })),
    }));

    mock.method(db, 'select', mockSelect);
    mock.method(db, 'update', mockUpdate);

    const { MemoryService } = await import('@mioagent/memory');
    mock.method(MemoryService, 'getUserSettings', async () => null);

    mock.method(toolsModule.ToolAggregator.prototype, 'findTool', () => { return { name: 'send_calls' }; });
    mock.method(toolsModule.ToolAggregator.prototype, 'callTool', async () => {
       return { content: JSON.stringify({ approvalUrl: "https://mock.base.org/approve/123", requestId: "123" }), isError: false };
    });

    const response = await request(app).post('/api/actions/action-1/execute');

    if (response.body.success !== true) {
      console.log('Execution failed. response:', response.body);
    }

    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.success, true);
    assert.ok(response.body.approvalUrl);

    mock.restoreAll();
  });

  await t.test('POST /api/actions/:actionId/dismiss dismisses action', async () => {
    const mockSelect = mock.fn(() => ({ from: mock.fn(() => ({ where: mock.fn(async () => [{ id: 'action-1', userId: 'default-user', kind: 'test', status: 'pending', createdAt: new Date(), updatedAt: new Date() }]) })) }));
    mock.method(db, 'select', mockSelect);
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
