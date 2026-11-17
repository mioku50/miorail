import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { mcpClientKindOfRedirectsV1, mcpClientKindV1 } from './mcpClientKind.js';

describe('which assistant a connected client is, from where its codes go', () => {
  it('names Claude, ChatGPT and Grok by their own hosts, as production saw them', () => {
    assert.equal(mcpClientKindOfRedirectsV1(['https://claude.ai/api/mcp/auth_callback']), 'claude');
    assert.equal(mcpClientKindOfRedirectsV1(['https://claude.ai/api/mcp/auth_callback', 'https://claude.com/api/mcp/auth_callback']), 'claude');
    assert.equal(mcpClientKindOfRedirectsV1(['https://chatgpt.com/connector_platform_oauth_redirect']), 'chatgpt');
    assert.equal(mcpClientKindOfRedirectsV1(['https://grok.com/oauth/callback']), 'grok');
  });

  it('never trusts a name, a loopback CLI, plain http, another port or a second address', () => {
    for (const redirects of [
      ['http://127.0.0.1:38025/callback'],
      ['http://localhost:63014/callback'],
      ['http://claude.ai/api/mcp/auth_callback'],
      ['https://claude.ai:8443/api/mcp/auth_callback'],
      ['https://claude.ai.example.com/callback'],
      ['https://evil.example/claude.ai'],
      // Registered beside an address of its own, the client could have used that one.
      ['https://claude.ai/api/mcp/auth_callback', 'https://evil.example/callback'],
      ['https://claude.ai/api/mcp/auth_callback', 'https://chatgpt.com/connector_platform_oauth_redirect'],
      ['not a url'],
      ['https://constructor/callback'],
      ['https://__proto__/callback'],
      [],
    ]) assert.equal(mcpClientKindOfRedirectsV1(redirects), 'other', JSON.stringify(redirects));
    assert.equal(mcpClientKindOfRedirectsV1(undefined), 'other');
  });

  it('reads the client once, and a failed read loses only the label', async () => {
    const asked: string[] = [];
    const store = { async getClient(id: string) { asked.push(id); return id === 'c1' ? { client_name: 'Claude', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] } : undefined; } };
    assert.equal(await mcpClientKindV1('c1', store), 'claude');
    assert.equal(await mcpClientKindV1('missing', store), 'other');
    assert.equal(await mcpClientKindV1(undefined, store), 'other');
    assert.deepEqual(asked, ['c1', 'missing']);
    const broken = { async getClient(): Promise<undefined> { throw new Error('db down'); } };
    assert.equal(await mcpClientKindV1('c1', broken), 'other');
    // A client named Claude whose codes go elsewhere is not Claude.
    const named = { async getClient() { return { client_name: 'Claude', redirect_uris: ['http://127.0.0.1:5000/cb'] }; } };
    assert.equal(await mcpClientKindV1('c2', named), 'other');
  });
});
