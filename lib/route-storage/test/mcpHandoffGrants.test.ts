import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  MCP_OAUTH_GRANT_ID_PREFIX_V1,
  MCP_SESSION_TOKEN_ID_V1,
  mcpAuditRowV1,
  mcpHandoffGrantsV1,
  type McpExecutionAuditV1,
} from '../src/index.js';

// ---------------------------------------------------------------------------
// Connected Apps — the grants a wallet handed out.
//
// Derived from the audit trail and the revocation list, because those already
// record every event in a grant's life. The tests below are mostly about what
// this projection must REFUSE to say.
// ---------------------------------------------------------------------------

const TENANT = 'eip155:8453:0x4de27ead5a3c9aeb58c7f812178ddde282670d70';
const WALLET = '0x4de27ead5a3c9aeb58c7f812178ddde282670d70';
const NOW = new Date('2026-09-01T13:30:00.000Z');

let seq = 0;
const row = (over: {
  tokenId: string;
  outcome: McpExecutionAuditV1['outcome'];
  at: string;
  toolName?: string;
  clientKind?: McpExecutionAuditV1['clientKind'];
  expiresAt?: string | null;
}): McpExecutionAuditV1 =>
  mcpAuditRowV1({
    id: `row-${(seq += 1)}`,
    tokenId: over.tokenId,
    tenantId: TENANT,
    walletAddress: WALLET,
    toolName: over.toolName ?? 'miorail_get_stock_base_mcp_action',
    outcome: over.outcome,
    clientKind: over.clientKind ?? null,
    expiresAt: over.expiresAt ?? null,
    now: new Date(over.at),
  });

const revocation = (tokenId: string, at: string) => ({
  tokenId,
  tenantId: TENANT,
  revokedAt: at,
  expiresAt: at,
});

