import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import type { B20BatchCallV1, B20BlockAnchorV1, B20ReaderV1 } from '@mioagent/b20-control';

import {
  DINARI_BASE_ROOT_V1,
  DINARI_BASE_STAGING_FACTORY_V1,
  DINARI_MEMBERSHIP_SELECTOR_V1,
  readDinariMembershipV1,
} from '../src/dinariRoot.js';
import {
  DINARI_BALANCE_PER_SHARE_SCALE_V1,
  readDinariBalancePerShareV1,
} from '../src/dinariRatio.js';
import {
  baseRepresentationsOfV1,
  dinariSourceStateV1,
  dinariUnderlyingKeyV1,
  fetchDinariStocksV1,
  parseCaip10V1,
} from '../src/dinariStockApi.js';

const DINARI_AAPL = '0x41f7a63713e76c0ab800be03bae9f17b8a356348';
const WRAPPED_AAPL = '0x052175b0015ccca91919f374043a665441e4b0b8';

const ANCHOR: B20BlockAnchorV1 = {
  blockNumber: '50487393',
  blockHash: `0x${'a1'.repeat(32)}` as B20BlockAnchorV1['blockHash'],
  blockTag: '0x3026061',
};

const TRUE_WORD = `0x${'0'.repeat(63)}1`;
const FALSE_WORD = `0x${'0'.repeat(64)}`;
const WAD_WORD = `0x${(10n ** 18n).toString(16).padStart(64, '0')}`;

function readerReturning(
  answer: (call: B20BatchCallV1) => Awaited<ReturnType<B20ReaderV1['call']>>,
): B20ReaderV1 {
  return {
    readBlockAnchor: async () => ({ ok: true, value: ANCHOR, raw: '' }),
    readIsB20: async () => ({ ok: false, reason: 'reverted' }),
    readIsB20Initialized: async () => ({ ok: false, reason: 'reverted' }),
    readVariantActivated: async () => ({ ok: false, reason: 'reverted' }),
    call: async (call: B20BatchCallV1) => answer(call),
  } as unknown as B20ReaderV1;
}

describe('the pinned Dinari root', () => {
  test('records the environment it came from, not just an address', () => {
    // Two live Base factories disagree about the same token because one is
    // production and one is staging. Without the environment key in the pin,
    // a later re-pin would silently land on the wrong one.
    assert.equal(DINARI_BASE_ROOT_V1.provenance.environment, 'production');
    assert.equal(DINARI_BASE_ROOT_V1.provenance.chainKey, '8453');
    assert.match(DINARI_BASE_ROOT_V1.provenance.path, /releases\/v0\.4\.0\/dshare_factory\.json/);
    assert.notEqual(
      DINARI_BASE_ROOT_V1.rootAddress,
      DINARI_BASE_STAGING_FACTORY_V1,
      'the staging factory is recorded so it cannot be mistaken for the root',
    );
  });

  test('a true from the root establishes membership, anchored to a block', async () => {
    const reader = readerReturning((call) => {
      assert.equal(call.to, DINARI_BASE_ROOT_V1.rootAddress);
      assert.ok(call.data.startsWith(DINARI_MEMBERSHIP_SELECTOR_V1));
      assert.ok(call.data.endsWith(DINARI_AAPL.slice(2)));
      return { ok: true, value: TRUE_WORD, raw: TRUE_WORD };
    });
    const read = await readDinariMembershipV1(reader, { tokenAddress: DINARI_AAPL, anchor: ANCHOR });
    assert.equal(read.outcome, 'established');
    assert.equal(read.outcome === 'established' ? read.blockNumber : null, '50487393');
  });

  test('a false is a refutation, and it is a real answer', async () => {
    // Measured: the factory says false about the wrapper that sits beside
    // every dShare. That "no" is worth storing.
    const reader = readerReturning(() => ({ ok: true, value: FALSE_WORD, raw: FALSE_WORD }));
    const read = await readDinariMembershipV1(reader, { tokenAddress: WRAPPED_AAPL, anchor: ANCHOR });
    assert.equal(read.outcome, 'refuted');
  });

  test('an endpoint that would not answer is never a refutation', async () => {
    // The bug class this repository keeps re-shipping: our failure wearing the
    // token's name. A throttled call must not delist an issuer.
    const reader = readerReturning(() => ({ ok: false, reason: 'rate_limited' }));
    const read = await readDinariMembershipV1(reader, { tokenAddress: DINARI_AAPL, anchor: ANCHOR });
    assert.equal(read.outcome, 'unread');
    assert.equal(read.outcome === 'unread' ? read.reason : null, 'rate_limited');
  });

  test('a revert from the root is unread, not no', async () => {
    // The factory implements this selector on both live deployments, so a
    // revert means the call did not reach a working root.
    const reader = readerReturning(() => ({ ok: false, reason: 'reverted' }));
    const read = await readDinariMembershipV1(reader, { tokenAddress: DINARI_AAPL, anchor: ANCHOR });
    assert.equal(read.outcome, 'unread');
  });

  test('an answer that is not a bool decides nothing', async () => {
    const reader = readerReturning(() => ({ ok: true, value: '0x1234', raw: '0x1234' }));
    const read = await readDinariMembershipV1(reader, { tokenAddress: DINARI_AAPL, anchor: ANCHOR });
    assert.equal(read.outcome, 'unread');
  });
});

