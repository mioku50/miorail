import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  ENDPOINT_FAILURE_REASONS_V1,
  anchorThroughFirstAnsweringV1,
  isEndpointFailureV1,
  withCallFailoverV1,
  type B20BlockAnchorV1,
  type B20ReaderV1,
  type B20RpcResultV1,
} from '../src/reader.js';

// ---------------------------------------------------------------------------
// 2026-10-25: the pools worker read through one endpoint, the shared Alchemy
// account ran out, and every pass stored nothing for more than eleven hours
// while two other configured endpoints answered. These tests pin what may move
// a pass to the next endpoint, and what may not.
// ---------------------------------------------------------------------------

const ANCHOR = {
  blockNumber: '53107445',
  blockHash: `0x${'ab'.repeat(32)}`,
  blockTag: '0x32a5af5',
} as B20BlockAnchorV1;

function endpoint(name: string, asked: string[], answer: B20RpcResultV1<B20BlockAnchorV1>) {
  return {
    name,
    async readBlockAnchor() {
      asked.push(name);
      return answer;
    },
  };
}

describe('an endpoint that did not answer is not an answer', () => {
  test('a throttle, an outage and a garbled reply move to another endpoint', () => {
    for (const reason of ['rate_limited', 'rpc_unavailable', 'rpc_timeout', 'rpc_error', 'invalid_response'] as const) {
      assert.equal(isEndpointFailureV1(reason), true, reason);
    }
  });

  test("a revert and an empty result are the chain's answer and stay put", () => {
    assert.equal(isEndpointFailureV1('reverted'), false);
    assert.equal(isEndpointFailureV1('empty_result'), false);
    assert.equal(isEndpointFailureV1('not_configured'), false);
    assert.ok(!ENDPOINT_FAILURE_REASONS_V1.includes('reverted'));
  });
});

describe('a pass anchors through the first endpoint that answers', () => {
  test('the pools endpoint first, and the next one only when it refused', async () => {
    const asked: string[] = [];
    const anchored = await anchorThroughFirstAnsweringV1([
      endpoint('pools', asked, { ok: false, reason: 'rate_limited' }),
      endpoint('read', asked, { ok: true, value: ANCHOR, raw: '"0x32a5af5"' }),
      endpoint('public', asked, { ok: true, value: ANCHOR, raw: '"0x32a5af5"' }),
    ]);
    assert.equal(anchored.ok, true);
    if (!anchored.ok) return;
    // The whole pass then reads through the endpoint that anchored it.
    assert.equal(anchored.reader.name, 'read');
    assert.equal(anchored.position, 1);
    assert.deepEqual(anchored.anchor, ANCHOR);
    assert.deepEqual(anchored.refusals, ['rate_limited']);
    assert.deepEqual(asked, ['pools', 'read']);
  });

  test('a healthy first endpoint is the only one asked', async () => {
    const asked: string[] = [];
    const anchored = await anchorThroughFirstAnsweringV1([
      endpoint('pools', asked, { ok: true, value: ANCHOR, raw: '"0x32a5af5"' }),
      endpoint('read', asked, { ok: true, value: ANCHOR, raw: '"0x32a5af5"' }),
    ]);
    assert.equal(anchored.ok && anchored.position, 0);
    assert.deepEqual(asked, ['pools']);
  });

  test('every endpoint refusing is a failure that names each refusal', async () => {
    const asked: string[] = [];
    const anchored = await anchorThroughFirstAnsweringV1([
      endpoint('pools', asked, { ok: false, reason: 'rate_limited' }),
      endpoint('read', asked, { ok: false, reason: 'rpc_unavailable', detail: 'status 402' }),
    ]);
    assert.deepEqual(anchored, { ok: false, refusals: ['rate_limited', 'rpc_unavailable'] });
    assert.deepEqual(asked, ['pools', 'read']);
  });

  test('an answer that is not an endpoint failure is not re-asked elsewhere', async () => {
    const asked: string[] = [];
    const anchored = await anchorThroughFirstAnsweringV1([
      endpoint('pools', asked, { ok: false, reason: 'empty_result' }),
      endpoint('read', asked, { ok: true, value: ANCHOR, raw: '"0x32a5af5"' }),
    ]);
    assert.deepEqual(anchored, { ok: false, refusals: ['empty_result'] });
    assert.deepEqual(asked, ['pools']);
  });

  test('no endpoint is no anchor', async () => {
    assert.deepEqual(await anchorThroughFirstAnsweringV1([]), { ok: false, refusals: [] });
  });
});

