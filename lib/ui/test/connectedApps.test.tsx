import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

void React;

import {
  CONNECTED_APP_CHOICES_V1,
  ConnectedAppsCard,
  connectedAppLabelV1,
  type ConnectedAppsCardModelV1,
} from '../src/console/ConnectedAppsCard';

/** Every class console.css defines a rule for. A card that invents its own
 * ships as unstyled text. */
const definedConsoleClasses = new Set(
  readFileSync(new URL('../src/console/console.css', import.meta.url), 'utf8')
    .match(/\.[A-Za-z][A-Za-z0-9_-]*/g)
    ?.map((selector) => selector.slice(1)) ?? [],
);

// ---------------------------------------------------------------------------
// Connect Miorail to your AI.
//
// Most of these tests are about what the card must NOT say. It is the one page
// that answers "who else can act as me", and every overclaim on it is a reason
// somebody leaves a key connected.
// ---------------------------------------------------------------------------

const GRANT = {
  tokenId: 'grant-1',
  grantKind: 'oauth' as const,
  clientKind: 'claude' as const,
  clientName: 'Claude',
  scopes: ['miorail:connected'],
  walletAddress: '0x4de27ead5a3c9aeb58c7f812178ddde282670d70',
  issuedAt: '2026-09-01T09:00:00.000Z',
  lastUsedAt: '2026-09-01T11:00:00.000Z',
  useCount: 3,
  revokedAt: null,
  expiresAt: '2099-09-01T13:00:00.000Z',
  status: 'current' as const,
  historyComplete: true,
};

function model(over: Partial<ConnectedAppsCardModelV1> = {}): ConnectedAppsCardModelV1 {
  return {
    available: true,
    unavailableReason: null,
    grants: [GRANT],
    loading: false,
    error: null,
    permissions: { read: true, executableHandoff: true },
    oauth: {
      endpointUrl: 'https://miorail.xyz/mcp/private',
      accessTokenTtlMinutes: 15,
      grantTtlDays: 30,
      refreshTokenRotation: true,
    },
    issued: null,
    issuing: false,
    revokingTokenId: null,
    onIssueTemporary: () => {},
    onRevoke: () => {},
    onDismissIssued: () => {},
    ...over,
  };
}

const render = (over: Partial<ConnectedAppsCardModelV1> = {}) =>
  renderToStaticMarkup(<ConnectedAppsCard {...model(over)} />);

