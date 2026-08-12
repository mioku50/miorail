import assert from 'node:assert/strict';
import test, { afterEach, beforeEach, describe } from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { OPPORTUNITY_QUOTE_ASSET_V1 } from '@mioagent/opportunity-rail';
import {
  B20OpportunityClearanceV1Schema,
  B20_CLEARANCE_TTL_MS_V1,
  InMemoryB20ClearanceRepositoryV1,
  InMemoryB20EntryPlanRepositoryV1,
  InMemoryB20EntrySubmissionRepositoryV1,
  InMemoryMcpExecutionAuditRepositoryV1,
  InMemoryMcpHandoffRevocationRepositoryV1,
  MCP_AUDIT_MANDATORY_OUTCOMES_V1,
  McpAuditWriteError,
  assertMcpAuditV1,
  mcpAuditRowV1,
  type B20OpportunityClearanceV1,
} from '@mioagent/route-storage';

import { buildEntryBlueprintV1 } from '../../lib/b20EntryPlan.js';
import { buildPreparedPlanV1 } from '../../lib/b20EntryPlanStore.js';
import { issueHandoffTokenV1 } from '../../lib/mcpHandoffToken.js';
import { routeHashV1 } from '../../lib/opportunityClearance.js';
import { b20RouteRuntime } from '../b20Control.js';
import { mcpAuditIdV1, mcpAuditRuntime } from './audit.js';
import { createMiorailPrivateMcpServerV1 } from './server.js';
import { mcpPrivateAuthRuntime, resolvePrivateIdentityV1 } from './session.js';
import type { McpPrivateIdentityV1 } from './session.js';

// ---------------------------------------------------------------------------
// T72-C §9 — the audit is a precondition, not a side effect.
//
// The tests that matter here are the ones where the audit FAILS. An audit that
// only works when everything else does is decoration; the question is what the
// surface does when it cannot record what it is about to make possible.
// ---------------------------------------------------------------------------

const here = __dirname;
const USDC = OPPORTUNITY_QUOTE_ASSET_V1;
const TOKEN = '0xb200000000000000000000578f3ae29d9e6e0101';
const WALLET = '0x1111111111111111111111111111111111111111';
const FACTORY = '0x420dd381b31aef6683db6b902084cb0ffece40da';
const NOW = new Date('2026-08-06T12:00:00.000Z');
const CONTROL_HASH = `0x${'a'.repeat(64)}`;
const ROUTE = [{ from: USDC, to: TOKEN, stable: false, factory: FACTORY }] as const;
const POSITION = '100000000';
const SECRET = 'session-secret-under-test';

const IDENTITY: McpPrivateIdentityV1 = {
  tenantId: `eip155:8453:${WALLET}`,
  walletAddress: WALLET,
  chainId: 8453,
  tokenId: 'token-under-test',
  source: 'handoff_token',
};

const FLAGS = {
  routeIntelligenceV1: true,
  legacyTerminal: true,
  paidIntelligence: false,
  earnRouteV1: false,
  commerceRouteV1: false,
  commerceExecutionV1: false,
  nftRouteV1: false,
  nftExecutionV1: false,
  privateAiRouteV1: false,
  privateAiExecutionV1: false,
  aerodromeExecutionV1: false,
  b20ControlV1: true,
  submissionRecoveryV1: false,
  publicProofV1: false,
  mcpPrivateV1: true,
  mcpPrivateExecutionV1: true,
  routeOutcomeFeedbackV1: false, tokenIdentityV1: false,
} as const;

