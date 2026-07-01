import test, { describe } from 'node:test';
import assert from 'node:assert';
import request from 'supertest';
import { app } from '../app.js';
import { db, actions } from '@mioagent/db';
import { eq } from 'drizzle-orm';

describe('Chat API & Recommendation Guardrails', () => {
  test('DELETE /api/chat/history clears chat history and GET returns empty list', async () => {
    const delRes = await request(app).delete('/api/chat/history');
    assert.strictEqual(delRes.status, 200);
    assert.strictEqual(delRes.body.success, true);

    const getRes = await request(app).get('/api/chat/history');
    assert.strictEqual(getRes.status, 200);
    assert.deepStrictEqual(getRes.body.messages, []);
  });

  test('POST /api/chat with action intent in mainnet-readonly generates blocked read-only recommendation', async () => {
    await request(app).delete('/api/chat/history');

    const response = await request(app)
      .post('/api/chat')
      .send({
        message: 'check my token portfolio and rebalance risky assets',
        walletAddress: '0x1234567890123456789012345678901234567890',
        chainEnv: 'mainnet-readonly'
      });

    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.role, 'assistant');
    assert.ok(response.body.actionId);
    assert.strictEqual(response.body.metadata.type, 'recommendation');

    const dbActions = await db.select().from(actions).where(eq(actions.id, response.body.actionId));
    assert.strictEqual(dbActions.length, 1);
    const createdAction = dbActions[0];
    assert.strictEqual(createdAction.kind, 'recommendation');
    assert.strictEqual((createdAction.metadata as any).safetyState, 'blocked');
    assert.strictEqual((createdAction.metadata as any).chainMode, 'mainnet-readonly');

    const payload = typeof createdAction.executionPayload === 'string'
      ? JSON.parse(createdAction.executionPayload)
      : createdAction.executionPayload;
    assert.strictEqual(payload.readOnly, true);
    assert.deepStrictEqual(payload.calls, []);
  });
});
