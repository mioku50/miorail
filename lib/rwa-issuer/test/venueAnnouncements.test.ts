import assert from 'node:assert/strict';
import test from 'node:test';

import { REVIEWED_ISSUERS_V1 } from '../src/issuers.js';
import type { DefiVenueListingV1 } from '../src/useAccess.js';
import {
  REVIEWED_VENUE_ANNOUNCEMENTS_V1,
  venueAnnouncementReadingsV1,
} from '../src/venueAnnouncements.js';

function aave(overrides: Partial<DefiVenueListingV1>): DefiVenueListingV1 {
  return {
    venueId: 'aave_v3',
    venueName: 'Aave v3',
    state: 'not_listed',
    uses: { lend: null, borrow: null, collateral: null },
    curated: null,
    marketRef: null,
    reason: null,
    ...overrides,
  };
}

const MOONWELL: DefiVenueListingV1 = {
  venueId: 'moonwell',
  venueName: 'Moonwell',
  state: 'not_listed',
  uses: { lend: null, borrow: null, collateral: null },
  curated: null,
  marketRef: null,
  reason: null,
};

test('every reviewed announcement names a party, a date, a document and a sentence', () => {
  for (const announcement of REVIEWED_VENUE_ANNOUNCEMENTS_V1) {
    assert.ok(REVIEWED_ISSUERS_V1.includes(announcement.issuerId));
    assert.ok(announcement.uses.length > 0);
    assert.ok(announcement.announcedBy.length > 0);
    assert.match(announcement.announcedAt, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(Number.isFinite(Date.parse(announcement.announcedAt)));
    assert.ok(announcement.sourceTitle.length > 0);
    assert.match(announcement.sourceRef, /^https:\/\//);
    // A claim with no sentence behind it is a rumour with a date on it.
    assert.ok(announcement.quote.length > 20);
  }
});

test('Base announced collateral at Aave and Aave does not list the address', () => {
  const readings = venueAnnouncementReadingsV1({
    issuerId: 'coinbase',
    venues: [MOONWELL, aave({ state: 'not_listed' })],
  });
  assert.equal(readings.length, 1);
  const reading = readings[0]!;
  assert.equal(reading.measured, 'not_listed');
  assert.equal(reading.announcement.announcedBy, 'Base');
  assert.deepEqual(reading.announcement.uses, ['collateral']);
  // Nothing about a use survives a miss. This is the whole point: an
  // announcement cannot fill in what the venue declined to say.
  assert.deepEqual(reading.establishedUses, []);
  assert.deepEqual(reading.unstatedUses, []);
  assert.equal(reading.reason, null);
});

test('a venue nobody checked is not a venue that said no', () => {
  const readings = venueAnnouncementReadingsV1({
    issuerId: 'coinbase',
    venues: [MOONWELL],
  });
  assert.equal(readings[0]?.measured, 'unchecked');
});

test('a venue that could not be read carries our reason, not a verdict', () => {
  const readings = venueAnnouncementReadingsV1({
    issuerId: 'coinbase',
    venues: [aave({ state: 'unread', reason: 'aave read rpc_error' })],
  });
  assert.equal(readings[0]?.measured, 'unread');
  assert.equal(readings[0]?.reason, 'aave read rpc_error');
});

test('a listed reserve still does not state whether collateral is enabled', () => {
  const readings = venueAnnouncementReadingsV1({
    issuerId: 'coinbase',
    venues: [aave({ state: 'listed', uses: { lend: true, borrow: true, collateral: null } })],
  });
  assert.equal(readings[0]?.measured, 'listed');
  assert.deepEqual(readings[0]?.establishedUses, []);
  assert.deepEqual(readings[0]?.unstatedUses, ['collateral']);
});

test('a venue that does state the announced use establishes it', () => {
  const readings = venueAnnouncementReadingsV1({
    issuerId: 'coinbase',
    venues: [aave({ state: 'listed', uses: { lend: true, borrow: true, collateral: true } })],
  });
  assert.deepEqual(readings[0]?.establishedUses, ['collateral']);
  assert.deepEqual(readings[0]?.unstatedUses, []);
});

test('an announcement about one issuer never reaches another issuer', () => {
  for (const issuerId of ['backed', 'dinari'] as const) {
    assert.deepEqual(
      venueAnnouncementReadingsV1({ issuerId, venues: [aave({ state: 'not_listed' })] }),
      [],
    );
  }
  assert.deepEqual(
    venueAnnouncementReadingsV1({ issuerId: null, venues: [aave({ state: 'not_listed' })] }),
    [],
  );
});
