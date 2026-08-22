import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  normalizeProviderPayloadV1,
  providerPayloadErrorCodeV1,
  providerRecordV1,
  providerRowsV1,
} from '../src/payload-normalizer.js';

// The rule this file exists to hold: a payload we could not READ is never
// reported as a payload with no rows. Every case below is a shape a reviewed
// read met in production, and the Venice one is why the module exists.

describe('a provider payload is read in whatever envelope it arrives in', () => {
  it('reads a plain object', () => {
    const result = normalizeProviderPayloadV1({ data: [{ id: 'a' }] });
    assert.equal(result.outcome, 'parsed');
    assert.deepEqual(providerRowsV1(result.value), [{ id: 'a' }]);
  });

  it('reads JSON that arrived as a string', () => {
    const result = normalizeProviderPayloadV1('{"data":[{"id":"a"}]}');
    assert.equal(result.outcome, 'parsed');
    assert.deepEqual(result.layers, ['json_string']);
    assert.deepEqual(providerRowsV1(result.value), [{ id: 'a' }]);
  });

  it('reads JSON that was encoded as a string inside JSON', () => {
    const result = normalizeProviderPayloadV1(JSON.stringify(JSON.stringify({ data: [{ id: 'a' }] })));
    assert.equal(result.outcome, 'parsed');
    assert.deepEqual(providerRowsV1(result.value), [{ id: 'a' }]);
  });

  it('reads the MCP result.content[].text envelope', () => {
    const result = normalizeProviderPayloadV1({
      content: [{ type: 'text', text: '{"items":[{"id":"a"},{"id":"b"}]}' }],
    });
    assert.equal(result.outcome, 'parsed');
    assert.deepEqual(result.layers, ['mcp_content', 'json_string']);
    assert.deepEqual(providerRowsV1(result.value, ['items']), [{ id: 'a' }, { id: 'b' }]);
  });

  it('reads the final JSON frame of an SSE stream and ignores [DONE]', () => {
    const stream = [
      'event: message',
      'data: {"partial":true}',
      '',
      'data: {"data":[{"id":"final"}]}',
      '',
      'data: [DONE]',
      '',
    ].join('\n');
    const result = normalizeProviderPayloadV1(stream);
    assert.equal(result.outcome, 'parsed');
    assert.deepEqual(providerRowsV1(result.value), [{ id: 'final' }]);
  });

  it('finds a record under a data envelope, not only an array', () => {
    // Moonwell answers one market this way. Requiring an array reported a
    // perfectly good response as having no market rows.
    const result = normalizeProviderPayloadV1({ success: true, data: { asset: 'USDC', mToken: 'mUSDC' } });
    assert.deepEqual(providerRecordV1(result.value), { asset: 'USDC', mToken: 'mUSDC' });
  });
});

describe('an unreadable payload is never reported as an empty one', () => {
  it('names a JSON document that arrived cut short', () => {
    // Exactly the Venice failure: 265 KB of valid JSON sliced at 200 KB.
    const cut = JSON.stringify({ data: [{ id: 'a', name: 'x'.repeat(50) }] }).slice(0, 40);
    const result = normalizeProviderPayloadV1(cut);
    assert.equal(result.outcome, 'truncated');
    assert.equal(result.value, null);
    assert.equal(providerPayloadErrorCodeV1(result.outcome), 'provider_payload_truncated');
  });

  it('names a body that is not JSON at all', () => {
    const result = normalizeProviderPayloadV1('<!DOCTYPE html><html>Just a moment...</html>');
    assert.equal(result.outcome, 'not_json');
    assert.equal(providerPayloadErrorCodeV1(result.outcome), 'provider_payload_not_json');
  });

  it('names an empty body', () => {
    assert.equal(normalizeProviderPayloadV1('').outcome, 'empty');
    assert.equal(normalizeProviderPayloadV1(null).outcome, 'empty');
  });

  it('returns no rows rather than half of a mixed array', () => {
    // Reporting the object half as "the rows" would silently drop the rest.
    assert.equal(providerRowsV1({ data: [{ id: 'a' }, 'not-an-object'] }), null);
  });
});
