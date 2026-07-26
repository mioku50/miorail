import test, { describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createOpenSeaGatewayV1 } from '../src/index.js';

// ---------------------------------------------------------------------------
// T65 §3 / §12 — the adapter, with a DETONATOR on the global fetch.
//
// Every test injects its own fetch. The global one throws, so a test that
// accidentally reaches the network fails loudly instead of passing slowly and
// occasionally.
//
// The payloads below are the real 2026-07-26 shapes from api.opensea.io,
// trimmed to the fields the adapter reads.
// ---------------------------------------------------------------------------

const realFetch = globalThis.fetch;
beforeEach(() => {
  globalThis.fetch = (() => {
    throw new Error('a unit test reached the network');
  }) as unknown as typeof fetch;
});
test.after(() => {
  globalThis.fetch = realFetch;
});

const SELLER = '0x4efca7cc8058d5acd2bb2ccd2a9430906291cdd6';
const COLLECTION = '0x41dc69132cce31fcbf6755c84538ca268520246f';
const SEAPORT = '0x0000000000000068f116a894984e2db1123eb395';
const ORDER_HASH = '0x476046cb4bd47450c6bf661a2b62766438fe03492e3b00348eba614dd14ef359';
const NOW = new Date('2026-07-26T12:00:00.000Z');

const LISTING_PAYLOAD = {
  order_hash: ORDER_HASH,
  chain: 'base',
  protocol_address: SEAPORT,
  status: 'ACTIVE',
  type: 'basic',
  remaining_quantity: 1,
  price: { current: { currency: 'ETH', decimals: 18, value: '3580000000000000' } },
  protocol_data: {
    parameters: {
      offerer: SELLER,
      offer: [{ itemType: 2, token: COLLECTION, identifierOrCriteria: '16668', startAmount: '1', endAmount: '1' }],
      consideration: [
        { itemType: 0, token: '0x0000000000000000000000000000000000000000', identifierOrCriteria: '0', startAmount: '3544200000000000', endAmount: '3544200000000000', recipient: SELLER },
        { itemType: 0, token: '0x0000000000000000000000000000000000000000', identifierOrCriteria: '0', startAmount: '35800000000000', endAmount: '35800000000000', recipient: '0x0000a26b00c1f0df003000390027140000faa719' },
      ],
      startTime: '1785066231',
      endTime: '1785152630',
      orderType: 3,
      zone: '0x000056f7000000ece9003ca63978907a00ffd100',
      totalOriginalConsiderationItems: 2,
    },
  },
};

const NFT_PAYLOAD = {
  nft: {
    identifier: '16668',
    contract: COLLECTION,
    token_standard: 'erc721',
    collection: 'dxterminal',
    name: 'IzioGh0st',
    image_url: 'https://i2c.seadn.io/base/example.png',
    is_disabled: false,
    is_nsfw: false,
  },
};