function clearance(): B20OpportunityClearanceV1 {
  return B20OpportunityClearanceV1Schema.parse({
    schemaVersion: 'b20-opportunity-clearance/v1',
    id: 'clearance-1',
    tenantId: IDENTITY.tenantId,
    walletAddress: WALLET,
    chainId: 8453,
    tokenAddress: TOKEN,
    quoteAsset: USDC,
    positionAtomic: POSITION,
    maxRoundTripBps: 300,
    maxExitSlippageBps: 300,
    profileIdentity: `${USDC}:${POSITION}:300:300`,
    controlSnapshotHash: CONTROL_HASH,
    controlBlockNumber: '49450000',
    entryRouteHash: routeHashV1(ROUTE),
    exitRouteHash: `0x${'c'.repeat(64)}`,
    entrySourceKey: `aerodrome:${FACTORY}:${USDC}:${TOKEN}:volatile`,
    exitSourceKey: `aerodrome:${FACTORY}:${TOKEN}:${USDC}:volatile`,
    simulationRequestHash: `0x${'d'.repeat(64)}`,
    simulationEvidenceHash: `0x${'e'.repeat(64)}`,
    simulationBlockNumber: '49450001',
    entryProvider: 'aerodrome',
    viability: 'qualified',
    coverage: 'partial',
    viableRouteConfirmed: true,
    bestRouteConfirmed: false,
    simulatedReturnedAtomic: '99000000',
    simulatedAcquiredAtomic: '4200000000000000000000',
    simulatedRoundTripBps: 100,
    createdAt: NOW.toISOString(),
    expiresAt: new Date(NOW.getTime() + B20_CLEARANCE_TTL_MS_V1).toISOString(),
  });
}

function preparedPlan() {
  const blueprint = buildEntryBlueprintV1({
    clearance: clearance(),
    fresh: { route: [...ROUTE], outputAtomic: '4200000000000000000000', quotedAt: NOW },
    freshControls: {
      factoryConfirmed: true,
      transfersPaused: false,
      transferPolicyActive: false,
      controlsFullyRead: true,
      snapshotHash: CONTROL_HASH,
      blockNumber: '49450050',
    },
    observedAllowanceAtomic: '0',
    deadlineSeconds: BigInt(Math.floor(NOW.getTime() / 1000)) + BigInt(300),
  });
  return buildPreparedPlanV1({
    clearance: clearance(),
    blueprint,
    simulation: {
      requestHash: `0x${'1'.repeat(64)}`,
      evidenceHash: `0x${'2'.repeat(64)}`,
      blockNumber: '49450051',
    },
    tokenName: 'Example',
    tokenSymbol: 'EXA',
    requestId: 'req-1',
    now: NOW,
    newId: () => 'plan-1',
  });
}

const originalRuntime = { ...b20RouteRuntime };
const originalAudit = { ...mcpAuditRuntime };
const originalAuthFlags = mcpPrivateAuthRuntime.flags;
let plans: InMemoryB20EntryPlanRepositoryV1;
let submissions: InMemoryB20EntrySubmissionRepositoryV1;
let clearances: InMemoryB20ClearanceRepositoryV1;
let audit: InMemoryMcpExecutionAuditRepositoryV1;
let revocations: InMemoryMcpHandoffRevocationRepositoryV1;
let originalSecret: string | undefined;

beforeEach(async () => {
  plans = new InMemoryB20EntryPlanRepositoryV1();
  submissions = new InMemoryB20EntrySubmissionRepositoryV1();
  clearances = new InMemoryB20ClearanceRepositoryV1();
  audit = new InMemoryMcpExecutionAuditRepositoryV1();
  revocations = new InMemoryMcpHandoffRevocationRepositoryV1();
  await clearances.insertClearance(clearance());

  originalSecret = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = SECRET;
  process.env.MIORAIL_MCP_PRIVATE_V1 = 'true';
  process.env.MIORAIL_MCP_PRIVATE_EXECUTION_V1 = 'true';

  mcpAuditRuntime.available = async () => true;
  mcpAuditRuntime.audit = () => audit;
  mcpAuditRuntime.revocations = () => revocations;
  mcpAuditRuntime.now = () => NOW;

  b20RouteRuntime.flags = () => ({ ...FLAGS });
  b20RouteRuntime.now = () => NOW;
  b20RouteRuntime.entryPlans = () => plans;
  b20RouteRuntime.entrySubmissions = () => submissions;
  b20RouteRuntime.clearances = () => clearances;
  b20RouteRuntime.entryPlanAvailable = async () => true;
  b20RouteRuntime.clearanceAvailable = async () => true;
  // Stubbed explicitly: without it this suite passes or fails depending on
  // whether some other package's tests left BASE_MAINNET_RPC_URL in the
  // environment, which is not a thing a test should depend on.
  b20RouteRuntime.rpcConfigured = () => true;
  b20RouteRuntime.executionCapabilities = async () => ({
    submissionRouteWired: true,
    walletIntegrationWired: true,
    reconciliationWired: true,
  });
  mcpPrivateAuthRuntime.flags = () => ({ ...FLAGS });
  await plans.insertPreparedPlan(preparedPlan() as Parameters<typeof plans.insertPreparedPlan>[0]);
});

