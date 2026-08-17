import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  DISCOVER_FOCUS_VIEWS_V1,
  discoverCardDomIdV1,
  discoverFocusHrefV1,
  discoverFocusTokenV1,
  parseDiscoverFocusV1,
} from '../src/console/discoverFocus';

// ---------------------------------------------------------------------------
// The rail's "View measurement" used to leave Discover entirely: it navigated
// to `/portfolio?token=0x…`, a surface that owns the wallet-bound exit check
// and no Discover measurement — and that has never read `?token=`, so the
// address was dropped on the way as well.
//
// The selection now lives in the URL of the surface that owns the measurement.
// That makes it a value a stranger can write, so everything below is about what
// this module refuses.
// ---------------------------------------------------------------------------

const TOKEN = '0xb200000000000000000000578f3ae29d9e6e0101';

describe('a focused token is a validated address or nothing', () => {
  test('a 20-byte address survives, in lower case', () => {
    assert.equal(discoverFocusTokenV1(TOKEN), TOKEN);
    assert.equal(discoverFocusTokenV1(TOKEN.toUpperCase().replace('0X', '0x')), TOKEN);
    assert.equal(discoverFocusTokenV1(`  ${TOKEN}  `), TOKEN);
  });

  test('anything that is not one is refused rather than passed through', () => {
    for (const value of [
      null,
      undefined,
      '',
      'MIO',
      '0x',
      // One nibble short. Nothing in the feed validated this shape before.
      TOKEN.slice(0, -1),
      `${TOKEN}00`,
      '0xzz00000000000000000000578f3ae29d9e6e0101',
      '<script>alert(1)</script>',
    ]) {
      assert.equal(discoverFocusTokenV1(value as string | null | undefined), null, String(value));
    }
  });
});

describe('the URL is the whole selection state', () => {
  test('token and view are read back', () => {
    assert.deepEqual(parseDiscoverFocusV1(`?token=${TOKEN}&view=measurement`), {
      tokenAddress: TOKEN,
      view: 'measurement',
    });
    // With or without the leading `?`, because a caller holds one or the other
    // depending on which router hook it asked.
    assert.deepEqual(parseDiscoverFocusV1(`token=${TOKEN}&view=measurement`), {
      tokenAddress: TOKEN,
      view: 'measurement',
    });
  });

  test('an unknown view is null, not a guessed default', () => {
    // A link with a token and a misspelled view asked for something this build
    // does not have, and inventing the nearest match would hide that.
    assert.deepEqual(parseDiscoverFocusV1(`?token=${TOKEN}&view=everything`), {
      tokenAddress: TOKEN,
      view: null,
    });
    assert.deepEqual(parseDiscoverFocusV1(`?token=${TOKEN}`), { tokenAddress: TOKEN, view: null });
  });

  test('a view without a token focuses nothing at all', () => {
    assert.deepEqual(parseDiscoverFocusV1('?view=measurement'), { tokenAddress: null, view: null });
    assert.deepEqual(parseDiscoverFocusV1(''), { tokenAddress: null, view: null });
    assert.deepEqual(parseDiscoverFocusV1(null), { tokenAddress: null, view: null });
  });

  test('a malformed token focuses nothing, so one test decides it', () => {
    assert.deepEqual(parseDiscoverFocusV1('?token=notanaddress&view=measurement'), {
      tokenAddress: null,
      view: null,
    });
  });
});

describe('the link is built from the section path, never from a literal', () => {
  test('it stays on the surface it was given', () => {
    assert.equal(
      discoverFocusHrefV1({ sectionPath: '/opportunities', tokenAddress: TOKEN }),
      `/opportunities?token=${TOKEN}&view=measurement`,
    );
    // Never Portfolio. That is the defect this module exists to close.
    assert.ok(!discoverFocusHrefV1({ sectionPath: '/opportunities', tokenAddress: TOKEN }).includes('portfolio'));
  });

  test('a round trip through the URL returns the same selection', () => {
    const href = discoverFocusHrefV1({ sectionPath: '/opportunities', tokenAddress: TOKEN });
    assert.deepEqual(parseDiscoverFocusV1(href.slice(href.indexOf('?'))), {
      tokenAddress: TOKEN,
      view: 'measurement',
    });
  });

  test('an address that is not one produces the plain section path', () => {
    assert.equal(discoverFocusHrefV1({ sectionPath: '/opportunities', tokenAddress: 'MIO' }), '/opportunities');
  });

  test('only the views this build has can be named', () => {
    assert.deepEqual([...DISCOVER_FOCUS_VIEWS_V1], ['measurement']);
  });
});

describe('the scroll target and the link agree', () => {
  test('the card id is derived from the same address, in the same case', () => {
    assert.equal(discoverCardDomIdV1(TOKEN), `b20-card-${TOKEN}`);
    assert.equal(discoverCardDomIdV1(TOKEN.toUpperCase().replace('0X', '0x')), `b20-card-${TOKEN}`);
  });
});
