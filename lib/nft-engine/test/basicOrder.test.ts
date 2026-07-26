import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  SEAPORT_FULFILL_BASIC_ORDER_ABI_V1,
  decodeNftFulfillmentCallV1,
  expectedFulfillmentFormV1,
  readOpenSeaFulfillmentV1,
} from '../src/index.js';
import {
  FIX_BUYER,
  FIX_NOW,
  FIX_PRICE_WEI,
  FIX_SEAPORT,
  advancedPayloadV1,
  basicPayloadV1,
  blueprintFixtureV1,
} from './blueprint-fixture.js';

// ---------------------------------------------------------------------------
// T65.1 §1/§2/§7 — the basic order form.
//
// The payload here is the shape OpenSea actually returned for an ordinary
// Base listing on 2026-07-26. What these tests hold in place is that the
// PROVIDER DOES NOT CHOOSE: the form follows from the order Miorail read, and
// the response is held to it.
// ---------------------------------------------------------------------------

function readBasic(payload: unknown, form: 'basic' | 'advanced' = 'basic') {
  const { candidate } = blueprintFixtureV1('basic');
  return readOpenSeaFulfillmentV1({ payload, candidate, buyer: FIX_BUYER, expectedForm: form, now: FIX_NOW });
}

describe('the form follows from the order, not from the response', () => {
  test('an ordinary order expects the basic form; a zone-restricted one the advanced', () => {
    assert.equal(expectedFulfillmentFormV1({ restrictedByZone: false }), 'basic');
    assert.equal(expectedFulfillmentFormV1({ restrictedByZone: true }), 'advanced');
  });

  test('a real ordinary listing encodes to fulfillBasicOrder_efficient_6GL6yc', () => {
    const result = readBasic(basicPayloadV1());
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.fulfillment.to, FIX_SEAPORT);
    assert.equal(result.fulfillment.valueWei, FIX_PRICE_WEI);
    // Seaport delivers a basic order to msg.sender; the buyer is whoever signs.
    assert.equal(result.fulfillment.recipient, FIX_BUYER.toLowerCase());
    const decoded = decodeNftFulfillmentCallV1(result.fulfillment.data);
    assert.equal(decoded.ok && decoded.form, 'basic');
    assert.equal(decoded.ok && decoded.recipient, null);
  });

  test("OpenSea's calldata suffix is never appended", () => {
    const result = readBasic(basicPayloadV1());
    assert.ok(result.ok);
    // Trailing bytes on a call we ask someone to sign are bytes nobody here
    // verified.
    assert.equal(result.fulfillment.data.endsWith('1234abcd'), false);
  });

  test('the provider offering Advanced for a Basic order is refused', () => {
    // Not "function_not_pinned" — it IS pinned. It is the wrong form, which
    // means it is a different order than the one that was verified.
    const result = readBasic(advancedPayloadV1(), 'basic');
    assert.equal(result.ok === false && result.reason, 'wrong_fulfillment_form');
  });

  test('the provider offering Basic for an Advanced order is refused', () => {
    const { candidate } = blueprintFixtureV1('advanced');
    const result = readOpenSeaFulfillmentV1({
      payload: basicPayloadV1(),
      candidate,
      buyer: FIX_BUYER,
      expectedForm: 'advanced',
      now: FIX_NOW,
    });
    assert.equal(result.ok === false && result.reason, 'wrong_fulfillment_form');
  });

  test('an unpinned function is refused outright', () => {
    const result = readBasic(basicPayloadV1({}, { function: 'transferFrom(address,address,uint256)' }));
    assert.equal(result.ok === false && result.reason, 'function_not_pinned');
  });

  test('the advanced form still works', () => {
    const { candidate } = blueprintFixtureV1('advanced');
    const result = readOpenSeaFulfillmentV1({
      payload: advancedPayloadV1(),
      candidate,
      buyer: FIX_BUYER,
      expectedForm: 'advanced',
      now: FIX_NOW,
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.fulfillment.data.slice(0, 10), '0xe7acab24');
    const decoded = decodeNftFulfillmentCallV1(result.fulfillment.data);
    assert.equal(decoded.ok && decoded.form, 'advanced');
    assert.equal(decoded.ok && decoded.recipient, FIX_BUYER.toLowerCase());
  });
});

