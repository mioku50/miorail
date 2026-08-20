import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import type { BaseMcpSkillExecutor } from '@mioagent/runtime-skills';
import { InMemoryBaseMcpPluginSessionStoreV1 } from './baseMcpPluginSessionStore.js';
import {
  reviewedBaseMcpPluginRuntimeV1,
  runReviewedBaseMcpPluginReadV1,
} from './baseMcpReviewedPluginRuntime.js';

const originalRuntime = { ...reviewedBaseMcpPluginRuntimeV1 };

afterEach(() => Object.assign(reviewedBaseMcpPluginRuntimeV1, originalRuntime));

function executor(calls: string[]): BaseMcpSkillExecutor {
  return {
    namespace: 'moonwell',
    manifest: {
      integration: 'http-api',
      chains: [8453],
      allowlist: { hosts: ['api.moonwell.fi'], methods: ['GET'], pathPrefixes: ['/v1/markets', '/v1/positions', '/v1/health'] },
      auth: 'none',
      risk: ['liquidation'],
    },
    allowedPaths: ['/v1/markets', '/v1/positions', '/v1/health'],
    async request(input) {
      calls.push(input.path);
      if (input.path.startsWith('/v1/markets')) {
        return { status: 200, data: { markets: [{ symbol: 'USDC', supplyApy: '4.2%' }] } };
      }
      if (input.path.startsWith('/v1/health')) return { status: 200, data: { healthFactor: '1.8' } };
      return { status: 200, data: { positions: [] } };
    },
  };
}

test('Moonwell market example runs the pinned reviewed recipe without an LLM', async () => {
  const calls: string[] = [];
  reviewedBaseMcpPluginRuntimeV1.loadSkillExecutor = () => executor(calls);
  reviewedBaseMcpPluginRuntimeV1.now = () => new Date('2026-08-20T20:00:00.000Z');

  const result = await runReviewedBaseMcpPluginReadV1({
    providerId: 'moonwell',
    exampleId: 'markets',
    message: 'Show Moonwell USDC supply markets on Base',
    walletAddress: '0x1111111111111111111111111111111111111111',
  });

  assert.ok(result);
  assert.equal(result.status, 'answered');
  assert.deepEqual(calls, ['/v1/markets/USDC?chain=base']);
  assert.equal(result.trace[0]?.tool, 'moonwell_get_markets');
  assert.equal(result.trace[0]?.ok, true);
  assert.match(result.reply ?? '', /USDC supply markets/);
  assert.match(result.reply ?? '', /4\.2%/);
});

test('Moonwell renders the live single-market data envelope', async () => {
  const calls: string[] = [];
  const liveEnvelopeExecutor = executor(calls);
  liveEnvelopeExecutor.request = async (input) => {
    calls.push(input.path);
    return {
      status: 200,
      data: {
        success: true,
        data: {
          asset: 'USDC',
          baseSupplyApy: 3.72,
          baseBorrowApy: 5.06,
          liquidityUsd: 2_750_163,
        },
      },
    };
  };
  reviewedBaseMcpPluginRuntimeV1.loadSkillExecutor = () => liveEnvelopeExecutor;

  const result = await runReviewedBaseMcpPluginReadV1({
    providerId: 'moonwell',
    exampleId: 'markets',
    message: 'Show Moonwell USDC supply markets on Base',
    walletAddress: '0x1111111111111111111111111111111111111111',
  });

  assert.equal(result?.status, 'answered');
  assert.match(result?.reply ?? '', /USDC/);
  assert.match(result?.reply ?? '', /supply 3\.72/);
  assert.match(result?.reply ?? '', /liquidity 2750163/);
});

test('Moonwell account recipe reads positions and health from the same reviewed host', async () => {
  const calls: string[] = [];
  reviewedBaseMcpPluginRuntimeV1.loadSkillExecutor = () => executor(calls);
  const wallet = '0x1111111111111111111111111111111111111111';
  const result = await runReviewedBaseMcpPluginReadV1({
    providerId: 'moonwell',
    exampleId: 'health',
    message: 'Check my Moonwell positions and health factor',
    walletAddress: wallet,
  });
  assert.ok(result);
  assert.equal(result.status, 'answered');
  assert.deepEqual(calls, [
    `/v1/positions/${wallet}?chain=base&active=true`,
    `/v1/health/${wallet}?chain=base`,
  ]);
  assert.deepEqual(result.trace.map((entry) => entry.tool), ['moonwell_get_positions', 'moonwell_get_health']);
});

test('a provider with no released reviewed recipe falls through to the read-only console', async () => {
  assert.equal(await runReviewedBaseMcpPluginReadV1({
    providerId: 'bankr',
    exampleId: 'portfolio',
    message: 'Show Bankr portfolio',
    walletAddress: '0x1111111111111111111111111111111111111111',
  }), null);
});

test('Virtuals agent list uses the encrypted authenticated session and never exposes its token', async () => {
  const sessions = new InMemoryBaseMcpPluginSessionStoreV1();
  reviewedBaseMcpPluginRuntimeV1.sessions = sessions;
  await sessions.save({
    userId: 'tenant-1',
    sessionSecret: 'session-secret',
    session: {
      stage: 'authenticated',
      walletAddress: '0x1111111111111111111111111111111111111111',
      token: 'jwt-secret',
      refreshToken: 'refresh-secret',
      expiresAt: '2099-08-20T23:00:00.000Z',
    },
  });
  reviewedBaseMcpPluginRuntimeV1.callVirtuals = async (input) => {
    assert.equal(input.method, 'agent_list');
    assert.equal(input.args.token, 'jwt-secret');
    return { ok: true, data: { agents: [{ id: 'agent-1', name: 'Mio Researcher', token: 'provider-leak' }] } };
  };

  const result = await runReviewedBaseMcpPluginReadV1({
    providerId: 'virtuals',
    exampleId: 'agents',
    message: 'List my Virtuals agents',
    walletAddress: '0x1111111111111111111111111111111111111111',
    userId: 'tenant-1',
    sessionSecret: 'session-secret',
  });

  assert.equal(result?.status, 'answered');
  assert.match(result?.reply ?? '', /Mio Researcher/);
  assert.doesNotMatch(JSON.stringify(result), /jwt-secret|refresh-secret|provider-leak/);
  assert.match(JSON.stringify(result), /\[redacted\]/);
});

test('Virtuals list without a reviewed sign-in explains the boundary and makes no provider call', async () => {
  reviewedBaseMcpPluginRuntimeV1.sessions = new InMemoryBaseMcpPluginSessionStoreV1();
  let called = false;
  reviewedBaseMcpPluginRuntimeV1.callVirtuals = async () => {
    called = true;
    return { ok: false, errorCode: 'unexpected' };
  };
  const result = await runReviewedBaseMcpPluginReadV1({
    providerId: 'virtuals',
    exampleId: 'agents',
    message: 'List my Virtuals agents',
    walletAddress: '0x1111111111111111111111111111111111111111',
    userId: 'tenant-1',
    sessionSecret: 'session-secret',
  });
  assert.equal(result?.status, 'answered');
  assert.match(result?.reply ?? '', /Approve Sign-In/);
  assert.equal(called, false);
});
