import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  mapOpenSeaListingStatusV1,
  readSeaportListingV1,
  seaportQuoteAgreesV1,
  type SeaportParametersV1,
} from '../src/index.js';

// ---------------------------------------------------------------------------
// T65 §7 — grounded against a REAL Base listing, read from api.opensea.io on
// 2026-07-26 (collection `dxterminal`, token 16668). Recorded verbatim so the
// parser is pinned to what OpenSea actually returns rather than to what the
// docs describe.
//
// The two consideration amounts sum to exactly the quoted 3580000000000000
// wei, which is why the sum is what gets trusted and the quote is what gets
// checked against it.
// ---------------------------------------------------------------------------

const SELLER = '0x4efca7cc8058d5acd2bb2ccd2a9430906291cdd6';
const COLLECTION = '0x41dc69132cce31fcbf6755c84538ca268520246f';
const OPENSEA_FEE_RECIPIENT = '0x0000a26b00c1f0df003000390027140000faa719';

const OBSERVED_PARAMETERS_V1: SeaportParametersV1 = {
  offerer: SELLER,
  offer: [{ itemType: 2, token: COLLECTION, identifierOrCriteria: '16668', startAmount: '1', endAmount: '1' }],
  consideration: [
    {
      itemType: 0,
      token: '0x0000000000000000000000000000000000000000',
      identifierOrCriteria: '0',
      startAmount: '3544200000000000',
      endAmount: '3544200000000000',
      recipient: SELLER,
    },
    {
      itemType: 0,
      token: '0x0000000000000000000000000000000000000000',
      identifierOrCriteria: '0',
      startAmount: '35800000000000',
      endAmount: '35800000000000',
      recipient: OPENSEA_FEE_RECIPIENT,
    },
  ],
  startTime: '1785066231',
  endTime: '1785152630',
  orderType: 3,
  zone: '0x000056f7000000ece9003ca63978907a00ffd100',
  totalOriginalConsiderationItems: 2,
};

/** The quoted price OpenSea returned alongside that order. */
const OBSERVED_QUOTED_WEI_V1 = '3580000000000000';

function withConsideration(items: SeaportParametersV1['consideration']): SeaportParametersV1 {
  return { ...OBSERVED_PARAMETERS_V1, consideration: items };
}

describe('the order is read, not the summary', () => {
  test('the real observed listing parses into what is bought and what is paid', () => {
    const result = readSeaportListingV1(OBSERVED_PARAMETERS_V1);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.listing.nftContract, COLLECTION);
    assert.equal(result.listing.tokenId, '16668');
    assert.equal(result.listing.seller, SELLER);
    // 3544200000000000 to the seller + 35800000000000 in fees.
    assert.equal(result.listing.totalWei, '3580000000000000');
    assert.equal(result.listing.feeWei, '35800000000000');
    assert.equal(result.listing.reservedForTaker, null);
    assert.equal(result.listing.endTimeUnix, 1785152630);
    // OpenSea's standard Base listings are zone-restricted. Recorded, not
    // refused — refusing it would reject every real listing on the chain.
    assert.equal(result.listing.restrictedByZone, true);
  });

  test('the quoted price has to equal what the order charges', () => {
    const result = readSeaportListingV1(OBSERVED_PARAMETERS_V1);
    assert.ok(result.ok);
    assert.equal(seaportQuoteAgreesV1({ quotedWei: OBSERVED_QUOTED_WEI_V1, listing: result.listing }), true);
    // A summary that undersells what the consideration actually takes is the
    // disagreement this check exists for.
    assert.equal(seaportQuoteAgreesV1({ quotedWei: '1000000000000000', listing: result.listing }), false);
  });

  test('a hidden extra consideration item raises the real total', () => {
    // The attack: the quote still says 0.00358 ETH, but the order takes more.
    const withExtra = withConsideration([
      ...OBSERVED_PARAMETERS_V1.consideration,
      {
        itemType: 0,
        token: '0x0000000000000000000000000000000000000000',
        identifierOrCriteria: '0',
        startAmount: '900000000000000000',
        endAmount: '900000000000000000',
        recipient: '0x9999999999999999999999999999999999999999',
      },
    ]);
    const result = readSeaportListingV1(withExtra);
    assert.ok(result.ok);
    assert.equal(result.listing.totalWei, '903580000000000000');
    assert.equal(
      seaportQuoteAgreesV1({ quotedWei: OBSERVED_QUOTED_WEI_V1, listing: result.listing }),
      false,
      'the quote must not survive an extra consideration item',
    );
  });
});