afterEach(() => {
  Object.assign(b20RouteRuntime, originalRuntime);
  Object.assign(mcpAuditRuntime, originalAudit);
  mcpPrivateAuthRuntime.flags = originalAuthFlags;
  if (originalSecret === undefined) delete process.env.SESSION_SECRET;
  else process.env.SESSION_SECRET = originalSecret;
  delete process.env.MIORAIL_MCP_PRIVATE_V1;
  delete process.env.MIORAIL_MCP_PRIVATE_EXECUTION_V1;
});

async function connectedClient(identity: McpPrivateIdentityV1 = IDENTITY): Promise<Client> {
  const client = new Client({ name: 'audit-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([
    createMiorailPrivateMcpServerV1(identity).connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return client;
}

type ToolResult = { isError?: boolean; structuredContent?: Record<string, unknown>; content?: unknown };
const payloadOf = (result: unknown) => ((result as ToolResult).structuredContent ?? {}) as Record<string, unknown>;
const errorTextOf = (result: unknown) => JSON.stringify((result as ToolResult).content ?? '');

const releaseArgs = { planId: 'plan-1', positionAtomic: POSITION, attemptRequestId: 'attempt-1' };

describe('§9 — no credential and no calldata reaches audit storage', () => {
  test('a released action stores a digest, never the bytes', async () => {
    const client = await connectedClient();
    const released = payloadOf(await client.callTool({ name: 'miorail_get_base_mcp_action', arguments: releaseArgs }));
    const rows = await audit.listForTenant({ tenantId: IDENTITY.tenantId });
    const row = rows.find((entry) => entry.outcome === 'action_released');
    assert.ok(row, 'the release was not audited');
    assert.equal(row.callsHash, released.callsHash);

    // The calldata that was handed out appears nowhere in the trail.
    const action = released.action as { calls: { data: string }[] };
    const stored = JSON.stringify(rows);
    for (const call of action.calls) {
      assert.ok(!stored.includes(call.data), 'calldata reached the audit');
    }
    await client.close();
  });

  test('the audit row shape has no field a token or a body could occupy', () => {
    // Two independent gates, and this asserts the second one.
    //
    // `mcpAuditRowV1` builds the row from named arguments, so an extra property
    // is simply never copied. That is good but not sufficient: it would stop
    // being true the moment somebody wrote to the repository directly. So the
    // SCHEMA is `.strict()`, and an extra property is a parse failure rather
    // than a silently dropped one — a dropped property would mean the
    // guarantee held today and quietly stopped holding later.
    const valid = mcpAuditRowV1({
      id: 'x',
      tokenId: 'token-1',
      tenantId: IDENTITY.tenantId,
      walletAddress: WALLET,
      toolName: 'miorail_get_base_mcp_action',
      outcome: 'action_released',
      now: NOW,
    });
    assert.equal((valid as Record<string, unknown>).bearerToken, undefined);
    for (const smuggled of ['bearerToken', 'calldata', 'rpcUrl', 'providerResponse']) {
      assert.throws(
        () => assertMcpAuditV1({ ...valid, [smuggled]: 'x' }, 'write'),
        McpAuditWriteError,
        `${smuggled} was accepted`,
      );
    }
  });

  test('a whole handoff token cannot be written as a token id', async () => {
    const issued = issueHandoffTokenV1({
      tenantId: IDENTITY.tenantId,
      walletAddress: WALLET,
      secret: SECRET,
      now: NOW,
    });
    assert.throws(
      () =>
        mcpAuditRowV1({
          id: 'x',
          tokenId: issued.token,
          tenantId: IDENTITY.tenantId,
          walletAddress: WALLET,
          toolName: 'handoff_issue',
          outcome: 'token_issued',
          now: NOW,
        }),
      McpAuditWriteError,
    );
  });
});

describe('§2/§9 — a mandatory audit failure refuses the action', () => {
  test('the release is refused and no calls are returned', async () => {
    mcpAuditRuntime.audit = () =>
      ({
        record: async () => {
          throw new McpAuditWriteError('storage down');
        },
        listForTenant: async () => [],
        listForPlan: async () => [],
      }) as never;

    const client = await connectedClient();
    const result = await client.callTool({ name: 'miorail_get_base_mcp_action', arguments: releaseArgs });
    assert.equal((result as ToolResult).isError, true);
    assert.match(errorTextOf(result), /mcp_audit_unavailable/);
    // Nothing executable in the refusal.
    assert.ok(!/0x095ea7b3/.test(errorTextOf(result)), 'calldata leaked in a refusal');
    await client.close();
  });

  test('the plan is released again after the audit recovers', async () => {
    // The refused attempt must not leave the plan permanently locked: nothing
    // was sent, so the honest state is one the user can retry from.
    let failing = true;
    const working = audit;
    mcpAuditRuntime.audit = () =>
      failing
        ? ({
            record: async () => {
              throw new McpAuditWriteError('storage down');
            },
            listForTenant: async () => [],
            listForPlan: async () => [],
          } as never)
        : working;

    const client = await connectedClient();
    assert.equal(
      ((await client.callTool({ name: 'miorail_get_base_mcp_action', arguments: releaseArgs })) as ToolResult)
        .isError,
      true,
    );
    failing = false;
    const retry = payloadOf(
      await client.callTool({
        name: 'miorail_get_base_mcp_action',
        arguments: { ...releaseArgs, attemptRequestId: 'attempt-2' },
      }),
    );
    assert.equal(retry.outcome, 'ready');
    await client.close();
  });

  test('an unmigrated server cannot release, rather than releasing unaudited', async () => {
    // §2's real failure mode: a deploy that turned the surface on and never ran
    // 0031 would otherwise hand out calls with no record at all.
    mcpAuditRuntime.available = async () => false;
    const client = await connectedClient();
    const result = await client.callTool({ name: 'miorail_get_base_mcp_action', arguments: releaseArgs });
    assert.equal((result as ToolResult).isError, true);
    assert.match(errorTextOf(result), /mcp_audit_unavailable/);
    await client.close();
  });

  test('a read-only status call still answers when the audit is down', async () => {
    // Refusing to tell somebody where their entry got to would be a worse
    // outcome than a gap in the log.
    mcpAuditRuntime.available = async () => false;
    const client = await connectedClient();
    const status = payloadOf(
      await client.callTool({ name: 'miorail_get_execution_status', arguments: { planId: 'plan-1' } }),
    );
    assert.ok(status.status, 'a status read was refused because of the audit');
    await client.close();
  });

  test('only the two irreversible outcomes are mandatory', () => {
    assert.deepEqual([...MCP_AUDIT_MANDATORY_OUTCOMES_V1], ['action_released', 'submission_recorded']);
  });
});

describe('§2/§9 — duplicates do not become duplicate rows or duplicate submissions', () => {
  test('a repeated release is one attempt and one audit row', async () => {
    const client = await connectedClient();
    const first = payloadOf(await client.callTool({ name: 'miorail_get_base_mcp_action', arguments: releaseArgs }));
    const second = payloadOf(await client.callTool({ name: 'miorail_get_base_mcp_action', arguments: releaseArgs }));
    assert.equal(first.attemptId, second.attemptId);
    const released = (await audit.listForPlan({ tenantId: IDENTITY.tenantId, planId: 'plan-1' })).filter(
      (row) => row.outcome === 'action_released',
    );
    assert.equal(released.length, 1, 'a retry produced a second "the calls were released" record');
    await client.close();
  });

  test('the mandatory row id is derived, not random', () => {
    const parts = [IDENTITY.tenantId, 'miorail_get_base_mcp_action', 'action_released', 'plan-1', null, null];
    assert.equal(mcpAuditIdV1(parts), mcpAuditIdV1(parts));
    assert.notEqual(mcpAuditIdV1(parts), mcpAuditIdV1([...parts.slice(0, 3), 'plan-2', null, null]));
  });

  test('recording the same batch twice is one submission row', async () => {
    const client = await connectedClient();
    const action = payloadOf(await client.callTool({ name: 'miorail_get_base_mcp_action', arguments: releaseArgs }));
    const args = {
      planId: 'plan-1',
      attemptId: action.attemptId,
      submittedCallsHash: action.callsHash,
      result: 'submitted' as const,
      batchId: 'batch-1',
    };
    await client.callTool({ name: 'miorail_record_base_mcp_submission', arguments: args });
    await client.callTool({ name: 'miorail_record_base_mcp_submission', arguments: args });
    const recorded = (await audit.listForPlan({ tenantId: IDENTITY.tenantId, planId: 'plan-1' })).filter(
      (row) => row.outcome === 'submission_recorded',
    );
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0].batchId, 'batch-1');
    await client.close();
  });
});

