import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { ethDecimalToWeiV1, extractNftIntentV1, resolveNftIntentV1 } from '../src/nft-extractor.js';

const WALLET = '0x1111111111111111111111111111111111111111' as const;
const NOW = new Date('2026-07-26T12:00:00.000Z');
const CONTRACT = '0x1234567890abcdef1234567890abcdef12345678';

function resolve(message: string, requestId = 'req-1') {
  return resolveNftIntentV1({ message, tenantId: 'tenant', walletAddress: WALLET, now: NOW, requestId });
}

describe('one token named three ways', () => {
  test('a Russian request grounds into an NFT purchase intent', () => {
    const resolution = resolve('Купи NFT BasePaint #123 дешевле 0.02 ETH');
    assert.equal(resolution.status, 'ready');
    assert.ok(resolution.intent);
    assert.equal(resolution.intent.collectionSlug, 'basepaint');
    assert.equal(resolution.intent.tokenId, '123');
    assert.equal(resolution.intent.maxSpendWei, '20000000000000000');
    assert.equal(resolution.intent.paymentAsset, 'native_eth');
    assert.equal(resolution.intent.quantity, 1);
    assert.equal(resolution.intent.tokenStandard, 'erc721');
  });

  test('the English request grounds the same way', () => {
    const resolution = resolve('Buy BasePaint #123 for under 0.02 ETH');
    assert.equal(resolution.status, 'ready');
    assert.equal(resolution.intent?.collectionSlug, 'basepaint');
    assert.equal(resolution.intent?.tokenId, '123');
    assert.equal(resolution.intent?.maxSpendWei, '20000000000000000');
  });

  test('an OpenSea item URL supplies chain, contract and token id', () => {
    const resolution = resolve(`Buy https://opensea.io/assets/base/${CONTRACT}/99 under 0.05 ETH`);
    assert.equal(resolution.status, 'ready');
    assert.equal(resolution.intent?.inputSource, 'opensea_url');
    assert.equal(resolution.intent?.contractAddress, CONTRACT);
    assert.equal(resolution.intent?.tokenId, '99');
  });

  test('a bare contract and token id is the strongest form and is taken as-is', () => {
    const resolution = resolve(`Buy ${CONTRACT} #7 max 1 ETH`);
    assert.equal(resolution.status, 'ready');
    assert.equal(resolution.intent?.inputSource, 'contract_and_token');
    assert.equal(resolution.intent?.contractAddress, CONTRACT);
    assert.equal(resolution.intent?.maxSpendWei, '1000000000000000000');
  });
});

describe('nothing is inferred', () => {
  test('an NFT request with no ceiling is a clarification, never an open cheque', () => {
    // The single most consequential refusal in this family.
    const resolution = resolve('Buy BasePaint #123');
    assert.equal(resolution.status, 'needs_clarification');
    assert.ok(resolution.issues.includes('max_spend_required'));
    assert.equal(resolution.intent, null);
  });

  test('a URL naming another chain is unsupported, not quietly treated as Base', () => {
    const resolution = resolve(`Buy https://opensea.io/assets/ethereum/${CONTRACT}/99 under 0.05 ETH`);
    assert.equal(resolution.status, 'unsupported');
    assert.ok(resolution.issues.includes('chain_unsupported'));
    assert.equal(resolution.intent, null);
  });

  test('a ceiling in a currency this rail does not pay with is refused, not converted', () => {
    const resolution = resolve(`Buy ${CONTRACT} #7 cheaper than 0.02 WETH`);
    assert.equal(resolution.status, 'needs_clarification');
    assert.ok(resolution.issues.includes('limit_currency_unsupported'));
  });

  test('two different ceilings are a clarification', () => {
    const resolution = resolve(`Buy ${CONTRACT} #7 under 1 ETH, max 2 ETH`);
    assert.equal(resolution.status, 'needs_clarification');
    assert.ok(resolution.issues.includes('conflicting_limits'));
  });

  test('a URL and a contradicting token id in the same sentence is ambiguous', () => {
    const resolution = resolve(`Buy https://opensea.io/assets/base/${CONTRACT}/99 #123 under 1 ETH`);
    assert.equal(resolution.status, 'needs_clarification');
    assert.ok(resolution.issues.includes('ambiguous_token'));
    assert.equal(resolution.intent, null);
  });

  test('no token id at all is a clarification', () => {
    const resolution = resolve('Buy an NFT cheaper than 0.02 ETH');
    assert.equal(resolution.status, 'needs_clarification');
    assert.ok(resolution.issues.includes('token_required'));
  });

  test('a swap goal is not routed to NFT', () => {
    const resolution = resolve('swap 100 USDC to ETH');
    assert.equal(resolution.status, 'unsupported');
    assert.ok(resolution.issues.includes('not_nft_goal'));
  });
});

describe('the ceiling clause never becomes part of the token', () => {
  test('numbers in the ceiling are not read as a token id', () => {
    const extraction = extractNftIntentV1('Купи NFT BasePaint #123 дешевле 0.02 ETH');
    assert.equal(extraction.tokenId, '123');
    assert.notEqual(extraction.tokenId, '0');
    assert.notEqual(extraction.tokenId, '02');
  });

  test('the ceiling vocabulary is not read as a collection slug', () => {
    const slug = extractNftIntentV1('Buy BasePaint #123 for under 0.02 ETH').collectionSlug ?? '';
    assert.equal(slug, 'basepaint');
    for (const phrase of ['under', 'cheaper', 'eth', '0.02', 'max']) {
      assert.equal(slug.includes(phrase), false, `slug still contains "${phrase}"`);
    }
  });
});

describe('ETH decimals become wei exactly', () => {
  test('the full 18-decimal range is placed, never scaled through a float', () => {
    assert.equal(ethDecimalToWeiV1('1'), '1000000000000000000');
    assert.equal(ethDecimalToWeiV1('0.02'), '20000000000000000');
    assert.equal(ethDecimalToWeiV1('0.1'), '100000000000000000');
    // 0.1 + 0.2 in float is 0.30000000000000004; this path never touches one.
    assert.equal(ethDecimalToWeiV1('0.3'), '300000000000000000');
    assert.equal(ethDecimalToWeiV1('0.000000000000000001'), '1');
    assert.equal(ethDecimalToWeiV1('12.345678901234567891'), '12345678901234567891');
  });

  test('more than 18 decimals is refused rather than truncated', () => {
    assert.equal(ethDecimalToWeiV1('0.0000000000000000001'), null);
    assert.equal(ethDecimalToWeiV1('abc'), null);
  });
});

describe('each comparison is its own run', () => {
  test('the same goal with a new request id resolves to a new intent id', () => {
    const first = resolve('Buy BasePaint #123 under 0.02 ETH', 'req-1');
    const second = resolve('Buy BasePaint #123 under 0.02 ETH', 'req-2');
    assert.ok(first.intent && second.intent);
    assert.notEqual(first.intent.id, second.intent.id);
  });

  test('a replayed request id is the same run, which is what idempotency means', () => {
    const first = resolve('Buy BasePaint #123 under 0.02 ETH', 'req-1');
    const replay = resolve('Buy BasePaint #123 under 0.02 ETH', 'req-1');
    assert.equal(first.intent?.id, replay.intent?.id);
    assert.equal(first.intent?.intentHash, replay.intent?.intentHash);
  });
});
