import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { loadSkillExecutor, SkillPathNotAllowedError } from '../src/http-executor.js';

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
// GMGN — a published key is not a missing one.
//
// This deployment reported GMGN as unavailable because the handler sent no
// auth at all: no X-APIKEY, no timestamp, no client_id. The API answers 401 to
// that and 200 to the documented contract, so "unavailable here" was a false
// absence about a read that works for everyone else.
// ---------------------------------------------------------------------------
describe('GMGN reads are signed the way GMGN documents', () => {
  test('the published read key travels, under the header GMGN actually names', async () => {
    const seen: { url: string; headers: Record<string, string> }[] = [];
    const executor = loadSkillExecutor('gmgn');
    assert.ok(executor, 'the gmgn namespace is loadable');
    await executor!.request({
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
    } as never);
    assert.equal(seen.length, 1);
    // The header name is GMGN's, not our house convention.
    assert.equal(seen[0]!.headers['X-APIKEY'], 'gmgn_basesolbscethmonadtron');
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
    await call();
    await call();
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
