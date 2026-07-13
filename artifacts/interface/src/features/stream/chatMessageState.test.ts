import assert from 'node:assert/strict';
import test from 'node:test';
import { baseMcpReconnectIssue } from './chatMessageState.js';

test('wallet mismatch is not treated as reconnect-only while unverified wallet still fails closed', () => {
  assert.equal(baseMcpReconnectIssue([
    { metadata: { directReadKind: 'base_portfolio', errorCode: 'base_mcp_wallet_mismatch' } },
  ]), null);
  assert.match(baseMcpReconnectIssue([
    { metadata: { directReadKind: 'base_mcp_send', errorCode: 'base_mcp_wallet_unverified' } },
  ]) || '', /could not verify/i);
});
test('a later successful Base portfolio read clears historical reconnect noise', () => {
  assert.equal(baseMcpReconnectIssue([
    { metadata: { directReadKind: 'base_portfolio', errorCode: 'base_mcp_wallet_mismatch' } },
    { metadata: { directReadKind: 'base_portfolio' } },
  ]), null);
});
