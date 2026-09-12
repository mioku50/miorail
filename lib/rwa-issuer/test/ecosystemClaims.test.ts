import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  BASE_STOCKS_ECOSYSTEM_SOURCE_V1,
  BASE_STOCKS_ECOSYSTEM_V1,
  ecosystemBlockV1,
  ecosystemClaimReadingsV1,
  ecosystemSummaryV1,
  ecosystemTallyV1,
  type EcosystemEvidenceV1,
  type ReviewedEcosystemAppV1,
} from '../src/ecosystemClaims.js';

const NVDA = '0xb20000000000000000000078ee7ce2fe4908108c';

function evidence(over: Partial<EcosystemEvidenceV1> = {}): EcosystemEvidenceV1 {
  return { issuerId: 'coinbase', ...over };
}

function app(over: Partial<ReviewedEcosystemAppV1> = {}): ReviewedEcosystemAppV1 {
  return {
    appId: 'test',
    appName: 'Test',
    claim: 'Does something with tokenized stocks.',
    category: 'lending',
    binding: { kind: 'none' },
    ...over,
  };
}

function readingFor(apps: ReviewedEcosystemAppV1[], over: Partial<EcosystemEvidenceV1> = {}) {
  return ecosystemClaimReadingsV1(evidence({ apps, ...over }))[0]!;
}