function gateway(handler: (url: string) => { status?: number; body: unknown }) {
  const calls: string[] = [];
  const fetchImpl = (async (url: string) => {
    calls.push(String(url));
    const { status = 200, body } = handler(String(url));
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { gateway: createOpenSeaGatewayV1({ apiKey: 'test-key', fetchImpl }), calls };
}

describe('the adapter reads what it asked for', () => {
  test('the real listing shape becomes an observation priced from the order', () => {
    const { gateway: api, calls } = gateway(() => ({ body: LISTING_PAYLOAD }));
    return api.readBestListing({ collectionSlug: 'dxterminal', tokenId: '16668', now: NOW }).then((result) => {
      assert.equal(result.ok, true);
      if (!result.ok) return;
      assert.equal(result.value.orderHash, ORDER_HASH);
      assert.equal(result.value.protocolAddress, SEAPORT);
      assert.equal(result.value.seller, SELLER);
      // From the consideration, not from `price`.
      assert.equal(result.value.totalWei, '3580000000000000');
      assert.equal(result.value.feeWei, '35800000000000');
      assert.equal(result.value.listingStatus, 'active');
      assert.equal(result.value.listingExpiresAt, new Date(1785152630 * 1000).toISOString());
      // The current per-NFT path, confirmed live on 2026-07-26.
      assert.match(calls[0], /\/api\/v2\/listings\/collection\/dxterminal\/nfts\/16668\/best$/);
    });
  });

  test('the real NFT shape becomes an asset observation', async () => {
    const { gateway: api, calls } = gateway(() => ({ body: NFT_PAYLOAD }));
    const result = await api.readNft({ contractAddress: COLLECTION, tokenId: '16668', now: NOW });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.tokenStandard, 'erc721');
    assert.equal(result.value.collectionSlug, 'dxterminal');
    assert.match(calls[0], /\/api\/v2\/chain\/base\/contract\//);
  });

  test('the API key never enters the evidence hashes', async () => {
    const { gateway: api } = gateway(() => ({ body: NFT_PAYLOAD }));
    const result = await api.readNft({ contractAddress: COLLECTION, tokenId: '16668', now: NOW });
    assert.ok(result.ok);
    // Hashes are stored and shown; a credential inside one would leak with it.
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes('test-key'), false);
  });
});

describe('the adapter refuses rather than repairs', () => {
  test('an ERC-1155 is named, not misread', async () => {
    const { gateway: api } = gateway(() => ({
      body: { nft: { ...NFT_PAYLOAD.nft, token_standard: 'erc1155' } },
    }));
    const result = await api.readNft({ contractAddress: COLLECTION, tokenId: '16668', now: NOW });
    assert.equal(result.ok === false && result.reason, 'standard_unsupported');
    assert.equal(result.ok === false && result.detail, 'erc1155');
  });

  test('a response describing another token is refused', async () => {
    const { gateway: api } = gateway(() => ({ body: { nft: { ...NFT_PAYLOAD.nft, identifier: '999' } } }));
    const result = await api.readNft({ contractAddress: COLLECTION, tokenId: '16668', now: NOW });
    assert.equal(result.ok === false && result.reason, 'provider_invalid_response');
  });

  test('a payload naming another chain is refused, not translated', async () => {
    const { gateway: api } = gateway(() => ({ body: { ...LISTING_PAYLOAD, chain: 'ethereum' } }));
    const result = await api.readBestListing({ collectionSlug: 'dxterminal', tokenId: '16668', now: NOW });
    assert.equal(result.ok === false && result.reason, 'chain_mismatch');
  });

  test('a protocol address that is not a pinned Seaport is refused', async () => {
    const { gateway: api } = gateway(() => ({
      body: { ...LISTING_PAYLOAD, protocol_address: '0x5555555555555555555555555555555555555555' },
    }));
    const result = await api.readBestListing({ collectionSlug: 'dxterminal', tokenId: '16668', now: NOW });
    assert.equal(result.ok === false && result.reason, 'protocol_not_allowlisted');
  });

  test('a quote that disagrees with the order is refused, not preferred', async () => {
    // The summary says 0.001 ETH; the consideration takes 0.00358. Neither
    // side is chosen — the response cannot be reconciled.
    const { gateway: api } = gateway(() => ({
      body: { ...LISTING_PAYLOAD, price: { current: { currency: 'ETH', decimals: 18, value: '1000000000000000' } } },
    }));
    const result = await api.readBestListing({ collectionSlug: 'dxterminal', tokenId: '16668', now: NOW });
    assert.equal(result.ok === false && result.reason, 'quote_disagrees_with_order');
  });

  test('an unlisted NFT is "no active listing", not a provider failure', async () => {
    for (const response of [{ status: 404, body: {} }, { status: 200, body: {} }]) {
      const { gateway: api } = gateway(() => response);
      const result = await api.readBestListing({ collectionSlug: 'dxterminal', tokenId: '16668', now: NOW });
      assert.equal(result.ok === false && result.reason, 'no_active_listing');
    }
  });

  test('HTTP failures map to distinct reasons', async () => {
    const cases: [number, string][] = [
      [401, 'unauthorized'],
      [403, 'unauthorized'],
      [429, 'rate_limited'],
      [500, 'provider_unavailable'],
    ];
    for (const [status, reason] of cases) {
      const { gateway: api } = gateway(() => ({ status, body: {} }));
      const result = await api.readNft({ contractAddress: COLLECTION, tokenId: '16668', now: NOW });
      assert.equal(result.ok === false && result.reason, reason, String(status));
    }
  });
});

describe('the pre-signature re-read uses the same code as the candidate', () => {
  test('a fresh order read produces the identical observation', async () => {
    const { gateway: api, calls } = gateway(() => ({ body: { order: LISTING_PAYLOAD } }));
    const result = await api.readOrder({ protocolAddress: SEAPORT, orderHash: ORDER_HASH, now: NOW });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.totalWei, '3580000000000000');
    assert.equal(result.value.listingStatus, 'active');
    assert.match(calls[0], /\/api\/v2\/orders\/chain\/base\/protocol\//);
  });

  test('a cancelled order comes back cancelled, and the caller decides', async () => {
    const { gateway: api } = gateway(() => ({ body: { order: { ...LISTING_PAYLOAD, status: 'CANCELLED' } } }));
    const result = await api.readOrder({ protocolAddress: SEAPORT, orderHash: ORDER_HASH, now: NOW });
    assert.ok(result.ok);
    assert.equal(result.value.listingStatus, 'cancelled');
  });

  test('an order read that answers about a different order is refused', async () => {
    const { gateway: api } = gateway(() => ({ body: { order: LISTING_PAYLOAD } }));
    const result = await api.readOrder({ protocolAddress: SEAPORT, orderHash: `0x${'b'.repeat(64)}`, now: NOW });
    assert.equal(result.ok === false && result.reason, 'provider_invalid_response');
  });

  test('an unpinned protocol address is refused before any request is made', async () => {
    const { gateway: api, calls } = gateway(() => ({ body: {} }));
    const result = await api.readOrder({
      protocolAddress: '0x5555555555555555555555555555555555555555',
      orderHash: ORDER_HASH,
      now: NOW,
    });
    assert.equal(result.ok === false && result.reason, 'protocol_not_allowlisted');
    assert.equal(calls.length, 0, 'nothing may be requested for an unpinned protocol');
  });
});
