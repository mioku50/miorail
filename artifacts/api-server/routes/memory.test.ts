import test from 'node:test';
import assert from 'node:assert';
import request from 'supertest';
import { app } from '../app';
import { mock } from 'node:test';
import { MemoryService } from '@mioagent/memory';

test('Memory API', async (t) => {
  await t.test('GET /api/memory returns empty memory when none exists', async () => {
    mock.method(MemoryService, 'getUserSettings', async () => null);

    const response = await request(app).get('/api/memory');
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.memoryMd, null);
  });

  await t.test('POST /api/memory updates memory', async () => {
    mock.method(MemoryService, 'updateUserSettings', async () => ({
      memoryMd: 'New memory',
      model: null,
      protocolToggles: null,
      encryptedKeys: null,
      updatedAt: new Date('2026-07-13T00:00:00.000Z'),
    }));

    const response = await request(app)
      .post('/api/memory')
      .send({ memoryMd: 'New memory' });

    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.memoryMd, 'New memory');
  });
});
