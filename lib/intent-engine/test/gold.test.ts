import assert from 'node:assert/strict';
import test from 'node:test';
import { RouteIntentV1Schema, type AssetRefV1 } from '@mioagent/route-domain';
import { resolveTrustedAsset, TRUSTED_ASSET_SYMBOLS, trustedBaseAssets } from '@mioagent/intent-core';
import {
  canonicalSwapExtractionV2,
  createClarificationV1,
  resolveRouteAssetV1,
  resolveSwapIntentV2,
  type IntentResolutionV2,
  type SwapIntentExtractionV2,
} from '../src/index.js';
import { swapExtraction, testContext } from './fixtures.js';

// PAXG joined the trusted swap registry on 2026-11-12: "Swap USDC to PAXG" in
// Swap AI got "Which exact token should be received?", the answer "120" was
// read as a token, and "Swap 121.076348 USDC to PAXG" got "Supported Swap V1
// assets are USDC, ETH, and WETH".

const PAXG = '0xe904aea5e1b110c9174728fa2effc8aed19e98ef';
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';

function resolve(message: string, extraction: SwapIntentExtractionV2, context = testContext()): IntentResolutionV2 {
  return resolveSwapIntentV2({ message, extraction, context });
}

function ready(message: string, extraction: SwapIntentExtractionV2) {
  const result = resolve(message, extraction);
  assert.equal(result.outcome, 'ready', `${message}: ${JSON.stringify(result)}`);
  RouteIntentV1Schema.parse(result.routeIntent);
  return result as Extract<IntentResolutionV2, { outcome: 'ready' }>;
}

test('the registry pins PAXG by its checksummed address, at 18 decimals', () => {
  const gold = trustedBaseAssets().find((asset) => asset.symbol === 'PAXG');
  assert.deepEqual(gold, {
    symbol: 'PAXG',
    address: '0xe904AEA5E1b110c9174728fA2efFc8aeD19E98Ef',
    decimals: 18,
    native: false,
    source: 'trusted_base_registry',
  });
  assert.deepEqual([...TRUSTED_ASSET_SYMBOLS], trustedBaseAssets().map((asset) => asset.symbol));
});

test('gold is named PAXG, gold or золото in any case of the noun, and never by the adjective', () => {
  for (const name of ['PAXG', 'paxg', 'gold', 'Gold', 'GOLD', 'Paxos Gold', 'золото', 'Золото', 'золота', 'золоту', 'золотом', 'золоте']) {
    assert.equal(resolveTrustedAsset(name)?.symbol, 'PAXG', name);
    assert.equal(resolveRouteAssetV1(name)?.address, PAXG, name);
  }
  for (const name of ['золотой', 'золотые', 'golden', 'XAUT', 'PAX']) {
    assert.equal(resolveTrustedAsset(name), null, name);
  }
});

test('buying and selling gold, in English and Russian, ground to USDC and PAXG', () => {
  const cases: Array<[string, Partial<SwapIntentExtractionV2>, 'USDC' | 'PAXG', string]> = [
    ['Swap 100 USDC to PAXG', { toAsset: 'PAXG' }, 'USDC', '100000000'],
    ['Swap 100 USDC to gold', { toAsset: 'gold' }, 'USDC', '100000000'],
    ['Купи золото на 100 USDC', { toAsset: 'золото' }, 'USDC', '100000000'],
    // A model may normalise the word to the ticker; the message still names gold.
    ['Купи золото на 100 USDC', { toAsset: 'PAXG' }, 'USDC', '100000000'],
    ['Обменяй 100 USDC на золото', { toAsset: 'золото' }, 'USDC', '100000000'],
    ['Продай 0.01 PAXG за USDC', { amount: '0.01', fromAsset: 'PAXG', toAsset: 'USDC' }, 'PAXG', '10000000000000000'],
    ['Обменяй 0.5 золота на USDC', { amount: '0.5', fromAsset: 'золота', toAsset: 'USDC' }, 'PAXG', '500000000000000000'],
  ];
  for (const [message, overrides, from, atomic] of cases) {
    const result = ready(message, swapExtraction(overrides));
    const to = from === 'USDC' ? 'PAXG' : 'USDC';
    assert.equal(result.routeIntent.fromAsset?.symbol, from, message);
    assert.equal(result.routeIntent.toAsset?.symbol, to, message);
    assert.equal(result.routeIntent.amount.amountAtomic, atomic, message);
    const gold = from === 'PAXG' ? result.routeIntent.fromAsset : result.routeIntent.toAsset;
    assert.deepEqual(gold, {
      assetId: `eip155:8453/erc20:${PAXG}`,
      chainId: 8453,
      kind: 'erc20',
      address: PAXG,
      symbol: 'PAXG',
      decimals: 18,
    }, message);
  }
});

