import assert from 'node:assert/strict';
import { test, describe, beforeEach } from 'node:test';

import { readChainConditionsV1, resetChainConditionsForTests } from './chainConditions.js';

// Chain conditions feed the console header, footer and gas sparkline. Every
// test here is a way those could show a number that is not true right now.

const RPC = 'https://mainnet.base.org';

function batchResponder(block: string, gas: string): typeof globalThis.fetch {
  return (async () =>
    new Response(
      JSON.stringify([
        { jsonrpc: '2.0', id: 1, result: block },
        { jsonrpc: '2.0', id: 2, result: gas },
      ]),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )) as typeof globalThis.fetch;
}

const originalFetch = globalThis.fetch;

beforeEach(() => {
  resetChainConditionsForTests();
  globalThis.fetch = originalFetch;
});

describe('reading the chain', () => {
  test('a good read reports the block and gas with units', async () => {
    globalThis.fetch = batchResponder('0x1c9c380', '0x3b9aca0'); // 30000000, 62500000 wei
    const conditions = await readChainConditionsV1(RPC);
    assert.equal(conditions.reason, 'ok');
    assert.equal(conditions.blockNumber, '30000000');
    assert.equal(conditions.gasPriceWei, '62500000');
    // Integer arithmetic, three decimals: gas on Base lives below 1 gwei and a
    // float would render the interesting digits as noise.
    assert.equal(conditions.gasPriceGwei, '0.062');
    assert.ok(conditions.observedAt);
  });

  test('an unconfigured RPC is its own reason, not a failure', async () => {
    const conditions = await readChainConditionsV1(undefined);
    assert.equal(conditions.reason, 'not_configured');
    assert.equal(conditions.blockNumber, null);
  });

  test('an unreachable RPC yields null and never throws', async () => {
    globalThis.fetch = (async () => {
      throw new Error('ECONNREFUSED');
    }) as typeof globalThis.fetch;
    const conditions = await readChainConditionsV1(RPC);
    assert.equal(conditions.reason, 'rpc_unreachable');
    assert.equal(conditions.blockNumber, null);
    assert.equal(conditions.gasPriceGwei, null);
  });

  test('a stale reading is NOT served as current', async () => {
    // The whole point. A block number from two minutes ago, shown in a header
    // with no qualification, is worse than a dash — it reads as live.
    globalThis.fetch = batchResponder('0x64', '0x3b9aca0');
    const fresh = await readChainConditionsV1(RPC, 1_000);
    assert.equal(fresh.blockNumber, '100');

    globalThis.fetch = (async () => {
      throw new Error('gone');
    }) as typeof globalThis.fetch;
    const later = await readChainConditionsV1(RPC, 1_000 + 60_000);
    assert.equal(later.blockNumber, null);
    assert.equal(later.reason, 'rpc_unreachable');
  });

  test('a malformed payload is refused rather than coerced', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x1' }), {
        status: 200,
      })) as typeof globalThis.fetch;
    const conditions = await readChainConditionsV1(RPC);
    assert.equal(conditions.blockNumber, null);
  });

  test('a non-hex result does not become NaN or zero', async () => {
    globalThis.fetch = batchResponder('not-hex', '0x1');
    const conditions = await readChainConditionsV1(RPC);
    assert.equal(conditions.blockNumber, null);
  });
});

// ---------------------------------------------------------------------------
// Phase 9A: four causes used to arrive as `rpc_unreachable`.
//
// On 2026-08-26 the console header showed "Block —" beside a rail that showed a
// stored ledger position, and the log said the RPC "did not answer" — while a
// direct probe of both configured endpoints answered in 118-226ms. Being
// declined this second is not being down, and an operator who cannot tell them
// apart cannot tell whether to wait or to page someone.
// ---------------------------------------------------------------------------

