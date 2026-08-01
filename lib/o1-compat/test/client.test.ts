import assert from 'node:assert/strict';
import { test, describe } from 'node:test';

import {
  O1ClientError,
  o1ConfigFromEnvV1,
  o1OrderUrlV1,
  requestUnsignedOrderV1,
} from '../src/client.js';
import { baseOrderRequestFixtureV1, baseOrderResponseFixtureV1 } from './fixtures.js';

// T67D §3 — the read-only client. Every test here injects `fetchImpl`; nothing
// in this file reaches the network, which is a property the suite as a whole
// depends on (a compatibility gate that phones a vendor during CI is a gate
// that fails when the vendor does).

const TOKEN = 'o1_test_token_do_not_log';

function env(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return { O1_TRADING_API_TOKEN: TOKEN, ...overrides };
}

function respondWith(status: number, body: unknown): typeof globalThis.fetch {
  return (async () =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })) as typeof globalThis.fetch;
}

describe('configuration', () => {
  test('live is off unless explicitly enabled', () => {
    assert.equal(o1ConfigFromEnvV1(env()).live, false);
    assert.equal(o1ConfigFromEnvV1(env({ O1_TRADING_COMPAT_LIVE: 'yes' })).live, false);
    assert.equal(o1ConfigFromEnvV1(env({ O1_TRADING_COMPAT_LIVE: 'true' })).live, true);
  });

  test('a missing token is reported by name, never by value', () => {
    const config = o1ConfigFromEnvV1({});
    assert.equal(config.configured, false);
    assert.deepEqual(config.missing, ['O1_TRADING_API_TOKEN']);
  });

  test('the timeout is mandatory and bounded', () => {
    assert.equal(o1ConfigFromEnvV1(env()).timeoutMs, 10_000);
    assert.equal(o1ConfigFromEnvV1(env({ O1_TRADING_TIMEOUT_MS: '2500' })).timeoutMs, 2_500);
    // A caller cannot remove the timeout by setting nonsense or something huge.
    assert.equal(o1ConfigFromEnvV1(env({ O1_TRADING_TIMEOUT_MS: '0' })).timeoutMs, 10_000);
    assert.equal(o1ConfigFromEnvV1(env({ O1_TRADING_TIMEOUT_MS: 'abc' })).timeoutMs, 10_000);
    assert.equal(o1ConfigFromEnvV1(env({ O1_TRADING_TIMEOUT_MS: '99999999' })).timeoutMs, 30_000);
  });
});

