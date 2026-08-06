import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test, { describe } from 'node:test';

import {
  MCP_HANDOFF_DEFAULT_TTL_MS_V1,
  MCP_HANDOFF_MAX_TTL_MS_V1,
  MCP_HANDOFF_MIN_TTL_MS_V1,
  MCP_HANDOFF_PREFIX_V1,
  bearerTokenV1,
  handoffTtlMsV1,
  issueHandoffTokenV1,
  verifyHandoffTokenV1,
} from './mcpHandoffToken.js';

// ---------------------------------------------------------------------------
// T72-B §1/§10 — the credential that carries a wallet binding to an MCP client.
//
// The thing being tested is not "does it round-trip". It is that every way of
// producing a token WITHOUT the secret fails, and that a token cannot be made
// long-lived by configuration.
// ---------------------------------------------------------------------------

const SECRET = 'session-secret-under-test';
const WALLET = '0x1111111111111111111111111111111111111111';
const TENANT = `eip155:8453:${WALLET}`;
const NOW = new Date('2026-08-06T10:00:00.000Z');

const issue = (overrides: Partial<Parameters<typeof issueHandoffTokenV1>[0]> = {}) =>
  issueHandoffTokenV1({ tenantId: TENANT, walletAddress: WALLET, secret: SECRET, now: NOW, ...overrides });

describe('§1 — the handoff token carries a wallet binding and nothing else', () => {
  test('a fresh token verifies back to the wallet that issued it', () => {
    const issued = issue();
    const verified = verifyHandoffTokenV1({ token: issued.token, secret: SECRET, now: NOW });
    assert.equal(verified.ok, true);
    assert.equal(verified.ok && verified.claims.walletAddress, WALLET);
    assert.equal(verified.ok && verified.claims.tenantId, TENANT);
    assert.equal(verified.ok && verified.claims.chainId, 8453);
  });

  test('the token is opaque about everything except its version', () => {
    // A credential that announced the wallet in cleartext would leak it into
    // every config file, log line and screenshot it appears in.
    const issued = issue();
    assert.ok(issued.token.startsWith(`${MCP_HANDOFF_PREFIX_V1}.`));
    // The claims are base64url, so the raw address must not appear as text.
    assert.ok(!issued.token.includes(WALLET));
  });

  test('a token minted for a tenant that is not its wallet is refused at issue', () => {
    // The binding is an invariant of the credential, not a convention the
    // caller is trusted to honour.
    assert.throws(() => issue({ tenantId: 'eip155:8453:0x2222222222222222222222222222222222222222' }));
    assert.throws(() => issue({ walletAddress: 'not-an-address' }));
  });
});

describe('§10 — every forgery route fails', () => {
  test('a token signed with another secret does not verify', () => {
    const issued = issueHandoffTokenV1({
      tenantId: TENANT,
      walletAddress: WALLET,
      secret: 'a-different-secret',
      now: NOW,
    });
    const verified = verifyHandoffTokenV1({ token: issued.token, secret: SECRET, now: NOW });
    assert.equal(verified.ok, false);
    assert.equal(verified.ok === false && verified.reason, 'handoff_token_bad_signature');
  });

  test('editing the claims invalidates the signature', () => {
    const issued = issue();
    const [prefix, body, signature] = issued.token.split('.');
    const claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    claims.walletAddress = '0x2222222222222222222222222222222222222222';
    claims.tenantId = `eip155:8453:${claims.walletAddress}`;
    const forged = `${prefix}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.${signature}`;
    const verified = verifyHandoffTokenV1({ token: forged, secret: SECRET, now: NOW });
    assert.equal(verified.ok, false);
    assert.equal(verified.ok === false && verified.reason, 'handoff_token_bad_signature');
  });

  test('a credential from another system is refused before it is parsed', () => {
    for (const token of ['', 'Bearer x', 'eyJhbGciOiJIUzI1NiJ9.e30.abc', `${MCP_HANDOFF_PREFIX_V1}.only-two`]) {
      const verified = verifyHandoffTokenV1({ token, secret: SECRET, now: NOW });
      assert.equal(verified.ok, false, `${token || '(empty)'} verified`);
    }
  });

  test('expiry is checked after the signature, and enforced', () => {
    const issued = issue({ ttlMs: 60_000 });
    const later = new Date(NOW.getTime() + 60_001);
    const verified = verifyHandoffTokenV1({ token: issued.token, secret: SECRET, now: later });
    assert.equal(verified.ok, false);
    assert.equal(verified.ok === false && verified.reason, 'handoff_token_expired');
  });

  test('the signing key is derived, so the session secret is not the token key', () => {
    // Domain separation: a value signed with SESSION_SECRET directly must not
    // verify here, or one leak would be two compromises.
    const issued = issue();
    const [prefix, body] = issued.token.split('.');
    const direct = crypto
      .createHmac('sha256', SECRET)
      .update(`${prefix}.${body}`)
      .digest('base64url');
    const verified = verifyHandoffTokenV1({ token: `${prefix}.${body}.${direct}`, secret: SECRET, now: NOW });
    assert.equal(verified.ok, false);
  });
});

describe('§10 — short-lived is a property of the code', () => {
  test('configuration cannot push the lifetime past the ceiling', () => {
    assert.equal(handoffTtlMsV1('99999999999'), MCP_HANDOFF_MAX_TTL_MS_V1);
    assert.equal(handoffTtlMsV1('1'), MCP_HANDOFF_MIN_TTL_MS_V1);
    assert.equal(handoffTtlMsV1('-5'), MCP_HANDOFF_MIN_TTL_MS_V1);
    // T72-C §3 — fifteen minutes in production.
    assert.equal(handoffTtlMsV1('not a number'), MCP_HANDOFF_DEFAULT_TTL_MS_V1);
    assert.equal(handoffTtlMsV1(undefined), MCP_HANDOFF_DEFAULT_TTL_MS_V1);
    assert.equal(MCP_HANDOFF_DEFAULT_TTL_MS_V1, 15 * 60 * 1000);
  });

  test('two tokens for one wallet are distinguishable in an audit line', () => {
    assert.notEqual(issue().tokenId, issue().tokenId);
  });
});

describe('the bearer header is the only accepted transport', () => {
  test('a well-formed header yields the token', () => {
    assert.equal(bearerTokenV1('Bearer abc.def.ghi'), 'abc.def.ghi');
    assert.equal(bearerTokenV1('bearer   abc'), 'abc');
  });

  test('anything else yields nothing', () => {
    for (const header of [undefined, '', 'Basic abc', 'abc', 'Bearer'] as (string | undefined)[]) {
      assert.equal(bearerTokenV1(header), null, `accepted ${String(header)}`);
    }
  });
});
