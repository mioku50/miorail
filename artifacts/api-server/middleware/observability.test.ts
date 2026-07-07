import test from 'node:test';
import assert from 'node:assert';
import { Request, Response } from 'express';
import { observability, sanitizeRequestUrlForLogs } from './observability.js';

test('observability middleware logs request details', async () => {
  let finished = false;
  const req = { method: 'GET', url: '/test', context: { traceId: '123' } } as unknown as Request;

  // We need to wait for the finish event
  let resolveFinish!: () => void;
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

test('observability middleware redacts Base MCP OAuth callback secrets from logged URLs', () => {
  assert.strictEqual(
    sanitizeRequestUrlForLogs('/api/mcp/base/callback?code=auth-code&state=oauth-state&error=access_denied'),
    '/api/mcp/base/callback?code=%5Bredacted%5D&state=%5Bredacted%5D&error=access_denied',
  );
  assert.strictEqual(
    sanitizeRequestUrlForLogs('/callback?code=auth-code&state=oauth-state'),
    '/callback?code=%5Bredacted%5D&state=%5Bredacted%5D',
  );
  assert.strictEqual(
    sanitizeRequestUrlForLogs('/api/status?state=portfolio'),
    '/api/status?state=portfolio',
  );
});