describe('the host and path cannot be redirected', () => {
  test('there is exactly one URL and it is pinned', () => {
    assert.equal(o1OrderUrlV1(), 'https://api.o1.exchange/api/v2/order');
  });

  test('the request goes to that URL and nowhere else', async () => {
    let seen: string | null = null;
    await requestUnsignedOrderV1(baseOrderRequestFixtureV1(), {
      env: env(),
      fetchImpl: (async (input: RequestInfo | URL) => {
        seen = String(input);
        return new Response(JSON.stringify(baseOrderResponseFixtureV1()), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }) as typeof globalThis.fetch,
    });
    assert.equal(seen, 'https://api.o1.exchange/api/v2/order');
  });
});

describe('the token stays out of everything observable', () => {
  test('no error message or stack carries the token', async () => {
    for (const status of [401, 403, 429, 500, 503]) {
      // A provider error body is a place a request header can be echoed back,
      // so the client never reads one into an error.
      const echoed = { error: `bad token ${TOKEN}`, authorization: `Bearer ${TOKEN}` };
      await assert.rejects(
        requestUnsignedOrderV1(baseOrderRequestFixtureV1(), {
          env: env(),
          fetchImpl: respondWith(status, echoed),
        }),
        (error: unknown) => {
          assert.ok(error instanceof O1ClientError);
          const serialized = `${error.message}${error.stack ?? ''}${JSON.stringify(error)}`;
          assert.equal(serialized.includes(TOKEN), false, `the ${status} path leaked the token`);
          return true;
        },
      );
    }
  });

  test('the request body never contains the token', async () => {
    let body = '';
    await requestUnsignedOrderV1(baseOrderRequestFixtureV1(), {
      env: env(),
      fetchImpl: (async (_input: RequestInfo | URL, init?: RequestInit) => {
        body = String(init?.body ?? '');
        return new Response(JSON.stringify(baseOrderResponseFixtureV1()), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }) as typeof globalThis.fetch,
    });
    assert.equal(body.includes(TOKEN), false);
    // `schemaVersion` is Miorail's own marker and must not travel to o1.
    assert.equal(body.includes('schemaVersion'), false);
  });
});

describe('failure modes are typed', () => {
  const cases: Array<[number, string]> = [
    [401, 'o1_unauthorized'],
    [403, 'o1_unauthorized'],
    [429, 'o1_rate_limited'],
    [500, 'o1_server_error'],
    [502, 'o1_server_error'],
  ];
  for (const [status, code] of cases) {
    test(`${status} maps to ${code}`, async () => {
      await assert.rejects(
        requestUnsignedOrderV1(baseOrderRequestFixtureV1(), {
          env: env(),
          fetchImpl: respondWith(status, { error: 'x' }),
        }),
        (error: unknown) => error instanceof O1ClientError && error.code === code,
      );
    });
  }

  test('an unconfigured token fails before any request is attempted', async () => {
    let called = false;
    await assert.rejects(
      requestUnsignedOrderV1(baseOrderRequestFixtureV1(), {
        env: {},
        fetchImpl: (async () => {
          called = true;
          return new Response('{}');
        }) as typeof globalThis.fetch,
      }),
      (error: unknown) => error instanceof O1ClientError && error.code === 'o1_not_configured',
    );
    assert.equal(called, false, 'no request may be made without a token');
  });

  test('a response with an unexpected field is refused, not tolerated', async () => {
    // A field nobody has judged is a field nobody has judged.
    const mutated = { ...baseOrderResponseFixtureV1(), surprise: 'new-provider-feature' };
    await assert.rejects(
      requestUnsignedOrderV1(baseOrderRequestFixtureV1(), {
        env: env(),
        fetchImpl: respondWith(200, mutated),
      }),
      (error: unknown) => error instanceof O1ClientError && error.code === 'o1_malformed_response',
    );
  });

  test('non-JSON is refused', async () => {
    await assert.rejects(
      requestUnsignedOrderV1(baseOrderRequestFixtureV1(), {
        env: env(),
        fetchImpl: respondWith(200, '<html>maintenance</html>'),
      }),
      (error: unknown) => error instanceof O1ClientError && error.code === 'o1_malformed_response',
    );
  });

  test('a timeout is its own code, distinguishable from a refusal', async () => {
    await assert.rejects(
      requestUnsignedOrderV1(baseOrderRequestFixtureV1(), {
        env: env({ O1_TRADING_TIMEOUT_MS: '10' }),
        fetchImpl: ((_input: RequestInfo | URL, init?: RequestInit) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              const error = new Error('aborted');
              error.name = 'AbortError';
              reject(error);
            });
          })) as typeof globalThis.fetch,
      }),
      (error: unknown) => error instanceof O1ClientError && error.code === 'o1_timeout',
    );
  });
});

describe('the request schema refuses what it must never send', () => {
  test('a private key or a signed transaction cannot be added to a request', async () => {
    // `.strict()` is the enforcement: these fields have no home in the schema,
    // so a caller cannot smuggle them past it — and the rejection happens
    // before any request is attempted.
    for (const smuggled of [{ privateKey: '0xdead' }, { signed: '0x02f8…' }, { signerKey: 'k' }]) {
      let called = false;
      await assert.rejects(
        requestUnsignedOrderV1({ ...baseOrderRequestFixtureV1(), ...smuggled } as never, {
          env: env(),
          fetchImpl: (async () => {
            called = true;
            return new Response('{}');
          }) as typeof globalThis.fetch,
        }),
      );
      assert.equal(called, false, `${Object.keys(smuggled)[0]} must be refused before the request`);
    }
  });
});