describe('the reason says which failure it was', () => {
  test('a 429 is throttling, not an outage', async () => {
    globalThis.fetch = (async () => new Response('slow down', { status: 429 })) as typeof globalThis.fetch;
    const conditions = await readChainConditionsV1(RPC);
    assert.equal(conditions.reason, 'rpc_rate_limited');
    assert.equal(conditions.blockNumber, null);
  });

  test('a 5xx is the endpoint failing, not the endpoint missing', async () => {
    globalThis.fetch = (async () => new Response('boom', { status: 502 })) as typeof globalThis.fetch;
    assert.equal((await readChainConditionsV1(RPC)).reason, 'rpc_http_error');
  });

  test('a throttle inside a 200 envelope is still a throttle', async () => {
    // Some providers answer 200 and put the refusal per-call. Reading that as
    // an unreadable shape would blame the payload for a quota.
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify([
          { jsonrpc: '2.0', id: 1, error: { code: -32005, message: 'over rate limit' } },
          { jsonrpc: '2.0', id: 2, error: { code: -32005, message: 'over rate limit' } },
        ]),
        { status: 200 },
      )) as typeof globalThis.fetch;
    assert.equal((await readChainConditionsV1(RPC)).reason, 'rpc_rate_limited');
  });

  test('our own abort is a timeout, not an unreachable endpoint', async () => {
    globalThis.fetch = ((_url: string, init?: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        });
      })) as unknown as typeof globalThis.fetch;
    assert.equal((await readChainConditionsV1(RPC)).reason, 'rpc_timeout');
  });

  test('a 200 whose shape is wrong is still about the shape', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x1' }), {
        status: 200,
      })) as typeof globalThis.fetch;
    assert.equal((await readChainConditionsV1(RPC)).reason, 'rpc_invalid_response');
  });
});

describe('the gas history is measured, never interpolated', () => {
  test('a failed read adds no point', async () => {
    globalThis.fetch = batchResponder('0x64', '0x3b9aca0');
    await readChainConditionsV1(RPC, 1_000);

    globalThis.fetch = (async () => {
      throw new Error('gone');
    }) as typeof globalThis.fetch;
    const afterFailure = await readChainConditionsV1(RPC, 1_000 + 60_000);
    // One real sample survives; the failure contributes nothing. A gap in the
    // chart is a real gap.
    assert.equal(afterFailure.gasPoints.length, 1);
  });

  test('samples closer together than the thinning gap are not duplicated', async () => {
    globalThis.fetch = batchResponder('0x64', '0x3b9aca0');
    await readChainConditionsV1(RPC, 1_000);
    // Past the value cache but inside the history gap.
    const second = await readChainConditionsV1(RPC, 1_000 + 15_000);
    assert.equal(second.gasPoints.length, 1, 'a busy poller must not become a chart of identical points');
  });

  test('successive spaced reads accumulate', async () => {
    globalThis.fetch = batchResponder('0x64', '0x3b9aca0');
    await readChainConditionsV1(RPC, 1_000);
    await readChainConditionsV1(RPC, 1_000 + 40_000);
    const third = await readChainConditionsV1(RPC, 1_000 + 80_000);
    assert.equal(third.gasPoints.length, 3);
    assert.ok(third.gasPoints.every((point) => point.gwei === '0.062'));
  });
});

describe('the RPC is not hammered', () => {
  test('a burst of callers produces one request', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return new Response(
        JSON.stringify([
          { jsonrpc: '2.0', id: 1, result: '0x64' },
          { jsonrpc: '2.0', id: 2, result: '0x3b9aca0' },
        ]),
        { status: 200 },
      );
    }) as typeof globalThis.fetch;

    await Promise.all([
      readChainConditionsV1(RPC),
      readChainConditionsV1(RPC),
      readChainConditionsV1(RPC),
    ]);
    assert.equal(calls, 1, 'status polling must not multiply into RPC calls');
  });

  test('a repeat inside the cache window makes no request at all', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response(
        JSON.stringify([
          { jsonrpc: '2.0', id: 1, result: '0x64' },
          { jsonrpc: '2.0', id: 2, result: '0x3b9aca0' },
        ]),
        { status: 200 },
      );
    }) as typeof globalThis.fetch;
    await readChainConditionsV1(RPC, 1_000);
    await readChainConditionsV1(RPC, 1_005);
    assert.equal(calls, 1);
  });
});
