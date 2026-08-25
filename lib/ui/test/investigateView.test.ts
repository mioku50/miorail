import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  investigateViewV1,
  OBSERVED_ACTIVITY_TITLE_V1,
  type AddressDossierWireV1,
} from '../src/console/investigateView';

const NOW = new Date('2026-08-25T12:00:00.000Z');
const TOKEN = '0xb200000000000000000000dead0000000000ad01';
const AAPL = '0xb200000000000000000000c2e324d24d7eecd1fb';
const BUNDLER = '0x5ff137d4b0fdcd49dca30c7cf57e578a026d2789';
const VENUE = '0xa3b1e3f9747065e2073722ff4c9027d3ea4994f0';

function wireV1(overrides: Partial<AddressDossierWireV1> = {}): AddressDossierWireV1 {
  return {
    tokenAddress: TOKEN,
    assembledAt: '2026-08-25T11:59:30.000Z',
    identity: {
      standing: 'unknown_to_miorail',
      official: null,
      project: null,
      launch: null,
      lookalike: null,
      origin: { status: 'no_launch_row', deployerAddress: null, relation: null, readAt: null },
      contract: { status: 'read', isB20: true, symbol: 'MIO', name: 'Miorail', decimals: 18 },
    },
    referenceValue: null,
    controls: {
      status: 'complete',
      blockNumber: '50000000',
      observedAt: '2026-08-25T11:59:30.000Z',
      multiplier: { status: 'exact_chain_read', atomic: '1', decimals: 18 },
      fields: [
        { key: 'token_symbol', status: 'exact_chain_read', value: 'MIO', reason: null },
        {
          key: 'supply_cap',
          status: 'unavailable',
          value: null,
          reason: 'The call did not complete at the anchored block',
        },
      ],
    },
    market: {
      routeStatus: 'not_measured',
      measuredAt: null,
      approvedSources: [],
      ladder: [],
      change: { status: 'first_reading', previousMeasuredAt: null, measuredAt: null, rungs: [] },
      topology: {
        status: 'observed',
        checkedThroughBlock: 50_000_000,
        venueCount: 2,
        pairedPoolCount: 2,
        directCashPoolCount: 1,
      },
      activity: {
        status: 'observed',
        semantics: 'venue_transfers_not_confirmed_swaps',
        movementCount: 7,
        outOfVenueCount: 4,
        intoVenueCount: 3,
        confirmedSwapCount: null,
        latest: [
          {
            venueAddress: VENUE,
            direction: 'out_of_venue',
            counterparty: '0x2222222222222222222222222222222222222222',
            counterpartyRole: 'unattributed_counterparty',
            amountAtomic: '1000',
            blockNumber: 50_000_000,
            observedAt: '2026-08-25T11:00:00.000Z',
          },
        ],
      },
    },
    established: [],
    unknown: [],
    ...overrides,
  } as AddressDossierWireV1;
}

describe('Investigate — a movement is never a trade', () => {
  test('the section is named for what the evidence establishes', () => {
    const view = investigateViewV1(wireV1(), NOW);
    assert.equal(view.activity.title, OBSERVED_ACTIVITY_TITLE_V1);
    assert.equal(view.activity.title, 'Observed market activity');
    assert.match(view.activity.semantics, /Venue transfers · not confirmed swaps/);
  });

  test('confirmed swaps is always shown as not established, never omitted', () => {
    // An absent row would let a reader assume the movement counts above it are
    // swaps. Measured: of 34 transactions moving a tracked asset through the
    // v4 singleton, 32 carried a Swap event and 2 did not.
    const view = investigateViewV1(wireV1(), NOW);
    const row = view.activity.facts.find((fact) => fact.label === 'Confirmed swaps')!;
    assert.equal(row.value, 'not established');
    assert.match(row.note!, /not built/);
  });

  test('no word in the activity section promotes a movement into a trade', () => {
    const view = investigateViewV1(wireV1(), NOW);
    const text = JSON.stringify(view.activity).toLowerCase();
    for (const word of ['trade', 'trader', 'buyer', 'seller', ' bought', ' sold', 'purchase']) {
      assert.equal(text.includes(word), false, `the activity section must not say "${word.trim()}"`);
    }
    // What it says instead.
    assert.equal(view.activity.movements[0]!.direction, 'Left a venue');
  });

  test('a tail that has not read the token is not a quiet market', () => {
    const view = investigateViewV1(
      wireV1({
        market: {
          ...wireV1().market,
          activity: {
            status: 'unavailable',
            semantics: 'venue_transfers_not_confirmed_swaps',
            movementCount: null,
            outOfVenueCount: null,
            intoVenueCount: null,
            confirmedSwapCount: null,
            latest: [],
          },
        },
      }),
      NOW,
    );
    assert.match(view.activity.headline, /not a quiet market/);
    assert.deepEqual(view.activity.facts, []);
  });
});

