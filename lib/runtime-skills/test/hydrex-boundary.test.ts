import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadSkillExecutor, SkillPathNotAllowedError } from '../src/http-executor.js';

const address = '0x1111111111111111111111111111111111111111';

test('Hydrex exposes one bounded Base GET and rejects redirects', async () => {
  const executor = loadSkillExecutor('hydrex')!;
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  assert.ok(executor);
  const result = await executor.request({ path: `/state/positions?address=${address}`, method: 'GET', chainId: 8453,
    timeoutMs: 9000, fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response('{"ok":true,"count":0,"positions":[]}');
    } });
  assert.equal(result.status, 200);
  assert.equal(calls[0]?.url, `https://hydrex-agent.com/state/positions?address=${address}`);
  assert.equal(calls[0]?.init?.method, 'GET');
  assert.equal(calls[0]?.init?.body, undefined);
  assert.equal(calls[0]?.init?.redirect, 'error');
  assert.ok(calls[0]?.init?.signal);
  assert.doesNotMatch(JSON.stringify(calls[0]?.init?.headers), /authorization|api.key/i);
});

test('Hydrex read cannot reach prepare, other state endpoints or extra query parameters', async () => {
  const executor = loadSkillExecutor('hydrex')!;
  let calls = 0;
  const fetchImpl: typeof fetch = async () => { calls++; return new Response('{}'); };
  for (const path of ['/prepare/add-liquidity', '/prepare/remove-liquidity', '/state/portfolio', '/state/quote',
    '/state/positions', `/state/positions/other?address=${address}`, `/state/positions?address=${address}&address=${address}`,
    `/state/positions?address=${address}&url=https://evil.invalid`, '/state/positions?address=bad']) {
    await assert.rejects(() => executor.request({ path, method: 'GET', fetchImpl }), SkillPathNotAllowedError);
  }
  await assert.rejects(() => executor.request({ path: `/state/positions?address=${address}`, method: 'POST', fetchImpl }), SkillPathNotAllowedError);
  await assert.rejects(() => executor.request({ path: `/state/positions?address=${address}`, method: 'GET', body: {}, fetchImpl }), SkillPathNotAllowedError);
  await assert.rejects(() => executor.request({ path: `/state/positions?address=${address}`, method: 'GET', chainId: 1, fetchImpl }));
  assert.equal(calls, 0);
});
