import assert from 'node:assert/strict';
import test, { afterEach, beforeEach, describe } from 'node:test';
import express from 'express';
import helmet from 'helmet';
import session from 'express-session';
import request from 'supertest';
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';

import {
  MCP_OAUTH_SCOPES_V1,
  consentFormActionPolicyV1,
  mcpOAuthProviderV1,
  mcpOAuthResourceUrlV1,
  mcpOAuthRuntimeV1,
} from './mcpOAuthProvider.js';

// ---------------------------------------------------------------------------
// The consent screen, end to end.
//
// A live Codex run reached the consent page and pressing Authorize appeared to
// do nothing. The nginx log said otherwise: POST /authorize answered 302. The
// server was never the problem — the browser was refusing the redirect, because
// helmet's default `form-action 'self'` is enforced across the whole redirect
// chain of a form submission, and the chain ends at the client's own callback.
//
// So this exercises the real leg a client walks: GET the page, read the consent
// token out of the HTML it actually rendered, POST it back as a browser does
// (form-urlencoded), and require both halves of the answer — the redirect
// itself, and a policy that lets a browser follow it.
// ---------------------------------------------------------------------------

const WALLET = '0x1111111111111111111111111111111111111111';
const TENANT = `eip155:8453:${WALLET}`;
const REDIRECT = 'http://127.0.0.1:38025/callback/ZVZ5DGjwKk5o';
const STATE = '7P8htsVhlnh_Fgyp30ubEg';
const CHALLENGE = 'tcDN0EBC8c093CuwLGEzmnrWq6k-K5zh0yHegh_gAOQ';

type QueryV1 = { text: string; values: unknown[] };

const originalSql = mcpOAuthRuntimeV1.sql;
let queries: QueryV1[] = [];
let storedClient: string | null = null;

function fakeSql(strings: TemplateStringsArray, ...values: unknown[]): Promise<Record<string, unknown>[]> {
  const text = strings.join('?').replace(/\s+/g, ' ').trim();
  queries.push({ text, values });
  if (text.startsWith('SELECT encrypted_metadata FROM mcp_oauth_clients')) {
    return Promise.resolve(storedClient ? [{ encrypted_metadata: storedClient }] : []);
  }
  if (text.startsWith('INSERT INTO mcp_oauth_clients')) {
    storedClient = String(values[1]);
    return Promise.resolve([]);
  }
  if (text.startsWith('INSERT INTO mcp_oauth_authorization_codes')) return Promise.resolve([]);
  throw new Error(`unexpected query in this test: ${text}`);
}

function appV1(user: unknown = { id: TENANT, address: WALLET, chainId: 8453 }) {
  // Mirrors app.ts: helmet's policy, then the JSON parser (deliberately the
  // only app-level body parser), then the session, then the SDK router.
  const server = express();
  server.set('trust proxy', 1);
  server.use(helmet({ crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' } }));
  server.use(express.json());
  server.use(session({ secret: 'consent-test', resave: false, saveUninitialized: false }));
  server.use((req, _res, next) => {
    if (user) (req.session as unknown as Record<string, unknown>).user = user;
    next();
  });
  const issuer = new URL('https://miorail.xyz');
  server.use(mcpAuthRouter({
    provider: mcpOAuthProviderV1,
    issuerUrl: issuer,
    baseUrl: issuer,
    resourceServerUrl: mcpOAuthResourceUrlV1(),
    scopesSupported: [...MCP_OAUTH_SCOPES_V1],
  }));
  return server;
}

async function registerClientV1(): Promise<string> {
  const registered = await mcpOAuthProviderV1.clientsStore.registerClient!({
    client_id: 'codex-test-client',
    client_name: 'Codex',
    redirect_uris: [REDIRECT],
  } as never);
  return registered.client_id;
}

function authorizeQueryV1(clientId: string): string {
  return new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    state: STATE,
    code_challenge: CHALLENGE,
    code_challenge_method: 'S256',
    redirect_uri: REDIRECT,
    scope: 'miorail:connected offline_access',
    resource: mcpOAuthResourceUrlV1().href,
  }).toString();
}

function hiddenFieldsV1(html: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const match of html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)) {
    fields[match[1]!] = match[2]!.replaceAll('&amp;', '&').replaceAll('&#39;', "'").replaceAll('&quot;', '"');
  }
  return fields;
}

beforeEach(() => {
  queries = [];
  storedClient = null;
  mcpOAuthRuntimeV1.sql = fakeSql;
});

afterEach(() => {
  mcpOAuthRuntimeV1.sql = originalSql;
});

