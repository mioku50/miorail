import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import helmet from 'helmet';
import request from 'supertest';
// Farcaster's own schema for a manifest, as its servers parse one.
import { domainManifestSchema, domainMiniAppConfigSchema } from '@farcaster/miniapp-core/dist/schemas/manifest.js';

import { farcasterAccountAssociationV1, farcasterManifestRouter, farcasterManifestV1 } from './farcasterManifest.js';
import { stockPagesRuntime } from './stockPages.js';

/** An association of the right shape. Its signature is not one: checking it is Farcaster's job. */
function associationV1(domain: string, header: Record<string, unknown> = { fid: 1, type: 'custody', key: '0x' + '11'.repeat(20) }) {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return JSON.stringify({
    header: part(header),
    payload: part({ domain }),
    signature: Buffer.from('not a real signature').toString('base64url'),
  });
}

function appV1(t: test.TestContext, association: string | undefined) {
  const savedOrigin = stockPagesRuntime.origin;
  const savedEnv = process.env.FARCASTER_ACCOUNT_ASSOCIATION;
  stockPagesRuntime.origin = () => 'https://miorail.xyz';
  if (association === undefined) delete process.env.FARCASTER_ACCOUNT_ASSOCIATION;
  else process.env.FARCASTER_ACCOUNT_ASSOCIATION = association;
  t.after(() => {
    stockPagesRuntime.origin = savedOrigin;
    if (savedEnv === undefined) delete process.env.FARCASTER_ACCOUNT_ASSOCIATION;
    else process.env.FARCASTER_ACCOUNT_ASSOCIATION = savedEnv;
  });
  const app = express();
  app.use(helmet());
  app.use(farcasterManifestRouter);
  return app;
}

test('the manifest opens the board, and Farcaster’s own schema accepts every field', () => {
  const manifest = farcasterManifestV1({ origin: 'https://miorail.xyz', association: null }) as {
    miniapp: Record<string, unknown>;
  };
  const parsed = domainMiniAppConfigSchema.safeParse(manifest.miniapp);
  assert.ok(parsed.success, JSON.stringify(parsed.error?.issues));
  assert.equal(manifest.miniapp.homeUrl, 'https://miorail.xyz/stocks');
  assert.equal(manifest.miniapp.iconUrl, 'https://miorail.xyz/miniapp-icon.png');
  assert.equal(manifest.miniapp.canonicalDomain, 'miorail.xyz');
  assert.deepEqual(manifest.miniapp.requiredChains, ['eip155:8453']);
  // Nothing signed, nothing claimed.
  assert.equal('accountAssociation' in manifest, false);
});

test('an association is served only whole and signed for this domain', () => {
  assert.equal(farcasterAccountAssociationV1(associationV1('miorail.xyz'), 'miorail.xyz').problem, null);
  // The manifest tool's whole output, pasted as it comes.
  const wrapped = JSON.stringify({ accountAssociation: JSON.parse(associationV1('miorail.xyz')) });
  assert.deepEqual(
    farcasterAccountAssociationV1(wrapped, 'miorail.xyz').association,
    JSON.parse(associationV1('miorail.xyz')),
  );
  assert.equal(farcasterAccountAssociationV1('null', 'miorail.xyz').problem, 'malformed');
  assert.equal(farcasterAccountAssociationV1(associationV1('example.com'), 'miorail.xyz').problem, 'other_domain');
  assert.equal(farcasterAccountAssociationV1(associationV1('miorail.xyz.evil'), 'miorail.xyz').problem, 'other_domain');
  assert.equal(farcasterAccountAssociationV1(undefined, 'miorail.xyz').problem, 'missing');
  assert.equal(farcasterAccountAssociationV1('  ', 'miorail.xyz').problem, 'missing');
  assert.equal(farcasterAccountAssociationV1('{', 'miorail.xyz').problem, 'malformed');
  assert.equal(farcasterAccountAssociationV1('{"header":"","payload":"","signature":""}', 'miorail.xyz').problem, 'malformed');
  assert.equal(
    farcasterAccountAssociationV1(associationV1('miorail.xyz', { type: 'custody' }), 'miorail.xyz').problem,
    'malformed',
    'a header that names no account',
  );
});

test('the route serves the signed manifest to anyone, from any origin', async (t) => {
  const response = await request(appV1(t, associationV1('miorail.xyz'))).get('/.well-known/farcaster.json').expect(200);
  assert.match(String(response.headers['content-type']), /application\/json/);
  assert.equal(response.headers['access-control-allow-origin'], '*');
  assert.equal(response.headers['cross-origin-resource-policy'], 'cross-origin');
  assert.equal(response.headers['cache-control'], 'public, max-age=300');
  const parsed = domainManifestSchema.safeParse(response.body);
  assert.ok(parsed.success, JSON.stringify(parsed.error?.issues));
  assert.equal(response.body.miniapp.homeUrl, 'https://miorail.xyz/stocks');
});

test('an association for another domain is left out, not served', async (t) => {
  const response = await request(appV1(t, associationV1('example.com'))).get('/.well-known/farcaster.json').expect(200);
  assert.equal(response.body.accountAssociation, undefined);
  assert.equal(response.body.miniapp.name, 'Miorail');
});
