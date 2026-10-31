import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test, { describe } from 'node:test';
import { encodeFunctionData, erc20Abi } from 'viem';

import {
  AERODROME_USDC_V1,
  AERODROME_WETH_V1,
  HYDREX_BASE_ROUTER_PROXY_V1,
  QUOTE_PIN_REUSE_MS_V1,
  createAerodromeReaderV1,
  createEthSimulateGasMeterV1,
  pricedGasV1,
  reusePassingCheckV1,
  rpcThrottleSignalV1,
} from '../src/index.js';
import { WALLET } from './fixtures.js';

// ---------------------------------------------------------------------------
// 2026-10-19, the operator's comparisons on production: Aerodrome "unreachable"
// in five of seven, Hydrex never ranked for want of a gas figure, and up to
// 11.7 s of waiting. Measured the same day against the public Base endpoint,
// the same adapters answered in under three seconds and Aerodrome said "no
// route" every time.
// ---------------------------------------------------------------------------

const FACTORY = '0x420dd381b31aef6683db6b902084cb0ffece40da' as const;
const LEG = [{ from: AERODROME_USDC_V1, to: AERODROME_WETH_V1, stable: false, factory: FACTORY }] as const;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const word = (value: bigint) => value.toString(16).padStart(64, '0');
// getAmountsOut → uint256[2]: offset, length, amountIn, amountOut.
const amountsOut = (amountIn: bigint, out: bigint) => `0x${word(32n)}${word(2n)}${word(amountIn)}${word(out)}`;
const noSleep = async () => undefined;

describe('a throttle is read in every provider’s words', () => {
  test('Infura’s 429, its -32005 and -33200, and the public endpoint’s sentence', () => {
    assert.equal(rpcThrottleSignalV1({ status: 429 }), true);
    assert.equal(rpcThrottleSignalV1({ code: -32005, message: 'project ID request rate exceeded' }), true);
    assert.equal(rpcThrottleSignalV1({ code: 429, message: 'Too Many Requests' }), true);
    assert.equal(rpcThrottleSignalV1({ code: -33200 }), true);
    assert.equal(rpcThrottleSignalV1({ message: 'over rate limit' }), true);
    assert.equal(rpcThrottleSignalV1({ code: 3, message: 'execution reverted' }), false);
    assert.equal(rpcThrottleSignalV1({ status: 402 }), false, 'a spent daily allowance does not clear by waiting');
  });
});

