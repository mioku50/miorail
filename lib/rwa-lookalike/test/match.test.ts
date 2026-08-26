import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  lookalikeMatchV1,
  normalizeIdentityTextV1,
  officialAliasesV1,
  type OfficialIdentityForMatchV1,
} from '../src/match.js';

const AAPL = '0xb200000000000000000000c2e324d24d7eecd1fb';
const NVDA = '0xb20000000000000000000078ee7ce2fe4908108c';
const IMPOSTOR = '0xb200000000000000000000dead0000000000ad01';
const OTHER = '0xb200000000000000000000beef0000000000be02';

const OFFICIALS: OfficialIdentityForMatchV1[] = [
  { tokenAddress: AAPL, ticker: 'AAPLc', displayName: 'Apple' },
  { tokenAddress: NVDA, ticker: 'NVDAc', displayName: null },
];

describe('official aliases', () => {
  test('a ticker names its asset twice: as published and as the underlying', () => {
    // Measured: the contracts answer AAPLc while Miorail's launch index stored
    // AAPL for the same token, because B20 metadata is mutable and the index
    // holds what the launch event said. An impostor may wear either.
    assert.deepEqual(officialAliasesV1(OFFICIALS[0]), [
      { value: 'AAPLc', kind: 'published_ticker' },
      { value: 'AAPL', kind: 'underlying' },
      { value: 'Apple', kind: 'display_name' },
    ]);
    assert.deepEqual(officialAliasesV1(OFFICIALS[1]), [
      { value: 'NVDAc', kind: 'published_ticker' },
      { value: 'NVDA', kind: 'underlying' },
    ]);
  });

  test('normalization removes case and punctuation and nothing else', () => {
    assert.equal(normalizeIdentityTextV1('A A P L - c'), 'aaplc');
    assert.equal(normalizeIdentityTextV1('ΑΑPL'), 'pl');
  });
});

/**
 * The measured Dinari Apple dShare on Base, and its own wrapper.
 *
 * Real addresses, because the finding is real: `symbol()` on the dShare is
 * exactly `AAPL`, and Miorail's `underlying` alias for `AAPLc` is exactly
 * `AAPL`, so this contract sat in the Lookalikes list on the strongest match
 * kind there is — flagged for wearing a name its own issuer gave it.
 */
const DINARI_AAPL = '0x41f7a63713e76c0ab800be03bae9f17b8a356348';
const DINARI_AAPL_LAUNCH = {
  tokenAddress: DINARI_AAPL,
  symbol: 'AAPL',
  name: 'Apple Inc. - Dinari',
};

describe("another issuer's reviewed representation", () => {
  test('is a lookalike while nothing has reviewed it', () => {
    // The state before Phase 9B: nothing vouches for the address, so the
    // resemblance is all the product knows, and reporting it is correct.
    const match = lookalikeMatchV1({ launch: DINARI_AAPL_LAUNCH, officials: OFFICIALS });
    assert.equal(match?.officialAddress, AAPL);
    assert.equal(match?.matchKind, 'symbol_exact');
    assert.equal(match?.matchedAlias, 'underlying');
  });

  test('stops being one the moment a reviewed root vouches for it', () => {
    // Dinari's own factory answers isTokenDShare(0x41f7…6348) = true. The
    // sentence "this is not the official contract and is dressed as if it
    // were" is simply false about it after that, so the row goes — it is not
    // annotated, downgraded or kept with a caveat.
    assert.equal(
      lookalikeMatchV1({
        launch: DINARI_AAPL_LAUNCH,
        officials: OFFICIALS,
        reviewedRepresentations: [DINARI_AAPL],
      }),
      null,
    );
  });

  test('and an unreviewed contract wearing the same name still is one', () => {
    // The half that must NOT change. Excluding one reviewed address cannot
    // become an amnesty for everything that spells AAPL.
    const match = lookalikeMatchV1({
      launch: { tokenAddress: IMPOSTOR, symbol: 'AAPL', name: 'Apple' },
      officials: OFFICIALS,
      reviewedRepresentations: [DINARI_AAPL],
    });
    assert.equal(match?.tokenAddress, IMPOSTOR);
    assert.equal(match?.officialAddress, AAPL);
    assert.equal(match?.matchKind, 'symbol_exact');
  });

  test('is excluded by address, not by the name it shares with the reviewed one', () => {
    // A checksummed or upper-cased address from a registry is the same
    // address. An impostor that copies the reviewed contract's NAME is not.
    assert.equal(
      lookalikeMatchV1({
        launch: DINARI_AAPL_LAUNCH,
        officials: OFFICIALS,
        reviewedRepresentations: [DINARI_AAPL.toUpperCase().replace('0X', '0x')],
      }),
      null,
    );
    const copycat = lookalikeMatchV1({
      launch: { tokenAddress: OTHER, symbol: 'AAPL', name: 'Apple Inc. - Dinari' },
      officials: OFFICIALS,
      reviewedRepresentations: [DINARI_AAPL],
    });
    assert.equal(copycat?.tokenAddress, OTHER, 'wearing a reviewed contract name grants nothing');
  });
});

