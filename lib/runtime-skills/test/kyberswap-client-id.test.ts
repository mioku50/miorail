import assert from 'node:assert/strict';
import test from 'node:test';
import { KYBERSWAP_CLIENT_ID_V1, loadSkillExecutor } from '../src/http-executor.js';

// KyberSwap names an integrator by x-client-id on quote and build alike, and
// records route/build's `source` onchain, which base.dev's integrator code
// matches. The executor adds the header itself, so no caller can forget it.
test('every KyberSwap call names Miorail in x-client-id, and no other provider is sent it', async () => {
  const seen: Array<{ url: string; clientId: string | undefined }> = [];
  const capture = (async (url: string, init: { headers: Record<string, string> }) => {
    seen.push({ url: String(url), clientId: init.headers['x-client-id'] });
    return new Response('{}');
  }) as unknown as typeof fetch;
  const kyber = loadSkillExecutor('kyberswap');
  assert.ok(kyber, 'the kyberswap namespace is loadable');
  await kyber.request({ path: '/base/api/v1/routes?tokenIn=0x1&tokenOut=0x2&amountIn=1', method: 'GET', chainId: 8453, fetchImpl: capture });
  await kyber.request({ path: '/base/api/v1/route/build', method: 'POST', body: { source: KYBERSWAP_CLIENT_ID_V1 }, chainId: 8453, fetchImpl: capture });
  assert.equal(KYBERSWAP_CLIENT_ID_V1, 'miorail');
  assert.deepEqual(seen.map((call) => call.clientId), [KYBERSWAP_CLIENT_ID_V1, KYBERSWAP_CLIENT_ID_V1]);
  assert.ok(seen.every((call) => call.url.startsWith('https://aggregator-api.kyberswap.com/base/api/v1/')));

  seen.length = 0;
  await loadSkillExecutor('hydrex')!.request({
    path: `/state/positions?address=0x${'1'.repeat(40)}`, method: 'GET', chainId: 8453, fetchImpl: capture,
  });
  assert.deepEqual(seen.map((call) => call.clientId), [undefined]);
});
