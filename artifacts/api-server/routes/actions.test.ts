import test from 'node:test';
import assert from 'node:assert';
import request from 'supertest';
import { app } from '../app';
process.env.CHAIN_ENV = 'sepolia';
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
                tokens: ['USDC', 'transfer'],
                executionPayload: { chain: 'base', calls: [{ to: '0x123' }] },
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
    assert.deepStrictEqual(response.body.actions[0].executionPayload, { chain: 'base', calls: [{ to: '0x123' }] });

    mock.restoreAll();
  });

  await t.test('POST /api/actions/:actionId/execute executes action with executionPayload', async () => {
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
            tokens: ['tag1'],
            executionPayload: { chain: 'base', calls: [{ to: '0x123' }] },
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
    mock.method(toolsModule.ToolAggregator.prototype, 'callTool', async (name: any, payload: any) => {
       assert.deepStrictEqual(payload, { chain: 'base', calls: [{ to: '0x123' }] });
       return { content: JSON.stringify({ approvalUrl: "https://mock.base.org/approve/123", requestId: "123" }), isError: false };
    });

    const response = await request(app).post('/api/actions/action-1/execute');
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.success, true);
    assert.ok(response.body.approvalUrl);

    mock.restoreAll();
  });

  await t.test('POST /api/actions/:actionId/execute supports legacy tokens[0]', async () => {
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
            tokens: ['{"chain":"base","calls":[{"to":"0x456"}]}'],
            executionPayload: null,
            createdAt: new Date('2024-01-01T00:00:00Z'),
            updatedAt: new Date('2024-01-01T00:00:00Z'),
          }
        ]),
      })),
    }));

    const mockUpdate = mock.fn(() => ({ set: mock.fn(() => ({ where: mock.fn(async () => []) })) }));
    mock.method(db, 'select', mockSelect);
    mock.method(db, 'update', mockUpdate);
    const { MemoryService } = await import('@mioagent/memory');
    mock.method(MemoryService, 'getUserSettings', async () => null);
    mock.method(toolsModule.ToolAggregator.prototype, 'findTool', () => ({ name: 'send_calls' }));
    mock.method(toolsModule.ToolAggregator.prototype, 'callTool', async (name: any, payload: any) => {
       assert.deepStrictEqual(payload, { chain: 'base', calls: [{ to: '0x456' }] });
       return { content: JSON.stringify({ approvalUrl: "url", requestId: "123" }), isError: false };
    });

    const response = await request(app).post('/api/actions/action-1/execute');
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.success, true);

    mock.restoreAll();
  });

  await t.test('POST /api/actions/:actionId/execute fails closed on malformed payload', async () => {
    const mockSelect = mock.fn(() => ({
      from: mock.fn(() => ({
        where: mock.fn(async () => [
          {
            id: 'action-1',
            userId: 'default-user',
            kind: 'test-action',
            status: 'pending',
            tokens: ['invalid_json'],
            executionPayload: { broken: 'yes' }, // no chain, no calls
            createdAt: new Date(), updatedAt: new Date(),
          }
        ]),
      })),
    }));
    mock.method(db, 'select', mockSelect);
    
    const response = await request(app).post('/api/actions/action-1/execute');
    assert.strictEqual(response.status, 400);
    assert.strictEqual(response.body.success, false);
    assert.strictEqual(response.body.error, 'Malformed or missing execution payload');

    mock.restoreAll();
  });

  
  await t.test('POST /api/actions/:actionId/execute blocks execution in mainnet-readonly mode', async () => {
    process.env.CHAIN_ENV = 'mainnet-readonly';

    const mockSelect = mock.fn(() => ({
      from: mock.fn(() => ({
        where: mock.fn(async () => [
          {
            id: 'action-1', userId: 'default-user', status: 'pending',
            executionPayload: { chain: 'eip155:8453', calls: [{ to: '0x123' }] },
          }
        ]),
      })),
    }));
    mock.method(db, 'select', mockSelect);
    
    const response = await request(app).post('/api/actions/action-1/execute');
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.success, false);
    assert.strictEqual(response.body.error, 'Mainnet execution is disabled in read-only mode.');

    mock.restoreAll();
    process.env.CHAIN_ENV = 'sepolia';
  });

  await t.test('POST /api/actions/:actionId/execute blocks mainnet execution if MAINNET_EXECUTION_ENABLED is not true', async () => {
    process.env.CHAIN_ENV = "mainnet";
    process.env.MAINNET_EXECUTION_ENABLED = "false";
    process.env.MAINNET_EXECUTION_ENABLED = 'false';

    const mockSelect = mock.fn(() => ({
      from: mock.fn(() => ({
        where: mock.fn(async () => [
          {
            id: 'action-1', userId: 'default-user', status: 'pending',
            executionPayload: { chain: 'eip155:8453', calls: [{ to: '0x123' }] },
          }
        ]),
      })),
    }));
    mock.method(db, 'select', mockSelect);
    
    const response = await request(app).post('/api/actions/action-1/execute');
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.success, false);
    assert.strictEqual(response.body.error, 'Mainnet execution is not enabled.');

    mock.restoreAll();
    process.env.CHAIN_ENV = 'sepolia';
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

  await t.test('DELETE /api/actions/demo deletes only demo seeded actions', async () => {
    const mockSelect = mock.fn(() => ({ from: mock.fn(() => ({ where: mock.fn(async () => [{ id: 'demo-1', userId: 'default-user', kind: 'recommendation', status: 'pending', createdAt: new Date(), updatedAt: new Date(), metadata: { createdBy: 'seed' } }]) })) }));
    mock.method(db, 'select', mockSelect);
    const mockDelete = mock.fn(() => ({ where: mock.fn(async () => []) }));
    mock.method(db, 'delete', mockDelete);

    const response = await request(app).delete('/api/actions/demo');
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.success, true);
    assert.strictEqual(response.body.count, 1);
    mock.restoreAll();
  });

  await t.test('PATCH /api/actions/recommendations/dismiss-all dismisses all recommendations', async () => {
    const mockSelect = mock.fn(() => ({ from: mock.fn(() => ({ where: mock.fn(async () => [{ id: 'rec-1', userId: 'default-user', kind: 'recommendation', status: 'pending', createdAt: new Date(), updatedAt: new Date() }]) })) }));
    mock.method(db, 'select', mockSelect);
    const mockUpdate = mock.fn(() => ({ set: mock.fn(() => ({ where: mock.fn(async () => []) })) }));
    mock.method(db, 'update', mockUpdate);

    const response = await request(app).patch('/api/actions/recommendations/dismiss-all');
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.success, true);
    assert.strictEqual(response.body.count, 1);
    mock.restoreAll();
  });

  await t.test('DELETE /api/actions/recommendations deletes recommendations when confirm=true', async () => {
    const responseNoConfirm = await request(app).delete('/api/actions/recommendations');
    assert.strictEqual(responseNoConfirm.status, 400);

    const mockSelect = mock.fn(() => ({ from: mock.fn(() => ({ where: mock.fn(async () => [{ id: 'rec-1' }]) })) }));
    mock.method(db, 'select', mockSelect);
    const mockDelete = mock.fn(() => ({ where: mock.fn(async () => []) }));
    mock.method(db, 'delete', mockDelete);

    const response = await request(app).delete('/api/actions/recommendations?confirm=true');
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.success, true);
    assert.strictEqual(response.body.count, 1);
    mock.restoreAll();
  });

  await t.test('DELETE /api/actions/:actionId deletes a single action', async () => {
    const mockSelect = mock.fn(() => ({ from: mock.fn(() => ({ where: mock.fn(async () => [{ id: 'act-1' }]) })) }));
    mock.method(db, 'select', mockSelect);
    const mockDelete = mock.fn(() => ({ where: mock.fn(async () => []) }));
    mock.method(db, 'delete', mockDelete);

    const response = await request(app).delete('/api/actions/act-1');
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.success, true);
    mock.restoreAll();
  });

  await t.test('POST /api/actions/:actionId/regenerate creates new recommendation and dismisses old', async () => {
    const mockSelect = mock.fn(() => ({ from: mock.fn(() => ({ where: mock.fn(async () => [{ id: 'act-1', userId: 'default-user', kind: 'recommendation', status: 'pending', suggestedPrompt: 'Test Prompt', metadata: { createdBy: 'agent-stream' } }]) })) }));
    mock.method(db, 'select', mockSelect);
    const mockInsert = mock.fn(() => ({ values: mock.fn(async () => []) }));
    mock.method(db, 'insert', mockInsert);
    const mockUpdate = mock.fn(() => ({ set: mock.fn(() => ({ where: mock.fn(async () => []) })) }));
    mock.method(db, 'update', mockUpdate);

    const response = await request(app).post('/api/actions/act-1/regenerate').send({ walletAddress: '0x1111111111111111111111111111111111111111', chainEnv: 'mainnet-readonly' });
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.success, true);
    assert.ok(response.body.actionId.startsWith('rec_'));
    mock.restoreAll();
  });
});