describe('the Aerodrome reader on a throttling endpoint', () => {
  test('an HTTP 429 is repeated, not reported as an unreachable endpoint', async () => {
    let calls = 0;
    const reader = createAerodromeReaderV1({
      rpcUrl: 'https://primary.invalid/key',
      sleepImpl: noSleep,
      fetchImpl: (async () => {
        calls += 1;
        return calls === 1
          ? json({ jsonrpc: '2.0', id: 1, error: { code: -32005, message: 'project ID request rate exceeded' } }, 429)
          : json({ jsonrpc: '2.0', id: 1, result: amountsOut(1_000n, 400n) });
      }) as unknown as typeof fetch,
    });
    const result = await reader.readAmountsOut({ amountIn: 1_000n, route: LEG });
    assert.deepEqual(result, { ok: true, value: [1_000n, 400n] });
    assert.equal(calls, 2);
  });

  test('a -32005 inside a 200 is a throttle too', async () => {
    let calls = 0;
    const reader = createAerodromeReaderV1({
      rpcUrl: 'https://primary.invalid/key',
      sleepImpl: noSleep,
      fetchImpl: (async () => {
        calls += 1;
        return calls === 1
          ? json({ jsonrpc: '2.0', id: 1, error: { code: -32005, message: 'limit exceeded' } })
          : json({ jsonrpc: '2.0', id: 1, result: amountsOut(1_000n, 400n) });
      }) as unknown as typeof fetch,
    });
    assert.equal((await reader.readAmountsOut({ amountIn: 1_000n, route: LEG })).ok, true);
    assert.equal(calls, 2);
  });

  test('when the primary keeps failing, the second endpoint answers', async () => {
    const asked: string[] = [];
    const reader = createAerodromeReaderV1({
      rpcUrl: 'https://primary.invalid/key',
      fallbackRpcUrl: 'https://fallback.invalid',
      sleepImpl: noSleep,
      fetchImpl: (async (url: string) => {
        asked.push(new URL(url).host);
        return url.includes('primary')
          ? json({ jsonrpc: '2.0', id: 1, error: { code: 429, message: 'Too Many Requests' } }, 429)
          : json({ jsonrpc: '2.0', id: 1, error: { code: 3, message: 'execution reverted' } });
      }) as unknown as typeof fetch,
    });
    const result = await reader.readAmountsOut({ amountIn: 1_000n, route: LEG });
    assert.equal(result.ok === false && result.reason, 'no_route', 'the answer about the pair, from the endpoint that gave one');
    assert.deepEqual([...new Set(asked)], ['primary.invalid', 'fallback.invalid']);
  });

  test('an answer about the pair is never asked again elsewhere', async () => {
    const asked: string[] = [];
    const reader = createAerodromeReaderV1({
      rpcUrl: 'https://primary.invalid/key',
      fallbackRpcUrl: 'https://fallback.invalid',
      sleepImpl: noSleep,
      fetchImpl: (async (url: string) => {
        asked.push(new URL(url).host);
        return json({ jsonrpc: '2.0', id: 1, error: { code: 3, message: 'execution reverted' } });
      }) as unknown as typeof fetch,
    });
    const result = await reader.readAmountsOut({ amountIn: 1_000n, route: LEG });
    assert.equal(result.ok === false && result.reason, 'no_route');
    assert.deepEqual(asked, ['primary.invalid']);
  });

  test('a batch re-asks only the entries the primary could not serve', async () => {
    const fallbackBodies: unknown[] = [];
    const reader = createAerodromeReaderV1({
      rpcUrl: 'https://primary.invalid/key',
      fallbackRpcUrl: 'https://fallback.invalid',
      sleepImpl: noSleep,
      maxRetries: 0,
      fetchImpl: (async (url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body)) as { id: number }[] | { id: number };
        if (url.includes('fallback')) {
          fallbackBodies.push(body);
          const entries = Array.isArray(body) ? body : [body];
          const answers = entries.map((entry) => ({ jsonrpc: '2.0', id: entry.id, result: amountsOut(1_000n, 7n) }));
          return json(Array.isArray(body) ? answers : answers[0]);
        }
        const entries = body as { id: number }[];
        return json([
          { jsonrpc: '2.0', id: entries[0]!.id, result: amountsOut(1_000n, 5n) },
          { jsonrpc: '2.0', id: entries[1]!.id, error: { code: -32005, message: 'project ID request rate exceeded' } },
        ]);
      }) as unknown as typeof fetch,
    });
    const results = await reader.readAmountsOutMany!([
      { amountIn: 1_000n, route: LEG },
      { amountIn: 1_000n, route: LEG },
    ]);
    assert.deepEqual(results, [
      { ok: true, value: [1_000n, 5n] },
      { ok: true, value: [1_000n, 7n] },
    ]);
    assert.equal(fallbackBodies.length, 1, 'one request for the one entry that failed');
  });
});

describe('a router pin that passed is reused by comparison only', () => {
  test('a pass is reused inside its window; a refusal is read again', async () => {
    const cache = new Map<string, { until: number; value: { ok: boolean } }>();
    let clock = 1_000;
    let reads = 0;
    let answer = { ok: true };
    const read = async () => {
      reads += 1;
      return answer;
    };
    const options = { ttlMs: QUOTE_PIN_REUSE_MS_V1, now: () => clock };
    await reusePassingCheckV1(cache, 'k', options, read);
    await reusePassingCheckV1(cache, 'k', options, read);
    assert.equal(reads, 1);
    clock += QUOTE_PIN_REUSE_MS_V1;
    answer = { ok: false };
    await reusePassingCheckV1(cache, 'k', options, read);
    await reusePassingCheckV1(cache, 'k', options, read);
    assert.equal(reads, 3, 'an expired pass is read again, and a refusal every time');
    await reusePassingCheckV1(new Map(), 'k', { ttlMs: 0, now: () => clock }, read);
    assert.equal(reads, 4, 'no window, no reuse');
  });

  test('the comparison adapters reuse; review, approval and the composer read the chain', () => {
    const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
    assert.match(source('../src/o1.ts'), /createO1RouterPinReaderV1\(\{ rpcUrl: options\.rpcUrl, cacheTtlMs: QUOTE_PIN_REUSE_MS_V1 \}\)/);
    // Both endpoints are the same reuse window: the second only answers when the first did not.
    assert.match(
      source('../src/hydrex.ts'),
      /createHydrexRouterPinReaderV1\(\{\s*rpcUrl: options\.rpcUrl,\s*fallbackRpcUrl: options\.fallbackRpcUrl,\s*cacheTtlMs: QUOTE_PIN_REUSE_MS_V1,?\s*\}\)/,
    );
    for (const path of [
      '../../transaction-composer/src/adapters/o1.ts',
      '../../transaction-composer/src/adapters/hydrex.ts',
      '../../../artifacts/api-server/routes/routeIntelligence.ts',
    ]) {
      assert.doesNotMatch(source(path), /cacheTtlMs/, `${path} must read the pin fresh`);
    }
  });
});