test('PAXG named by its address is the pinned PAXG, read from no contract', () => {
  const message = `Swap 100 ${USDC} to 0xe904AEA5E1b110c9174728fA2efFc8aeD19E98Ef on Base`;
  const extraction = canonicalSwapExtractionV2(message);
  assert.ok(extraction);
  // No identified assets: the address is known because the registry pins it.
  const result = ready(message, extraction);
  assert.equal(result.routeIntent.toAsset?.symbol, 'PAXG');
  assert.equal(result.routeIntent.toAsset?.address, PAXG);
});

test('"Swap USDC to PAXG" asks for the amount and keeps the pair for the answer', () => {
  const first = resolve('Swap USDC to PAXG', swapExtraction({ amount: null, toAsset: 'PAXG' }));
  assert.equal(first.outcome, 'needs_clarification', JSON.stringify(first));
  assert.equal(first.clarification?.code, 'amount_required');
  assert.equal(first.pendingIntent?.fromAssetSymbol, 'USDC');
  assert.equal(first.pendingIntent?.toAssetSymbol, 'PAXG');

  const second = resolve(
    '120',
    swapExtraction({ amount: '120', fromAsset: null, toAsset: null }),
    testContext({
      requestId: 'request-fixture-2',
      requestedAt: '2026-07-15T12:01:00.000Z',
      pendingIntents: [first.pendingIntent!],
    }),
  );
  assert.equal(second.outcome, 'ready', JSON.stringify(second));
  assert.equal(second.routeIntent?.fromAsset?.symbol, 'USDC');
  assert.equal(second.routeIntent?.toAsset?.symbol, 'PAXG');
  assert.equal(second.routeIntent?.amount.amountAtomic, '120000000');
});

test('a token named by address that calls itself PAXG, GOLD or USDC is never stored by that name', () => {
  // Stored by name, it would come back on the next turn as the pinned token.
  for (const symbol of ['PAXG', 'GOLD', 'USDC']) {
    const impostor = '0x9999999999999999999999999999999999999999';
    const identified: AssetRefV1 = {
      assetId: `eip155:8453/erc20:${impostor}`,
      chainId: 8453,
      kind: 'erc20',
      address: impostor,
      symbol,
      decimals: 18,
    };
    const result = resolveSwapIntentV2({
      message: `Swap ${impostor} to ETH`,
      extraction: swapExtraction({ amount: null, fromAsset: impostor, toAsset: 'ETH' }),
      context: testContext(),
      identifiedAssets: [identified],
    });
    assert.equal(result.outcome, 'needs_clarification', `${symbol}: ${JSON.stringify(result)}`);
    assert.equal(result.clarification?.code, 'amount_required', symbol);
    assert.equal(result.pendingIntent?.fromAssetSymbol, null, symbol);
    assert.equal(result.pendingIntent?.toAssetSymbol, 'ETH', symbol);
  }
});

test('an unrecognised name says so, names gold, and offers the address', () => {
  const unknown = resolve('Swap 100 USDC to DOGE', swapExtraction({ toAsset: 'DOGE' }));
  assert.equal(unknown.outcome, 'needs_clarification');
  assert.equal(unknown.clarification?.code, 'asset_unknown');
  assert.match(unknown.clarification!.message, /did not recognise that token name/);
  assert.match(unknown.clarification!.message, /PAXG \(gold\)/);
  assert.match(unknown.clarification!.message, /paste its contract address/);
  assert.doesNotMatch(unknown.clarification!.message, /Swap V1/);

  const russian = createClarificationV1('asset_unknown', ['toAsset'], 'ru');
  assert.match(russian.message, /не узнал название токена/);
  assert.match(russian.message, /PAXG \(золото\)/);

  for (const code of ['from_asset_required', 'to_asset_required'] as const) {
    for (const locale of ['en', 'ru'] as const) {
      const { message } = createClarificationV1(code, [], locale);
      assert.match(message, /PAXG/, `${code} ${locale}`);
      assert.match(message, /(?:contract address|адрес его контракта)/, `${code} ${locale}`);
    }
  }
});
