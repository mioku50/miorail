import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  publicIdentityViewV1,
  type PublicIdentityReadingV1,
} from '../src/console/publicIdentityView';

const OFFICIAL = '0xb200000000000000000000c2e324d24d7eecd1fb';
const IMPOSTOR = '0x1111111111111111111111111111111111111111';

function reading(over: Partial<PublicIdentityReadingV1> = {}): PublicIdentityReadingV1 {
  return {
    schemaVersion: 'address-identity/v1',
    chainId: 8453,
    tokenAddress: OFFICIAL,
    standing: 'reviewed_official',
    answer: 'Yes. It is AAPLc.',
    official: {
      ticker: 'AAPLc',
      displayName: 'Apple',
      issuer: 'coinbase',
      listedIn: [
        { sourceKind: 'base_docs_technical', currentlyListed: true, lastSeenAt: '2026-09-15T00:00:00.000Z' },
      ],
    },
    issuerRepresentation: null,
    lookalike: null,
    corpus: { lookalikeRows: 160, lookalikesLastScannedAt: '2026-09-16T03:00:00.000Z' },
    caveats: ['Compare ADDRESSES, not symbols.'],
    generatedAt: '2026-09-16T08:00:00.000Z',
    ...over,
  };
}

describe('the public identity verdict', () => {
  test('nothing on file is neither green nor red', () => {
    // The whole reason this view exists. Green would say safe and red would
    // say dangerous; Miorail has evidence for neither.
    const view = publicIdentityViewV1(
      reading({
        standing: 'unknown_to_miorail',
        official: null,
        answer: 'Miorail has nothing on file.',
      }),
    );
    assert.equal(view?.tone, 'off');
    assert.notEqual(view?.tone, 'good');
    assert.notEqual(view?.tone, 'bad');
    assert.match(view?.verdict ?? '', /Nothing on file/);
  });

  test('the size of the search travels with the silence', () => {
    const view = publicIdentityViewV1(
      reading({ standing: 'unknown_to_miorail', official: null }),
    );
    const fact = view?.facts.find((row) => row.label.includes('wearing an official name'));
    assert.equal(fact?.value, '160');
    assert.match(fact?.note ?? '', /not among them/);
    assert.match(fact?.note ?? '', /last scanned 2026-09-16/);
  });

  test('a corpus that has never been scanned is not a search', () => {
    const view = publicIdentityViewV1(
      reading({
        standing: 'unknown_to_miorail',
        official: null,
        corpus: { lookalikeRows: 0, lookalikesLastScannedAt: null },
      }),
    );
    const fact = view?.facts.find((row) => row.label.includes('wearing an official name'));
    assert.match(fact?.note ?? '', /no scan has run yet/);
  });

  test('a lookalike is a warning, never a verdict of fraud, and names the address to compare', () => {
    const view = publicIdentityViewV1(
      reading({
        tokenAddress: IMPOSTOR,
        standing: 'known_lookalike',
        official: null,
        answer: 'No. It is not AAPLc.',
        lookalike: {
          officialAddress: OFFICIAL,
          officialTicker: 'AAPLc',
          matchKind: 'symbol_exact',
          matchedAlias: 'underlying',
          matchedValue: 'aapl',
          declaredSymbol: 'AAPL',
          declaredName: 'apple on base',
          firstFlaggedAt: '2026-08-31T00:00:00.000Z',
        },
      }),
    );
    assert.equal(view?.tone, 'warn');
    assert.notEqual(view?.tone, 'bad');
    assert.deepEqual(view?.compareWith, { label: 'AAPLc', address: OFFICIAL });
    assert.match(
      view?.facts.find((row) => row.label === 'How it matched')?.value ?? '',
      /the symbol is identical/,
    );
    assert.match(
      view?.facts.find((row) => row.label === 'It declared')?.note ?? '',
      /can be changed on chain/,
    );
  });

  test('an issuer vouching for an address is not an endorsement of what it represents', () => {
    const view = publicIdentityViewV1(
      reading({
        standing: 'issuer_representation',
        official: null,
        answer: 'Dinari vouches for it.',
        issuerRepresentation: {
          issuerId: 'dinari',
          rootKey: 'dinari_factory_v1',
          observedAt: '2026-09-16T02:00:00.000Z',
        },
      }),
    );
    assert.equal(view?.tone, 'neutral');
    assert.equal(
      view?.facts.find((row) => row.label === 'What it represents')?.value,
      'not established',
    );
    assert.equal(view?.compareWith, null);
  });

  test('a delisted asset is not demoted to a warning', () => {
    const view = publicIdentityViewV1(
      reading({
        standing: 'delisted_official',
        official: {
          ticker: 'AAPLc',
          displayName: 'Apple',
          issuer: 'coinbase',
          listedIn: [
            { sourceKind: 'base_docs_technical', currentlyListed: false, lastSeenAt: '2026-09-01T00:00:00.000Z' },
          ],
        },
      }),
    );
    assert.equal(view?.tone, 'neutral');
    assert.equal(
      view?.facts.find((row) => row.label === 'Reviewed sources')?.value,
      'none list it now',
    );
  });

  test('a listed asset carries the date the source was last seen naming it', () => {
    const view = publicIdentityViewV1(reading());
    assert.equal(view?.tone, 'good');
    const sources = view?.facts.find((row) => row.label === 'Reviewed sources');
    assert.equal(sources?.value, '1 still list it');
    assert.match(sources?.note ?? '', /listed 2026-09-15/);
  });

  test('Miorail’s own sentence is carried through, not rewritten', () => {
    const view = publicIdentityViewV1(reading({ answer: 'Yes. Exactly this.' }));
    assert.equal(view?.answer, 'Yes. Exactly this.');
    assert.deepEqual(view?.caveats, ['Compare ADDRESSES, not symbols.']);
  });

  test('no reading is not an empty reading', () => {
    assert.equal(publicIdentityViewV1(null), null);
  });
});
