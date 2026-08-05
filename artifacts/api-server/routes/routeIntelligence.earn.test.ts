import assert from 'node:assert/strict';
import test, { afterEach, beforeEach, describe } from 'node:test';
import express from 'express';
import request from 'supertest';
import { resolveEarnIntentV1 } from '@mioagent/intent-engine';
import { compareEarnRoutesV1, createCuratedEarnDataSourceV1, PINNED_BASE_USDC_V1 } from '@mioagent/earn-engine';
import { earnCompareRouteRuntime, earnExecutionGateRuntime, routeIntelligenceRouter } from './routeIntelligence.js';

// Guard (T63A follow-up): the compare seam resolves LIVE Moonwell/Morpho
// readings in production, so any test that restores it must supply an offline
// data source. A detonator on the global fetch turns a regression here into a
// loud failure instead of a silent network call. supertest drives the router
// over a local http server, never through fetch.
globalThis.fetch = (() => {
  throw new Error('live network call attempted in a unit test');
}) as unknown as typeof fetch;

// A passing pinned-contract preflight fixture — the earn gate consults this, not
// a live RPC, so the whole suite stays offline.
const OK_PREFLIGHT = {
  ok: true as const,
  usdc: { address: PINNED_BASE_USDC_V1, codePresent: true },
  venues: [],
  failures: [] as string[],
};
const originalGate = { ...earnExecutionGateRuntime };

// ---------------------------------------------------------------------------
// T61: POST /api/route-intelligence/earn/compare. The route is gated on BOTH
// routeIntelligenceV1 and earnRouteV1, and — unlike the swap routes — has NO
// route-storage/migration dependency: the comparison is pure and offline
// through the injected curated data source. Every test stubs the seam (no live
// provider or DB calls); the happy-path fixtures are produced by running the
// real offline engine so the Earn Route Card round-trips through the response
// schema exactly as it will in production.
// ---------------------------------------------------------------------------

const WALLET = '0x1111111111111111111111111111111111111111';
const USER = { id: `eip155:8453:${WALLET}`, address: WALLET, chainId: 8453 as const };
const NOW = new Date('2026-07-21T12:00:00.000Z');
const originalRuntime = { ...earnCompareRouteRuntime };
const originalChainEnv = process.env.CHAIN_ENV;

const ENABLED_FLAGS = {
  routeIntelligenceV1: true,
  legacyTerminal: true,
  paidIntelligence: false,
  earnRouteV1: true, commerceRouteV1: false, commerceExecutionV1: false,
  nftRouteV1: false, nftExecutionV1: false, privateAiRouteV1: false, privateAiExecutionV1: false, aerodromeExecutionV1: false, b20ControlV1: false, submissionRecoveryV1: false, publicProofV1: false, mcpPrivateV1: false, mcpPrivateExecutionV1: false, routeOutcomeFeedbackV1: false,
} as const;

const BODY = { message: 'Deposit 500 USDC for yield.', walletAddress: WALLET, requestId: 'earn-req-1' };

function routeApp(user: typeof USER | null = USER) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (user) Object.defineProperty(req, 'session', { configurable: true, value: { user } });
    next();
  });
  app.use('/api/route-intelligence', routeIntelligenceRouter);
  return app;
}

function readyResolution() {
  const resolution = resolveEarnIntentV1({ message: BODY.message, tenantId: USER.id, walletAddress: WALLET, now: NOW });
  assert.equal(resolution.status, 'ready');
  return resolution;
}

function clarifyResolution() {
  const resolution = resolveEarnIntentV1({ message: 'Deposit USDC for yield.', tenantId: USER.id, walletAddress: WALLET, now: NOW });
  assert.equal(resolution.status, 'needs_clarification');
  return resolution;
}

function unsupportedResolution() {
  const resolution = resolveEarnIntentV1({ message: 'Swap 1 ETH to USDC.', tenantId: USER.id, walletAddress: WALLET, now: NOW });
  assert.equal(resolution.status, 'unsupported');
  return resolution;
}

async function comparisonFixture() {
  const resolution = readyResolution();
  if (resolution.status !== 'ready') throw new Error('fixture intent not ready');
  const comparison = await compareEarnRoutesV1(
    { dataSource: createCuratedEarnDataSourceV1() },
    { intent: resolution.intent, now: NOW },
  );
  assert.equal(comparison.ok, true);
  return comparison;
}

