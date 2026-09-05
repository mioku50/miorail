import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  USE_ACCESS_NOT_STATED_V1,
  UseAccessAgentOutputV1Schema,
  exactUseAccessAddressV1,
  reviewedIssuerIdOrNullV1,
  useAccessForAgentV1,
} from '../src/useAccessAgent.js';
import type { ReviewedVenueAnnouncementV1 } from '../src/venueAnnouncements.js';
import type { DefiVenueListingV1, RepresentationUseAccessV1 } from '../src/useAccess.js';

const NVDA = '0xb20000000000000000000078ee7ce2fe4908108c';
const WALLET = '0xdead00000000000000000000000000000000beef';

const AAVE_ANNOUNCEMENT_V1: ReviewedVenueAnnouncementV1 = {
  announcementId: 'base-2026-08-24-aave-collateral',
  venueId: 'aave_v3',
  venueName: 'Aave v3',
  issuerId: 'coinbase',
  uses: ['collateral'],
  announcedBy: 'Base',
  announcedAt: '2026-08-24',
  sourceTitle: 'Stocks just got updated.',
  sourceRef: 'https://blog.base.org',
  quote: 'Use your tokenized NVIDIA stock as collateral for an onchain loan on Aave.',
};

const venue = (over: Partial<DefiVenueListingV1>): DefiVenueListingV1 => ({
  venueId: 'aave_v3',
  venueName: 'Aave v3',
  state: 'not_listed',
  uses: { lend: null, borrow: null, collateral: null },
  curated: null,
  marketRef: null,
  reason: null,
  observed: { source: 'chain_head', at: '2026-09-05T10:00:00.000Z' },
  ...over,
});

const use = (over: Partial<RepresentationUseAccessV1> = {}): RepresentationUseAccessV1 => ({
  schemaVersion: 'representation-use-access/v1',
  chainId: 8453,
  tokenAddress: NVDA,
  caip10: `eip155:8453:${NVDA}`,
  blockTag: '0x3060000',
  observedAt: '2026-09-05T10:00:00.000Z',
  transfers: { state: 'read', transfersPaused: false },
  transferPolicies: [{ scope: 'sender', state: 'bound', policyId: '5', policyExists: true }],
  bridge: { state: 'none_detected' },
  defi: { checkedVenues: ['Aave v3'], venues: [venue({})] },
  wallet: null,
  ...over,
});

const project = (over: Partial<RepresentationUseAccessV1> = {}) =>
  useAccessForAgentV1({
    use: use(over),
    underlyingKey: 'security:isin:US67066G1040',
    displaySymbol: 'NVDA',
    issuerId: 'coinbase',
    announcements: [AAVE_ANNOUNCEMENT_V1],
  });

describe('the public use & access projection holds no wallet', () => {
  test('walletBound is a literal false, whatever the assembly carried', () => {
    const projected = project({
      wallet: { address: WALLET, checks: [{ scope: 'sender', state: 'allowed', policyId: '5' }] },
    });
    assert.equal(projected.walletBound, false);
    // Not merely absent from the type: absent from the bytes. A public read
    // that echoed a wallet back would be a wallet-bound answer wearing a
    // public tool's name.
    assert.ok(!JSON.stringify(projected).includes(WALLET));
    assert.ok(!JSON.stringify(projected).includes('wallet"'));
  });

  test('the output is strict, so a field can never be added without its schema', () => {
    assert.doesNotThrow(() => UseAccessAgentOutputV1Schema.parse(project()));
  });
});

describe('the block governs what it governs, and says which', () => {
  test('blockTagCovers never names defi', () => {
    const projected = project();
    assert.equal(projected.blockTag, '0x3060000');
    assert.ok(!projected.blockTagCovers.includes('defi'));
    assert.deepEqual(projected.blockTagCovers, ['transfers', 'transferPolicies', 'bridge']);
  });

  test('each venue row carries its own provenance instead', () => {
    const projected = project();
    assert.deepEqual(projected.defi.venues[0]?.observed, {
      source: 'chain_head',
      at: '2026-09-05T10:00:00.000Z',
    });
  });

  test('a row from a server that stated no provenance says null, not the block', () => {
    const bare = venue({});
    delete (bare as { observed?: unknown }).observed;
    const projected = project({ defi: { checkedVenues: ['Aave v3'], venues: [bare] } });
    assert.equal(projected.defi.venues[0]?.observed, null);
  });
});