describe('the matcher', () => {
  test('an official contract is never a lookalike', () => {
    // Not of another official asset, and not of itself. Checked before any
    // string is compared, so the strongest possible match cannot outrank
    // identity.
    assert.equal(
      lookalikeMatchV1({
        launch: { tokenAddress: AAPL, symbol: 'AAPLc', name: 'Apple' },
        officials: OFFICIALS,
      }),
      null,
    );
    assert.equal(
      lookalikeMatchV1({
        launch: { tokenAddress: NVDA, symbol: 'AAPLc', name: 'Apple' },
        officials: OFFICIALS,
      }),
      null,
    );
  });

  test('a contract wearing the published ticker is flagged, with both addresses', () => {
    const match = lookalikeMatchV1({
      launch: { tokenAddress: IMPOSTOR, symbol: 'AAPLc', name: 'Apple Inc' },
      officials: OFFICIALS,
    });
    assert.deepEqual(match, {
      tokenAddress: IMPOSTOR,
      officialAddress: AAPL,
      matchKind: 'symbol_exact',
      matchedAlias: 'published_ticker',
      matchedValue: 'AAPLc',
    });
  });

  test('a contract wearing the older ticker is flagged too', () => {
    const match = lookalikeMatchV1({
      launch: { tokenAddress: IMPOSTOR, symbol: 'AAPL', name: 'nothing in particular' },
      officials: OFFICIALS,
    });
    assert.equal(match?.matchKind, 'symbol_exact');
    assert.equal(match?.matchedValue, 'AAPL');
    assert.equal(match?.officialAddress, AAPL);
    // Measured over the real index: 95 of 112 matches wore the underlying and
    // most are ordinary words -- one is a memecoin called "we like the coin".
    // Still a resemblance, and now distinguishable from wearing `AAPLc`.
    assert.equal(match?.matchedAlias, 'underlying');
  });

  test('dressing the ticker up in punctuation does not hide it', () => {
    const match = lookalikeMatchV1({
      launch: { tokenAddress: IMPOSTOR, symbol: 'a.a.p.l-c', name: '' },
      officials: OFFICIALS,
    });
    assert.equal(match?.matchKind, 'symbol_normalized');
    assert.equal(match?.matchedValue, 'aaplc');
  });

  test('a name match is weaker than a symbol match and loses to it', () => {
    const nameOnly = lookalikeMatchV1({
      launch: { tokenAddress: IMPOSTOR, symbol: 'WAGMI', name: 'apple' },
      officials: OFFICIALS,
    });
    assert.equal(nameOnly?.matchKind, 'name_normalized');
    assert.equal(nameOnly?.officialAddress, AAPL);
    assert.equal(nameOnly?.matchedAlias, 'display_name');

    const both = lookalikeMatchV1({
      launch: { tokenAddress: IMPOSTOR, symbol: 'NVDA', name: 'apple' },
      officials: OFFICIALS,
    });
    assert.equal(both?.matchKind, 'symbol_exact');
    assert.equal(both?.officialAddress, NVDA);
  });

  test('no match is not a clean bill of health', () => {
    // Null means nothing matched. It does not mean the launch was checked and
    // found honest, and no caller may render it that way.
    assert.equal(
      lookalikeMatchV1({
        launch: { tokenAddress: IMPOSTOR, symbol: 'WAGMI', name: 'Wagmi Coin' },
        officials: OFFICIALS,
      }),
      null,
    );
  });

  test('an empty symbol matches nothing rather than everything', () => {
    assert.equal(
      lookalikeMatchV1({
        launch: { tokenAddress: IMPOSTOR, symbol: '', name: '' },
        officials: [...OFFICIALS, { tokenAddress: OTHER, ticker: 'X', displayName: '' }],
      }),
      null,
    );
  });

  test('a tie between two officials resolves the same way every time', () => {
    const twins: OfficialIdentityForMatchV1[] = [
      { tokenAddress: NVDA, ticker: 'TWIN', displayName: null },
      { tokenAddress: AAPL, ticker: 'TWIN', displayName: null },
    ];
    const first = lookalikeMatchV1({
      launch: { tokenAddress: IMPOSTOR, symbol: 'TWIN', name: '' },
      officials: twins,
    });
    const reversed = lookalikeMatchV1({
      launch: { tokenAddress: IMPOSTOR, symbol: 'TWIN', name: '' },
      officials: [...twins].reverse(),
    });
    assert.deepEqual(first, reversed);
    assert.equal(first?.officialAddress, AAPL < NVDA ? AAPL : NVDA);
  });

  test('an empty official corpus flags nothing', () => {
    assert.equal(
      lookalikeMatchV1({ launch: { tokenAddress: IMPOSTOR, symbol: 'AAPLc', name: 'Apple' }, officials: [] }),
      null,
    );
  });
});