describe('§1/§9 — outcomes are persisted, including the ones nobody wants', () => {
  async function reachTerminal(outcome: 'entry_succeeded' | 'entry_reverted'): Promise<Client> {
    const client = await connectedClient();
    const action = payloadOf(await client.callTool({ name: 'miorail_get_base_mcp_action', arguments: releaseArgs }));
    await client.callTool({
      name: 'miorail_record_base_mcp_submission',
      arguments: {
        planId: 'plan-1',
        attemptId: action.attemptId,
        submittedCallsHash: action.callsHash,
        result: 'submitted',
        batchId: 'batch-terminal',
      },
    });
    const attempt = await submissions.latestForPlan({ planId: 'plan-1', tenantId: IDENTITY.tenantId });
    await submissions.updateAttempt({
      attemptId: attempt!.id,
      tenantId: IDENTITY.tenantId,
      status: 'terminal',
      terminalOutcome: outcome,
      ...(outcome === 'entry_succeeded'
        ? {
            reconciliation: {
              spentAtomic: POSITION,
              receivedAtomic: '4190000000000000000000',
              confirmedBlockNumber: '49450090',
              transactionHashes: [`0x${'7'.repeat(64)}`],
              evidenceHash: `0x${'8'.repeat(64)}`,
            },
          }
        : { errorCode: 'entry_reverted' }),
      now: NOW,
    });
    return client;
  }

  for (const outcome of ['entry_succeeded', 'entry_reverted'] as const) {
    test(`${outcome} is written to the trail when the status is read`, async () => {
      const client = await reachTerminal(outcome);
      await client.callTool({ name: 'miorail_get_execution_status', arguments: { planId: 'plan-1' } });
      const rows = await audit.listForPlan({ tenantId: IDENTITY.tenantId, planId: 'plan-1' });
      assert.ok(
        rows.some((row) => row.outcome === outcome),
        `${outcome} never reached the audit`,
      );
      await client.close();
    });
  }

  test('a wallet rejection is recorded as itself, not as a submission', async () => {
    const client = await connectedClient();
    const action = payloadOf(await client.callTool({ name: 'miorail_get_base_mcp_action', arguments: releaseArgs }));
    await client.callTool({
      name: 'miorail_record_base_mcp_submission',
      arguments: {
        planId: 'plan-1',
        attemptId: action.attemptId,
        submittedCallsHash: action.callsHash,
        result: 'user_rejected',
      },
    });
    const rows = await audit.listForPlan({ tenantId: IDENTITY.tenantId, planId: 'plan-1' });
    assert.ok(rows.some((row) => row.outcome === 'user_rejected'));
    assert.ok(
      !rows.some((row) => row.outcome === 'submission_recorded'),
      'a declined wallet was recorded as a submission',
    );
    await client.close();
  });

  test('an unknown result with no batch id is recorded as submitted_unknown', async () => {
    const client = await connectedClient();
    const action = payloadOf(await client.callTool({ name: 'miorail_get_base_mcp_action', arguments: releaseArgs }));
    await client.callTool({
      name: 'miorail_record_base_mcp_submission',
      arguments: {
        planId: 'plan-1',
        attemptId: action.attemptId,
        submittedCallsHash: action.callsHash,
        result: 'unknown',
      },
    });
    const rows = await audit.listForPlan({ tenantId: IDENTITY.tenantId, planId: 'plan-1' });
    assert.ok(rows.some((row) => row.outcome === 'submitted_unknown'));
    await client.close();
  });
});

