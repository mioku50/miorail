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
  entryPlanCallsHashV1,
  type B20OpportunityClearanceV1,
  type B20PreparedEntryPlanV1,
} from '@mioagent/route-storage';

import { buildEntryBlueprintV1 } from '../../lib/b20EntryPlan.js';
import { buildPreparedPlanV1 } from '../../lib/b20EntryPlanStore.js';
import { routeHashV1 } from '../../lib/opportunityClearance.js';
import { b20RouteRuntime } from '../b20Control.js';
import { mcpAuditRuntime } from './audit.js';
import { createMiorailPrivateMcpServerV1 } from './server.js';
import { resolvePrivateIdentityV1, mcpPrivateAuthRuntime } from './session.js';
import type { McpPrivateIdentityV1 } from './session.js';

// ---------------------------------------------------------------------------
// T72-B §11 — driven through a REAL MCP client over a real transport.
//
// The interesting tests here are not the happy path. They are the ones that
// assert what this surface REFUSES: another wallet's plan, a second submission,
// a modified batch, an expired plan, and an unknown result that must never
// become a retry.
//
// `__dirname`, not `import.meta.url`: this package compiles to CommonJS, where
// that meta-property is a compile error, and not `process.cwd()` either — the
// test runner sets cwd per package.
// ---------------------------------------------------------------------------

const here = __dirname;

const USDC = OPPORTUNITY_QUOTE_ASSET_V1;
const TOKEN = '0xb200000000000000000000578f3ae29d9e6e0101';
const WALLET = '0x1111111111111111111111111111111111111111';
const OTHER_WALLET = '0x2222222222222222222222222222222222222222';
const FACTORY = '0x420dd381b31aef6683db6b902084cb0ffece40da';
const NOW = new Date('2026-08-06T12:00:00.000Z');
const CONTROL_HASH = `0x${'a'.repeat(64)}`;
const ROUTE = [{ from: USDC, to: TOKEN, stable: false, factory: FACTORY }] as const;
const POSITION = '100000000';
const PROFILE_IDENTITY = `${USDC}:${POSITION}:300:300`;

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

function clearance(overrides: Partial<B20OpportunityClearanceV1> = {}): B20OpportunityClearanceV1 {
  return B20OpportunityClearanceV1Schema.parse({
    schemaVersion: 'b20-opportunity-clearance/v1',
    id: 'clearance-1',
    tenantId: `eip155:8453:${WALLET}`,
    walletAddress: WALLET,
    chainId: 8453,
    tokenAddress: TOKEN,
    quoteAsset: USDC,
    positionAtomic: POSITION,
    maxRoundTripBps: 300,
    maxExitSlippageBps: 300,
    profileIdentity: PROFILE_IDENTITY,
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
    ...overrides,
  });
}

function preparedPlan(now = NOW): { plan: B20PreparedEntryPlanV1; run: unknown } {
  const blueprint = buildEntryBlueprintV1({
    clearance: clearance(),
    fresh: { route: [...ROUTE], outputAtomic: '4200000000000000000000', quotedAt: now },
    freshControls: {
      factoryConfirmed: true,
      transfersPaused: false,
      transferPolicyActive: false,
      controlsFullyRead: true,
      snapshotHash: CONTROL_HASH,
      blockNumber: '49450050',
    },
    observedAllowanceAtomic: '0',
    deadlineSeconds: BigInt(Math.floor(now.getTime() / 1000)) + BigInt(300),
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
    now,
    newId: () => 'plan-1',
  });
}

const original = { ...b20RouteRuntime };
const originalAudit = { ...mcpAuditRuntime };
const originalAuthFlags = mcpPrivateAuthRuntime.flags;
let plans: InMemoryB20EntryPlanRepositoryV1;
let submissions: InMemoryB20EntrySubmissionRepositoryV1;
let clearances: InMemoryB20ClearanceRepositoryV1;
let audit: InMemoryMcpExecutionAuditRepositoryV1;
let revocations: InMemoryMcpHandoffRevocationRepositoryV1;
let clock: Date;

