import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalJsonV1, RouteIntentV1Schema } from '@mioagent/route-domain';
import {
  resolveSwapIntentV2,
  type IntentResolutionV2,
  type SwapIntentExtractionV2,
} from '../src/index.js';
import { swapExtraction, testContext } from './fixtures.js';

function ready(
  message: string,
  extraction: SwapIntentExtractionV2 = swapExtraction(),
): Extract<IntentResolutionV2, { outcome: 'ready' }> {
  const result = resolveSwapIntentV2({ message, extraction, context: testContext() });
  assert.equal(result.outcome, 'ready', JSON.stringify(result));
  RouteIntentV1Schema.parse(result.routeIntent);
  return result as Extract<IntentResolutionV2, { outcome: 'ready' }>;
}

test('basic EN/RU USDC to ETH swaps produce valid exact RouteIntentV1 objects', () => {
  const english = ready('Swap 100 USDC to ETH.');
  const russian = ready('Обменяй 100 USDC на ETH.');
  for (const result of [english, russian]) {
    assert.equal(result.routeIntent.goal, 'swap');
    assert.equal(result.routeIntent.chainId, 8453);
    assert.equal(result.routeIntent.fromAsset?.symbol, 'USDC');
    assert.equal(result.routeIntent.toAsset?.symbol, 'ETH');
    assert.equal(result.routeIntent.amount.amountDecimal, '100');
    assert.equal(result.routeIntent.amount.amountAtomic, '100000000');
    assert.equal(result.routeIntent.optimizationMode, 'best_net_result');
    assert.equal(result.routeIntent.verificationDepth, 'standard');
    assert.deepEqual(result.routeIntent.protocolConstraint, { mode: 'any', protocols: [] });
    assert.deepEqual(result.routeIntent.slippageConstraint, { maxBps: 50, source: 'default' });
    assert.equal(result.routeIntent.executionRequested, true);
  }
  assert.equal(english.routeIntent.intentHash, russian.routeIntent.intentHash);
});

test('everyday Russian swap verbs and token names resolve to the same intent', () => {
  const cases: Array<[string, Partial<SwapIntentExtractionV2>]> = [
    ['Переведи 100 USDC в ETH.', {}],
    ['Поменяй 100 USDC на ETH.', {}],
    ['Свап 100 USDC в ETH.', {}],
    ['Хочу обменять 100 USDC на эфир.', { toAsset: 'эфир' }],
    ['Обменяй 100 USDC на эфириум.', { toAsset: 'эфириум' }],
  ];
  for (const [message, overrides] of cases) {
    const result = ready(message, swapExtraction(overrides));
    assert.equal(result.routeIntent.fromAsset?.symbol, 'USDC', message);
    assert.equal(result.routeIntent.toAsset?.symbol, 'ETH', message);
    assert.equal(result.routeIntent.amount.amountDecimal, '100', message);
    assert.equal(result.routeIntent.executionRequested, true, message);
  }
});

test('buy wording names the destination first and does not reverse the pair', () => {
  const bought = ready('Купи ETH за 100 USDC.', swapExtraction());
  assert.equal(bought.routeIntent.fromAsset?.symbol, 'USDC');
  assert.equal(bought.routeIntent.toAsset?.symbol, 'ETH');

  const quoted = ready('Сколько ETH дадут за 100 USDC?', swapExtraction());
  assert.equal(quoted.routeIntent.fromAsset?.symbol, 'USDC');
  assert.equal(quoted.routeIntent.toAsset?.symbol, 'ETH');
  assert.equal(quoted.routeIntent.executionRequested, false);

  // The same preposition, the opposite direction: selling keeps source first.
  const sold = ready(
    'Продай 1.25 ETH за USDC.',
    swapExtraction({ amount: '1.25', fromAsset: 'ETH', toAsset: 'USDC' }),
  );
  assert.equal(sold.routeIntent.fromAsset?.symbol, 'ETH');
  assert.equal(sold.routeIntent.toAsset?.symbol, 'USDC');
});

test('ETH to USDC uses source decimals and preserves amount/source asset identity', () => {
  const result = ready(
    'Swap 1.25 ETH to USDC.',
    swapExtraction({ amount: '1.25', fromAsset: 'ETH', toAsset: 'USDC' }),
  );
  assert.equal(result.routeIntent.amount.amountAtomic, '1250000000000000000');
  assert.equal(result.routeIntent.amount.asset.assetId, result.routeIntent.fromAsset?.assetId);
});