describe('the order parameters decide, not the summary', () => {
  test('a consideration that does not sum to the reviewed price is refused', () => {
    // `value` still says the right number. The PAYOUTS do not, and they are
    // what the transaction actually performs.
    const result = readBasic(basicPayloadV1({ considerationAmount: '3000000000000000' }));
    assert.equal(result.ok === false && result.reason, 'consideration_total_mismatch');
  });

  test('a truncated additional-recipient list is refused', () => {
    const result = readBasic(basicPayloadV1({ totalOriginalAdditionalRecipients: '2' }));
    assert.equal(result.ok === false && result.reason, 'additional_recipients_mismatch');
  });

  test('a value that disagrees with the reviewed price is refused', () => {
    // Caught by the shared check before the form is even dispatched: the value
    // is compared against the card, not against the struct.
    const result = readBasic(basicPayloadV1({}, { value: '9000000000000000' }));
    assert.equal(result.ok === false && result.reason, 'value_mismatch');
  });

  test('a different seller is refused', () => {
    const result = readBasic(basicPayloadV1({ offerer: '0x5555555555555555555555555555555555555555' }));
    assert.equal(result.ok === false && result.reason, 'offerer_mismatch');
  });

  test('a different token id is refused', () => {
    const result = readBasic(basicPayloadV1({ offerIdentifier: '99999' }));
    assert.equal(result.ok === false && result.reason, 'order_mismatch');
  });

  test('a different collection is refused', () => {
    const result = readBasic(basicPayloadV1({ offerToken: '0x5555555555555555555555555555555555555555' }));
    assert.equal(result.ok === false && result.reason, 'order_mismatch');
  });

  test('a quantity other than one is refused', () => {
    const result = readBasic(basicPayloadV1({ offerAmount: '2' }));
    assert.equal(result.ok === false && result.reason, 'offer_amount_not_one');
  });

  test('ERC-20 payment is refused — V1 pays native ETH', () => {
    const result = readBasic(basicPayloadV1({ considerationToken: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' }));
    assert.equal(result.ok === false && result.reason, 'payment_not_native_eth');
  });

  test('every basicOrderType except ETH_TO_ERC721_FULL_OPEN is refused', () => {
    for (const type of [1, 2, 3, 4, 8, 16, 23]) {
      const result = readBasic(basicPayloadV1({ basicOrderType: type }));
      assert.equal(result.ok === false && result.reason, 'basic_order_type_unsupported', `type ${type}`);
    }
  });

  test('a zone on a supposedly open order is refused', () => {
    const result = readBasic(basicPayloadV1({ zone: '0x000056f7000000ece9003ca63978907a00ffd100' }));
    assert.equal(result.ok === false && result.reason, 'zone_present');
  });

  test('an expired order is refused at encode time, not only at quote time', () => {
    const result = readBasic(basicPayloadV1({ endTime: '1000000000' }));
    assert.equal(result.ok === false && result.reason, 'order_expired');
  });

  test('an unsigned order is refused', () => {
    const result = readBasic(basicPayloadV1({ signature: '0x' }));
    assert.equal(result.ok === false && result.reason, 'signature_missing');
  });

  test('another Seaport target is refused', () => {
    const result = readBasic(basicPayloadV1({}, { to: '0x5555555555555555555555555555555555555555' }));
    assert.equal(result.ok === false && result.reason, 'target_not_seaport');
  });

  test('another chain is refused', () => {
    const result = readBasic(basicPayloadV1({}, { chain: 1 }));
    assert.equal(result.ok === false && result.reason, 'chain_mismatch');
  });
});

describe('the kernel decodes what it is given', () => {
  test('bytes outside the pinned pair are refused, not interpreted', () => {
    const decoded = decodeNftFulfillmentCallV1('0x095ea7b3000000000000000000000000');
    assert.equal(decoded.ok, false);
    assert.equal(decoded.ok === false && decoded.reason, 'calldata_not_pinned_function');
  });

  test('a pinned selector with garbage behind it is undecodable, not accepted', () => {
    const decoded = decodeNftFulfillmentCallV1('0xfb0f3ee1deadbeef');
    assert.equal(decoded.ok, false);
  });

  test('the decoded price is the sum of every payout', () => {
    const result = readBasic(basicPayloadV1());
    assert.ok(result.ok);
    const decoded = decodeNftFulfillmentCallV1(result.fulfillment.data);
    assert.ok(decoded.ok);
    // Seller share plus the fee recipient, recomputed from the bytes.
    assert.equal(decoded.totalWei, FIX_PRICE_WEI);
  });

  test('the ABI is pinned to one function', () => {
    assert.equal(SEAPORT_FULFILL_BASIC_ORDER_ABI_V1.length, 1);
    assert.equal(SEAPORT_FULFILL_BASIC_ORDER_ABI_V1[0].name, 'fulfillBasicOrder_efficient_6GL6yc');
  });
});
