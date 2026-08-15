import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { B20_QUOTE_ASSETS_V1 } from '@mioagent/swap-adapters';
import {
  B20_MEASUREMENT_QUOTE_ASSETS_V1,
  b20QuoteAssetDisplayV1,
  b20QuoteAssetIsEthScaledV1,
} from '@mioagent/opportunity-rail';

// ---------------------------------------------------------------------------
// Three lists of "which assets a B20 measurement may be denominated in", in
// three places that cannot import each other.
//
//   swap-adapters   decides which pool the RESOLVER will accept
//   opportunity-rail decides which asset an OBSERVATION may be stored in
//   Postgres         refuses the write outright
//
// Adding an asset to one and not the others produces a specific, quiet
// failure: the resolver returns a pool, the measurement runs, and the insert
// throws inside a worker that treats a storage error as a skipped token. That
// is exactly the shape of the bug this repository keeps re-finding, so the
// lists are pinned to each other by value.
// ---------------------------------------------------------------------------

/** `__dirname`, not `import.meta.url`: this package compiles as CommonJS,
 * where that meta-property is a compile error. */
const migration = readFileSync(
  path.join(__dirname, '..', '..', '..', 'lib', 'db', 'drizzle', '0042_b20_observation_weth_quote.sql'),
  'utf8',
);

describe('the quote-asset allowlists cannot drift apart', () => {
  test('the resolver and the observation store accept the same assets', () => {
    assert.deepEqual(
      [...B20_QUOTE_ASSETS_V1].sort(),
      [...B20_MEASUREMENT_QUOTE_ASSETS_V1].sort(),
      'a pool the resolver accepts must be an observation the rail can store',
    );
  });

  test('Postgres accepts exactly those assets and no others', () => {
    // The in-memory path must refuse what the database refuses, and the
    // database must not refuse what the code will hand it.
    const inCheck = [...migration.matchAll(/'(0x[0-9a-f]{40})'/g)].map((match) => match[1]!);
    assert.deepEqual(inCheck.sort(), [...B20_MEASUREMENT_QUOTE_ASSETS_V1].sort());
  });

  test('every accepted asset has a name and a scale', () => {
    // An asset the resolver accepts but the display table does not know would
    // be printed atomic on every card that mentions it.
    for (const asset of B20_QUOTE_ASSETS_V1) {
      const display = b20QuoteAssetDisplayV1(asset);
      assert.notEqual(display.decimals, null, `${asset} has no known scale`);
      assert.doesNotMatch(display.symbol, /…/, `${asset} is displayed as a truncated address`);
    }
  });
});

describe('an unknown asset is stated, never guessed', () => {
  test('it keeps its address and refuses to claim a scale', () => {
    // The two implementations this replaced disagreed: the Discover card
    // assumed six decimals, the copilot assumed eighteen. The same stored
    // observation could be printed as two numbers twelve orders of magnitude
    // apart, each with a confident label beside it.
    const display = b20QuoteAssetDisplayV1('0x1234567890abcdef1234567890abcdef12345678');
    assert.equal(display.decimals, null);
    assert.match(display.symbol, /^0x1234…5678$/);
  });

  test('an absent asset does not become an address-shaped label', () => {
    assert.deepEqual(b20QuoteAssetDisplayV1(null), { symbol: 'quote asset', decimals: null });
    assert.deepEqual(b20QuoteAssetDisplayV1(undefined), { symbol: 'quote asset', decimals: null });
  });
});

describe('position scale is chosen by the asset, not by "is this native"', () => {
  test('ETH and WETH both take the wei-denominated position', () => {
    // The measurement worker holds two sizes: one in USDC from the profile,
    // one explicitly in wei. Picking by "is this native ETH" would have sent a
    // WETH pool the profile's 100000000 — a ten-billionth of an ETH.
    assert.equal(b20QuoteAssetIsEthScaledV1('0x0000000000000000000000000000000000000000'), true);
    assert.equal(b20QuoteAssetIsEthScaledV1('0x4200000000000000000000000000000000000006'), true);
    assert.equal(b20QuoteAssetIsEthScaledV1('0x4200000000000000000000000000000000000006'.toUpperCase()), true);
  });

  test('USDC does not', () => {
    assert.equal(b20QuoteAssetIsEthScaledV1('0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'), false);
  });
});
