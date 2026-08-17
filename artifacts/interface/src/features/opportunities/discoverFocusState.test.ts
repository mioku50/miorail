import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  DISCOVER_FOCUS_FAILED_COPY_V1,
  DISCOVER_FOCUS_NOT_FOUND_CODE_V1,
  DISCOVER_FOCUS_OFF_COPY_V1,
  discoverFocusStateV1,
} from './discoverFocusState';

// ---------------------------------------------------------------------------
// Four outcomes look identical to a panel that only checks for a card: still
// loading, Discover off on this server, no canonical launch at this address,
// and the read failed. Only the third is a fact about the token.
//
// This is the recurring defect this codebase has already shipped three times —
// an endpoint failure wearing a token's name — so the mapping is a pure
// function with a test rather than four ternaries in a component.
// ---------------------------------------------------------------------------

const TOKEN = '0xb200000000000000000000578f3ae29d9e6e0101';

const base = {
  tokenAddress: TOKEN,
  discoverOn: true,
  inFeed: false,
  detailPending: false,
  detailError: null as string | null,
  hasCard: false,
};

describe('nothing focused is not a state at all', () => {
  test('a null token is quiet', () => {
    assert.deepEqual(discoverFocusStateV1({ ...base, tokenAddress: null }), {
      loading: false,
      notFound: false,
      error: null,
    });
  });

  test('a null token stays quiet even while a stale query is pending', () => {
    assert.deepEqual(discoverFocusStateV1({ ...base, tokenAddress: null, detailPending: true }), {
      loading: false,
      notFound: false,
      error: null,
    });
  });
});

describe('the card already on the page costs no request', () => {
  test('a card in the feed page is ready immediately', () => {
    assert.deepEqual(discoverFocusStateV1({ ...base, inFeed: true, detailPending: true }), {
      loading: false,
      notFound: false,
      error: null,
    });
  });

  test('a card loaded by address is ready too', () => {
    assert.deepEqual(discoverFocusStateV1({ ...base, hasCard: true }), {
      loading: false,
      notFound: false,
      error: null,
    });
  });
});

describe('the four failure shapes stay apart', () => {
  test('Discover off is about the server, and says so', () => {
    const state = discoverFocusStateV1({ ...base, discoverOn: false, detailPending: true });
    assert.equal(state.error, DISCOVER_FOCUS_OFF_COPY_V1);
    assert.equal(state.notFound, false);
    assert.match(state.error!, /not a statement about this token/);
  });

  test('a 404 is a fact about the index, not an error', () => {
    const state = discoverFocusStateV1({
      ...base,
      detailError: DISCOVER_FOCUS_NOT_FOUND_CODE_V1,
    });
    assert.deepEqual(state, { loading: false, notFound: true, error: null });
  });

  test('the 404 is recognised through the wrapping the client adds', () => {
    // fetchApi turns the body's `error` field into an Error message, sometimes
    // with a detail appended. Matching the whole string exactly would make the
    // 404 read as a transport failure the moment a detail is added.
    const state = discoverFocusStateV1({
      ...base,
      detailError: `${DISCOVER_FOCUS_NOT_FOUND_CODE_V1}: no canonical launch`,
    });
    assert.equal(state.notFound, true);
  });

  test('any other failure is Miorail’s, and is worded as one', () => {
    const state = discoverFocusStateV1({ ...base, detailError: 'API error: 500 Internal Server Error' });
    assert.equal(state.error, DISCOVER_FOCUS_FAILED_COPY_V1);
    assert.equal(state.notFound, false);
    assert.match(state.error!, /about the request, not about the token/);
  });

  test('a pending read is loading, and nothing else', () => {
    assert.deepEqual(discoverFocusStateV1({ ...base, detailPending: true }), {
      loading: true,
      notFound: false,
      error: null,
    });
  });

  test('a finished read with no card and no error is the index having nothing', () => {
    assert.deepEqual(discoverFocusStateV1(base), { loading: false, notFound: true, error: null });
  });
});