describe('§3/§9 — revocation, and how it differs from expiry', () => {
  const requestWith = (token: string) =>
    resolvePrivateIdentityV1({ headers: { authorization: `Bearer ${token}` } } as never);

  test('a live token works until it is revoked, then does not', async () => {
    const issued = issueHandoffTokenV1({
      tenantId: IDENTITY.tenantId,
      walletAddress: WALLET,
      secret: SECRET,
      now: NOW,
    });
    mcpPrivateAuthRuntime.now = () => NOW;

    const before = await requestWith(issued.token);
    assert.equal(before.ok, true);

    await revocations.revoke({
      tokenId: issued.tokenId,
      tenantId: IDENTITY.tenantId,
      revokedAt: NOW.toISOString(),
      expiresAt: issued.expiresAt,
    });
    const after = await requestWith(issued.token);
    assert.equal(after.ok, false);
    assert.equal(after.ok === false && after.reason, 'handoff_token_revoked');
    mcpPrivateAuthRuntime.now = originalAudit.now;
  });

  test('revoked and expired are different answers', async () => {
    // A user who revoked a token needs to see that the revocation is what
    // stopped it, not a clock they cannot check.
    const issued = issueHandoffTokenV1({
      tenantId: IDENTITY.tenantId,
      walletAddress: WALLET,
      secret: SECRET,
      now: NOW,
      ttlMs: 60_000,
    });
    mcpPrivateAuthRuntime.now = () => new Date(NOW.getTime() + 60_001);
    const expired = await requestWith(issued.token);
    assert.equal(expired.ok === false && expired.reason, 'handoff_token_expired');

    // And expiry still applies to a revoked token: revoking does not resurrect
    // it, and the expiry answer is not overwritten by the revocation one.
    await revocations.revoke({
      tokenId: issued.tokenId,
      tenantId: IDENTITY.tenantId,
      revokedAt: NOW.toISOString(),
      expiresAt: issued.expiresAt,
    });
    const both = await requestWith(issued.token);
    assert.equal(both.ok === false && both.reason, 'handoff_token_expired');
    mcpPrivateAuthRuntime.now = originalAudit.now;
  });

  test('one tenant cannot revoke another’s token', async () => {
    const issued = issueHandoffTokenV1({
      tenantId: IDENTITY.tenantId,
      walletAddress: WALLET,
      secret: SECRET,
      now: NOW,
    });
    mcpPrivateAuthRuntime.now = () => NOW;
    await revocations.revoke({
      tokenId: issued.tokenId,
      tenantId: 'eip155:8453:0x2222222222222222222222222222222222222222',
      revokedAt: NOW.toISOString(),
      expiresAt: issued.expiresAt,
    });
    assert.equal((await requestWith(issued.token)).ok, true);
    mcpPrivateAuthRuntime.now = originalAudit.now;
  });

  test('a browser session has nothing to revoke', async () => {
    // Revoking the string 'session' would take down every cookie caller at
    // once, so the lookup never happens for one.
    assert.equal(await mcpAuditRuntime.revocations().isRevoked({ tokenId: 'session', tenantId: IDENTITY.tenantId }), false);
  });
});

