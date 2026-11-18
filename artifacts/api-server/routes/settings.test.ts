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

// Audit P2 Settings, 2026-11-18: Autonomy keeps its policy inside
// protocolToggles, and every row that had one answered GET with a 500. A POST
// of toggles replaced the record and would have erased the policy with it.
test('a settings row that holds an Autonomy policy', async (t) => {
  mock.restoreAll();
  const AUTONOMY = { status: 'configured', killSwitch: false, dailyLimitUsdc: '5', whitelist: ['0x1111111111111111111111111111111111111111'] };
  let stored: { model: string | null; protocolToggles: Record<string, unknown> | null; memoryMd: null; encryptedKeys: null };
  const writes: Record<string, unknown>[] = [];
  t.beforeEach(() => {
    stored = { model: 'fixture', protocolToggles: { 'base-mcp': true, goplus: false, autonomy: structuredClone(AUTONOMY) }, memoryMd: null, encryptedKeys: null };
    writes.length = 0;
  });
  // The store as MemoryService.updateUserSettings writes it: each column given replaces the stored one.
  t.mock.method(MemoryService, 'getUserSettings', async () => structuredClone(stored));
  t.mock.method(MemoryService, 'updateUserSettings', async (_userId: string, data: Record<string, unknown>) => {
    writes.push(structuredClone(data));
    stored = { ...stored, ...structuredClone(data) };
    return stored;
  });

  await t.test('GET answers 200 with the boolean toggles only', async () => {
    const response = await request(app).get('/api/settings');
    assert.strictEqual(response.status, 200);
    assert.deepStrictEqual(response.body.protocolToggles, { 'base-mcp': true, goplus: false });
    assert.strictEqual(response.body.chosenModel, 'fixture');
  });

  await t.test('POST of toggles merges them and keeps the Autonomy policy intact', async () => {
    const response = await request(app).post('/api/settings').send({ protocolToggles: { goplus: true, moralis: false } });
    assert.strictEqual(response.status, 200);
    assert.deepStrictEqual(response.body.protocolToggles, { 'base-mcp': true, goplus: true, moralis: false });
    assert.deepStrictEqual(stored.protocolToggles, { 'base-mcp': true, goplus: true, moralis: false, autonomy: AUTONOMY });
  });

  await t.test('a toggle never overwrites the policy that holds its name', async () => {
    const response = await request(app).post('/api/settings').send({ protocolToggles: { autonomy: false } });
    assert.strictEqual(response.status, 200);
    assert.deepStrictEqual(stored.protocolToggles?.autonomy, AUTONOMY);
  });

  await t.test('a model change keeps both the toggles and the policy', async () => {
    const response = await request(app).post('/api/settings').send({ chosenModel: 'another-model' });
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.chosenModel, 'another-model');
    assert.deepStrictEqual(response.body.protocolToggles, { 'base-mcp': true, goplus: false });
    assert.deepStrictEqual(writes, [{ model: 'another-model' }]);
    assert.deepStrictEqual(stored.protocolToggles, { 'base-mcp': true, goplus: false, autonomy: AUTONOMY });
  });
});
