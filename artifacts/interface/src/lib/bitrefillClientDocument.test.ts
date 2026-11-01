import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

// Still is a client of Bitrefill's MCP by a Client ID Metadata Document: the
// client_id IS the HTTPS URL of this public file, so Bitrefill reads it from
// stills.lat, and no secret exists to keep. Their rules: public, served over
// HTTPS on a real hostname, under 10 KB, client_credentials, auth method none.
test('the Bitrefill client document names its own address and asks for nothing secret', () => {
  const root = process.cwd().endsWith('artifacts/interface') ? process.cwd() : resolve(process.cwd(), 'artifacts/interface');
  const text = readFileSync(resolve(root, 'public/clients/bitrefill-mcp.json'), 'utf8');
  const document = JSON.parse(text) as Record<string, unknown>;
  assert.equal(document.client_id, 'https://stills.lat/clients/bitrefill-mcp.json');
  assert.deepEqual(document.grant_types, ['client_credentials']);
  assert.equal(document.token_endpoint_auth_method, 'none');
  assert.equal(document.scope, 'mcp');
  assert.ok(Buffer.byteLength(text) < 10_240);
  assert.ok(!/secret|key|password/i.test(Object.keys(document).join(' ')));
});
