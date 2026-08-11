import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import {
  addressesInTextV1,
  identifyTokenV1,
  sanitizeTokenSymbolV1,
  trustedBaseAssets,
  trustedByAddressV1,
  type TokenIdentityReaderV1,
} from '@mioagent/intent-core';

// ---------------------------------------------------------------------------
// Identifying a token beyond the canonical three. What is under test is not
// "can we read a contract" — it is WHERE the address is allowed to come from,
// and what a contract's own words are allowed to buy it.
// ---------------------------------------------------------------------------

const MIO = '0x1234567890abcdef1234567890abcdef12345678';

function reader(overrides: Partial<TokenIdentityReaderV1> = {}): TokenIdentityReaderV1 {
  return {
    readSymbol: async () => 'MIO',
    readDecimals: async () => 18,
    ...overrides,
  };
}

describe('a token is identified by its address, read from the chain', () => {
  test('a readable contract yields an asset with its own symbol and decimals', async () => {
    const result = await identifyTokenV1(MIO, reader());
    assert.equal(result.outcome, 'identified');
    if (result.outcome === 'identified') {
      assert.equal(result.identity.address, MIO);
      assert.equal(result.identity.symbol, 'MIO');
      assert.equal(result.identity.decimals, 18);
      // Checksummed for display, lowercase for comparison — both, on purpose.
      assert.equal(result.identity.displayAddress.toLowerCase(), MIO);
    }
  });

  test('an unreadable contract is refused, never guessed at', async () => {
    const broken: Partial<TokenIdentityReaderV1>[] = [
      { readDecimals: async () => null },
      { readSymbol: async () => null },
      { readDecimals: async () => 255 },
      { readDecimals: async () => 1.5 },
      { readSymbol: async () => '   ' },
    ];
    for (const override of broken) {
      const result = await identifyTokenV1(MIO, reader(override));
      assert.equal(result.outcome, 'refused', JSON.stringify(Object.keys(override)));
    }
  });

  test('a malformed address never reaches the chain', async () => {
    let called = false;
    const spy = reader({
      readDecimals: async () => {
        called = true;
        return 18;
      },
    });
    const result = await identifyTokenV1('MIO', spy);
    assert.equal(result.outcome, 'refused');
    if (result.outcome === 'refused') assert.equal(result.reason, 'address_malformed');
    assert.equal(called, false, 'a symbol must never be treated as an address');
  });
});

describe('a contract cannot talk its way into being trusted', () => {
  test('answering "USDC" buys a stranger nothing — trust is by address', () => {
    const trusted = trustedBaseAssets();
    const usdc = trusted.find((asset) => asset.symbol === 'USDC');
    assert.ok(usdc?.address);
    assert.equal(trustedByAddressV1(usdc.address, trusted), true);
    // A different contract that calls itself USDC gains nothing by saying so.
    assert.equal(trustedByAddressV1(MIO, trusted), false);
  });

  test('a look-alike symbol survives as a label but is never an identity', () => {
    // Cyrillic С in place of Latin C. It renders identically, and must not be
    // silently normalised away — the defence is showing the ADDRESS.
    const lookalike = sanitizeTokenSymbolV1('USDС');
    assert.equal(lookalike, 'USDС');
    assert.notEqual(lookalike, 'USDC');
  });

  test('control characters and unbounded names are refused outright', () => {
    assert.equal(sanitizeTokenSymbolV1(['MI O', 'X'].join('\n')), 'MI OX');
    assert.equal(sanitizeTokenSymbolV1(''), null);
    assert.equal(sanitizeTokenSymbolV1('A'.repeat(33)), null);
  });
});

describe('addresses come from the user, in their own words', () => {
  test('every distinct address in a sentence is found, in order', () => {
    const other = '0xAAaaAAaaAAaaAAaaAAaaAAaaAAaaAAaaAAaaAAaa';
    const found = addressesInTextV1(`swap 100 ${MIO} to ${other} and ${MIO.toUpperCase()}`);
    assert.deepEqual(found, [MIO, other.toLowerCase()]);
  });

  test('a sentence with no address yields none — nothing is inferred from a name', () => {
    assert.deepEqual(addressesInTextV1('swap my 10000 MIO tokens to ETH'), []);
  });
});