describe('a swap whose quote states no gas is measured', () => {
  const price = { gasPriceWei: 6_000_000n, ethUsd: '2400.95' };

  test('the figure is exact, never a float in exponent form', () => {
    // The operator-sized swap, measured live on 2026-10-19.
    assert.deepEqual(pricedGasV1(411_283n, price), {
      gasUnits: '411283',
      maxFeePerGasWei: null,
      estimatedCostNative: '0.000002467698',
      estimatedCostUsd: '0.0059248195131',
    });
    assert.equal(pricedGasV1(0n, price), null);
    assert.equal(pricedGasV1(1n, { ...price, ethUsd: '2.4e3' }), null);
  });

  const meter = (answer: (body: { method: string; params: [{ blockStateCalls: [{ calls: Record<string, string>[] }] }] }) => Response) => {
    const bodies: unknown[] = [];
    return {
      bodies,
      meter: createEthSimulateGasMeterV1({
        rpcUrl: 'https://simulate.invalid',
        price: async () => price,
        fetchImpl: (async (_url: string, init: RequestInit) => {
          const body = JSON.parse(String(init.body));
          bodies.push(body);
          return answer(body);
        }) as unknown as typeof fetch,
      }),
    };
  };
  const input = {
    walletAddress: WALLET,
    approval: { token: AERODROME_USDC_V1, spender: HYDREX_BASE_ROUTER_PROXY_V1, amountAtomic: '2000000' },
    call: { to: HYDREX_BASE_ROUTER_PROXY_V1, data: '0xabcdef' as const, value: '0' },
  };

  test('the approval and the swap run once, on real state, and the swap’s gas is priced', async () => {
    const { meter: m, bodies } = meter(() =>
      json({ jsonrpc: '2.0', id: 1, result: [{ calls: [{ status: '0x1', gasUsed: '0xd88d' }, { status: '0x1', gasUsed: '0x64693' }] }] }),
    );
    const gas = await m.measure(input);
    assert.equal(gas?.gasUnits, '411283');
    const body = bodies[0] as { method: string; params: [{ blockStateCalls: [Record<string, unknown> & { calls: Record<string, string>[] }] }] };
    assert.equal(body.method, 'eth_simulateV1');
    const block = body.params[0].blockStateCalls[0];
    assert.equal('stateOverrides' in block, false, 'nothing about the wallet is invented');
    assert.equal(block.calls[0]!.to, AERODROME_USDC_V1);
    assert.equal(
      block.calls[0]!.data,
      encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [HYDREX_BASE_ROUTER_PROXY_V1, 2_000_000n] }),
    );
    assert.equal(block.calls[1]!.to, HYDREX_BASE_ROUTER_PROXY_V1);
  });

  test('a revert, a short answer, or no price leaves the gas unmeasured', async () => {
    const reverted = meter(() =>
      json({ jsonrpc: '2.0', id: 1, result: [{ calls: [{ status: '0x1', gasUsed: '0xd88d' }, { status: '0x0', gasUsed: '0x5208' }] }] }),
    );
    assert.equal(await reverted.meter.measure(input), null, 'a wallet that cannot afford it gets no figure');
    const short = meter(() => json({ jsonrpc: '2.0', id: 1, result: [{ calls: [{ status: '0x1', gasUsed: '0x5208' }] }] }));
    assert.equal(await short.meter.measure(input), null);
    const unsupported = meter(() => json({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'method does not exist' } }));
    assert.equal(await unsupported.meter.measure(input), null);
    const unpriced = createEthSimulateGasMeterV1({
      rpcUrl: 'https://simulate.invalid',
      price: async () => null,
      fetchImpl: (async () =>
        json({ jsonrpc: '2.0', id: 1, result: [{ calls: [{ status: '0x1', gasUsed: '0x1' }, { status: '0x1', gasUsed: '0x1' }] }] })) as unknown as typeof fetch,
    });
    assert.equal(await unpriced.measure(input), null);
  });
});
