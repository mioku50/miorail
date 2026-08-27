import assert from 'node:assert/strict';
import test from 'node:test';
import type { B20ReaderV1 } from '@mioagent/b20-control';
import type { OfficialAssetRepositoryV1 } from '@mioagent/route-storage';

import { createReviewedMarketRealityReferenceAdapterV1 } from './rwaReferenceSession.js';

const TOKEN_A = '0xb20000000000000000000078ee7ce2fe4908108c';
const TOKEN_B = '0xa34c5e0abe843e10461e2c9586ea03e55dbcc495';
const FEED = '0x04689a41629776563e6822f76f2e57d148d28513';
const NOW = new Date('2026-08-27T14:00:00.000Z');

function identity(tokenAddress: string = TOKEN_A) {
  return {
    chainId: 8453,
    tokenAddress,
    issuer: 'coinbase',
    listings: [
      {
        sourceKind: 'base_docs_technical' as const,
        sourceUrl: 'https://docs.base.org/base-chain/asset-issuance/tokenized-stocks-on-base',
        ticker: 'NVDAc',
        displayName: 'NVIDIA',
        referenceFeedAddress: FEED,
        firstSeenAt: '2026-08-25T00:00:00.000Z',
        lastSeenAt: '2026-08-27T00:00:00.000Z',
        currentlyListed: true,
        sourceCheckedAt: '2026-08-27T00:00:00.000Z',
        sourceStatus: 'ok' as const,
      },
    ],
  };
}

test('a Base provider failure stays unknown rather than becoming a market state', async () => {
  const official = {
    officialIdentity: async () => identity(),
  } as unknown as OfficialAssetRepositoryV1;
  const reader = {
    readBlockAnchor: async () => ({ ok: false, reason: 'rpc_failure' }),
    call: async () => {
      throw new Error('no feed read without an anchor');
    },
  } as unknown as B20ReaderV1;
  const adapter = createReviewedMarketRealityReferenceAdapterV1({ official, reader });
  const result = await adapter({ tokenAddress: TOKEN_A, issuerId: 'coinbase', now: NOW });
  assert.equal(result.status, 'unknown');
  assert.equal(result.session, 'unknown');
  assert.equal(result.reasonCode, 'reference_read_failed');
  assert.equal(result.valueAtomic, null);
});

test('another issuer never borrows Coinbase reference configuration', async () => {
  let configurationReads = 0;
  let chainReads = 0;
  const official = {
    officialIdentity: async () => {
      configurationReads += 1;
      return identity();
    },
  } as unknown as OfficialAssetRepositoryV1;
  const reader = {
    readBlockAnchor: async () => {
      chainReads += 1;
      return { ok: false, reason: 'rpc_failure' };
    },
  } as unknown as B20ReaderV1;
  const adapter = createReviewedMarketRealityReferenceAdapterV1({ official, reader });
  const result = await adapter({ tokenAddress: TOKEN_B, issuerId: 'backed', now: NOW });
  assert.equal(result.session, 'unknown');
  assert.equal(result.reasonCode, 'issuer_reference_not_reviewed');
  assert.equal(configurationReads, 0);
  assert.equal(chainReads, 0);
});

test('a reviewed row for representation A cannot be returned for representation B', async () => {
  let chainReads = 0;
  const official = {
    // A buggy repository answer is still refused at the adapter boundary.
    officialIdentity: async () => identity(TOKEN_A),
  } as unknown as OfficialAssetRepositoryV1;
  const reader = {
    readBlockAnchor: async () => {
      chainReads += 1;
      return { ok: false, reason: 'rpc_failure' };
    },
  } as unknown as B20ReaderV1;
  const adapter = createReviewedMarketRealityReferenceAdapterV1({ official, reader });
  const result = await adapter({ tokenAddress: TOKEN_B, issuerId: 'coinbase', now: NOW });
  assert.equal(result.session, 'unknown');
  assert.equal(result.reasonCode, 'exact_representation_not_reviewed');
  assert.equal(chainReads, 0);
});