describe('the reviewed ecosystem registry', () => {
  test('carries the whole published list, with Base named as its author', () => {
    // Thirty is asserted for the same reason the corpus count is: an app
    // silently dropped from the registry must fail here rather than quietly
    // shrink a card that claims to be somebody's whole list.
    assert.equal(BASE_STOCKS_ECOSYSTEM_V1.length, 30);
    assert.equal(BASE_STOCKS_ECOSYSTEM_SOURCE_V1.listedBy, 'Base');
    assert.match(BASE_STOCKS_ECOSYSTEM_SOURCE_V1.sourceRef, /^https:\/\//);
    const ids = BASE_STOCKS_ECOSYSTEM_V1.map((entry) => entry.appId);
    assert.equal(new Set(ids).size, ids.length, 'an app id is used twice');
    for (const entry of BASE_STOCKS_ECOSYSTEM_V1) {
      assert.ok(entry.claim.length > 0, `${entry.appId} carries no claim`);
      assert.ok(entry.appName.length > 0, `${entry.appId} carries no name`);
    }
  });

  test('the three lenders Base names are three, and Miorail reads two of them', () => {
    // The sentence this card exists to publish. If a third lender ever gains a
    // binding, this test is where that is recorded.
    const lenders = BASE_STOCKS_ECOSYSTEM_V1.filter((entry) => entry.category === 'lending');
    assert.deepEqual(lenders.map((entry) => entry.appName).sort(), ['Aave', 'Euler', 'Morpho']);
    assert.deepEqual(
      lenders.filter((entry) => entry.binding.kind !== 'none').map((entry) => entry.appName).sort(),
      ['Aave', 'Morpho'],
    );
  });

  test('the reading keeps the published order, never the outcome order', () => {
    // Sorting by outcome would float the apps Miorail happens to read to the
    // top and present our coverage as the ecosystem's shape.
    const readings = ecosystemClaimReadingsV1(evidence());
    assert.deepEqual(
      readings.map((row) => row.app.appId),
      BASE_STOCKS_ECOSYSTEM_V1.map((entry) => entry.appId),
    );
  });
});

describe('a claim read against one exact address', () => {
  test('a venue that lists the address names it, and says on what terms', () => {
    const reading = readingFor([app({ binding: { kind: 'defi_venue', venueId: 'morpho' } })], {
      venues: [
        {
          venueId: 'morpho',
          venueName: 'Morpho',
          state: 'listed',
          curated: false,
          marketRef: '0xce98',
        },
      ],
    });
    assert.equal(reading.measured, 'listed');
    // Permissionless: a market EXISTS, which is not the venue accepting the
    // asset, and the difference belongs in the sentence rather than in a
    // stronger word.
    assert.match(reading.evidence ?? '', /the venue has not listed it/);
    // The market key is a 32-byte id and never belongs on a consumer line.
    assert.doesNotMatch(reading.evidence ?? '', /0xce98/);
    assert.match(reading.detail ?? '', /0xce98/);
  });

  test('a venue that answered and did not list it is a refusal', () => {
    const reading = readingFor([app({ binding: { kind: 'defi_venue', venueId: 'aave_v3' } })], {
      venues: [
        { venueId: 'aave_v3', venueName: 'Aave v3', state: 'not_listed' },
      ],
    });
    assert.equal(reading.measured, 'not_listed');
    assert.equal(reading.evidence, null);
  });

  test('a venue that could not be read keeps its reason and is not a refusal', () => {
    const reading = readingFor([app({ binding: { kind: 'defi_venue', venueId: 'aave_v3' } })], {
      venues: [
        { venueId: 'aave_v3', venueName: 'Aave v3', state: 'unread', reason: 'rpc timeout' },
      ],
    });
    assert.equal(reading.measured, 'unread');
    assert.equal(reading.reason, 'rpc timeout');
  });

  test('a venue nobody checked is unchecked, never not_listed', () => {
    // The whole reason this vocabulary has four words. Twenty-four of the
    // thirty live in this state, and rendering them as refusals would publish
    // Miorail's reach under somebody else's name.
    const reading = readingFor([app({ binding: { kind: 'defi_venue', venueId: 'euler' } })], {
      venues: [{ venueId: 'morpho', venueName: 'Morpho', state: 'listed' }],
    });
    assert.equal(reading.measured, 'unchecked');
    assert.equal(reading.reason, null);
  });

  test('an app with no binding at all is unchecked', () => {
    assert.equal(readingFor([app()]).measured, 'unchecked');
  });
});

describe('the bindings that are not lending venues', () => {
  const aerodrome = app({ binding: { kind: 'pool_venue', venueIds: ['aerodrome_cl', 'aerodrome_v2'] } });

  test('a pool venue holding the address names it, counted from measured rows', () => {
    const reading = readingFor([aerodrome], {
      poolRows: [{ venueId: 'aerodrome_cl' }, { venueId: 'uniswap_v3' }, { venueId: 'aerodrome_v2' }],
    });
    assert.equal(reading.measured, 'listed');
    assert.match(reading.evidence ?? '', /2 measured pools/);
    assert.equal(reading.detail, null);
  });

  test('pools measured with none of this venue is a refusal; pools never measured is not', () => {
    assert.equal(readingFor([aerodrome], { poolRows: [{ venueId: 'uniswap_v3' }] }).measured, 'not_listed');
    assert.equal(readingFor([aerodrome], { poolRows: null }).measured, 'unchecked');
    assert.equal(readingFor([aerodrome]).measured, 'unchecked');
  });

  test('a router is only a refusal if it was asked', () => {
    const kyber = app({ binding: { kind: 'route_source', sourceId: 'kyberswap' } });
    assert.equal(
      readingFor([kyber], { routeSources: { asked: ['kyberswap'], quoted: ['kyberswap'] } }).measured,
      'listed',
    );
    assert.equal(
      readingFor([kyber], { routeSources: { asked: ['kyberswap'], quoted: [] } }).measured,
      'not_listed',
    );
    // Never asked: a router Miorail does not call cannot have declined.
    assert.equal(
      readingFor([kyber], { routeSources: { asked: ['odos'], quoted: ['odos'] } }).measured,
      'unchecked',
    );
    assert.equal(readingFor([kyber], { routeSources: null }).measured, 'unchecked');
  });

  test('the oracle is named by the feed a reviewed source binds', () => {
    const chainlink = app({ binding: { kind: 'reference_feed' } });
    const bound = readingFor([chainlink], { referenceFeedAddress: '0x787f' });
    assert.equal(bound.measured, 'listed');
    assert.doesNotMatch(bound.evidence ?? '', /0x787f/);
    assert.match(bound.detail ?? '', /0x787f/);
    assert.equal(readingFor([chainlink], { referenceFeedAddress: null }).measured, 'unchecked');
  });

  test('the issuer of record answers for its own representations only', () => {
    const coinbase = app({ binding: { kind: 'issuer_of_record', issuerId: 'coinbase' } });
    assert.equal(readingFor([coinbase], { issuerId: 'coinbase' }).measured, 'listed');
    assert.equal(readingFor([coinbase], { issuerId: 'backed' }).measured, 'not_listed');
    assert.equal(readingFor([coinbase], { issuerId: null }).measured, 'unchecked');
  });
});

describe('the summary a reader may repeat', () => {
  test('it names the unread remainder and refuses to call it a refusal', () => {
    const readings = ecosystemClaimReadingsV1(
      evidence({
        venues: [{ venueId: 'morpho', venueName: 'Morpho', state: 'listed' }],
        poolRows: [{ venueId: 'aerodrome_cl' }],
        routeSources: { asked: ['kyberswap'], quoted: ['kyberswap'] },
        referenceFeedAddress: '0x787f',
      }),
    );
    const summary = ecosystemSummaryV1({ displaySymbol: 'NVDAc', tokenAddress: NVDA, readings });
    const tally = ecosystemTallyV1(readings);
    assert.equal(tally.named, 30);
    assert.ok(tally.unchecked > 0);
    assert.match(summary, /Base names 30 apps/);
    assert.match(summary, new RegExp(`The other ${tally.unchecked} are apps Miorail does not read`));
    assert.match(summary, /never a statement that they refused/);
    // The leap this sentence exists to stop. "do not support" appears only
    // inside the denial, so the guard is that it never appears as a claim.
    assert.doesNotMatch(summary, /unsupported/i);
    for (const match of summary.matchAll(/do not support/gi)) {
      const before = summary.slice(Math.max(0, match.index - 80), match.index);
      assert.match(before, /never a statement/, 'non-support was asserted rather than denied');
    }
  });

  test('one app on either side reads as one app, not as several', () => {
    // "Aave do not" shipped to production for about twenty minutes.
    const one = ecosystemSummaryV1({
      displaySymbol: 'NVDAc',
      tokenAddress: NVDA,
      readings: ecosystemClaimReadingsV1(
        evidence({
          apps: [
            app({ appId: 'a', appName: 'Alpha', binding: { kind: 'issuer_of_record', issuerId: 'coinbase' } }),
            app({ appId: 'b', appName: 'Beta', binding: { kind: 'issuer_of_record', issuerId: 'backed' } }),
          ],
        }),
      ),
    });
    assert.match(one, /Alpha names this exact address/);
    assert.match(one, /Beta does not/);
    assert.doesNotMatch(one, /Alpha name this|Beta do not/);
  });

  test('reading nothing says so instead of reporting an empty ecosystem', () => {
    const readings = ecosystemClaimReadingsV1(evidence({ issuerId: null }));
    const summary = ecosystemSummaryV1({ displaySymbol: 'NVDAc', tokenAddress: NVDA, readings });
    assert.match(summary, /Miorail reads none of them/);
    assert.doesNotMatch(summary, /name this exact address/);
  });
});

describe('the block a payload carries', () => {
  test('it travels with its source, its tally and every row', () => {
    const block = ecosystemBlockV1(
      evidence({ venues: [{ venueId: 'aave_v3', venueName: 'Aave v3', state: 'not_listed' }] }),
    );
    assert.equal(block.listedBy, 'Base');
    assert.equal(block.sourceRef, BASE_STOCKS_ECOSYSTEM_SOURCE_V1.sourceRef);
    assert.equal(block.rows.length, 30);
    assert.equal(block.tally.named, 30);
    assert.equal(
      block.tally.namesIt + block.tally.doesNot + block.tally.unread + block.tally.unchecked,
      30,
    );
    const aave = block.rows.find((row) => row.appId === 'aave')!;
    assert.equal(aave.measured, 'not_listed');
    assert.equal(aave.category, 'lending');
    // Base's own sentence, unrewritten.
    assert.equal(aave.claim, 'Lend and borrow against tokenized stock positions.');
  });
});