describe('a pinned call the endpoint did not answer is asked of the next one', () => {
  const TOKEN_A = '0x000000000000000000000000000000000000000a';
  const TOKEN_B = '0x000000000000000000000000000000000000000b';
  const TOKEN_C = '0x000000000000000000000000000000000000000c';
  const pinned = (to: string) => ({ to, data: '0x70a08231', blockTag: ANCHOR.blockTag });

  function caller(name: string, asked: string[], answer: (to: string) => B20RpcResultV1<string>): B20ReaderV1 {
    const unused = async (): Promise<never> => {
      throw new Error('not read in these tests');
    };
    return {
      async readBlockAnchor() {
        asked.push(`${name}:anchor`);
        return { ok: true, value: ANCHOR, raw: '"0x32a5af5"' };
      },
      readIsB20: unused,
      readIsB20Initialized: unused,
      readVariantActivated: unused,
      async call(input) {
        asked.push(`${name}:call:${input.to}`);
        return answer(input.to);
      },
      async callMany(inputs) {
        asked.push(`${name}:callMany:${inputs.map((input) => input.to).join(',')}`);
        return inputs.map((input) => answer(input.to));
      },
    };
  }

  const answered = (value: string): B20RpcResultV1<string> => ({ ok: true, value, raw: `"${value}"` });

  test('only the unanswered entries are asked again, and they land in place', async () => {
    const asked: string[] = [];
    const reader = withCallFailoverV1(
      caller('public', asked, (to) => (to === TOKEN_B ? { ok: false, reason: 'rate_limited' } : answered('0x01'))),
      [caller('read', asked, () => answered('0x02'))],
    );
    const answers = await reader.callMany!([pinned(TOKEN_A), pinned(TOKEN_B), pinned(TOKEN_C)]);
    assert.deepEqual(answers, [answered('0x01'), answered('0x02'), answered('0x01')]);
    assert.deepEqual(asked, [`public:callMany:${TOKEN_A},${TOKEN_B},${TOKEN_C}`, `read:callMany:${TOKEN_B}`]);
  });

  test('a single call fails over the same way', async () => {
    const asked: string[] = [];
    const reader = withCallFailoverV1(
      caller('public', asked, () => ({ ok: false, reason: 'rpc_timeout' })),
      [caller('read', asked, () => answered('0x02'))],
    );
    assert.deepEqual(await reader.call(pinned(TOKEN_A)), answered('0x02'));
    assert.deepEqual(asked, [`public:call:${TOKEN_A}`, `read:call:${TOKEN_A}`]);
  });

  test('a revert stays the answer and nobody else is asked', async () => {
    const asked: string[] = [];
    const reader = withCallFailoverV1(
      caller('public', asked, () => ({ ok: false, reason: 'reverted' })),
      [caller('read', asked, () => answered('0x02'))],
    );
    assert.deepEqual(await reader.callMany!([pinned(TOKEN_A)]), [{ ok: false, reason: 'reverted' }]);
    assert.deepEqual(asked, [`public:callMany:${TOKEN_A}`]);
  });

  test('the anchor stays with the endpoint that gave it', async () => {
    const asked: string[] = [];
    const reader = withCallFailoverV1(caller('public', asked, () => answered('0x01')), [
      caller('read', asked, () => answered('0x02')),
    ]);
    await reader.readBlockAnchor();
    assert.deepEqual(asked, ['public:anchor']);
  });

  test('with nowhere else to ask, the reader is unchanged', () => {
    const reader = caller('public', [], () => answered('0x01'));
    assert.equal(withCallFailoverV1(reader, []), reader);
  });
});