test('optimization mappings are deterministic in English and Russian', () => {
  const cases: Array<[string, string]> = [
    ['Swap 100 USDC to ETH with the best net result.', 'best_net_result'],
    ['Swap 100 USDC to ETH using the safest route.', 'lowest_risk'],
    ['Обменяй 100 USDC на ETH с минимальными комиссиями.', 'lowest_fees'],
    ['Swap 100 USDC to ETH with fewer calls.', 'simplest_route'],
    ['Обменяй 100 USDC на ETH быстрее.', 'fastest_execution'],
    ['Use MEV protection when swapping 100 USDC to ETH.', 'mev_protected'],
    ['Обменяй 100 USDC на ETH с защитой от MEV.', 'mev_protected'],
  ];
  for (const [message, expected] of cases) {
    assert.equal(ready(message).routeIntent.optimizationMode, expected, message);
  }
});

test('protocol constraints normalize to lowercase canonical identifiers', () => {
  assert.deepEqual(
    ready('Swap 100 USDC to ETH. Use Uniswap only.').routeIntent.protocolConstraint,
    { mode: 'include_only', protocols: ['uniswap'] },
  );
  assert.deepEqual(
    ready('Обменяй 100 USDC на ETH. Используй только KyberSwap.').routeIntent.protocolConstraint,
    { mode: 'include_only', protocols: ['kyberswap'] },
  );
  assert.deepEqual(
    ready('Swap 100 USDC to ETH. Do not use Uniswap.').routeIntent.protocolConstraint,
    { mode: 'exclude', protocols: ['uniswap'] },
  );
  assert.deepEqual(
    ready('Find the best route to swap 100 USDC to ETH.').routeIntent.protocolConstraint,
    {
      mode: 'any',
      protocols: [],
    },
  );

  const manifestedProviders = [
    ['Swap 100 USDC to ETH through Balancer.', 'balancer'],
    ['Swap 100 USDC to ETH on Hydrex.', 'hydrex'],
    ['Get an o1.exchange quote to swap 100 USDC to ETH.', 'o1-exchange'],
  ] as const;
  for (const [message, provider] of manifestedProviders) {
    assert.deepEqual(
      ready(message).routeIntent.protocolConstraint,
      { mode: 'include_only', protocols: [provider] },
      message,
    );
  }
});

test('verification and slippage mappings use explicit deterministic values', () => {
  assert.equal(
    ready('Swap 100 USDC to ETH and check more deeply before I sign.').routeIntent
      .verificationDepth,
    'enhanced',
  );
  assert.equal(
    ready('Обменяй 100 USDC на ETH с максимальной проверкой.').routeIntent.verificationDepth,
    'maximum',
  );
  assert.deepEqual(
    ready('Swap 100 USDC to ETH with max 0.5% slippage.').routeIntent.slippageConstraint,
    { maxBps: 50, source: 'user' },
  );
  assert.deepEqual(
    ready('Обменяй 100 USDC на ETH, проскальзывание не больше 1%.').routeIntent.slippageConstraint,
    { maxBps: 100, source: 'user' },
  );
});

test('quote-only, compare, prepare, and explicit no-execution language remain distinct', () => {
  const quote = ready('What quote would I get swapping 100 USDC to ETH?');
  const compare = ready('Compare routes for swapping 100 USDC to ETH.');
  const prepare = ready('Prepare the swap of 100 USDC to ETH.');
  const noExecute = ready('Prepare the swap of 100 USDC to ETH, but do not execute it yet.');
  assert.equal(quote.routeIntent.executionRequested, false);
  assert.equal(compare.routeIntent.executionRequested, false);
  assert.equal(prepare.routeIntent.executionRequested, true);
  assert.equal(noExecute.routeIntent.executionRequested, false);
});

test('same request and authenticated context produce identical object, JSON, and intentHash', () => {
  const input = {
    message: 'Swap 100 USDC to ETH with the best net result.',
    extraction: swapExtraction(),
    context: testContext(),
  };
  const first = resolveSwapIntentV2(input);
  const second = resolveSwapIntentV2(structuredClone(input));
  assert.equal(first.outcome, 'ready');
  assert.equal(second.outcome, 'ready');
  assert.deepEqual(first.routeIntent, second.routeIntent);
  assert.equal(canonicalJsonV1(first.routeIntent), canonicalJsonV1(second.routeIntent));
  assert.equal(first.routeIntent.intentHash, second.routeIntent.intentHash);
});