describe('the Dinari ratio adapter', () => {
  test('reads balance-per-share and says the scale was reviewed, not read', async () => {
    const reader = readerReturning(() => ({ ok: true, value: WAD_WORD, raw: WAD_WORD }));
    const read = await readDinariBalancePerShareV1(reader, {
      tokenAddress: DINARI_AAPL,
      anchor: ANCHOR,
    });
    assert.equal(read.outcome, 'read');
    if (read.outcome !== 'read') return;
    assert.equal(read.application, 'already_applied_by_token');
    assert.equal(read.scaleSource, 'reviewed_constant');
    assert.equal(read.scale, DINARI_BALANCE_PER_SHARE_SCALE_V1);
    assert.equal(read.normalized, '1.000000000000000000');
  });

  test('a rebased value normalises without losing a digit', async () => {
    const raw = 1191732972027972021n;
    const word = `0x${raw.toString(16).padStart(64, '0')}`;
    const reader = readerReturning(() => ({ ok: true, value: word, raw: word }));
    const read = await readDinariBalancePerShareV1(reader, {
      tokenAddress: DINARI_AAPL,
      anchor: ANCHOR,
    });
    assert.equal(read.outcome === 'read' ? read.normalized : null, '1.191732972027972021');
  });

  test('a contract without the function is absent; an endpoint failure is unread', async () => {
    const reverting = readerReturning(() => ({ ok: false, reason: 'reverted' }));
    const throttled = readerReturning(() => ({ ok: false, reason: 'rate_limited' }));
    assert.equal(
      (await readDinariBalancePerShareV1(reverting, { tokenAddress: DINARI_AAPL, anchor: ANCHOR }))
        .outcome,
      'absent',
    );
    assert.equal(
      (await readDinariBalancePerShareV1(throttled, { tokenAddress: DINARI_AAPL, anchor: ANCHOR }))
        .outcome,
      'unread',
    );
  });

  test('a zero ratio is unusable rather than stored', async () => {
    const reader = readerReturning(() => ({ ok: true, value: FALSE_WORD, raw: FALSE_WORD }));
    const read = await readDinariBalancePerShareV1(reader, {
      tokenAddress: DINARI_AAPL,
      anchor: ANCHOR,
    });
    assert.equal(read.outcome, 'absent');
  });
});

describe('the dormant stock API', () => {
  test('chain and address travel together, and a foreign chain is dropped', () => {
    assert.deepEqual(parseCaip10V1(`eip155:8453:${DINARI_AAPL}`), {
      chainId: 8453,
      address: DINARI_AAPL,
    });
    assert.equal(parseCaip10V1('eip155:8453'), null);
    const stock = {
      id: '7e6a9c04-1b3e-4a2f-9f0d-2b5c8a1d4e77',
      name: 'Apple Inc.',
      symbol: 'AAPL',
      is_fractionable: true,
      is_tradable: true,
      tokens: [`eip155:42161:${WRAPPED_AAPL}`, `eip155:8453:${DINARI_AAPL}`],
    };
    assert.deepEqual(baseRepresentationsOfV1(stock), [DINARI_AAPL]);
  });

  test('the underlying key is namespaced by the source that issued it', () => {
    assert.equal(
      dinariUnderlyingKeyV1('7E6A9C04-1B3E-4A2F-9F0D-2B5C8A1D4E77'),
      'dinari:stock_id:7e6a9c04-1b3e-4a2f-9f0d-2b5c8a1d4e77',
    );
  });

  test('missing credentials are our state, not the issuer being unreachable', async () => {
    assert.equal(dinariSourceStateV1({}), 'credentials_absent');
    assert.equal(dinariSourceStateV1({ DINARI_API_KEY_ID: 'x' }), 'credentials_incomplete');
    assert.equal(
      dinariSourceStateV1({ DINARI_API_KEY_ID: 'x', DINARI_API_SECRET_KEY: 'y' }),
      'ready',
    );
  });

  test('nothing reaches the network without both credentials', async () => {
    let called = false;
    const result = await fetchDinariStocksV1({
      credentials: null,
      fetchImpl: (async () => {
        called = true;
        throw new Error('must not be called');
      }) as unknown as typeof fetch,
    });
    assert.equal(called, false);
    assert.equal(result.ok, false);
    assert.equal(result.ok === false ? result.reason : null, 'credentials_absent');
  });

  test('the confirmed response contract is what is parsed', async () => {
    const stock = {
      id: '7e6a9c04-1b3e-4a2f-9f0d-2b5c8a1d4e77',
      name: 'Apple Inc.',
      symbol: 'AAPL',
      is_fractionable: true,
      is_tradable: true,
      tokens: [`eip155:8453:${DINARI_AAPL}`],
      cusip: null,
      cik: '0000320193',
    };
    const result = await fetchDinariStocksV1({
      credentials: { apiKeyId: 'id', apiSecretKey: 'secret' },
      fetchImpl: (async (_url: string, init: RequestInit) => {
        const headers = init.headers as Record<string, string>;
        assert.equal(headers['X-API-Key-Id'], 'id');
        assert.equal(headers['X-API-Secret-Key'], 'secret');
        return new Response(JSON.stringify({ data: [stock], pagination_metadata: {} }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }) as unknown as typeof fetch,
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.stocks[0]?.id, stock.id);
    assert.equal(result.stocks[0]?.cusip, null, 'a null CUSIP is a licence gap, not a missing field');
  });

  test('a 401 is named as unauthorized rather than as the source being down', async () => {
    const result = await fetchDinariStocksV1({
      credentials: { apiKeyId: 'id', apiSecretKey: 'secret' },
      fetchImpl: (async () => new Response('', { status: 401 })) as unknown as typeof fetch,
    });
    assert.equal(result.ok === false ? result.reason : null, 'unauthorized');
    assert.doesNotMatch(result.ok === false ? result.detail : '', /secret/i);
  });
});
