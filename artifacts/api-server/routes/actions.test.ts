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

  
  await t.test('POST /api/actions/:actionId/execute blocks execution in mainnet-readonly mode and never broadcasts', async () => {
    process.env.CHAIN_ENV = 'mainnet-readonly';
    process.env.SESSION_SECRET = '00000000000000000000000000000000';

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

    // T19.1 regression: the server must NEVER invoke the broadcast tool on Base
    // Mainnet when MAINNET_EXECUTION_ENABLED=false. callTool throws if reached.
    const callToolMock = mock.method(toolsModule.ToolAggregator.prototype, 'callTool', async () => {
      throw new Error('BROADCAST_ATTEMPTED');
    });
    mock.method(toolsModule.ToolAggregator.prototype, 'findTool', () => ({ name: 'send_calls' }));

    const response = await request(app).post('/api/actions/action-1/execute');
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.success, false);
    assert.strictEqual(response.body.error, 'Mainnet execution is disabled in read-only mode.');
    assert.strictEqual(callToolMock.mock.calls.length, 0, 'server must not broadcast in mainnet-readonly');

    mock.restoreAll();
    process.env.CHAIN_ENV = 'sepolia';
  });

  await t.test('POST /api/actions/:actionId/execute blocks mainnet execution if MAINNET_EXECUTION_ENABLED is not true and never broadcasts', async () => {
    process.env.CHAIN_ENV = "mainnet";
    process.env.MAINNET_EXECUTION_ENABLED = 'false';
    process.env.SESSION_SECRET = '00000000000000000000000000000000';

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

    // T19.1 regression: MAINNET_EXECUTION_ENABLED=false ⇒ serverBroadcastEnabled=false
    // ⇒ the broadcast tool is never called.
    const callToolMock = mock.method(toolsModule.ToolAggregator.prototype, 'callTool', async () => {
      throw new Error('BROADCAST_ATTEMPTED');
    });
    mock.method(toolsModule.ToolAggregator.prototype, 'findTool', () => ({ name: 'send_calls' }));

    const response = await request(app).post('/api/actions/action-1/execute');
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.success, false);
    assert.strictEqual(response.body.error, 'Mainnet execution is not enabled.');
    assert.strictEqual(callToolMock.mock.calls.length, 0, 'server must not broadcast when MAINNET_EXECUTION_ENABLED=false');

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
    process.env.TOKEN_BALANCES_PROVIDER = 'none';
    process.env.PRICE_PROVIDER = 'none';
    process.env.TOKEN_SECURITY_PROVIDER = 'none';
    const mockFetch = mock.fn(async () => ({
      ok: true,
      json: async () => ({ result: '0xde0b6b3a7640000' })
    } as Response));
    global.fetch = mockFetch as unknown as typeof fetch;
    const mockSelect = mock.fn(() => ({ from: mock.fn(() => ({ where: mock.fn(async () => [{ id: 'act-1', userId: 'default-user', kind: 'recommendation', status: 'pending', suggestedPrompt: 'Test Prompt', metadata: { createdBy: 'agent-stream' } }]) })) }));
    mock.method(db, 'select', mockSelect);
    const mockInsert = mock.fn(() => ({
      values: mock.fn(() => ({
        onConflictDoNothing: mock.fn(async () => [])
      }))
    }));
    mock.method(db, 'insert', mockInsert);
    const mockUpdate = mock.fn(() => ({ set: mock.fn(() => ({ where: mock.fn(async () => []) })) }));
    mock.method(db, 'update', mockUpdate);

    const response = await request(app).post('/api/actions/act-1/regenerate').send({ walletAddress: '0x1111111111111111111111111111111111111111', chainEnv: 'mainnet-readonly' });
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.success, true);
    assert.ok(response.body.actionId.startsWith('rec_'));
    mock.restoreAll();
  });

  // T19: user-confirmed flow — prepare returns an UNSIGNED EIP-5792 payload and
  // never broadcasts. confirm records the result with no server-side signing.
  const BASE_MAINNET_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

  await t.test('POST /api/actions/:actionId/prepare returns an unsigned EIP-5792 payload for a safe USDC transfer', async () => {
    process.env.CHAIN_ENV = 'mainnet-readonly';
    process.env.MAINNET_EXECUTION_ENABLED = 'false';
    const mockSelect = mock.fn(() => ({
      from: mock.fn(() => ({
        where: mock.fn(async () => [
          {
            id: 'act-prepare',
            userId: 'default-user',
            kind: 'recommendation',
            status: 'pending',
            suggestedPrompt: 'Transfer 1 USDC to 0x1111111111111111111111111111111111111111',
            executionPayload: {
              chain: 'eip155:8453',
              actionType: 'limited_transfer',
              calls: [{ to: BASE_MAINNET_USDC, value: '0', data: '0xa9059cbb0000000000000000000000001111111111111111111111111111111111111111000000000000000000000000000000000000000000000000000000000000000a' }],
            },
            metadata: { instruction: 'Transfer 1 USDC to 0x1111111111111111111111111111111111111111' },
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ]),
      })),
    }));
    mock.method(db, 'select', mockSelect);

    const response = await request(app).post('/api/actions/act-prepare/prepare');
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.success, true);
    assert.strictEqual(response.body.chainId, '0x2105');
    assert.strictEqual(response.body.atomicRequired, true);
    assert.strictEqual(response.body.actionType, 'limited_transfer');
    assert.ok(Array.isArray(response.body.calls) && response.body.calls.length === 1);
    assert.strictEqual(response.body.screening.allowed, true);
    assert.strictEqual(response.body.simulation.success, true);

    mock.restoreAll();
    process.env.CHAIN_ENV = 'sepolia';
  });

  await t.test('POST /api/actions/:actionId/prepare rejects a payload whose actionType is not whitelisted', async () => {
    process.env.CHAIN_ENV = 'mainnet-readonly';
    const mockSelect = mock.fn(() => ({
      from: mock.fn(() => ({
        where: mock.fn(async () => [
          {
            id: 'act-bad-type', userId: 'default-user', status: 'pending',
            executionPayload: { chain: 'eip155:8453', actionType: 'swap', calls: [{ to: BASE_MAINNET_USDC }] },
            metadata: { instruction: 'swap something' },
            createdAt: new Date(), updatedAt: new Date(),
          },
        ]),
      })),
    }));
    mock.method(db, 'select', mockSelect);

    const response = await request(app).post('/api/actions/act-bad-type/prepare');
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.success, false);
    assert.ok(response.body.error.includes('whitelist'));

    mock.restoreAll();
    process.env.CHAIN_ENV = 'sepolia';
  });

  await t.test('POST /api/actions/:actionId/prepare rejects an action with no calls', async () => {
    process.env.CHAIN_ENV = 'mainnet-readonly';
    const mockSelect = mock.fn(() => ({
      from: mock.fn(() => ({
        where: mock.fn(async () => [
          {
            id: 'act-readonly', userId: 'default-user', status: 'pending',
            executionPayload: { chain: 'eip155:8453', readOnly: true, calls: [] },
            metadata: { instruction: 'check my portfolio' },
            createdAt: new Date(), updatedAt: new Date(),
          },
        ]),
      })),
    }));
    mock.method(db, 'select', mockSelect);

    const response = await request(app).post('/api/actions/act-readonly/prepare');
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.success, false);
    assert.ok(response.body.error.includes('no onchain calls'));

    mock.restoreAll();
    process.env.CHAIN_ENV = 'sepolia';
  });

  await t.test('POST /api/actions/:actionId/confirm records an executed result without a txHash (no RPC)', async () => {
    const mockSelect = mock.fn(() => ({
      from: mock.fn(() => ({
        where: mock.fn(async () => [
          {
            id: 'act-confirm', userId: 'default-user', status: 'pending',
            executionPayload: { chain: 'eip155:8453', calls: [{ to: BASE_MAINNET_USDC }] },
            metadata: { instruction: 'Transfer 1 USDC to 0x1111111111111111111111111111111111111111' },
            createdAt: new Date(), updatedAt: new Date(),
          },
        ]),
      })),
    }));
    const mockUpdate = mock.fn(() => ({ set: mock.fn(() => ({ where: mock.fn(async () => []) })) }));
    mock.method(db, 'select', mockSelect);
    mock.method(db, 'update', mockUpdate);
    const { ObservabilityService } = await import('@mioagent/observability');
    mock.method(ObservabilityService, 'logAction', async () => {});

    const response = await request(app).post('/api/actions/act-confirm/confirm').send({
      batchId: 'batch-1',
      status: 200,
      // no txHash → route skips the read-only RPC integrity check
    });
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.success, true);
    assert.strictEqual(response.body.status, 'executed');

    mock.restoreAll();
  });

  await t.test('POST /api/actions/:actionId/confirm replays are rejected for a non-pending action', async () => {
    const mockSelect = mock.fn(() => ({
      from: mock.fn(() => ({
        where: mock.fn(async () => [
          { id: 'act-done', userId: 'default-user', status: 'executed', metadata: {}, createdAt: new Date(), updatedAt: new Date() },
        ]),
      })),
    }));
    mock.method(db, 'select', mockSelect);

    const response = await request(app).post('/api/actions/act-done/confirm').send({ batchId: 'batch-1', status: 200 });
    assert.strictEqual(response.status, 400);
    assert.strictEqual(response.body.success, false);

    mock.restoreAll();
  });

  await t.test('T19.9: POST /api/actions/:actionId/confirm must not mark executed when txHash, batchId, and receipts are all null', async () => {
    let updatedStatus: string | null = null;
    const mockSelect = mock.fn(() => ({
      from: mock.fn(() => ({
        where: mock.fn(async () => [
          {
            id: 'act-confirm-null', userId: 'default-user', status: 'pending',
            executionPayload: { chain: 'eip155:8453', calls: [{ to: BASE_MAINNET_USDC }] },
            metadata: { instruction: 'Revoke allowance' },
            createdAt: new Date(), updatedAt: new Date(),
          },
        ]),
      })),
    }));
    const mockUpdate = mock.fn(() => ({
      set: mock.fn((vals: any) => {
        updatedStatus = vals.status;
        return { where: mock.fn(async () => []) };
      }),
    }));
    mock.method(db, 'select', mockSelect);
    mock.method(db, 'update', mockUpdate);
    const { ObservabilityService } = await import('@mioagent/observability');
    mock.method(ObservabilityService, 'logAction', async () => {});

    const response = await request(app).post('/api/actions/act-confirm-null/confirm').send({
      batchId: null,
      status: 200,
      txHash: null,
      receipts: null,
    });
    assert.strictEqual(response.status, 200);
    assert.notStrictEqual(response.body.status, 'executed', 'Must not be executed when proof is null');
    assert.strictEqual(response.body.status, 'failed', 'Must fail when no execution proof is provided');
    assert.strictEqual(updatedStatus, 'failed');

    mock.restoreAll();
  });

  await t.test('T19.9: POST /api/actions/:actionId/confirm sets pending_confirmation when status is 102 (submitted, waiting for receipt)', async () => {
    let updatedStatus: string | null = null;
    const mockSelect = mock.fn(() => ({
      from: mock.fn(() => ({
        where: mock.fn(async () => [
          {
            id: 'act-confirm-pending', userId: 'default-user', status: 'pending',
            executionPayload: { chain: 'eip155:8453', calls: [{ to: BASE_MAINNET_USDC }] },
            metadata: { instruction: 'Revoke allowance' },
            createdAt: new Date(), updatedAt: new Date(),
          },
        ]),
      })),
    }));
    const mockUpdate = mock.fn(() => ({
      set: mock.fn((vals: any) => {
        updatedStatus = vals.status;
        return { where: mock.fn(async () => []) };
      }),
    }));
    mock.method(db, 'select', mockSelect);
    mock.method(db, 'update', mockUpdate);
    const { ObservabilityService } = await import('@mioagent/observability');
    mock.method(ObservabilityService, 'logAction', async () => {});

    const response = await request(app).post('/api/actions/act-confirm-pending/confirm').send({
      batchId: 'batch-xyz',
      status: 102,
    });
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.status, 'pending_confirmation');
    assert.strictEqual(updatedStatus, 'pending_confirmation');

    mock.restoreAll();
  });

  await t.test('T19.9: POST /api/actions/:actionId/confirm sets cancelled when status is 4001', async () => {
    let updatedStatus: string | null = null;
    const mockSelect = mock.fn(() => ({
      from: mock.fn(() => ({
        where: mock.fn(async () => [
          {
            id: 'act-confirm-cancel', userId: 'default-user', status: 'pending',
            executionPayload: { chain: 'eip155:8453', calls: [{ to: BASE_MAINNET_USDC }] },
            metadata: { instruction: 'Revoke allowance' },
            createdAt: new Date(), updatedAt: new Date(),
          },
        ]),
      })),
    }));
    const mockUpdate = mock.fn(() => ({
      set: mock.fn((vals: any) => {
        updatedStatus = vals.status;
        return { where: mock.fn(async () => []) };
      }),
    }));
    mock.method(db, 'select', mockSelect);
    mock.method(db, 'update', mockUpdate);
    const { ObservabilityService } = await import('@mioagent/observability');
    mock.method(ObservabilityService, 'logAction', async () => {});

    const response = await request(app).post('/api/actions/act-confirm-cancel/confirm').send({
      batchId: '',
      status: 4001,
      error: 'User rejected the request',
    });
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.status, 'cancelled');
    assert.strictEqual(updatedStatus, 'cancelled');

    mock.restoreAll();
  });

  // T19.2: revoke-approval discovery. A revoke for a spender with no real
  // provider-discovered USDC allowance must NOT create a confirmable action —
  // and must NOT create a generic read-only recommendation either. It returns
  // an honest "nothing to revoke" note and inserts nothing.
  const FAKE_SPENDER = '0x1111111111111111111111111111111111111111';
  const MOCK_USDC_SPENDER = '0x9999999999999999999999999999999999999999'; // MockApprovalProvider: unlimited USDC

  await t.test('POST /api/actions/recommend revoke for a fake spender creates a read-only recommendation with calls.length=0 and message "No active approval found"', async () => {
    const origChain = process.env.CHAIN_ENV;
    const origApproval = process.env.APPROVAL_PROVIDER;
    process.env.CHAIN_ENV = 'mainnet-readonly';
    process.env.APPROVAL_PROVIDER = 'none';

    const onConflictMock = mock.fn(async () => []);
    const valuesMock = mock.fn((_vals?: any) => ({ onConflictDoNothing: onConflictMock }));
    const insertMock = mock.fn(() => ({ values: valuesMock }));
    mock.method(db, 'insert', insertMock);

    const response = await request(app).post('/api/actions/recommend').send({
      instruction: `revoke approval for ${FAKE_SPENDER}`,
      walletAddress: '0x1234567890123456789012345678901234567890',
      chainEnv: 'mainnet-readonly',
    });
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.success, true);
    assert.strictEqual(insertMock.mock.calls.length, 1, 'must insert a read-only recommendation for a missing approval');

    const insertedRow = valuesMock.mock.calls[0].arguments[0] as any;
    const payload = typeof insertedRow.executionPayload === 'string'
      ? JSON.parse(insertedRow.executionPayload)
      : insertedRow.executionPayload;
    assert.strictEqual(payload.actionType, undefined);
    assert.strictEqual(payload.calls.length, 0);
    assert.ok(String(insertedRow.metadata.message).includes('No active approval found'));

    mock.restoreAll();
    if (origChain === undefined) delete process.env.CHAIN_ENV; else process.env.CHAIN_ENV = origChain;
    if (origApproval === undefined) delete process.env.APPROVAL_PROVIDER; else process.env.APPROVAL_PROVIDER = origApproval;
  });

  await t.test('POST /api/actions/recommend revoke for a real USDC approval creates a confirmable revoke_approval', async () => {
    const origChain = process.env.CHAIN_ENV;
    const origApproval = process.env.APPROVAL_PROVIDER;
    const origBalances = process.env.TOKEN_BALANCES_PROVIDER;
    const origPrice = process.env.PRICE_PROVIDER;
    const origSecurity = process.env.TOKEN_SECURITY_PROVIDER;
    process.env.CHAIN_ENV = 'mainnet-readonly';
    process.env.APPROVAL_PROVIDER = 'mock';
    process.env.TOKEN_BALANCES_PROVIDER = 'none';
    process.env.PRICE_PROVIDER = 'none';
    process.env.TOKEN_SECURITY_PROVIDER = 'none';

    // Capture the inserted row via the db.insert().values() chain.
    const onConflictMock = mock.fn(async () => []);
    const valuesMock = mock.fn((_vals?: any) => ({ onConflictDoNothing: onConflictMock }));
    const insertMock = mock.fn(() => ({ values: valuesMock }));
    mock.method(db, 'insert', insertMock);

    const response = await request(app).post('/api/actions/recommend').send({
      instruction: `revoke approval for ${MOCK_USDC_SPENDER}`,
      walletAddress: '0x1234567890123456789012345678901234567890',
      chainEnv: 'mainnet-readonly',
    });
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.success, true);
    assert.ok(response.body.actionId, 'expected an actionId for a created revoke');
    assert.strictEqual(insertMock.mock.calls.length, 1, 'expected exactly one insert');

    const insertedRow = valuesMock.mock.calls[0].arguments[0] as any;
    const payload = typeof insertedRow.executionPayload === 'string'
      ? JSON.parse(insertedRow.executionPayload)
      : insertedRow.executionPayload;
    assert.strictEqual(payload.actionType, 'revoke_approval');
    assert.ok(Array.isArray(payload.calls) && payload.calls.length === 1);
    // ERC-20 approve(address,uint256) selector = 0x095ea7b3
    assert.ok(String(payload.calls[0].data).toLowerCase().startsWith('0x095ea7b3'));
    assert.ok(String(payload.calls[0].data).toLowerCase().includes(MOCK_USDC_SPENDER.toLowerCase().slice(2)));

    mock.restoreAll();
    if (origChain === undefined) delete process.env.CHAIN_ENV; else process.env.CHAIN_ENV = origChain;
    if (origApproval === undefined) delete process.env.APPROVAL_PROVIDER; else process.env.APPROVAL_PROVIDER = origApproval;
    if (origBalances === undefined) delete process.env.TOKEN_BALANCES_PROVIDER; else process.env.TOKEN_BALANCES_PROVIDER = origBalances;
    if (origPrice === undefined) delete process.env.PRICE_PROVIDER; else process.env.PRICE_PROVIDER = origPrice;
    if (origSecurity === undefined) delete process.env.TOKEN_SECURITY_PROVIDER; else process.env.TOKEN_SECURITY_PROVIDER = origSecurity;
  });
});
