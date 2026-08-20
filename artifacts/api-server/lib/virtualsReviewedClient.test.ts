import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import {
  callVirtualsReviewedV1,
  virtualsReviewedClientRuntimeV1,
} from './virtualsReviewedClient.js';

const originalFetch = virtualsReviewedClientRuntimeV1.fetch;

afterEach(() => {
  virtualsReviewedClientRuntimeV1.fetch = originalFetch;
});

test('Virtuals reviewed client uses only the pinned JSON-RPC host and unwraps SSE tool data', async () => {
  const observed: { url: string; body: Record<string, unknown> } = { url: '', body: {} };
  virtualsReviewedClientRuntimeV1.fetch = async (scope, url, init) => {
    assert.deepEqual(scope.methods, ['POST']);
    assert.deepEqual(scope.pathPrefixes, ['/']);
    observed.url = String(url);
    observed.body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    const result = {
      jsonrpc: '2.0',
      result: {
        content: [{ type: 'text', text: JSON.stringify({ message: 'Sign this exact SIWE challenge' }) }],
      },
    };
    return new Response(`event: message\ndata: ${JSON.stringify(result)}\n\n`, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  };

  const response = await callVirtualsReviewedV1({
    method: 'login_start',
    args: { walletAddress: '0x1111111111111111111111111111111111111111' },
  });

  assert.equal(observed.url, 'https://mcp.acp.virtuals.io/');
  assert.equal(observed.body.method, 'tools/call');
  assert.deepEqual((observed.body.params as Record<string, unknown>)?.name, 'login_start');
  assert.deepEqual(response, { ok: true, data: { message: 'Sign this exact SIWE challenge' } });
});

test('Virtuals reviewed client refuses an unreleased method before network access', async () => {
  let called = false;
  virtualsReviewedClientRuntimeV1.fetch = async () => {
    called = true;
    return new Response('{}');
  };

  const response = await callVirtualsReviewedV1({ method: 'agent_card_issue' as never, args: {} });

  assert.deepEqual(response, { ok: false, errorCode: 'virtuals_method_not_released' });
  assert.equal(called, false);
});

test('Virtuals auth failures become a closed session error without response leakage', async () => {
  virtualsReviewedClientRuntimeV1.fetch = async () => new Response('secret provider body', { status: 401 });
  const response = await callVirtualsReviewedV1({ method: 'agent_list', args: { token: 'secret' } });
  assert.deepEqual(response, { ok: false, errorCode: 'virtuals_session_expired' });
});