describe('V1 buys exactly one ERC-721 with native ETH', () => {
  test('an ERC-1155 offer is refused by name', () => {
    const result = readSeaportListingV1({
      ...OBSERVED_PARAMETERS_V1,
      offer: [{ itemType: 3, token: COLLECTION, identifierOrCriteria: '16668', startAmount: '1', endAmount: '1' }],
    });
    assert.equal(result.ok === false && result.reason, 'offer_is_erc1155');
  });

  test('a criteria offer is refused — it names a set, not a token', () => {
    const result = readSeaportListingV1({
      ...OBSERVED_PARAMETERS_V1,
      offer: [{ itemType: 4, token: COLLECTION, identifierOrCriteria: '0', startAmount: '1', endAmount: '1' }],
    });
    assert.equal(result.ok === false && result.reason, 'offer_uses_criteria');
  });

  test('an offer of two tokens is refused', () => {
    const result = readSeaportListingV1({
      ...OBSERVED_PARAMETERS_V1,
      offer: [...OBSERVED_PARAMETERS_V1.offer, ...OBSERVED_PARAMETERS_V1.offer],
    });
    assert.equal(result.ok === false && result.reason, 'offer_not_single_item');
  });

  test('an ERC-20 consideration is refused — this rail pays in native ETH', () => {
    const result = readSeaportListingV1(
      withConsideration([
        {
          itemType: 1,
          token: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
          identifierOrCriteria: '0',
          startAmount: '3580000',
          endAmount: '3580000',
          recipient: SELLER,
        },
      ]),
    );
    assert.equal(result.ok === false && result.reason, 'consideration_not_native');
  });

  test('a private listing is detected by the NFT sitting on the paying side', () => {
    // There is no `restrictedTaker` field on the wire. Seaport reserves a
    // listing by putting the NFT into the consideration, aimed at one buyer —
    // anyone else who fills it pays and receives nothing.
    const result = readSeaportListingV1(
      withConsideration([
        ...OBSERVED_PARAMETERS_V1.consideration,
        {
          itemType: 2,
          token: COLLECTION,
          identifierOrCriteria: '16668',
          startAmount: '1',
          endAmount: '1',
          recipient: '0x8888888888888888888888888888888888888888',
        },
      ]),
    );
    assert.equal(result.ok === false && result.reason, 'consideration_contains_nft');
  });

  test('a Dutch auction is refused — the quoted price is not the paid price', () => {
    const result = readSeaportListingV1(
      withConsideration([
        {
          itemType: 0,
          token: '0x0000000000000000000000000000000000000000',
          identifierOrCriteria: '0',
          startAmount: '3580000000000000',
          endAmount: '1000000000000000',
          recipient: SELLER,
        },
      ]),
    );
    assert.equal(result.ok === false && result.reason, 'amount_not_fixed');
  });

  test('a quantity other than one is refused', () => {
    const result = readSeaportListingV1({
      ...OBSERVED_PARAMETERS_V1,
      offer: [{ itemType: 2, token: COLLECTION, identifierOrCriteria: '16668', startAmount: '2', endAmount: '2' }],
    });
    assert.equal(result.ok === false && result.reason, 'offer_quantity_not_one');
  });

  test('a malformed order is refused rather than partially read', () => {
    assert.equal(readSeaportListingV1(null).ok, false);
    assert.equal(readSeaportListingV1({}).ok, false);
    assert.equal(readSeaportListingV1({ ...OBSERVED_PARAMETERS_V1, offerer: 'not-an-address' }).ok, false);
  });
});

describe('listing status is mapped through a closed set', () => {
  test('OpenSea reports upper case, and only ACTIVE means active', () => {
    assert.equal(mapOpenSeaListingStatusV1('ACTIVE'), 'active');
    assert.equal(mapOpenSeaListingStatusV1('EXPIRED'), 'expired');
    assert.equal(mapOpenSeaListingStatusV1('CANCELLED'), 'cancelled');
    assert.equal(mapOpenSeaListingStatusV1('FULFILLED'), 'filled');
  });

  test('an unrecognised word is unknown, never active', () => {
    for (const value of ['', null, undefined, 'live', 'ok', 'ACTIVE_SOON']) {
      assert.equal(mapOpenSeaListingStatusV1(value), 'unknown', String(value));
    }
  });
});