describe('POST /api/route-intelligence/earn/compare', () => {
  beforeEach(() => {
    earnCompareRouteRuntime.flags = () => ({ ...ENABLED_FLAGS });
    earnCompareRouteRuntime.now = () => NOW;
    earnCompareRouteRuntime.resolveIntent = () => readyResolution();
    earnCompareRouteRuntime.compare = async () => comparisonFixture();
    // T62/T62.1: the compare route now PERSISTS behind the earn gate. Stub the
    // storage + gate seams so the suite stays fully offline (no DB, no RPC) —
    // the persist stub echoes the freshly compared Route Card and a
    // deterministic routeRunId the client would prepare against.
    earnCompareRouteRuntime.persist = async ({ comparison }) => ({
      routeRunId: 'earn-run-t62-fixture',
      routeCard: comparison.routeCard,
    });
    earnExecutionGateRuntime.migrationAvailable = async () => true;
    earnExecutionGateRuntime.preflight = async () => OK_PREFLIGHT;
    process.env.CHAIN_ENV = 'mainnet-readonly';
  });

  afterEach(() => {
    Object.assign(earnCompareRouteRuntime, originalRuntime);
    Object.assign(earnExecutionGateRuntime, originalGate);
    if (originalChainEnv === undefined) delete process.env.CHAIN_ENV;
    else process.env.CHAIN_ENV = originalChainEnv;
  });

  test('is disabled (404) unless BOTH routeIntelligenceV1 and earnRouteV1 are on, without resolving or comparing', async () => {
    for (const flags of [
      { ...ENABLED_FLAGS, earnRouteV1: false, commerceRouteV1: false, commerceExecutionV1: false, nftRouteV1: false, nftExecutionV1: false, privateAiRouteV1: false, privateAiExecutionV1: false, aerodromeExecutionV1: false, b20ControlV1: false, submissionRecoveryV1: false, publicProofV1: false, mcpPrivateV1: false, mcpPrivateExecutionV1: false, routeOutcomeFeedbackV1: false, },
      { ...ENABLED_FLAGS, routeIntelligenceV1: false },
      { ...ENABLED_FLAGS, routeIntelligenceV1: false, earnRouteV1: false, commerceRouteV1: false, commerceExecutionV1: false, nftRouteV1: false, nftExecutionV1: false, privateAiRouteV1: false, privateAiExecutionV1: false, aerodromeExecutionV1: false, b20ControlV1: false, submissionRecoveryV1: false, publicProofV1: false, mcpPrivateV1: false, mcpPrivateExecutionV1: false, routeOutcomeFeedbackV1: false, },
    ]) {
      let touched = false;
      earnCompareRouteRuntime.flags = () => flags;
      earnCompareRouteRuntime.resolveIntent = () => {
        touched = true;
        throw new Error('must not run');
      };
      earnCompareRouteRuntime.compare = async () => {
        touched = true;
        throw new Error('must not run');
      };
      const response = await request(routeApp()).post('/api/route-intelligence/earn/compare').send(BODY);
      assert.equal(response.status, 404);
      assert.deepEqual(response.body, { error: 'earn_route_disabled', code: 'earn_route_disabled' });
      assert.equal(touched, false);
    }
  });

  test('requires a signed wallet session and exact wallet binding', async () => {
    assert.equal((await request(routeApp(null)).post('/api/route-intelligence/earn/compare').send(BODY)).status, 401);
    const mismatch = await request(routeApp()).post('/api/route-intelligence/earn/compare').send({
      ...BODY,
      walletAddress: '0x2222222222222222222222222222222222222222',
    });
    assert.equal(mismatch.status, 403);
    assert.equal(mismatch.body.code, 'wallet_mismatch');
  });

  test('strictly rejects extra request fields and a non-mainnet runtime context', async () => {
    const extra = await request(routeApp()).post('/api/route-intelligence/earn/compare').send({ ...BODY, score: 100 });
    assert.equal(extra.status, 400);
    assert.equal(extra.body.code, 'invalid_earn_compare_request');

    const emptyMessage = await request(routeApp()).post('/api/route-intelligence/earn/compare').send({ ...BODY, message: '' });
    assert.equal(emptyMessage.status, 400);

    delete process.env.CHAIN_ENV;
    assert.equal((await request(routeApp()).post('/api/route-intelligence/earn/compare').send(BODY)).status, 409);
    process.env.CHAIN_ENV = 'sepolia';
    const sepolia = await request(routeApp()).post('/api/route-intelligence/earn/compare').send(BODY);
    assert.equal(sepolia.status, 409);
    assert.equal(sepolia.body.code, 'base_mainnet_required');
  });

  test('returns a validated compared Earn Route Card with the persisted routeRunId, no calldata/payment artifacts', async () => {
    const response = await request(routeApp()).post('/api/route-intelligence/earn/compare').send(BODY);
    assert.equal(response.status, 200);
    assert.equal(response.body.outcome, 'compared');
    assert.equal(response.body.routeRunId, 'earn-run-t62-fixture');
    assert.equal(response.body.routeCard.optimizationMode, 'best_net_yield');
    assert.equal(response.body.routeCard.comparisons.length, 2);
    // best_net_yield ranks Morpho (net 7.10%) above Moonwell (net 5.80%) and can
    // recommend it — safety stays Not scored but net_yield/liquidity carry it.
    assert.notEqual(response.body.routeCard.recommendedCandidateHash, null);
    const serialized = JSON.stringify(response.body);
    assert.equal(/calldata|walletCalls|send_calls|x402|executionBlueprint/i.test(serialized), false);
  });

  test('a ready comparison fails closed with 503 when the earn storage migration is absent (never a card the client cannot prepare)', async () => {
    let persisted = false;
    earnExecutionGateRuntime.migrationAvailable = async () => false;
    earnCompareRouteRuntime.persist = async ({ comparison }) => {
      persisted = true;
      return { routeRunId: 'earn-run-t62-fixture', routeCard: comparison.routeCard };
    };
    const response = await request(routeApp()).post('/api/route-intelligence/earn/compare').send(BODY);
    assert.equal(response.status, 503);
    assert.deepEqual(response.body, { error: 'earn_storage_unavailable', code: 'earn_storage_unavailable' });
    assert.equal(persisted, false);
  });

  test('a ready comparison fails closed with 503 when the pinned-contract preflight has NOT passed (production gate)', async () => {
    let persisted = false;
    earnExecutionGateRuntime.preflight = async () => ({
      ok: false,
      usdc: { address: PINNED_BASE_USDC_V1, codePresent: false },
      venues: [],
      failures: ['moonwell_target_not_a_contract'],
    });
    earnCompareRouteRuntime.persist = async ({ comparison }) => {
      persisted = true;
      return { routeRunId: 'earn-run-t62-fixture', routeCard: comparison.routeCard };
    };
    const response = await request(routeApp()).post('/api/route-intelligence/earn/compare').send(BODY);
    assert.equal(response.status, 503);
    assert.deepEqual(response.body, { error: 'earn_gate_unavailable', code: 'earn_gate_unavailable' });
    assert.equal(persisted, false);
  });

  test('maps needs_clarification and unsupported resolutions to honest closed outcomes (no invented card)', async () => {
    let compared = 0;
    earnCompareRouteRuntime.compare = async () => {
      compared += 1;
      return comparisonFixture();
    };

    earnCompareRouteRuntime.resolveIntent = () => clarifyResolution();
    const clarify = await request(routeApp()).post('/api/route-intelligence/earn/compare').send({ ...BODY, message: 'Deposit USDC for yield.' });
    assert.equal(clarify.status, 200);
    assert.equal(clarify.body.outcome, 'needs_clarification');
    assert.ok(clarify.body.issues.includes('amount_required'));
    assert.equal('routeCard' in clarify.body, false);

    earnCompareRouteRuntime.resolveIntent = () => unsupportedResolution();
    const unsupported = await request(routeApp()).post('/api/route-intelligence/earn/compare').send({ ...BODY, message: 'Swap 1 ETH to USDC.' });
    assert.equal(unsupported.status, 200);
    assert.equal(unsupported.body.outcome, 'unsupported');
    assert.equal(typeof unsupported.body.reason, 'string');
    assert.equal('routeCard' in unsupported.body, false);

    // Neither non-ready resolution should ever reach the comparison engine.
    assert.equal(compared, 0);
  });

  test('a ready intent whose comparison yields no route is an honest unsupported, not a fabricated card', async () => {
    earnCompareRouteRuntime.compare = async () => ({ ok: false, reason: 'no_protocols_selected', failures: [] });
    const response = await request(routeApp()).post('/api/route-intelligence/earn/compare').send(BODY);
    assert.equal(response.status, 200);
    assert.equal(response.body.outcome, 'unsupported');
    assert.equal(response.body.reason, 'no_protocols_selected');
  });

  test('fails closed with an opaque 500 when the comparison throws, without leaking the error', async () => {
    earnCompareRouteRuntime.compare = async () => {
      throw new Error('curated source secret detail');
    };
    const response = await request(routeApp()).post('/api/route-intelligence/earn/compare').send(BODY);
    assert.equal(response.status, 500);
    assert.deepEqual(response.body, { error: 'earn_compare_failed', code: 'earn_compare_failed' });
    assert.equal(JSON.stringify(response.body).includes('secret detail'), false);
  });

  test('end-to-end through the REAL offline seam produces a schema-valid Earn Route Card', async () => {
    // Restore the real resolveEarnIntentV1 + compareEarnRoutesV1 to prove the
    // wiring. The DATA SOURCE stays the curated offline one on purpose: since
    // T63A the production seam resolves LIVE Moonwell/Morpho readings, and a
    // unit test must never open a socket. The live source's own wiring is
    // covered by lib/earnLiveData.test.ts with an injected fetch/RPC.
    earnCompareRouteRuntime.resolveIntent = originalRuntime.resolveIntent;
    earnCompareRouteRuntime.compare = (input) =>
      compareEarnRoutesV1({ dataSource: createCuratedEarnDataSourceV1() }, input);
    const response = await request(routeApp()).post('/api/route-intelligence/earn/compare').send(BODY);
    assert.equal(response.status, 200);
    assert.equal(response.body.outcome, 'compared');
    assert.equal(response.body.routeCard.comparisons.length, 2);
    const protocols = response.body.routeCard.comparisons
      .map((c: { candidate: { protocol: string } }) => c.candidate.protocol)
      .sort();
    assert.deepEqual(protocols, ['moonwell', 'morpho']);
  });
});
