import test from 'node:test';
import assert from 'node:assert';
import request from 'supertest';
import { app } from '../app';
process.env.CHAIN_ENV = 'sepolia';
// T67X-B2: the mainnet cases below activate execution, which now also requires
// a usable ERC-8021 Builder Code. Set once here rather than in each case — the
// gate is a property of the environment, not of any individual test.
process.env.BASE_BUILDER_CODE ||= 'bc_a1b2c3d4';
import { mock } from 'node:test';
import { db } from '@mioagent/db';
import * as toolsModule from '@mioagent/tools';
import { actionProofRuntime } from '../lib/actionProofs.js';
import { InMemoryAutonomyPolicyRepository } from '@mioagent/autonomy';
import { setAutonomyPolicyRepositoryForTests } from '../lib/autonomyGateway.js';
import { actionsRouteRuntime } from './actions.js';
import { providerFactoryRuntime } from '@mioagent/data-providers';
import { MockApprovalProvider } from '@mioagent/data-providers/testing';

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
    let updatedStatus: string | null = null;

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
            executionPayload: { chain: '84532', calls: [{ to: '0x123' }] },
            createdAt: new Date('2024-01-01T00:00:00Z'),
            updatedAt: new Date('2024-01-01T00:00:00Z'),
          }
        ]),
      })),
    }));

    const mockUpdate = mock.fn(() => ({
      set: mock.fn((vals: any) => {
        updatedStatus = vals.status;
        return {
          where: mock.fn(async () => []),
        };
      }),
    }));

    mock.method(db, 'select', mockSelect);
    mock.method(db, 'update', mockUpdate);

    const { MemoryService } = await import('@mioagent/memory');
    mock.method(MemoryService, 'getUserSettings', async () => null);

    mock.method(toolsModule.ToolAggregator.prototype, 'findTool', (name: string) => {
      assert.strictEqual(name, 'sepolia_send_calls');
      return { name: 'sepolia_send_calls' };
    });
    mock.method(toolsModule.ToolAggregator.prototype, 'callTool', async (name: any, payload: any) => {
       assert.strictEqual(name, 'sepolia_send_calls');
       assert.deepStrictEqual(payload, { chain: '84532', calls: [{ to: '0x123' }] });
       return { content: JSON.stringify({ approvalUrl: "https://mock.base.org/approve/123", requestId: "123" }), isError: false };
    });

    const response = await request(app).post('/api/actions/action-1/execute');
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.success, true);
    assert.ok(response.body.approvalUrl);
    assert.strictEqual(updatedStatus, 'pending_confirmation');

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
            tokens: ['{"chain":"84532","calls":[{"to":"0x456"}]}'],
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
    mock.method(toolsModule.ToolAggregator.prototype, 'findTool', (name: string) => {
      assert.strictEqual(name, 'sepolia_send_calls');
      return { name: 'sepolia_send_calls' };
    });
    mock.method(toolsModule.ToolAggregator.prototype, 'callTool', async (name: any, payload: any) => {
       assert.strictEqual(name, 'sepolia_send_calls');
       assert.deepStrictEqual(payload, { chain: '84532', calls: [{ to: '0x456' }] });
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

  await t.test('POST /api/actions/:actionId/prepare blocks a safe USDC transfer while mainnet is read-only', async () => {
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
    mock.method(db, 'update', () => ({ set: () => ({ where: async () => [] }) }) as any);
    mock.method(actionsRouteRuntime, 'loadExecutionSecurityContext', async () => ({
      required: true,
      providerContext: { risk: 'connected', riskProvider: 'goplus', securityProvider: 'goplus' },
      tokenSecurity: [{ address: BASE_MAINNET_USDC, provider: 'goplus', status: 'ok' }],
    }));

    const response = await request(app).post('/api/actions/act-prepare/prepare');
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.success, false);
    assert.match(response.body.error, /Mainnet is read-only/);

    mock.restoreAll();
    process.env.CHAIN_ENV = 'sepolia';
  });

  await t.test('bounded mainnet prepare reserves budget and still returns only a wallet approval payload', async () => {
    process.env.CHAIN_ENV = 'mainnet';
    process.env.MAINNET_EXECUTION_ENABLED = 'true';
    const wallet = '0x9999999999999999999999999999999999999999';
    const recipient = '0x1111111111111111111111111111111111111111';
    const repository = new InMemoryAutonomyPolicyRepository();
    await repository.configure({
      userId: 'default-user',
      chainId: 8453,
      walletAddress: wallet,
      dailyLimit: 10,
      maxPerAction: 5,
      whitelist: [recipient],
      scope: 'bounded-approval',
      expiresAt: Date.now() + 60_000,
      mainnetOptIn: true,
    });
    setAutonomyPolicyRepositoryForTests(repository);

    let updatedMetadata: any = null;
    const mockSelect = mock.fn(() => ({
      from: mock.fn(() => ({
        where: mock.fn(async () => [{
          id: 'act-bounded',
          userId: 'default-user',
          kind: 'recommendation',
          status: 'pending',
          suggestedPrompt: 'Transfer 1 USDC to an approved recipient',
          executionPayload: {
            chain: 'eip155:8453',
            actionType: 'limited_transfer',
            calls: [{
              to: BASE_MAINNET_USDC,
              value: '0',
              data: `0xa9059cbb${recipient.slice(2).padStart(64, '0')}${(1_000_000).toString(16).padStart(64, '0')}`,
            }],
          },
          metadata: { instruction: 'Transfer 1 USDC to an approved recipient', walletAddress: wallet },
          createdAt: new Date(),
          updatedAt: new Date(),
        }]),
      })),
    }));
    const mockUpdate = mock.fn(() => ({
      set: mock.fn((values: any) => {
        updatedMetadata = values.metadata;
        return { where: mock.fn(async () => []) };
      }),
    }));
    mock.method(db, 'select', mockSelect);
    mock.method(db, 'update', mockUpdate);
    mock.method(actionsRouteRuntime, 'loadExecutionSecurityContext', async () => ({
      required: true,
      providerContext: { risk: 'connected', riskProvider: 'goplus', securityProvider: 'goplus' },
      tokenSecurity: [{ address: BASE_MAINNET_USDC, provider: 'goplus', status: 'ok' }],
    }));
    const { MemoryService } = await import('@mioagent/memory');
    mock.method(MemoryService, 'getUserSettings', async () => null);

    const response = await request(app).post('/api/actions/act-bounded/prepare').send({ walletAddress: wallet });
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.success, true);
    assert.strictEqual(response.body.executionMode, 'bounded-approval');
    assert.strictEqual(response.body.requiresUserApproval, true);
    assert.strictEqual(response.body.from, wallet);
    assert.strictEqual(response.body.autonomy.amountUsdc, 1);
    assert.strictEqual((await repository.getByUser('default-user', 8453))?.reservedToday, 1);
    assert.strictEqual(updatedMetadata.autonomyReservation.status, 'reserved');

    mock.restoreAll();
    process.env.CHAIN_ENV = 'sepolia';
    process.env.MAINNET_EXECUTION_ENABLED = 'false';
  });

  await t.test('T47: native action preparation is rejected after its typed intent was invalidated', async () => {
    process.env.CHAIN_ENV = 'mainnet';
    process.env.MAINNET_EXECUTION_ENABLED = 'true';
    let selectCount = 0;
    const mockSelect = mock.fn(() => ({
      from: mock.fn(() => ({
        where: mock.fn(async () => {
          selectCount += 1;
          if (selectCount > 1) return [];
          return [{
            id: 'act-native-invalidated',
            userId: 'default-user',
            kind: 'transaction',
            status: 'pending',
            suggestedPrompt: 'Transfer 1 USDC',
            executionPayload: {
              chain: 'eip155:8453',
              actionType: 'limited_transfer',
              calls: [{
                to: BASE_MAINNET_USDC,
                value: '0',
                data: `0xa9059cbb${'1'.padStart(64, '0')}${(1_000_000).toString(16).padStart(64, '0')}`,
              }],
            },
            metadata: {
              createdBy: 'baseapp-native-routing',
              instruction: 'Transfer 1 USDC',
              walletAddress: '0x0000000000000000000000000000000000000000',
            },
            createdAt: new Date(),
            updatedAt: new Date(),
          }];
        }),
      })),
    }));
    mock.method(db, 'select', mockSelect);
    const { MemoryService } = await import('@mioagent/memory');
    mock.method(MemoryService, 'getUserSettings', async () => null);

    const response = await request(app).post('/api/actions/act-native-invalidated/prepare');

    assert.strictEqual(response.status, 403);
    assert.match(response.body.error, /intent is missing/);
    assert.strictEqual(selectCount, 2);

    mock.restoreAll();
    process.env.CHAIN_ENV = 'sepolia';
    process.env.MAINNET_EXECUTION_ENABLED = 'false';
  });

  await t.test('unified prepare guard rejects actionType/calldata mismatch before wallet approval', async () => {
    process.env.CHAIN_ENV = 'mainnet';
    process.env.MAINNET_EXECUTION_ENABLED = 'true';
    const spender = '0x2222222222222222222222222222222222222222';
    const mockSelect = mock.fn(() => ({
      from: mock.fn(() => ({
        where: mock.fn(async () => [{
          id: 'act-semantic-mismatch',
          userId: 'default-user',
          status: 'pending',
          suggestedPrompt: 'Revoke approval',
          executionPayload: {
            chain: 'eip155:8453',
            actionType: 'revoke_approval',
            calls: [{
              to: BASE_MAINNET_USDC,
              value: '0',
              data: `0x095ea7b3${spender.slice(2).padStart(64, '0')}${'1'.padStart(64, '0')}`,
            }],
          },
          metadata: { instruction: 'Revoke approval' },
          createdAt: new Date(),
          updatedAt: new Date(),
        }]),
      })),
    }));
    mock.method(db, 'select', mockSelect);
    mock.method(actionsRouteRuntime, 'loadExecutionSecurityContext', async () => ({
      required: false,
      providerContext: { risk: 'missing', riskProvider: 'none', securityProvider: 'none' },
      tokenSecurity: [],
    }));

    const response = await request(app).post('/api/actions/act-semantic-mismatch/prepare');
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.success, false);
    assert.match(response.body.error, /approve\(spender, 0\)/);
    assert.strictEqual(response.body.guard.code, 'action_calldata_mismatch');

    mock.restoreAll();
    process.env.CHAIN_ENV = 'sepolia';
  });

  await t.test('POST /api/actions/:actionId/prepare rejects a payload whose actionType is not whitelisted', async () => {
    process.env.CHAIN_ENV = 'mainnet';
    process.env.MAINNET_EXECUTION_ENABLED = 'true';
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

  await t.test('T19.10: POST /api/actions/:actionId/confirm can execute revoke_approval without txHash only when allowance is verified zero', async () => {
    const wallet = '0x1234567890123456789012345678901234567890';
    const spender = '0x9999999999999999999999999999999999999999';
    let updatedStatus: string | null = null;
    let updatedMetadata: any = null;
    const mockSelect = mock.fn(() => ({
      from: mock.fn(() => ({
        where: mock.fn(async () => [
          {
            id: 'act-confirm', userId: 'default-user', status: 'pending',
            executionPayload: { chain: 'eip155:8453', actionType: 'revoke_approval', calls: [{ to: BASE_MAINNET_USDC }] },
            metadata: {
              actionType: 'revoke_approval',
              instruction: 'Revoke allowance',
              walletAddress: wallet,
              tokenAddress: BASE_MAINNET_USDC,
              spender,
            },
            createdAt: new Date(), updatedAt: new Date(),
          },
        ]),
      })),
    }));
    const mockUpdate = mock.fn(() => ({
      set: mock.fn((vals: any) => {
        updatedStatus = vals.status;
        updatedMetadata = vals.metadata;
        return { where: mock.fn(async () => []) };
      }),
    }));
    mock.method(db, 'select', mockSelect);
    mock.method(db, 'update', mockUpdate);
    mock.method(actionProofRuntime, 'readErc20Allowance', async (ctx: any) => {
      assert.strictEqual(ctx.wallet, wallet);
      assert.strictEqual(ctx.token, BASE_MAINNET_USDC);
      assert.strictEqual(ctx.spender, spender);
      return 0n;
    });
    const { ObservabilityService } = await import('@mioagent/observability');
    mock.method(ObservabilityService, 'logAction', async () => {});

    const response = await request(app).post('/api/actions/act-confirm/confirm').send({
      status: 200,
      txHash: null,
      batchId: null,
      receipts: null,
    });
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.success, true);
    assert.strictEqual(response.body.status, 'executed');
    assert.strictEqual(updatedStatus, 'executed');
    assert.strictEqual(updatedMetadata.executionProof.type, 'state_verified_allowance_zero');
    assert.strictEqual(updatedMetadata.executionProof.allowanceAfter, '0');
    assert.strictEqual(updatedMetadata.txHash, undefined);

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

  await t.test('T19.10: POST /api/actions/:actionId/confirm must not mark executed with batchId only and no wallet_getCallsStatus receipts', async () => {
    let updatedStatus: string | null = null;
    const mockSelect = mock.fn(() => ({
      from: mock.fn(() => ({
        where: mock.fn(async () => [
          {
            id: 'act-confirm-batch-only', userId: 'default-user', status: 'pending',
            executionPayload: { chain: 'eip155:8453', actionType: 'limited_transfer', calls: [{ to: BASE_MAINNET_USDC }] },
            metadata: { instruction: 'Transfer 1 USDC' },
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

    const response = await request(app).post('/api/actions/act-confirm-batch-only/confirm').send({
      batchId: 'batch-without-proof',
      status: 200,
      txHash: null,
      receipts: null,
    });
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.status, 'failed');
    assert.strictEqual(updatedStatus, 'failed');

    mock.restoreAll();
  });

  await t.test('T19.10: GET /api/actions repairs polluted executed revoke_approval rows or downgrades them', async () => {
    const wallet = '0x1234567890123456789012345678901234567890';
    const zeroSpender = '0x9999999999999999999999999999999999999999';
    const liveSpender = '0x8888888888888888888888888888888888888888';
    const updates: Array<{ status: string; metadata: any }> = [];
    const mockSelect = mock.fn(() => ({
      from: mock.fn(() => ({
        where: mock.fn(() => ({
          orderBy: mock.fn(() => ({
            limit: mock.fn(async () => [
              {
                id: 'act-stale-zero',
                userId: 'default-user',
                kind: 'transaction',
                status: 'executed',
                suggestedPrompt: 'Builder: revoke approval',
                tokens: [],
                executionPayload: { chain: 'eip155:8453', actionType: 'revoke_approval', calls: [{ to: BASE_MAINNET_USDC }] },
                metadata: { actionType: 'revoke_approval', walletAddress: wallet, tokenAddress: BASE_MAINNET_USDC, spender: zeroSpender },
                createdAt: new Date('2026-01-01T00:00:00Z'),
                updatedAt: new Date('2026-01-01T00:00:00Z'),
                executedAt: new Date('2026-01-01T00:00:00Z'),
              },
              {
                id: 'act-stale-live',
                userId: 'default-user',
                kind: 'transaction',
                status: 'executed',
                suggestedPrompt: 'Builder: revoke approval',
                tokens: [],
                executionPayload: { chain: 'eip155:8453', actionType: 'revoke_approval', calls: [{ to: BASE_MAINNET_USDC }] },
                metadata: { actionType: 'revoke_approval', walletAddress: wallet, tokenAddress: BASE_MAINNET_USDC, spender: liveSpender },
                createdAt: new Date('2026-01-01T00:01:00Z'),
                updatedAt: new Date('2026-01-01T00:01:00Z'),
                executedAt: new Date('2026-01-01T00:01:00Z'),
              },
            ]),
          })),
        })),
      })),
    }));
    const mockUpdate = mock.fn(() => ({
      set: mock.fn((vals: any) => {
        updates.push({ status: vals.status, metadata: vals.metadata });
        return { where: mock.fn(async () => []) };
      }),
    }));
    mock.method(db, 'select', mockSelect);
    mock.method(db, 'update', mockUpdate);
    mock.method(actionProofRuntime, 'readErc20Allowance', async (ctx: any) => {
      return ctx.spender === zeroSpender ? 0n : 7n;
    });

    const response = await request(app).get('/api/actions');
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.actions.length, 2);
    const repaired = response.body.actions.find((a: any) => a.id === 'act-stale-zero');
    const downgraded = response.body.actions.find((a: any) => a.id === 'act-stale-live');
    assert.strictEqual(repaired.status, 'executed');
    assert.strictEqual(repaired.metadata.executionProof.type, 'state_verified_allowance_zero');
    assert.strictEqual(downgraded.status, 'failed');
    assert.ok(downgraded.metadata.repairError.message.includes('current allowance is not zero'));
    assert.strictEqual(updates.length, 2);

    mock.restoreAll();
  });

  await t.test('T19.12: GET /api/actions normalizes metadata.confirmation proof and exposes aliases', async () => {
    const txHash = '0xabc1230000000000000000000000000000000000000000000000000000000000';
    const batchId = '0xbatch1234567890abcdef';
    const updates: any[] = [];
    const mockSelect = mock.fn(() => ({
      from: mock.fn(() => ({
        where: mock.fn(() => ({
          orderBy: mock.fn(() => ({
            limit: mock.fn(async () => [
              {
                id: 'act-confirmed-proof',
                userId: 'default-user',
                kind: 'transaction',
                status: 'executed',
                suggestedPrompt: 'Builder: revoke approval',
                tokens: [],
                executionPayload: { chain: 'eip155:8453', actionType: 'revoke_approval', calls: [{ to: BASE_MAINNET_USDC }] },
                metadata: {
                  actionType: 'revoke_approval',
                  allowanceAfter: '0',
                  confirmation: {
                    txHash,
                    batchId,
                    statusCode: 200,
                    confirmedAt: '2026-01-02T00:00:00Z',
                    receipts: [{ status: 'success', transactionHash: txHash }],
                    allowanceAfter: '0',
                  },
                },
                createdAt: new Date('2026-01-02T00:00:00Z'),
                updatedAt: new Date('2026-01-02T00:00:00Z'),
                executedAt: new Date('2026-01-02T00:00:00Z'),
              },
            ]),
          })),
        })),
      })),
    }));
    const mockUpdate = mock.fn(() => ({
      set: mock.fn((vals: any) => {
        updates.push(vals);
        return { where: mock.fn(async () => []) };
      }),
    }));
    mock.method(db, 'select', mockSelect);
    mock.method(db, 'update', mockUpdate);

    const response = await request(app).get('/api/actions');
    assert.strictEqual(response.status, 200);
    const action = response.body.actions[0];
    assert.strictEqual(action.status, 'executed');
    assert.strictEqual(action.txHash, txHash);
    assert.strictEqual(action.batchId, batchId);
    assert.strictEqual(action.receipts[0].status, 'success');
    assert.strictEqual(action.metadata.executionProof.type, 'wallet_confirmation_receipt');
    assert.strictEqual(action.metadata.executionProof.source, 'metadata.confirmation');
    assert.strictEqual(action.metadata.executionProof.txHash, txHash);
    assert.strictEqual(updates.length, 1);
    assert.strictEqual(updates[0].metadata.executionProof.type, 'wallet_confirmation_receipt');

    mock.restoreAll();
  });

  await t.test('T19.12: GET /api/actions downgrades executed non-revoke rows with no durable proof', async () => {
    let updateVals: any = null;
    const mockSelect = mock.fn(() => ({
      from: mock.fn(() => ({
        where: mock.fn(() => ({
          orderBy: mock.fn(() => ({
            limit: mock.fn(async () => [
              {
                id: 'act-no-proof',
                userId: 'default-user',
                kind: 'transaction',
                status: 'executed',
                suggestedPrompt: 'Transfer',
                tokens: [],
                executionPayload: { chain: 'eip155:8453', actionType: 'limited_transfer', calls: [{ to: BASE_MAINNET_USDC }] },
                metadata: { actionType: 'limited_transfer' },
                createdAt: new Date('2026-01-03T00:00:00Z'),
                updatedAt: new Date('2026-01-03T00:00:00Z'),
                executedAt: new Date('2026-01-03T00:00:00Z'),
              },
            ]),
          })),
        })),
      })),
    }));
    const mockUpdate = mock.fn(() => ({
      set: mock.fn((vals: any) => {
        updateVals = vals;
        return { where: mock.fn(async () => []) };
      }),
    }));
    mock.method(db, 'select', mockSelect);
    mock.method(db, 'update', mockUpdate);

    const response = await request(app).get('/api/actions');
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.actions[0].status, 'submitted_unknown');
    assert.ok(response.body.actions[0].metadata.repairError.message.includes('no durable execution proof'));
    assert.strictEqual(updateVals.status, 'submitted_unknown');
    assert.strictEqual(updateVals.executedAt, null);

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
  const MOCK_USDC_SPENDER = '0x9999999999999999999999999999999999999999'; // unit provider: unlimited USDC

  await t.test('POST /api/actions/recommend revoke for a fake spender creates a read-only recommendation with calls.length=0 and message "No active approval found"', async () => {
    const origChain = process.env.CHAIN_ENV;
    const origApproval = process.env.APPROVAL_PROVIDER;
    process.env.CHAIN_ENV = 'mainnet-readonly';
    process.env.APPROVAL_PROVIDER = 'none';

    const onConflictMock = mock.fn(async () => []);
    const valuesMock = mock.fn((_vals?: any) => ({ onConflictDoNothing: onConflictMock }));
    const insertMock = mock.fn(() => ({ values: valuesMock }));
    mock.method(db, 'insert', insertMock);
    const { MemoryService } = await import('@mioagent/memory');
    mock.method(MemoryService, 'getUserSettings', async () => null);

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
    providerFactoryRuntime.approvals = () => ({
      provider: new MockApprovalProvider(), status: 'Test approvals connected', statusCode: 'connected', providerName: 'moralis',
    });
    process.env.TOKEN_BALANCES_PROVIDER = 'none';
    process.env.PRICE_PROVIDER = 'none';
    process.env.TOKEN_SECURITY_PROVIDER = 'none';

    // Capture the inserted row via the db.insert().values() chain.
    const onConflictMock = mock.fn(async () => []);
    const valuesMock = mock.fn((_vals?: any) => ({ onConflictDoNothing: onConflictMock }));
    const insertMock = mock.fn(() => ({ values: valuesMock }));
    mock.method(db, 'insert', insertMock);
    const { MemoryService } = await import('@mioagent/memory');
    mock.method(MemoryService, 'getUserSettings', async () => null);

    const response = await request(app).post('/api/actions/recommend').send({
      instruction: `revoke approval for ${MOCK_USDC_SPENDER}`,
      walletAddress: '0x1234567890123456789012345678901234567890',
      chainEnv: 'mainnet-readonly',
    });
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.success, true);
    assert.ok(response.body.actionId, 'expected an actionId for a created revoke');
    const actionRows = valuesMock.mock.calls
      .map((call) => call.arguments[0] as any)
      .filter((row) => row?.executionPayload);
    assert.strictEqual(actionRows.length, 1, 'expected exactly one action insert');

    const insertedRow = actionRows[0];
    const payload = typeof insertedRow.executionPayload === 'string'
      ? JSON.parse(insertedRow.executionPayload)
      : insertedRow.executionPayload;
    assert.strictEqual(payload.actionType, 'revoke_approval');
    assert.ok(Array.isArray(payload.calls) && payload.calls.length === 1);
    // ERC-20 approve(address,uint256) selector = 0x095ea7b3
    assert.ok(String(payload.calls[0].data).toLowerCase().startsWith('0x095ea7b3'));
    assert.ok(String(payload.calls[0].data).toLowerCase().includes(MOCK_USDC_SPENDER.toLowerCase().slice(2)));

    mock.restoreAll();
    providerFactoryRuntime.approvals = undefined;
    if (origChain === undefined) delete process.env.CHAIN_ENV; else process.env.CHAIN_ENV = origChain;
    if (origApproval === undefined) delete process.env.APPROVAL_PROVIDER; else process.env.APPROVAL_PROVIDER = origApproval;
    if (origBalances === undefined) delete process.env.TOKEN_BALANCES_PROVIDER; else process.env.TOKEN_BALANCES_PROVIDER = origBalances;
    if (origPrice === undefined) delete process.env.PRICE_PROVIDER; else process.env.PRICE_PROVIDER = origPrice;
    if (origSecurity === undefined) delete process.env.TOKEN_SECURITY_PROVIDER; else process.env.TOKEN_SECURITY_PROVIDER = origSecurity;
  });
});
