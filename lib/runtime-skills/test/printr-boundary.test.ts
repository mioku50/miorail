import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { loadSkillExecutor, PluginCredentialMissingError, SkillPathNotAllowedError } from '../src/http-executor.js';

test('Printr does not cross quote and deployment-read methods or permit building a launch', async () => {
  const executor = loadSkillExecutor('printr')!;
  assert.ok(executor);
  for (const [path, method] of [
    ['/v0/print', 'POST'], ['/v0/print/quote/other', 'POST'],
    ['/v0/tokens/0xab/deployments', 'POST'], ['/v0/tokens/../../print/deployments', 'GET'],
    ['/v0/tokens/0xab', 'GET'], ['/v0/print/quote', 'GET'],
  ] as const) {
    await assert.rejects(() => executor.request({ path, method, chainId: 8453 }), SkillPathNotAllowedError);
  }
});

// ---------------------------------------------------------------------------
// GMGN — signed the way GMGN documents, with the operator's own key only.
//
// The first handler sent no auth at all: no X-APIKEY, no timestamp, no
// client_id, and GMGN answered 401. Base's spec then supplied a published read
// key, which GMGN calls a demo limited per IP; from 2026-10-06 it answered this
// server 429 on every read. Without GMGN_API_KEY nothing is sent at all.
// ---------------------------------------------------------------------------
async function withGmgnKey<T>(value: string | undefined, run: () => Promise<T>): Promise<T> {
  const previous = process.env.GMGN_API_KEY;
  try {
    if (value === undefined) delete process.env.GMGN_API_KEY;
    else process.env.GMGN_API_KEY = value;
    return await run();
  } finally {
    if (previous === undefined) delete process.env.GMGN_API_KEY;
    else process.env.GMGN_API_KEY = previous;
  }
}
describe('GMGN reads are signed the way GMGN documents', () => {
  test('a personal server credential overrides the public demo and is scrubbed from the result', async () => {
    const previous = process.env.GMGN_API_KEY;
    const credential = 'gmgn-personal-fixture';
    try {
      process.env.GMGN_API_KEY = credential;
      let sent = '';
      const response = await loadSkillExecutor('gmgn')!.request({
        path: '/v1/trade/gas_price?chain=base', method: 'GET', chainId: 8453,
        fetchImpl: (async (_url, init) => {
          sent = (init?.headers as Record<string, string>)['X-APIKEY']!;
          return new Response(JSON.stringify({ code: 0, data: { echoed: credential } }));
        }) as typeof fetch,
      });
      assert.equal(sent, credential);
      assert.ok(!JSON.stringify(response).includes(credential));
    } finally {
      if (previous === undefined) delete process.env.GMGN_API_KEY;
      else process.env.GMGN_API_KEY = previous;
    }
  });
  test('without the operator\'s key nothing is sent, not even the published demo key', async () => {
    let calls = 0;
    await withGmgnKey(undefined, () => assert.rejects(() => loadSkillExecutor('gmgn')!.request({
      path: '/v1/market/rank?chain=base&interval=1h&limit=10&order_by=volume', method: 'GET', chainId: 8453,
      fetchImpl: (async () => { calls++; return new Response('{}'); }) as never,
    } as never), PluginCredentialMissingError));
    assert.equal(calls, 0);
  });
  test('the operator\'s key travels under the header GMGN actually names', async () => {
    const seen: { url: string; headers: Record<string, string> }[] = [];
    const executor = loadSkillExecutor('gmgn');
    assert.ok(executor, 'the gmgn namespace is loadable');
    await withGmgnKey('gmgn-personal-fixture', () => executor!.request({
      path: '/v1/market/rank?chain=base&interval=1h&limit=10&order_by=volume',
      method: 'GET',
      chainId: 8453,
      timeoutMs: 5_000,
      fetchImpl: (async (url: string, init: { headers: Record<string, string> }) => {
        seen.push({ url: String(url), headers: init.headers });
        return new Response(JSON.stringify({ code: 0, data: { data: { rank: [] } } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }) as never,
    } as never));
    assert.equal(seen.length, 1);
    // The header name is GMGN's, not our house convention.
    assert.equal(seen[0]!.headers['X-APIKEY'], 'gmgn-personal-fixture');
    assert.ok(!('x-api-key' in seen[0]!.headers), 'the default header name is not also sent');
  });

  test('every request carries a fresh timestamp and client id', async () => {
    const urls: string[] = [];
    const executor = loadSkillExecutor('gmgn');
    const call = () =>
      executor!.request({
        path: '/v1/trade/gas_price?chain=base',
        method: 'GET',
        chainId: 8453,
        timeoutMs: 5_000,
        fetchImpl: (async (url: string) => {
          urls.push(String(url));
          return new Response('{"code":0,"data":{}}', {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }) as never,
      } as never);
    await withGmgnKey('gmgn-personal-fixture', async () => { await call(); await call(); });
    for (const url of urls) {
      assert.match(url, /[?&]timestamp=\d{10}\b/, 'a Unix timestamp is sent');
      assert.match(url, /[?&]client_id=[0-9a-f-]{36}\b/, 'a UUID client id is sent');
    }
    // Replay protection is worthless if the id is reused.
    const ids = urls.map((url) => new URL(url).searchParams.get('client_id'));
    assert.equal(new Set(ids).size, 2, 'each request gets its own client id');
  });

  test('the swap-calldata endpoint is not reachable from this read surface', async () => {
    const executor = loadSkillExecutor('gmgn');
    await assert.rejects(() =>
      executor!.request({
        path: '/v1/trade/quote?chain=base',
        method: 'GET',
        chainId: 8453,
        timeoutMs: 5_000,
        fetchImpl: (async () => new Response('{}', { status: 200 })) as never,
      } as never),
    );
  });
});