beforeEach(async () => {
  plans = new InMemoryB20EntryPlanRepositoryV1();
  submissions = new InMemoryB20EntrySubmissionRepositoryV1();
  clearances = new InMemoryB20ClearanceRepositoryV1();
  audit = new InMemoryMcpExecutionAuditRepositoryV1();
  revocations = new InMemoryMcpHandoffRevocationRepositoryV1();
  clock = NOW;

  mcpAuditRuntime.available = async () => true;
  mcpAuditRuntime.audit = () => audit;
  mcpAuditRuntime.revocations = () => revocations;
  mcpAuditRuntime.now = () => clock;

  await clearances.insertClearance(clearance());

  b20RouteRuntime.flags = () => ({ ...FLAGS });
  b20RouteRuntime.now = () => clock;
  b20RouteRuntime.entryPlans = () => plans;
  b20RouteRuntime.entrySubmissions = () => submissions;
  b20RouteRuntime.clearances = () => clearances;
  b20RouteRuntime.entryPlanAvailable = async () => true;
  b20RouteRuntime.clearanceAvailable = async () => true;
  b20RouteRuntime.migrationAvailable = async () => true;
  b20RouteRuntime.rpcConfigured = () => true;
  b20RouteRuntime.executionCapabilities = async () => ({
    submissionRouteWired: true,
    walletIntegrationWired: true,
    reconciliationWired: true,
  });
  mcpPrivateAuthRuntime.flags = () => ({ ...FLAGS });
  process.env.MIORAIL_MCP_PRIVATE_V1 = 'true';
  process.env.MIORAIL_MCP_PRIVATE_EXECUTION_V1 = 'true';
});

afterEach(() => {
  Object.assign(b20RouteRuntime, original);
  Object.assign(mcpAuditRuntime, originalAudit);
  mcpPrivateAuthRuntime.flags = originalAuthFlags;
  delete process.env.MIORAIL_MCP_PRIVATE_V1;
  delete process.env.MIORAIL_MCP_PRIVATE_EXECUTION_V1;
});

