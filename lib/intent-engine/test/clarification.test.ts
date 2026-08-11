import assert from 'node:assert/strict';
import test from 'node:test';
import {
  resolveSwapIntentV2,
  type IntentResolutionV2,
  type SwapIntentExtractionV2,
} from '../src/index.js';
import { swapExtraction, testContext } from './fixtures.js';

function clarification(
  message: string,
  extraction: SwapIntentExtractionV2,
): Extract<IntentResolutionV2, { outcome: 'needs_clarification' }> {
  const result = resolveSwapIntentV2({ message, extraction, context: testContext() });
  assert.equal(result.outcome, 'needs_clarification', JSON.stringify(result));
  assert.equal(result.routeIntent, null);
  return result as Extract<IntentResolutionV2, { outcome: 'needs_clarification' }>;
}

test('missing and non-exact amounts produce deterministic structured clarification', () => {
  const missing = clarification('Swap USDC to ETH.', swapExtraction({ amount: null }));
  assert.equal(missing.clarification.code, 'amount_required');
  assert.deepEqual(missing.clarification.missingFields, ['amount']);

  for (const [message, amount] of [
    ['Swap 25% of USDC to ETH.', '25%'],
    ['Swap all USDC to ETH.', 'all'],
    ['Swap about 100 USDC to ETH.', '100'],
    ['Обменяй немного USDC на ETH.', 'немного'],
  ] as const) {
    const result = clarification(message, swapExtraction({ amount }));
    assert.equal(result.clarification.code, 'exact_amount_required', message);
  }
});

test('asset errors never create incomplete RouteIntentV1 objects', () => {
  const samePair = clarification(
    'Swap 100 USDC to USDC.',
    swapExtraction({ fromAsset: 'USDC', toAsset: 'USDC' }),
  );
  assert.equal(samePair.clarification.code, 'asset_pair_invalid');

  const missingDestination = clarification('Swap 100 USDC.', swapExtraction({ toAsset: null }));
  assert.equal(missingDestination.clarification.code, 'to_asset_required');
  assert.ok(missingDestination.pendingIntent);

  const unknown = clarification('Swap 100 DOGE to ETH.', swapExtraction({ fromAsset: 'DOGE' }));
  assert.equal(unknown.clarification.code, 'asset_unknown');
  assert.equal(unknown.routeIntent, null);
});

test('one named asset behind a destination marker is the destination, not the source', () => {
  for (const message of ['Swap 0.1 to ETH', 'Convert 0.1 into ETH', 'Обменяй 0.1 на ETH']) {
    const named = clarification(message, swapExtraction({ amount: '0.1', fromAsset: null }));
    assert.equal(named.clarification.code, 'from_asset_required', message);
    assert.equal(named.pendingIntent?.toAssetSymbol, 'ETH', message);
    assert.equal(named.pendingIntent?.fromAssetSymbol, null, message);

    // The extractor may stay silent; the marker in the user's own text decides.
    const silent = clarification(
      message,
      swapExtraction({ amount: '0.1', fromAsset: null, toAsset: null }),
    );
    assert.equal(silent.clarification.code, 'from_asset_required', message);
  }

  const sourceMarker = clarification(
    'Swap 0.1 from ETH',
    swapExtraction({ amount: '0.1', fromAsset: 'ETH', toAsset: null }),
  );
  assert.equal(sourceMarker.clarification.code, 'to_asset_required');
});

test('the destination named alone survives into the next turn as a pending intent', () => {
  const first = clarification('Swap 0.1 to ETH', swapExtraction({ amount: '0.1', fromAsset: null }));
  assert.ok(first.pendingIntent);

  const second = resolveSwapIntentV2({
    message: 'USDC',
    extraction: swapExtraction({ amount: null, fromAsset: 'USDC', toAsset: null }),
    context: testContext({ requestId: 'request-fixture-2', pendingIntents: [first.pendingIntent] }),
  });
  assert.equal(second.outcome, 'ready', JSON.stringify(second));
  assert.equal(second.routeIntent?.fromAsset?.symbol, 'USDC');
  assert.equal(second.routeIntent?.toAsset?.symbol, 'ETH');
  assert.equal(second.routeIntent?.amount.amountDecimal, '0.1');
});

test('invalid slippage and ambiguous protocol requests are structured clarification', () => {
  const slippage = clarification('Swap 100 USDC to ETH with slippage bananas.', swapExtraction());
  assert.equal(slippage.clarification.code, 'slippage_invalid');
  assert.deepEqual(slippage.clarification.missingFields, ['slippageConstraint']);

  const protocol = clarification(
    'Swap 100 USDC to ETH. Use Uniswap or KyberSwap.',
    swapExtraction(),
  );
  assert.equal(protocol.clarification.code, 'protocol_conflict');
  assert.deepEqual(protocol.clarification.missingFields, ['protocolConstraint']);

  const unknownProtocol = clarification('Swap 100 USDC to ETH. Use Sushi only.', swapExtraction());
  assert.equal(unknownProtocol.clarification.code, 'protocol_conflict');
});

test('Russian clarification is localized while code and field order stay deterministic', () => {
  const first = clarification('Обменяй USDC.', swapExtraction({ amount: null, toAsset: null }));
  const second = clarification('Обменяй USDC.', swapExtraction({ amount: null, toAsset: null }));
  assert.equal(first.clarification.locale, 'ru');
  assert.equal(first.clarification.code, second.clarification.code);
  assert.deepEqual(first.clarification.missingFields, ['amount', 'toAsset']);
  assert.deepEqual(first.issues, second.issues);
});
