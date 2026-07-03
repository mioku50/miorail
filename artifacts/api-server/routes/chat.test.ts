import test, { describe } from 'node:test';
import assert from 'node:assert';
import request from 'supertest';
import { app } from '../app.js';
import { db, actions } from '@mioagent/db';
import { eq } from 'drizzle-orm';
import { clearTokenSecurityCacheForTests } from '@mioagent/data-providers';

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

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
    clearTokenSecurityCacheForTests();
    const origSecurityProvider = process.env.TOKEN_SECURITY_PROVIDER;
    process.env.TOKEN_SECURITY_PROVIDER = 'none';
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
    assert.ok((createdAction.metadata as any).analysis);
    assert.ok((createdAction.metadata as any).analysis.securityProvider);
    assert.strictEqual((createdAction.metadata as any).analysis.portfolioSnapshot.walletAddress, '0x1234567890123456789012345678901234567890');
    assert.ok((createdAction.metadata as any).analysis.portfolioSnapshot.dataFreshness !== undefined);
    assert.ok(Array.isArray(createdAction.tokens));

    const payload = typeof createdAction.executionPayload === 'string'
      ? JSON.parse(createdAction.executionPayload)
      : createdAction.executionPayload;
    assert.strictEqual(payload.readOnly, true);
    assert.deepStrictEqual(payload.calls, []);
    restoreEnv('TOKEN_SECURITY_PROVIDER', origSecurityProvider);
  });

  test('POST /api/actions/recommend with portfolio intent generates analysis metadata', async () => {
    clearTokenSecurityCacheForTests();
    const origSecurityProvider = process.env.TOKEN_SECURITY_PROVIDER;
    process.env.TOKEN_SECURITY_PROVIDER = 'none';
    const response = await request(app)
      .post('/api/actions/recommend')
      .send({
        instruction: 'analyze my wallet tokens for risk',
        walletAddress: '0x1234567890123456789012345678901234567890',
        chainEnv: 'mainnet-readonly'
      });

    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.success, true);
    assert.ok(response.body.actionId);

    const dbActions = await db.select().from(actions).where(eq(actions.id, response.body.actionId));
    assert.strictEqual(dbActions.length, 1);
    const createdAction = dbActions[0];
    assert.ok((createdAction.metadata as any).analysis);
    assert.ok((createdAction.metadata as any).analysis.securityProvider);
    assert.ok((createdAction.metadata as any).analysis.portfolioSnapshot.tokenCount >= 1);
    restoreEnv('TOKEN_SECURITY_PROVIDER', origSecurityProvider);
  });
});