describe('Connect Miorail to your AI', () => {
  test('a grant shows its app, its wallet, when it was used, and a way to end it', () => {
    const markup = render();
    assert.match(markup, /Claude/);
    assert.match(markup, /Last used/);
    assert.match(markup, /Revoke/);
    // The wallet, shortened but recognisable.
    assert.match(markup, /0x4de27e/);
    assert.match(markup, /3 calls/);
  });

  test('it counts only grants whose recorded expiry is still current', () => {
    const markup = render({
      grants: [
        GRANT,
        { ...GRANT, tokenId: 'expired', status: 'expired', expiresAt: '2026-09-01T10:00:00.000Z' },
        { ...GRANT, tokenId: 'revoked', status: 'revoked', revokedAt: '2026-09-01T12:00:00.000Z' },
      ],
    });
    assert.match(markup, /1 usable now/);
    assert.doesNotMatch(markup, /3 connected/);
  });

  test('a grant minted and never used says so', () => {
    // The one an owner most wants to find. Counting its own issuance as a use
    // would bury it among the grants that are actually doing something.
    const markup = render({ grants: [{ ...GRANT, lastUsedAt: null, useCount: 0 }] });
    assert.match(markup, /Never used/);
    assert.doesNotMatch(markup, /calls/);
  });

  test('a revoked grant stays visible, and loses its Revoke button', () => {
    const markup = render({
      grants: [{ ...GRANT, status: 'revoked', revokedAt: '2026-09-01T12:00:00.000Z' }],
    });
    assert.match(markup, /Revoked/);
    assert.doesNotMatch(markup, />Revoke</);
  });

  test('an unrecorded client is "Not recorded", never a client name', () => {
    assert.equal(connectedAppLabelV1(null), 'Not recorded');
    assert.equal(connectedAppLabelV1('claude'), 'Claude');
    assert.equal(connectedAppLabelV1('other'), 'Another client');
    const markup = render({ grants: [{ ...GRANT, clientKind: null, clientName: null }] });
    assert.match(markup, /Not recorded/);
  });

  test('a current grant describes a future expiry as future, never as zero seconds ago', () => {
    const markup = render();
    assert.match(markup, /expires in/);
    assert.doesNotMatch(markup, /expires 0s ago/);
  });

  test('OAuth is primary and manual bearer issuance is explicitly advanced fallback', () => {
    const markup = render();
    assert.match(markup, /Connect with OAuth/);
    assert.match(markup, /Advanced: temporary bearer key/);
    assert.match(markup, /Issue temporary key/);
    assert.doesNotMatch(markup, /Give an assistant a key/);
  });

  test('permissions are stated once for the server, never per grant', () => {
    // A handoff token carries no scopes; the executable half can be turned off
    // under a token that already exists.
    const on = render();
    assert.match(on, /Unsigned transactions, for you to approve/);
    assert.match(on, /Sign or send anything/);
    const off = render({ permissions: { read: true, executableHandoff: false } });
    assert.match(off, /switched off on this server/);
    assert.doesNotMatch(off, /Unsigned transactions/);
  });

  test('a failed read is never rendered as "nothing is connected"', () => {
    // The worst answer this page could give: an owner told they have none
    // stops looking.
    const markup = render({ grants: [], error: 'Your connected apps could not be read right now.' });
    assert.match(markup, /could not be read/);
    assert.doesNotMatch(markup, /No grants have been issued/);
  });

  test('an empty list says it plainly, and only when it is one', () => {
    const markup = render({ grants: [], error: null });
    assert.match(markup, /No grants have been issued/);
  });

  test('the minted key is shown once, with the warning attached', () => {
    const markup = render({
      issued: {
        token: 'miorail-handoff-v1.aaaa.bbbb',
        tokenId: 'grant-9',
        expiresAt: '2026-09-01T13:00:00.000Z',
        notice: 'Treat it like a password.',
      },
    });
    assert.match(markup, /shown once/);
    assert.match(markup, /Expires/);
    assert.match(markup, /miorail-handoff-v1\.aaaa\.bbbb/);
    assert.match(markup, /Treat it like a password/);
    // And a card with no freshly minted key never renders one.
    assert.doesNotMatch(render(), /miorail-handoff-v1/);
  });

  test('a server without the surface offers nothing to connect', () => {
    const markup = render({ available: false, unavailableReason: 'Switched off here.' });
    assert.match(markup, /Switched off here/);
    // The real check: no client button, and no grant list. An earlier version
    // of this test looked for the string "Connect", which stopped
    // discriminating the moment the button was labelled with a client name.
    for (const label of ['Claude', 'ChatGPT', 'Hermes']) {
      assert.doesNotMatch(markup, new RegExp(`>${label}<`));
    }
    assert.doesNotMatch(markup, /Revoke/);
  });

  test('it renders no control the console has no styling for', () => {
    // This card shipped with the only <select> in the console. There is no CSS
    // for one, so it rendered as a raw browser widget wedged into a row meant
    // for buttons. Everything interactive here is a `.btn`.
    const markup = render({
      issued: { token: 't', tokenId: 'i', expiresAt: 'e', notice: 'n' },
    });
    for (const tag of ['<select', '<input', '<textarea']) {
      assert.doesNotMatch(markup, new RegExp(tag));
    }
    assert.match(markup, /class="btn sec"/);
  });

  test('the three named clients are offered, plus a way to name another', () => {
    assert.deepEqual(
      CONNECTED_APP_CHOICES_V1.map((choice) => choice.kind),
      ['claude', 'chatgpt', 'hermes', 'other'],
    );
    const markup = render();
    for (const label of ['Claude', 'ChatGPT', 'Hermes']) assert.match(markup, new RegExp(label));
  });

  test('every class it uses is one console.css defines', () => {
    // A panel that invents a class ships as unstyled text.
    const markup = render({
      issued: { token: 't', tokenId: 'i', expiresAt: 'e', notice: 'n' },
    });
    for (const className of markup.match(/class="([^"]+)"/g) ?? []) {
      for (const name of className.slice(7, -1).split(/\s+/)) {
        assert.equal(definedConsoleClasses.has(name), true, `console.css defines no .${name}`);
      }
    }
  });
});