describe('§4 — Stage A proves the read path with executable handoff off', () => {
  beforeEach(() => {
    process.env.MIORAIL_MCP_PRIVATE_EXECUTION_V1 = 'false';
  });

  test('a plan can still be read and described', async () => {
    const client = await connectedClient();
    const status = payloadOf(
      await client.callTool({ name: 'miorail_get_execution_status', arguments: { planId: 'plan-1' } }),
    );
    assert.ok(status.review, 'Stage A lost the read path');
    assert.equal((status.status as { state: string }).state, 'review');
    await client.close();
  });

  test('the prepared plan reports execution as unavailable, and names why', async () => {
    const client = await connectedClient();
    const prepared = payloadOf(
      await client.callTool({
        name: 'miorail_prepare_b20_entry',
        arguments: { clearanceId: 'clearance-1', positionAtomic: POSITION, requestId: 'req-1' },
      }),
    );
    assert.equal(prepared.executionAvailable, false);
    assert.equal(prepared.executionUnavailableReason, 'mcp_execution_disabled');
    await client.close();
  });

  test('no executable calls are released, and no attempt is opened', async () => {
    const client = await connectedClient();
    const result = await client.callTool({ name: 'miorail_get_base_mcp_action', arguments: releaseArgs });
    assert.equal((result as ToolResult).isError, true);
    assert.match(errorTextOf(result), /mcp_execution_disabled/);
    assert.equal(await submissions.latestForPlan({ planId: 'plan-1', tenantId: IDENTITY.tenantId }), null);
    // And nothing was audited as released, because nothing was.
    const rows = await audit.listForTenant({ tenantId: IDENTITY.tenantId });
    assert.ok(!rows.some((row) => row.outcome === 'action_released'));
    await client.close();
  });
});