describe('announced is not live, all the way to the assistant', () => {
  test('a venue that answered no keeps the announcement beside the reading', () => {
    const projected = project();
    const announcement = projected.announcements[0]!;
    assert.equal(announcement.measured, 'not_listed');
    assert.deepEqual(announcement.announcedUses, ['collateral']);
    // The announcement can never become a use.
    assert.deepEqual(announcement.establishedUses, []);
    assert.deepEqual(projected.miorailSummary.establishedUses, []);
    assert.match(projected.miorailSummary.summary, /the listing has not happened/);
    assert.match(projected.miorailSummary.summary, /Do not tell a user they can do this now/);
  });

  test('a venue nobody checked is unchecked, and never a refusal', () => {
    const projected = project({ defi: { checkedVenues: ['Moonwell'], venues: [] } });
    assert.equal(projected.announcements[0]?.measured, 'unchecked');
    assert.match(projected.miorailSummary.summary, /was not among the venues this reading checked/);
    assert.doesNotMatch(projected.miorailSummary.summary, /does not name this exact address/);
  });

  test('a venue that could not be read said nothing either way', () => {
    const projected = project({
      defi: {
        checkedVenues: ['Aave v3'],
        venues: [venue({ state: 'unread', reason: 'aave read endpoint_unavailable' })],
      },
    });
    assert.equal(projected.announcements[0]?.measured, 'unread');
    // Our read failed. Saying "none of them lists it" would put Miorail's own
    // gap on the token's name, which is the sentence this project keeps
    // shipping by accident.
    assert.match(projected.miorailSummary.summary, /could not be read on this call/);
    assert.match(projected.miorailSummary.summary, /a gap in Miorail's reading, not a fact about NVDA/);
    assert.doesNotMatch(projected.miorailSummary.summary, /lists NVDA/);
  });

  test('a venue that answered no and a venue that could not be read stay apart', () => {
    const projected = project({
      defi: {
        checkedVenues: ['Aave v3', 'Moonwell'],
        venues: [
          venue({}),
          venue({
            venueId: 'moonwell',
            venueName: 'Moonwell',
            state: 'unread',
            reason: 'moonwell answered HTTP 502',
            observed: { source: 'venue_catalogue', at: '2026-09-05T10:00:01.000Z' },
          }),
        ],
      },
    });
    // Only the venue that answered is named as a miss.
    assert.match(projected.miorailSummary.summary, /None of the venues that answered \(Aave v3\) lists NVDA/);
    assert.match(projected.miorailSummary.summary, /Moonwell could not be read on this call/);
  });

  test('a listing that happened is reported as one, with the use still unproven', () => {
    const projected = project({
      defi: {
        checkedVenues: ['Aave v3'],
        venues: [venue({ state: 'listed', curated: true, marketRef: '0xpool' })],
      },
    });
    assert.equal(projected.announcements[0]?.measured, 'listed');
    assert.match(projected.miorailSummary.summary, /does name this exact address today/);
    // A reserve exists. That a user may post it as collateral right now is a
    // different permission, and Aave's reserve list does not answer it.
    assert.deepEqual(projected.announcements[0]?.unstatedUses, ['collateral']);
  });

  test('an unknown issuer carries no announcement at all', () => {
    const projected = useAccessForAgentV1({
      use: use(),
      underlyingKey: 'security:isin:US67066G1040',
      displaySymbol: 'NVDA',
      issuerId: null,
      announcements: [AAVE_ANNOUNCEMENT_V1],
    });
    assert.deepEqual(projected.announcements, []);
  });
});

describe('what the summary refuses to let a reader conclude', () => {
  test('a miss is bounded by where we looked', () => {
    const projected = project();
    assert.match(projected.miorailSummary.summary, /Other venues exist and were not checked/);
    assert.doesNotMatch(projected.miorailSummary.summary, /not in DeFi|cannot be used/i);
  });

  test('the absence list is the constant, on a good call as much as a bad one', () => {
    const listed = project({
      defi: {
        checkedVenues: ['Aave v3'],
        venues: [venue({ state: 'listed', uses: { lend: true, borrow: null, collateral: null } })],
      },
    });
    assert.deepEqual(listed.miorailSummary.notStated, [...USE_ACCESS_NOT_STATED_V1]);
    assert.deepEqual(project().miorailSummary.notStated, [...USE_ACCESS_NOT_STATED_V1]);
    assert.match(listed.miorailSummary.summary, /not a statement that the operation would succeed/);
  });
});

describe('an exact address, or nothing', () => {
  test('0x and CAIP-10 both resolve to the same address', () => {
    assert.equal(exactUseAccessAddressV1(NVDA), NVDA);
    assert.equal(exactUseAccessAddressV1(`eip155:8453:${NVDA.toUpperCase()}`), NVDA);
    assert.equal(exactUseAccessAddressV1(`  ${NVDA}  `), NVDA);
  });

  test('a ticker is refused rather than guessed at', () => {
    for (const raw of ['NVDA', 'nvidia', 'security:isin:US67066G1040', '0x123', '']) {
      assert.equal(exactUseAccessAddressV1(raw), null, raw);
    }
  });

  test('an untyped issuer is null rather than an invented one', () => {
    assert.equal(reviewedIssuerIdOrNullV1('coinbase'), 'coinbase');
    assert.equal(reviewedIssuerIdOrNullV1(null), null);
    assert.equal(reviewedIssuerIdOrNullV1('robinhood'), null);
  });
});