describe('the grants a wallet has handed out', () => {
  test('a grant is one row, with its client, its start and its last use', () => {
    const grants = mcpHandoffGrantsV1({
      audit: [
        row({ tokenId: 't1', outcome: 'plan_read', at: '2026-09-01T12:00:00.000Z' }),
        row({
          tokenId: 't1',
          outcome: 'token_issued',
          at: '2026-09-01T09:00:00.000Z',
          toolName: 'handoff_issue',
          clientKind: 'claude',
        }),
        row({ tokenId: 't1', outcome: 'action_released', at: '2026-09-01T11:00:00.000Z' }),
      ],
      revocations: [],
      now: NOW,
    });
    assert.equal(grants.length, 1);
    assert.deepEqual(
      [grants[0]!.clientKind, grants[0]!.issuedAt, grants[0]!.lastUsedAt, grants[0]!.useCount],
      ['claude', '2026-09-01T09:00:00.000Z', '2026-09-01T12:00:00.000Z', 2],
    );
    assert.equal(grants[0]!.historyComplete, true);
    assert.equal(grants[0]!.revokedAt, null);
  });

  test('issuing is not using', () => {
    // The grant an owner most wants to find is the one minted and never
    // touched. Counting its own issuance as a use would hide it among the
    // grants that are actually doing something.
    const grants = mcpHandoffGrantsV1({
      audit: [
        row({
          tokenId: 't2',
          outcome: 'token_issued',
          at: '2026-09-01T09:00:00.000Z',
          toolName: 'handoff_issue',
          clientKind: 'chatgpt',
        }),
      ],
      revocations: [],
      now: NOW,
    });
    assert.equal(grants[0]!.lastUsedAt, null);
    assert.equal(grants[0]!.useCount, 0);
  });

  test('a grant whose issuance is outside the window does not get a start date', () => {
    // The audit query is bounded. An old grant can surface through recent
    // activity alone, and dating it to the oldest row in view would say it
    // began whenever the page last happened to be busy.
    const grants = mcpHandoffGrantsV1({
      audit: [row({ tokenId: 't3', outcome: 'plan_read', at: '2026-09-01T12:00:00.000Z' })],
      revocations: [],
      now: NOW,
    });
    assert.equal(grants[0]!.issuedAt, null);
    assert.equal(grants[0]!.historyComplete, false);
    assert.equal(grants[0]!.lastUsedAt, '2026-09-01T12:00:00.000Z');
  });

  test('recorded expiry distinguishes current, expired and historical unknown', () => {
    const grants = mcpHandoffGrantsV1({
      audit: [
        row({
          tokenId: 'current',
          outcome: 'token_issued',
          at: '2026-09-01T13:00:00.000Z',
          expiresAt: '2026-09-01T14:00:00.000Z',
          toolName: 'handoff_issue',
        }),
        row({
          tokenId: 'expired',
          outcome: 'token_issued',
          at: '2026-09-01T09:00:00.000Z',
          expiresAt: '2026-09-01T10:00:00.000Z',
          toolName: 'handoff_issue',
        }),
        row({ tokenId: 'historical', outcome: 'token_issued', at: '2026-09-01T08:00:00.000Z', toolName: 'handoff_issue' }),
      ],
      revocations: [],
      now: NOW,
    });
    assert.deepEqual(
      Object.fromEntries(grants.map((grant) => [grant.tokenId, grant.status])),
      { current: 'current', expired: 'expired', historical: 'unknown' },
    );
    assert.equal(grants.find((grant) => grant.tokenId === 'historical')?.expiresAt, null);
  });

  test('a revoked grant with no rows in the window still appears', () => {
    // Otherwise the list that reports revocations is the one place a
    // revocation can vanish from.
    const grants = mcpHandoffGrantsV1({
      audit: [],
      revocations: [revocation('t5', '2026-09-01T13:00:00.000Z')],
      now: NOW,
    });
    assert.equal(grants.length, 1);
    assert.equal(grants[0]!.tokenId, 't5');
    assert.equal(grants[0]!.revokedAt, '2026-09-01T13:00:00.000Z');
    assert.equal(grants[0]!.historyComplete, false);
  });

  test('the earliest revocation is the one that took effect', () => {
    const grants = mcpHandoffGrantsV1({
      audit: [row({ tokenId: 't6', outcome: 'plan_read', at: '2026-09-01T09:00:00.000Z' })],
      revocations: [
        revocation('t6', '2026-09-01T14:00:00.000Z'),
        revocation('t6', '2026-09-01T11:00:00.000Z'),
      ],
      now: NOW,
    });
    assert.equal(grants[0]!.revokedAt, '2026-09-01T11:00:00.000Z');
  });

  test('the browser session is not a grant', () => {
    // It authenticates as a cookie, it was never handed to anybody, and there
    // is nothing about it to revoke here.
    const grants = mcpHandoffGrantsV1({
      audit: [
        row({ tokenId: MCP_SESSION_TOKEN_ID_V1, outcome: 'plan_read', at: '2026-09-01T12:00:00.000Z' }),
        row({ tokenId: 't7', outcome: 'plan_read', at: '2026-09-01T10:00:00.000Z' }),
      ],
      revocations: [revocation(MCP_SESSION_TOKEN_ID_V1, '2026-09-01T13:00:00.000Z')],
      now: NOW,
    });
    assert.deepEqual(
      grants.map((grant) => grant.tokenId),
      ['t7'],
    );
  });

  test('an OAuth grant is not derived here, however it was used or revoked', () => {
    // OAuth grants audit under their own durable id, and `mcp_oauth_grants`
    // already knows their client, expiry and use count. Deriving a second,
    // weaker row for the same grant would show every OAuth connection twice:
    // once named, once as an anonymous grant with no client and no expiry.
    const oauthId = `${MCP_OAUTH_GRANT_ID_PREFIX_V1}0f0f`;
    const grants = mcpHandoffGrantsV1({
      audit: [
        row({ tokenId: oauthId, outcome: 'plan_read', at: '2026-09-01T12:00:00.000Z' }),
        row({ tokenId: 't9', outcome: 'plan_read', at: '2026-09-01T10:00:00.000Z' }),
      ],
      revocations: [revocation(oauthId, '2026-09-01T13:00:00.000Z')],
      now: NOW,
    });
    assert.deepEqual(
      grants.map((grant) => grant.tokenId),
      ['t9'],
    );
  });

  test('an unrecorded client is null, never "other"', () => {
    // Every row written before Connected Apps existed carries no client.
    // `other` means a client the user named and we do not list; null means
    // nobody wrote one down. Collapsing them turns a gap into a claim.
    const grants = mcpHandoffGrantsV1({
      audit: [
        row({ tokenId: 't8', outcome: 'token_issued', at: '2026-09-01T09:00:00.000Z', toolName: 'handoff_issue' }),
      ],
      revocations: [],
      now: NOW,
    });
    assert.equal(grants[0]!.clientKind, null);
  });

  test('the newest thing that happened orders the list, revocation included', () => {
    const grants = mcpHandoffGrantsV1({
      audit: [
        row({ tokenId: 'old', outcome: 'plan_read', at: '2026-09-01T08:00:00.000Z' }),
        row({ tokenId: 'used', outcome: 'plan_read', at: '2026-09-01T12:00:00.000Z' }),
        row({ tokenId: 'killed', outcome: 'plan_read', at: '2026-09-01T09:00:00.000Z' }),
      ],
      revocations: [revocation('killed', '2026-09-01T13:00:00.000Z')],
      now: NOW,
    });
    assert.deepEqual(
      grants.map((grant) => grant.tokenId),
      ['killed', 'used', 'old'],
    );
  });
});
