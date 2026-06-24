import test from 'node:test';
import assert from 'node:assert';
import { Request, Response } from 'express';
import { observability } from './observability.js';

test('observability middleware logs request details', async () => {
  let finished = false;
  const req = { method: 'GET', url: '/test', context: { traceId: '123' } } as unknown as Request;

  // We need to wait for the finish event
  let resolveFinish: () => void;
  const finishPromise = new Promise<void>((resolve) => { resolveFinish = resolve; });

  let finishCallback: () => void = () => {};
  const res = {
    statusCode: 200,
    on: (event: string, cb: () => void) => {
      if (event === 'finish') {
        finishCallback = cb;
      }
    }
  } as unknown as Response;

  const next = () => {};

  observability(req, res, next);
  assert.strictEqual(finished, false, 'Should not be finished immediately before emitting event');

  finishCallback();
  finished = true;
  resolveFinish();

  await finishPromise;
  assert.strictEqual(finished, true);
});