describe('§9 — the public MCP surface cannot reach the audit or the execution modules', () => {
  const publicDir = path.join(here, '..', 'mcp');
  const publicSources = readdirSync(publicDir)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .map((name) => ({ name, text: readFileSync(path.join(publicDir, name), 'utf8') }));

  test('the scan found the public files it claims to check', () => {
    assert.deepEqual(publicSources.map((entry) => entry.name).sort(), ['index.ts', 'server.ts', 'tools.ts']);
  });

  test('nothing public imports the private surface or the audit', () => {
    for (const { name, text } of publicSources) {
      const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
      for (const banned of [
        'mcpPrivate',
        'mcpExecutionAudit',
        'McpExecutionAudit',
        'recordAuditV1',
        'mcpAuditRuntime',
        'mcpHandoffToken',
      ]) {
        assert.ok(!code.includes(banned), `${name} reaches ${banned}`);
      }
    }
  });

  test('§7 — all three surfaces are rate limited, and the private one by tenant AND token', () => {
    const privateRouter = readFileSync(path.join(here, 'index.ts'), 'utf8');
    const publicRouter = readFileSync(path.join(publicDir, 'index.ts'), 'utf8');
    const handoff = readFileSync(path.join(here, '..', 'mcpHandoff.ts'), 'utf8');
    for (const [name, source] of [
      ['public /mcp', publicRouter],
      ['private /mcp/private', privateRouter],
      ['handoff issuance', handoff],
    ] as const) {
      assert.match(source, /InMemoryRateLimiter/, `${name} has no rate limit`);
    }
    // Keyed by IP alone, the private limit would be meaningless: an MCP client
    // sits behind whatever egress its host has.
    assert.match(privateRouter, /mcp-private:\$\{identity\.tokenId\}:\$\{identity\.tenantId\}/);
    assert.match(handoff, /mcp-handoff:\$\{identity\.tenantId\}/);
  });

  test('the audit module is only reachable from the private surface and the handoff route', () => {
    const routesDir = path.join(here, '..');
    const importers = readdirSync(routesDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts'))
      .filter((entry) => readFileSync(path.join(routesDir, entry.name), 'utf8').includes('mcpPrivate/audit'))
      .map((entry) => entry.name);
    assert.deepEqual(importers, ['mcpHandoff.ts']);
  });
});
