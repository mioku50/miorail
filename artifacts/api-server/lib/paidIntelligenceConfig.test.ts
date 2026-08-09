import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  paidB20SimulationEnabledV1,
  paidSwapSimulationEnabledV1,
  resolvePaidB20SimulationPricingV1,
  simulationPriceUsdcForPrepareResponseV1,
} from './paidIntelligenceConfig.js';

describe('which surface the Intelligence Budget pays for', () => {
  test('both surfaces are off unless a deployment says otherwise', () => {
    // Charging is the deliberate act. A deployment that upgrades without
    // touching its env must not silently start billing for something new.
    assert.equal(paidSwapSimulationEnabledV1({}), false);
    assert.equal(paidB20SimulationEnabledV1({}), false);
  });

  test('the switch reads one word, forgiving only case and whitespace', () => {
    for (const value of ['1', 'yes', 'on', '', 'false']) {
      assert.equal(paidB20SimulationEnabledV1({ MIORAIL_PAID_B20_SIMULATION_V1: value }), false, value);
    }
    for (const value of ['true', 'TRUE', ' true ']) {
      assert.equal(paidB20SimulationEnabledV1({ MIORAIL_PAID_B20_SIMULATION_V1: value }), true, value);
    }
  });

  test('no price is advertised for a surface the server will refuse', () => {
    const env = {
      MIORAIL_SIMULATION_PRICE_USDC: '0.02',
      MIORAIL_SIMULATION_PROVIDER_URL: 'https://sim.example.test/simulate',
      MIORAIL_SIMULATION_PROVIDER_ALLOWLIST: 'sim.example.test',
    };
    assert.equal(simulationPriceUsdcForPrepareResponseV1(env), null);
    assert.equal(
      simulationPriceUsdcForPrepareResponseV1({ ...env, MIORAIL_PAID_SWAP_SIMULATION_V1: 'true' }),
      '0.02',
    );
  });

  test('B20 has its own price, and does not inherit a swap price that was set', () => {
    const both = resolvePaidB20SimulationPricingV1({
      MIORAIL_SIMULATION_PRICE_USDC: '0.02',
      MIORAIL_B20_SIMULATION_PRICE_USDC: '0.25',
    });
    assert.equal(both?.decimalUsdc, '0.25');
    assert.equal(both?.amountAtomic, '250000');
  });

  test('it falls back to the swap price only when it has nothing of its own', () => {
    const inherited = resolvePaidB20SimulationPricingV1({ MIORAIL_SIMULATION_PRICE_USDC: '0.02' });
    assert.equal(inherited?.decimalUsdc, '0.02');
  });

  test('an unparseable B20 price fails closed rather than becoming free', () => {
    // The alternative — treating a bad price as unpriced — would give away the
    // one operation this product sells, silently, on a typo.
    for (const bad of ['0', '-1', 'free', '0.0000001']) {
      assert.equal(resolvePaidB20SimulationPricingV1({ MIORAIL_B20_SIMULATION_PRICE_USDC: bad }), null, bad);
    }
  });
});