async function connectedClient(identity: McpPrivateIdentityV1 = IDENTITY): Promise<Client> {
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([
    createMiorailPrivateMcpServerV1(identity).connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return client;
}

type ToolResult = { isError?: boolean; structuredContent?: Record<string, unknown>; content?: unknown };

function payloadOf(result: unknown): Record<string, unknown> {
  return ((result as ToolResult).structuredContent ?? {}) as Record<string, unknown>;
}

function errorTextOf(result: unknown): string {
  return JSON.stringify((result as ToolResult).content ?? '');
}

async function storePlan(): Promise<B20PreparedEntryPlanV1> {
  const draft = preparedPlan();
  const stored = await plans.insertPreparedPlan(draft as Parameters<typeof plans.insertPreparedPlan>[0]);
  return stored.plan;
}

/** Walks a plan through to a live wallet action. */
async function openAction(client: Client, planId = 'plan-1') {
  return client.callTool({
    name: 'miorail_get_base_mcp_action',
    arguments: { planId, positionAtomic: POSITION, attemptRequestId: 'attempt-1' },
  });
}

describe('§11 — the public MCP surface cannot reach execution', () => {
  test('the public server registers none of the execution tools', async () => {
    const { createMiorailMcpServerV1 } = await import('../mcp/server.js');
    const client = new Client({ name: 'probe', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([
      createMiorailMcpServerV1().connect(serverTransport),
      client.connect(clientTransport),
    ]);
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    for (const forbidden of [
      'miorail_check_exit_profile',
      'miorail_prepare_b20_entry',
      'miorail_get_base_mcp_action',
      'miorail_record_base_mcp_submission',
      'miorail_get_execution_status',
    ]) {
      assert.ok(!names.includes(forbidden), `the public surface exposes ${forbidden}`);
    }
    await client.close();
  });

  test('the two surfaces are separate routers on separate paths', () => {
    const app = readFileSync(path.join(here, '..', '..', 'app.ts'), 'utf8');
    assert.match(app, /app\.use\('\/mcp\/private', mcpPrivateRouter\);/);
    assert.match(app, /app\.use\('\/mcp', mcpServerRouter\);/);
    // The public directory's guarantee is checked by listing it, so the
    // executable surface must not live inside it.
    const publicFiles = readdirSync(path.join(here, '..', 'mcp')).sort();
    assert.deepEqual(publicFiles, ['index.ts', 'mcpServer.test.ts', 'server.ts', 'tools.ts']);
  });
});

describe('§10 — nothing happens without a proved wallet', () => {
  const request = (headers: Record<string, string> = {}, session?: unknown) =>
    resolvePrivateIdentityV1({ headers, session } as never);

  test('no credential is a refusal, not an anonymous read', async () => {
    const resolved = await request();
    assert.equal(resolved.ok, false);
    assert.equal(resolved.ok === false && resolved.reason, 'handoff_token_missing');
  });

  test('a bad token never falls back to a session', async () => {
    const resolved = await request(
      { authorization: 'Bearer miorail-mcp-v1.aaaa.bbbb' },
      { user: { id: `eip155:8453:${WALLET}`, address: WALLET, chainId: 8453 } },
    );
    assert.equal(resolved.ok, false);
  });

  test('the surface is invisible while the flag is off', async () => {
    mcpPrivateAuthRuntime.flags = () => ({ ...FLAGS, mcpPrivateV1: false });
    const resolved = await request({}, { user: { id: `eip155:8453:${WALLET}`, address: WALLET, chainId: 8453 } });
    assert.equal(resolved.ok, false);
    assert.equal(resolved.ok === false && resolved.reason, 'mcp_private_disabled');
  });

  test('a dev single-user session is not enough', async () => {
    const resolved = await request({}, { user: { id: 'default-user', address: WALLET, chainId: 8453 } });
    assert.equal(resolved.ok, false);
  });
});

describe('§11 — another wallet can neither read nor execute a plan', () => {
  test('a stranger gets the same answer a nonexistent plan gets', async () => {
    await storePlan();
    const stranger = await connectedClient({
      ...IDENTITY,
      tenantId: `eip155:8453:${OTHER_WALLET}`,
      walletAddress: OTHER_WALLET as `0x${string}`,
    });
    for (const name of ['miorail_get_execution_status', 'miorail_get_base_mcp_action'] as const) {
      const result = await stranger.callTool({
        name,
        arguments:
          name === 'miorail_get_base_mcp_action'
            ? { planId: 'plan-1', positionAtomic: POSITION, attemptRequestId: 'a-1' }
            : { planId: 'plan-1' },
      });
      assert.equal((result as ToolResult).isError, true, `${name} answered a stranger`);
      assert.match(errorTextOf(result), /b20_entry_plan_not_found/);
    }
    await stranger.close();
  });

  test('no tool accepts a wallet, owner or tenant argument', async () => {
    const client = await connectedClient();
    for (const tool of (await client.listTools()).tools) {
      const properties = Object.keys(
        (tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {},
      );
      for (const property of properties) {
        assert.ok(
          !/wallet|owner|tenant|account|from|signer/i.test(property),
          `${tool.name} accepts ${property}`,
        );
      }
    }
    await client.close();
  });
});

describe('§3/§11 — a provisional observation cannot skip qualification', () => {
  test('preparing against an id that no simulation issued is refused', async () => {
    const client = await connectedClient();
    const result = await client.callTool({
      name: 'miorail_prepare_b20_entry',
      arguments: {
        // Shaped like a Discover observation id. Nothing certified it.
        clearanceId: 'b20-observation:1234',
        positionAtomic: POSITION,
        requestId: 'req-x',
      },
    });
    const payload = payloadOf(result);
    assert.equal(payload.planId, null);
    assert.notEqual(payload.outcome, 'prepared');
    await client.close();
  });

  test('the private tools never read the observation repository', () => {
    const tools = readFileSync(path.join(here, 'tools.ts'), 'utf8');
    for (const banned of ['observations', 'readDiscoverFeedV1', 'b20OpportunityCardV1']) {
      assert.ok(!tools.includes(banned), `the private tools reach ${banned}`);
    }
    // And the qualification it does reach is the shared one.
    assert.match(tools, /runOpportunitySimulationV1/);
  });

  test('the check tool states whether a clearance exists rather than implying it', async () => {
    b20RouteRuntime.repository = () =>
      ({
        recentSnapshots: async () => [],
      }) as never;
    const client = await connectedClient();
    const result = await client.callTool({
      name: 'miorail_check_exit_profile',
      arguments: { tokenAddress: TOKEN, positionAtomic: POSITION },
    });
    assert.equal((result as ToolResult).isError, true);
    assert.match(errorTextOf(result), /b20_controls_unread/);
    await client.close();
  });
});

describe('§5/§11 — the returned calls are the persisted calls', () => {
  test('every byte matches the stored plan, and the hash covers them', async () => {
    const plan = await storePlan();
    const client = await connectedClient();
    const payload = payloadOf(await openAction(client));

    assert.equal(payload.outcome, 'ready');
    const action = payload.action as { calls: { to: string; value: string; data: string }[]; from: string; chainId: string };
    assert.equal(action.from, plan.walletAddress);
    assert.equal(action.chainId, '0x2105');
    assert.equal(action.calls.length, plan.calls.length);
    action.calls.forEach((call, index) => {
      assert.equal(call.to, plan.calls[index].to);
      assert.equal(call.data, plan.calls[index].data);
    });
    assert.equal(payload.callsHash, plan.callsHash);
    // Recomputed from the bytes, so the two agree without trusting either.
    assert.equal(payload.callsHashOfReturnedCalls, entryPlanCallsHashV1(plan.calls));
    await client.close();
  });

  test('a plan whose stored calls were edited is refused rather than offered', async () => {
    const plan = await storePlan();
    // A row edited in the database — the same class of failure as a tampered
    // request, and caught by the same recomputation.
    const tampered: B20PreparedEntryPlanV1 = {
      ...plan,
      calls: [plan.calls[plan.calls.length - 1], ...plan.calls.slice(0, -1)],
    };
    b20RouteRuntime.entryPlans = () =>
      ({
        ...plans,
        getPreparedPlan: async () => tampered,
        findByIdempotency: async () => null,
      }) as never;
    const client = await connectedClient();
    const payload = payloadOf(await openAction(client));
    assert.equal(payload.outcome, 'refused');
    assert.equal(payload.reason, 'entry_plan_calls_tampered');
    assert.equal(payload.action, null);
    await client.close();
  });

  test('an expired plan yields no action', async () => {
    const plan = await storePlan();
    clock = new Date(Date.parse(plan.expiresAt) + 1000);
    const client = await connectedClient();
    const payload = payloadOf(await openAction(client));
    assert.equal(payload.outcome, 'refused');
    assert.equal(payload.reason, 'entry_plan_expired');
    assert.equal(payload.action, null);
    await client.close();
  });

  test('the execution gate is separate from the surface gate', async () => {
    await storePlan();
    process.env.MIORAIL_MCP_PRIVATE_EXECUTION_V1 = 'false';
    const client = await connectedClient();
    const result = await openAction(client);
    assert.equal((result as ToolResult).isError, true);
    assert.match(errorTextOf(result), /mcp_execution_disabled/);
    await client.close();
  });
});

describe('§7/§11 — one plan, one submission', () => {
  test('a duplicate request returns the same attempt rather than opening a second', async () => {
    await storePlan();
    const client = await connectedClient();
    const first = payloadOf(await openAction(client));
    const second = payloadOf(await openAction(client));
    assert.equal(first.outcome, 'ready');
    assert.equal(second.outcome, 'ready');
    assert.equal(first.attemptId, second.attemptId);
    await client.close();
  });

  test('a wallet rejection records no submission and leaves nothing on chain', async () => {
    const plan = await storePlan();
    const client = await connectedClient();
    const action = payloadOf(await openAction(client));

    const recorded = payloadOf(
      await client.callTool({
        name: 'miorail_record_base_mcp_submission',
        arguments: {
          planId: plan.id,
          attemptId: action.attemptId,
          submittedCallsHash: plan.callsHash,
          result: 'user_rejected',
        },
      }),
    );
    const status = recorded.status as { state: string; batchId: string | null };
    assert.equal(status.state, 'user_rejected');
    assert.equal(status.batchId, null);
    await client.close();
  });

  test('an unknown result with no batch id records nothing and locks the plan', async () => {
    const plan = await storePlan();
    const client = await connectedClient();
    const action = payloadOf(await openAction(client));

    const recorded = payloadOf(
      await client.callTool({
        name: 'miorail_record_base_mcp_submission',
        arguments: {
          planId: plan.id,
          attemptId: action.attemptId,
          submittedCallsHash: plan.callsHash,
          result: 'unknown',
        },
      }),
    );
    assert.equal(recorded.outcome, 'not_recorded');
    assert.equal(recorded.reason, 'unknown_without_batch_id');

    // And it is never resent: the attempt still holds the plan's one slot, so
    // asking again returns THAT attempt, not a new one.
    const again = payloadOf(await openAction(client));
    assert.equal(again.attemptId, action.attemptId);
    await client.close();
  });

  test('a submitted batch cannot be followed by a second one', async () => {
    const plan = await storePlan();
    const client = await connectedClient();
    const action = payloadOf(await openAction(client));
    await client.callTool({
      name: 'miorail_record_base_mcp_submission',
      arguments: {
        planId: plan.id,
        attemptId: action.attemptId,
        submittedCallsHash: plan.callsHash,
        result: 'submitted',
        batchId: 'base-mcp-batch-1',
      },
    });

    const second = payloadOf(await openAction(client));
    assert.equal(second.outcome, 'refused');
    assert.equal(second.reason, 'entry_plan_already_submitted');
    await client.close();
  });

  test('a reported hash that is not the plan’s hash records nothing', async () => {
    const plan = await storePlan();
    const client = await connectedClient();
    const action = payloadOf(await openAction(client));

    const result = await client.callTool({
      name: 'miorail_record_base_mcp_submission',
      arguments: {
        planId: plan.id,
        attemptId: action.attemptId,
        submittedCallsHash: `0x${'9'.repeat(64)}`,
        result: 'submitted',
        batchId: 'base-mcp-batch-2',
      },
    });
    assert.equal((result as ToolResult).isError, true);
    assert.match(errorTextOf(result), /submitted_calls_mismatch/);

    // Nothing was written, so the attempt is still waiting.
    const status = payloadOf(
      await client.callTool({ name: 'miorail_get_execution_status', arguments: { planId: plan.id } }),
    );
    assert.equal((status.status as { state: string }).state, 'awaiting_wallet_approval');
    await client.close();
  });

  test('recording the same batch twice is idempotent', async () => {
    const plan = await storePlan();
    const client = await connectedClient();
    const action = payloadOf(await openAction(client));
    const args = {
      planId: plan.id,
      attemptId: action.attemptId,
      submittedCallsHash: plan.callsHash,
      result: 'submitted' as const,
      batchId: 'base-mcp-batch-3',
    };
    const first = payloadOf(await client.callTool({ name: 'miorail_record_base_mcp_submission', arguments: args }));
    const second = payloadOf(await client.callTool({ name: 'miorail_record_base_mcp_submission', arguments: args }));
    assert.deepEqual(second.status, first.status);
    await client.close();
  });
});

describe('§8/§11 — the status is the reconciliation, not the caller’s hope', () => {
  test('a refresh recovers the existing attempt', async () => {
    const plan = await storePlan();
    const client = await connectedClient();
    const action = payloadOf(await openAction(client));
    await client.callTool({
      name: 'miorail_record_base_mcp_submission',
      arguments: {
        planId: plan.id,
        attemptId: action.attemptId,
        submittedCallsHash: plan.callsHash,
        result: 'submitted',
        batchId: 'base-mcp-batch-4',
      },
    });

    const status = payloadOf(
      await client.callTool({ name: 'miorail_get_execution_status', arguments: { planId: plan.id } }),
    );
    const view = status.status as { state: string; attemptId: string; batchId: string };
    assert.equal(view.state, 'submitted');
    assert.equal(view.attemptId, action.attemptId);
    assert.equal(view.batchId, 'base-mcp-batch-4');
    await client.close();
  });

  test('a confirmed batch without the expected receipt is not success', async () => {
    const plan = await storePlan();
    const client = await connectedClient();
    const action = payloadOf(await openAction(client));
    await client.callTool({
      name: 'miorail_record_base_mcp_submission',
      arguments: {
        planId: plan.id,
        attemptId: action.attemptId,
        submittedCallsHash: plan.callsHash,
        result: 'submitted',
        batchId: 'base-mcp-batch-5',
      },
    });
    // What reconciliation concluded — the projection is read, never recomputed.
    const attempt = await submissions.latestForPlan({ planId: plan.id, tenantId: IDENTITY.tenantId });
    await submissions.updateAttempt({
      attemptId: attempt!.id,
      tenantId: IDENTITY.tenantId,
      status: 'terminal',
      terminalOutcome: 'reconciliation_required',
      errorCode: 'entry_receipt_missing',
      now: clock,
    });

    const status = payloadOf(
      await client.callTool({ name: 'miorail_get_execution_status', arguments: { planId: plan.id } }),
    );
    assert.equal((status.status as { state: string }).state, 'reconciliation_required');
    assert.match(String(status.stateMeaning), /confirmed approval is not an entry/i);
    await client.close();
  });

  test('a successful entry reports what was actually spent and received', async () => {
    const plan = await storePlan();
    const client = await connectedClient();
    const action = payloadOf(await openAction(client));
    await client.callTool({
      name: 'miorail_record_base_mcp_submission',
      arguments: {
        planId: plan.id,
        attemptId: action.attemptId,
        submittedCallsHash: plan.callsHash,
        result: 'submitted',
        batchId: 'base-mcp-batch-6',
      },
    });
    const attempt = await submissions.latestForPlan({ planId: plan.id, tenantId: IDENTITY.tenantId });
    await submissions.updateAttempt({
      attemptId: attempt!.id,
      tenantId: IDENTITY.tenantId,
      status: 'terminal',
      terminalOutcome: 'entry_succeeded',
      reconciliation: {
        spentAtomic: POSITION,
        receivedAtomic: '4190000000000000000000',
        confirmedBlockNumber: '49450090',
        transactionHashes: [`0x${'7'.repeat(64)}`],
        evidenceHash: `0x${'8'.repeat(64)}`,
      },
      now: clock,
    });

    const status = payloadOf(
      await client.callTool({ name: 'miorail_get_execution_status', arguments: { planId: plan.id } }),
    );
    const view = status.status as { state: string; actualSpentAtomic: string; actualReceivedAtomic: string };
    assert.equal(view.state, 'entry_succeeded');
    assert.equal(view.actualSpentAtomic, POSITION);
    assert.equal(view.actualReceivedAtomic, '4190000000000000000000');
    await client.close();
  });

  test('every named outcome carries a sentence', async () => {
    const { EXECUTION_STATE_COPY_V1 } = await import('./tools.js');
    for (const state of [
      'awaiting_wallet_approval',
      'submitted',
      'reconciling',
      'entry_succeeded',
      'entry_reverted',
      'submitted_unknown',
      'reconciliation_required',
      'user_rejected',
    ]) {
      assert.ok(EXECUTION_STATE_COPY_V1[state], `${state} has no explanation`);
    }
    // The one an assistant is most likely to misreport.
    assert.match(EXECUTION_STATE_COPY_V1.submitted_unknown, /NOT a failure and NOT a success/);
  });
});

describe('§6/§10 — what this surface cannot do, and cannot leak', () => {
  const sources = readdirSync(here)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .map((name) => ({ name, text: readFileSync(path.join(here, name), 'utf8') }));

  test('the source scan actually found the files it claims to check', () => {
    // Without this a wrong `here` makes every assertion below pass vacuously.
    assert.deepEqual(sources.map((entry) => entry.name).sort(), [
      'audit.ts',
      'index.ts',
      'server.ts',
      'session.ts',
      'tools.ts',
    ]);
  });

  test('no signer or private-key path exists on this surface', () => {
    for (const { name, text } of sources) {
      const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
      for (const banned of [
        'privateKey',
        'PRIVATE_KEY',
        'signTransaction',
        'signMessage',
        'eth_sendRawTransaction',
        'sendRawTransaction',
        'Wallet(',
        'x402',
      ]) {
        assert.ok(!code.includes(banned), `${name} reaches ${banned}`);
      }
    }
  });

  test('the tools build no calldata of their own', () => {
    const tools = sources.find((entry) => entry.name === 'tools.ts')!.text;
    for (const banned of ['encodeFunctionData', 'buildEntryBlueprintV1', 'entryWalletPayloadV1(']) {
      assert.ok(!tools.includes(banned), `the private tools reach ${banned}`);
    }
    // Every executable byte comes from the shared facade.
    assert.match(tools, /beginEntrySubmissionV1/);
  });

  test('a storage failure names no endpoint, credential or connection string', async () => {
    b20RouteRuntime.entryPlans = () => {
      throw new Error('connect ECONNREFUSED postgres://user:hunter2@10.0.0.4:5432/mio');
    };
    const client = await connectedClient();
    const result = await client.callTool({
      name: 'miorail_get_execution_status',
      arguments: { planId: 'plan-1' },
    });
    const text = JSON.stringify(result);
    assert.equal((result as ToolResult).isError, true);
    for (const secret of ['hunter2', '10.0.0.4', 'postgres://', 'ECONNREFUSED']) {
      assert.ok(!text.includes(secret), `the error leaked ${secret}`);
    }
    await client.close();
  });

  test('a successful payload carries no URL or credential', async () => {
    await storePlan();
    const client = await connectedClient();
    const text = JSON.stringify(payloadOf(await openAction(client)));
    assert.ok(!/https?:\/\//.test(text), 'a payload returned a URL');
    assert.ok(!/apiKey|api_key|secret|password|Bearer /i.test(text), 'a payload returned a credential');
    await client.close();
  });

  test('§12 — generic Swap stays closed to arbitrary tokens', async () => {
    // Nothing here accepts a router, a recipient, calldata or an arbitrary
    // pair. The only executable family this surface can reach is the B20 entry
    // one, and the gate refuses anything else.
    const client = await connectedClient();
    const names = new Set((await client.listTools()).tools.map((tool) => tool.name));
    for (const forbidden of ['miorail_swap', 'miorail_execute_trade', 'miorail_send_calls']) {
      assert.ok(!names.has(forbidden), `${forbidden} exists`);
    }
    for (const tool of (await client.listTools()).tools) {
      const properties = Object.keys(
        (tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {},
      );
      for (const property of properties) {
        assert.ok(
          !/calldata|data|router|recipient|deadline|minimumOutput|to$/i.test(property),
          `${tool.name} accepts ${property}`,
        );
      }
    }
    await client.close();
  });

  test('the shared gate pins the execution family', () => {
    const gate = readFileSync(path.join(here, '..', '..', 'lib', 'b20EntrySubmitGate.ts'), 'utf8');
    assert.match(gate, /B20_ENTRY_EXECUTION_FAMILY_V1/);
    assert.match(gate, /entry_plan_wrong_family/);
  });
});