describe('MCP OAuth consent', () => {
  test('GET renders the consent form, POST allow redirects to the registered callback', async () => {
    const clientId = await registerClientV1();
    const agent = request.agent(appV1());

    const page = await agent.get(`/authorize?${authorizeQueryV1(clientId)}`);
    assert.equal(page.status, 200);
    assert.match(page.text, /<form method="post" action="\/authorize">/);
    assert.match(page.text, /name="decision" value="allow"/);

    const hidden = hiddenFieldsV1(page.text);
    assert.equal(hidden.client_id, clientId);
    assert.equal(hidden.redirect_uri, REDIRECT);
    assert.equal(hidden.state, STATE);
    assert.equal(hidden.code_challenge, CHALLENGE);
    assert.ok(hidden.consent_token && hidden.consent_token.length >= 24);

    // A browser posts the form as urlencoded, never as JSON.
    const posted = await agent
      .post('/authorize')
      .type('form')
      .send(new URLSearchParams({ ...hidden, decision: 'allow' }).toString());

    assert.equal(posted.status, 302);
    const location = new URL(posted.headers.location!);
    assert.equal(`${location.origin}${location.pathname}`, REDIRECT);
    assert.equal(location.searchParams.get('state'), STATE);
    const code = location.searchParams.get('code');
    assert.ok(code && code.length > 0);

    // The code is bound to this client, wallet and callback before it is issued.
    const insert = queries.find((entry) => entry.text.startsWith('INSERT INTO mcp_oauth_authorization_codes'));
    assert.ok(insert, 'an authorization code row is written');
    assert.ok(insert.values.includes(clientId));
    assert.ok(insert.values.includes(TENANT));
    assert.ok(insert.values.includes(REDIRECT));
    assert.equal(insert.values.includes(code), false, 'the raw code is never stored');
  });

  test('the consent response admits its own redirect target in form-action', async () => {
    const clientId = await registerClientV1();
    const page = await request.agent(appV1()).get(`/authorize?${authorizeQueryV1(clientId)}`);
    const policy = page.headers['content-security-policy'] ?? '';
    const directive = policy.split(';').map((part: string) => part.trim())
      .find((part: string) => part.startsWith('form-action'));
    assert.ok(directive, 'the consent page still carries a form-action directive');
    assert.match(directive!, /'self'/);
    assert.ok(
      directive!.includes('http://127.0.0.1:38025'),
      `form-action must admit the registered callback origin, got: ${directive}`,
    );
  });

  test('a POST without the session consent token does not issue a code', async () => {
    const clientId = await registerClientV1();
    const agent = request.agent(appV1());
    const page = await agent.get(`/authorize?${authorizeQueryV1(clientId)}`);
    const hidden = hiddenFieldsV1(page.text);

    const posted = await agent
      .post('/authorize')
      .type('form')
      .send(new URLSearchParams({ ...hidden, consent_token: 'x'.repeat(32), decision: 'allow' }).toString());

    assert.equal(posted.status, 200);
    assert.equal(posted.headers.location, undefined);
    assert.equal(queries.some((entry) => entry.text.startsWith('INSERT INTO mcp_oauth_authorization_codes')), false);
  });

  test('a code is issued once: replaying the same consent token is refused', async () => {
    const clientId = await registerClientV1();
    const agent = request.agent(appV1());
    const page = await agent.get(`/authorize?${authorizeQueryV1(clientId)}`);
    const form = new URLSearchParams({ ...hiddenFieldsV1(page.text), decision: 'allow' }).toString();

    const first = await agent.post('/authorize').type('form').send(form);
    assert.equal(first.status, 302);
    const second = await agent.post('/authorize').type('form').send(form);
    assert.equal(second.status, 200, 'a replayed consent token re-renders instead of issuing a second code');
    assert.equal(
      queries.filter((entry) => entry.text.startsWith('INSERT INTO mcp_oauth_authorization_codes')).length,
      1,
    );
  });

  test('Cancel returns access_denied to the registered callback', async () => {
    const clientId = await registerClientV1();
    const agent = request.agent(appV1());
    const page = await agent.get(`/authorize?${authorizeQueryV1(clientId)}`);
    const hidden = hiddenFieldsV1(page.text);

    const posted = await agent
      .post('/authorize')
      .type('form')
      .send(new URLSearchParams({ ...hidden, decision: 'deny' }).toString());

    assert.equal(posted.status, 302);
    const location = new URL(posted.headers.location!);
    assert.equal(location.origin, 'http://127.0.0.1:38025');
    assert.equal(location.searchParams.get('error'), 'access_denied');
    assert.equal(location.searchParams.get('state'), STATE);
    assert.ok(
      (posted.headers['content-security-policy'] ?? '').includes('http://127.0.0.1:38025'),
      'the refusal leaves through the same navigation the approval does',
    );
  });

  test('a signed-out browser is told to sign in rather than shown a consent form', async () => {
    const clientId = await registerClientV1();
    const page = await request.agent(appV1(null)).get(`/authorize?${authorizeQueryV1(clientId)}`);
    assert.equal(page.status, 401);
    assert.match(page.text, /Sign in to Miorail first/);
    assert.doesNotMatch(page.text, /name="decision"/);
  });
});

describe('consentFormActionPolicyV1', () => {
  const HELMET = "default-src 'self';base-uri 'self';form-action 'self';frame-ancestors 'self';upgrade-insecure-requests";

  test('adds the callback origin to the existing directive and changes nothing else', () => {
    const policy = consentFormActionPolicyV1(HELMET, 'http://127.0.0.1:38025/callback/abc')!;
    assert.match(policy, /form-action 'self' http:\/\/127\.0\.0\.1:38025/);
    assert.match(policy, /default-src 'self'/);
    assert.match(policy, /upgrade-insecure-requests/);
  });

  test('uses the origin only, because CSP ignores a source path when matching a redirect', () => {
    const policy = consentFormActionPolicyV1(HELMET, 'https://chatgpt.com/connector_platform_oauth_redirect')!;
    assert.match(policy, /form-action 'self' https:\/\/chatgpt\.com(;|$)/);
  });

  test('is idempotent', () => {
    const once = consentFormActionPolicyV1(HELMET, 'https://chatgpt.com/cb')!;
    assert.equal(consentFormActionPolicyV1(once, 'https://chatgpt.com/cb'), once);
  });

  test('adds the directive when the policy has none', () => {
    assert.equal(
      consentFormActionPolicyV1("default-src 'self'", 'https://example.test/cb'),
      "default-src 'self';form-action 'self' https://example.test",
    );
  });

  test('leaves the policy untouched for a callback no browser would navigate to', () => {
    for (const uri of ['not a url', 'javascript:alert(1)', 'data:text/html,x', 'myapp://cb']) {
      assert.equal(consentFormActionPolicyV1(HELMET, uri), HELMET, uri);
    }
  });
});
