import test from 'node:test';
import assert from 'node:assert';
import request from 'supertest';
import { app } from '../app';
import { mock } from 'node:test';
import { MemoryService } from '@mioagent/memory';

test('Settings API', async (t) => {
  await t.test('GET /api/settings returns settings', async () => {
    mock.method(MemoryService, 'getUserSettings', async () => ({
        model: 'gpt-4o',
        protocolToggles: { test: true },
        memoryMd: null,
        encryptedKeys: null
    }));

    const response = await request(app).get('/api/settings');
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.chosenModel, 'gpt-4o');
    assert.deepStrictEqual(response.body.protocolToggles, { test: true });
  });

  await t.test('POST /api/settings updates settings', async () => {
    mock.method(MemoryService, 'updateUserSettings', async () => {});
    mock.method(MemoryService, 'getUserSettings', async () => ({
        model: 'gpt-3.5',
        protocolToggles: { test: false },
        memoryMd: null,
        encryptedKeys: null
    }));

    const response = await request(app)
      .post('/api/settings')
      .send({ chosenModel: 'gpt-3.5', protocolToggles: { test: false } });

    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.chosenModel, 'gpt-3.5');
    assert.deepStrictEqual(response.body.protocolToggles, { test: false });
  });
});
