import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createDefaultSwapAdapters,
  KyberSwapRouteAdapter,
  UniswapSwapRouteAdapter,
  getEligibleSwapAdapters,
} from '../src/index.js';
import { makeIntent, NOW, WALLET, withProtocolConstraint } from './fixtures.js';

const adapters = [
  new UniswapSwapRouteAdapter({ apiKey: 'fixture-key' }),
  new KyberSwapRouteAdapter(),
];

function selectedIds(intent = makeIntent()): string[] {
  const result = getEligibleSwapAdapters(intent, adapters);
  assert.equal(result.outcome, 'selected');
  return result.outcome === 'selected' ? result.adapters.map((adapter) => adapter.id) : [];
}

test('protocol any selects both adapters in deterministic order', () => {
  assert.deepEqual(selectedIds(), ['uniswap', 'kyberswap']);
});

test('include_only selects Uniswap only', () => {
  const intent = withProtocolConstraint(makeIntent(), {
    mode: 'include_only',
    protocols: ['uniswap'],
  });
  assert.deepEqual(selectedIds(intent), ['uniswap']);
});

test('include_only selects KyberSwap only', () => {
  const intent = withProtocolConstraint(makeIntent(), {
    mode: 'include_only',
    protocols: ['kyberswap'],
  });
  assert.deepEqual(selectedIds(intent), ['kyberswap']);
});

test('excluding Uniswap leaves KyberSwap', () => {
  const intent = withProtocolConstraint(makeIntent(), {
    mode: 'exclude',
    protocols: ['uniswap'],
  });
  assert.deepEqual(selectedIds(intent), ['kyberswap']);
});

test('excluding KyberSwap leaves Uniswap', () => {
  const intent = withProtocolConstraint(makeIntent(), {
    mode: 'exclude',
    protocols: ['kyberswap'],
  });
  assert.deepEqual(selectedIds(intent), ['uniswap']);
});

test('no remaining adapter returns typed selection failure', () => {
  const intent = withProtocolConstraint(makeIntent(), {
    mode: 'include_only',
    protocols: ['aerodrome'],
  });
  assert.deepEqual(getEligibleSwapAdapters(intent, adapters), {
    outcome: 'no_eligible_adapters',
    adapters: [],
    errorCode: 'no_eligible_swap_adapters',
  });
});

test('a generic normalized intent never silently defaults to Uniswap', () => {
  assert.deepEqual(selectedIds(makeIntent()), ['uniswap', 'kyberswap']);
});

test('adapter supports() independently enforces protocol constraints', () => {
  const kyberOnly = withProtocolConstraint(makeIntent(), {
    mode: 'include_only',
    protocols: ['kyberswap'],
  });
  assert.equal(adapters[0].supports(kyberOnly), false);
  assert.equal(adapters[1].supports(kyberOnly), true);
});

test('Routes-owned manifested providers return a typed unavailable fact when explicitly selected', async () => {
  for (const provider of ['balancer', 'hydrex', 'o1-exchange'] as const) {
    const intent = withProtocolConstraint(makeIntent(), {
      mode: 'include_only',
      protocols: [provider],
    });
    const selection = getEligibleSwapAdapters(intent, createDefaultSwapAdapters());
    assert.equal(selection.outcome, 'selected');
    if (selection.outcome !== 'selected') continue;
    assert.deepEqual(selection.adapters.map((adapter) => adapter.id), [provider]);
    assert.deepEqual(
      await selection.adapters[0].quote({ intent, walletAddress: WALLET, requestId: `manifested-${provider}`, now: NOW }),
      {
        outcome: 'not_configured',
        provider,
        errorCode: `${provider.replace(/-/g, '_')}_route_adapter_not_released`,
        retryable: false,
      },
    );
  }
});

test('unsupported chain and non-ready intents select no adapters', () => {
  assert.equal(getEligibleSwapAdapters(makeIntent({ chainId: 84532 }), adapters).outcome, 'no_eligible_adapters');
  assert.equal(getEligibleSwapAdapters(makeIntent({ status: 'draft' }), adapters).outcome, 'no_eligible_adapters');
});