describe('Investigate — provenance is identity-safe', () => {
  test('a relayed launch names the relation and shows no address', () => {
    const view = investigateViewV1(
      wireV1({
        identity: {
          ...wireV1().identity,
          origin: {
            status: 'relayed',
            deployerAddress: null,
            relation: 'bundler',
            readAt: '2026-08-25T10:00:00.000Z',
          },
        },
      }),
      NOW,
    );
    assert.equal(view.origin.address, null);
    assert.match(view.origin.detail, /paid to include it rather than launched the token/);
    assert.match(view.origin.detail, /bundler acting for somebody else/);
    assert.equal(JSON.stringify(view).includes(BUNDLER), false);
  });

  test('only a direct-to-factory launch shows a sender', () => {
    const view = investigateViewV1(
      wireV1({
        identity: {
          ...wireV1().identity,
          origin: {
            status: 'established',
            deployerAddress: '0x3333333333333333333333333333333333333333',
            relation: 'direct',
            readAt: '2026-08-25T10:00:00.000Z',
          },
        },
      }),
      NOW,
    );
    assert.equal(view.origin.address, '0x3333333333333333333333333333333333333333');
    assert.match(view.origin.label, /straight to the B20 factory/);
  });

  test('a launch whose transaction has not been read says so about us', () => {
    const view = investigateViewV1(
      wireV1({
        identity: {
          ...wireV1().identity,
          origin: { status: 'not_read', deployerAddress: null, relation: null, readAt: null },
        },
      }),
      NOW,
    );
    assert.match(view.origin.detail, /about our backfill, not the launch/);
  });
});

describe('Investigate — absences are not findings', () => {
  test('an address nothing knows is the ordinary case, and says so', () => {
    const view = investigateViewV1(wireV1(), NOW);
    assert.equal(view.standing.chip, 'NOT ESTABLISHED');
    assert.match(view.standing.body, /ordinary answer for almost every contract/);
    assert.match(view.standing.body, /not a finding against this one/);
  });

  test('an unmeasured ladder renders no rows rather than rows of zero', () => {
    const view = investigateViewV1(wireV1(), NOW);
    assert.deepEqual(view.ladder, []);
    assert.equal(view.ladderNote, null);
  });

  test('one reading is not a market that has not moved', () => {
    const view = investigateViewV1(wireV1(), NOW);
    assert.match(view.change.headline, /nothing to compare it with/);
    assert.match(view.change.headline, /not a market that has not moved/);
  });

  test('a control that could not be read carries its reason, never a value', () => {
    const view = investigateViewV1(wireV1(), NOW);
    const row = view.controls.rows.find((entry) => entry.label === 'Supply cap')!;
    assert.equal(row.value, 'not read');
    assert.match(row.note!, /did not complete/);
    // True of every B20 and stated once, so a list of controls is never read as
    // a list of holders that came back empty.
    assert.match(view.controls.note, /hasRole\(role, account\) and no enumeration/);
  });

  test('a resemblance is stated with the reason it is only a resemblance', () => {
    const view = investigateViewV1(
      wireV1({
        identity: {
          ...wireV1().identity,
          lookalike: {
            officialAddress: AAPL,
            officialTicker: 'AAPLc',
            matchKind: 'symbol_exact',
            matchedAlias: 'published_ticker',
            matchedValue: 'AAPLc',
            firstFlaggedAt: '2026-08-20T10:00:00.000Z',
          },
        },
      }),
      NOW,
    );
    const row = view.identityFacts.find((fact) => fact.label === 'Resembles')!;
    assert.equal(row.value, 'AAPLc');
    assert.match(row.note!, /the addresses differ/);
    assert.match(row.note!, /establishes no relationship between the contracts/);
    const text = JSON.stringify(view).toLowerCase();
    for (const word of ['scam', 'fraud', 'suspicious', 'malicious']) {
      assert.equal(text.includes(word), false, `Investigate must not say "${word}"`);
    }
  });

  test('a chain read that failed says nothing about the contract', () => {
    const view = investigateViewV1(
      wireV1({
        identity: {
          ...wireV1().identity,
          contract: { status: 'unavailable', isB20: null, symbol: null, name: null, decimals: null },
        },
      }),
      NOW,
    );
    const row = view.identityFacts.find((fact) => fact.label === 'Recognised by the B20 factory')!;
    assert.equal(row.value, 'not read');
    assert.match(row.note!, /says nothing about the contract/);
  });
});
