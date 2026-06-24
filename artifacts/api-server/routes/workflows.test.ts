import test from 'node:test';
import assert from 'node:assert';
import request from 'supertest';
import { app } from '../app';
import { mock } from 'node:test';
import { db } from '@mioagent/db';

test('Workflows API', async (t) => {
  await t.test('GET /api/workflows returns workflows', async () => {
    const mockSelect = mock.fn(() => ({
      from: mock.fn(() => ({
        where: mock.fn(() => ({
          orderBy: mock.fn(async () => [
            {
              id: 'wf-1',
              userId: 'default-user',
              instructions: 'Do a thing',
              toolAllowlist: null,
              intervalMs: 60000,
              lastRun: null,
              createdAt: new Date('2024-01-01T00:00:00Z'),
              updatedAt: new Date('2024-01-01T00:00:00Z'),
            }
          ]),
        })),
      })),
    }));
    mock.method(db, 'select', mockSelect);

    const res = await request(app).get('/api/workflows');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.workflows.length, 1);
    assert.strictEqual(res.body.workflows[0].id, 'wf-1');
  });

  await t.test('POST /api/workflows creates a workflow', async () => {
    const mockInsert = mock.fn(() => ({
      values: mock.fn(() => ({
        returning: mock.fn(async () => [
          {
            id: 'wf-2',
            userId: 'default-user',
            instructions: 'New thing',
            toolAllowlist: null,
            intervalMs: 120000,
            lastRun: null,
            createdAt: new Date('2024-01-01T00:00:00Z'),
            updatedAt: new Date('2024-01-01T00:00:00Z'),
          }
        ]),
      })),
    }));
    mock.method(db, 'insert', mockInsert);

    const res = await request(app).post('/api/workflows').send({
      instructions: 'New thing',
      intervalMs: 120000,
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.success, true);
    assert.strictEqual(res.body.workflow.id, 'wf-2');
    assert.strictEqual(res.body.workflow.instructions, 'New thing');
  });

  await t.test('DELETE /api/workflows/:id deletes a workflow', async () => {
    const mockDelete = mock.fn(() => ({
      where: mock.fn(async () => []),
    }));
    mock.method(db, 'delete', mockDelete);

    const res = await request(app).delete('/api/workflows/wf-1');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.success, true);
  });
});
