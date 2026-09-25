import assert from 'node:assert/strict';
import test from 'node:test';
import { loadSkillExecutor } from '../src/http-executor.js';

// ---------------------------------------------------------------------------
// The transport removes secrets. It does not reshape what a provider sent.
//
// It used to replace everything deeper than eight levels with '[truncated]'.
// KyberSwap's route summary for a stock route is nine levels deep, and
// route/build needs it back exactly, so every NVDAc build answered HTTP 500
// (2026-09-25).
// ---------------------------------------------------------------------------

function answering(body: unknown) {
  return (async () =>
    new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })) as never;
}

test('a provider payload comes back as the provider sent it, ten levels deep', async () => {
  const deep = { a: { b: { c: { d: { e: { f: { g: { h: { i: { j: 'kept', n: 9, flag: false } } } } } } } } } };
  const executor = loadSkillExecutor('kyberswap');
  assert.ok(executor);
  const response = await executor!.request({
    path: '/base/api/v1/routes?tokenIn=0x1&tokenOut=0x2&amountIn=1',
    method: 'GET',
    chainId: 8453,
    fetchImpl: answering({ code: 0, data: deep }),
  } as never);
  assert.deepEqual((response.data as { data: unknown }).data, deep);
});

test('a secret-named field is still redacted, at any depth', async () => {
  const executor = loadSkillExecutor('kyberswap');
  const response = await executor!.request({
    path: '/base/api/v1/routes?tokenIn=0x1&tokenOut=0x2&amountIn=1',
    method: 'GET',
    chainId: 8453,
    fetchImpl: answering({ data: { a: { b: { c: { d: { e: { f: { g: { h: { i: { signature: 'abc', keep: 1 } } } } } } } } } } }),
  } as never);
  assert.match(JSON.stringify(response.data), /"signature":"\[redacted\]","keep":1/);
  assert.doesNotMatch(JSON.stringify(response.data), /abc/);
});
