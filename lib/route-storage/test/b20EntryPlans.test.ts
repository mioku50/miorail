import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  B20PreparedEntryPlanV1Schema,
  B20EntryExecutionRunV1Schema,
  B20_ENTRY_EXECUTION_FAMILY_V1,
  B20_ENTRY_LIFECYCLE_V1,
  InMemoryB20EntryPlanRepositoryV1,
  RouteStorageConflictError,
  b20EntryReviewV1,
  entryPlanCallsHashV1,
  entryPlanIdempotencyKeyV1,
  entryPlanTransitionRefusalV1,
  type B20PreparedEntryPlanV1,
} from '../src/index.js';

// ---------------------------------------------------------------------------
// T68F-A — the prepared entry plan as a stored execution subject.
//
// The plan is what a wallet will one day be asked to sign. Everything here is
// about the gap between "the server built something sound" and "the thing that
// gets signed is that same something": immutability, idempotency, and a
// lifecycle that cannot reach `submitted` by accident.
// ---------------------------------------------------------------------------

const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const ROUTER = '0xcf77a3ba9a5ca399b7c97c74d54e5b1beb874e43';
const TOKEN = '0xb200000000000000000000578f3ae29d9e6e0101';
const WALLET = '0x1111111111111111111111111111111111111111';
const OTHER_WALLET = '0x2222222222222222222222222222222222222222';
const TENANT = `eip155:8453:${WALLET}`;
const NOW = new Date('2026-08-03T12:00:00.000Z');
const DEADLINE = String(Math.floor(NOW.getTime() / 1000) + 300);

function calls(withApproval = true) {
  const list = [
    {
      index: 0,
      callType: 'approval' as const,
      to: USDC,
      data: '0x095ea7b3',
      valueWei: '0' as const,
      amountAtomic: '100000000',
      recipient: null,
      spender: ROUTER,
    },
    {
      index: 1,
      callType: 'swap' as const,
      to: ROUTER,
      data: '0x38ed1739',
      valueWei: '0' as const,
      amountAtomic: '100000000',
      recipient: WALLET,
      spender: null,
    },
  ];
  return (withApproval ? list : list.slice(1)).map((call, index) => ({ ...call, index }));
}

function plan(overrides: Record<string, unknown> = {}): B20PreparedEntryPlanV1 {
  const draft = {
    schemaVersion: 'b20-prepared-entry-plan/v1',
    executionFamily: B20_ENTRY_EXECUTION_FAMILY_V1,
    id: 'plan-1',
    tenantId: TENANT,
    walletAddress: WALLET,
    chainId: 8453,
    clearanceId: 'clearance-1',
    clearanceHash: `0x${'c'.repeat(64)}`,
    profileIdentity: `${USDC}:100000000:300:300`,
    tokenAddress: TOKEN,
    tokenName: 'Example',
    tokenSymbol: 'EXA',
    quoteAsset: USDC,
    positionAtomic: '100000000',
    entryProviderId: 'aerodrome',
    entrySourceKey: `aerodrome:${'0x' + 'f'.repeat(40)}:${USDC}:${TOKEN}:volatile`,
    entryRouteHash: `0x${'b'.repeat(64)}`,
    blueprintHash: `0x${'d'.repeat(64)}`,
    callsHash: entryPlanCallsHashV1(calls()),
    freshQuoteHash: `0x${'9'.repeat(64)}`,
    certificationControlSnapshotHash: `0x${'a'.repeat(64)}`,
    prepareControlSnapshotHash: `0x${'a'.repeat(64)}`,
    certificationSimulationEvidenceHash: `0x${'e'.repeat(64)}`,
    prepareSimulationEvidenceHash: `0x${'2'.repeat(64)}`,
    expectedOutputAtomic: '4200000000000000000000',
    minimumOutputAtomic: '4074000000000000000000',
    deadlineSeconds: DEADLINE,
    coverage: 'partial',
    viableRouteConfirmed: true,
    bestRouteConfirmed: false,
    certificationRoundTripBps: 100,
    certificationBlockNumber: '49450000',
    prepareControlBlockNumber: '49450050',
    prepareSimulationBlockNumber: '49450051',
    clearanceCreatedAt: NOW.toISOString(),
    clearanceExpiresAt: new Date(NOW.getTime() + 600_000).toISOString(),
    calls: calls(),
    lifecycle: 'prepared',
    submissionId: null,
    requestId: 'req-1',
    createdAt: NOW.toISOString(),
    expiresAt: new Date(Number(DEADLINE) * 1000).toISOString(),
    ...overrides,
  };
  return B20PreparedEntryPlanV1Schema.parse(draft);
}

function run(overrides: Record<string, unknown> = {}) {
  return B20EntryExecutionRunV1Schema.parse({
    schemaVersion: 'b20-entry-execution-run/v1',
    id: 'run-1',
    tenantId: TENANT,
    walletAddress: WALLET,
    chainId: 8453,
    executionFamily: B20_ENTRY_EXECUTION_FAMILY_V1,
    preparedPlanId: 'plan-1',
    clearanceId: 'clearance-1',
    state: 'prepared',
    submissionId: null,
    createdAt: NOW.toISOString(),
    ...overrides,
  });
}

const refuses = (overrides: Record<string, unknown>): void => {
  assert.throws(() => plan(overrides));
};

describe('a plan is bound to one wallet, one clearance and one route', () => {
  test('the execution family is the discriminator, and it is fixed', () => {
    assert.equal(plan().executionFamily, 'b20_opportunity_entry');
    refuses({ executionFamily: 'swap' });
    refuses({ executionFamily: 'b20_opportunity_exit' });
  });

  test('only Base mainnet and only canonical USDC', () => {
    refuses({ chainId: 84532 });
    refuses({ quoteAsset: TOKEN });
  });

  test('a plan cannot promise less than it requires', () => {
    refuses({ minimumOutputAtomic: '9999999999999999999999' });
    // Equal is fine: zero slippage is a legal profile, not a malformed plan.
    assert.ok(plan({ minimumOutputAtomic: '4200000000000000000000' }));
  });

  test('a plan cannot outlive the swap deadline in its own calls', () => {
    // Past that second the calls revert on chain. A Review screen still
    // offering them would be lying to the person about to sign.
    refuses({ expiresAt: new Date((Number(DEADLINE) + 60) * 1000).toISOString() });
  });

  test('a plan built on an unconfirmed exit does not exist', () => {
    refuses({ viableRouteConfirmed: false });
  });
});

describe('the stored calls are the calls that were checked', () => {
  test('the swap must target the pinned Router and pay the authenticated wallet', () => {
    refuses({ calls: calls().map((c) => (c.callType === 'swap' ? { ...c, to: OTHER_WALLET } : c)) });
    refuses({
      calls: calls().map((c) => (c.callType === 'swap' ? { ...c, recipient: OTHER_WALLET } : c)),
    });
  });

  test('the approval is exact, never open-ended', () => {
    // The one line that stops this family ever asking for unlimited spend.
    refuses({
      calls: calls().map((c) =>
        c.callType === 'approval' ? { ...c, amountAtomic: '999999999999999' } : c,
      ),
    });
    refuses({
      calls: calls().map((c) => (c.callType === 'approval' ? { ...c, spender: OTHER_WALLET } : c)),
    });
  });

  test('a reordered or padded batch is a different transaction, and is refused', () => {
    refuses({ calls: [calls()[1]!, calls()[0]!] });
    refuses({ calls: [...calls(), { ...calls()[1]!, index: 2 }] });
    refuses({ calls: [] });
  });

  test('native value is never sent on this path', () => {
    refuses({ calls: calls().map((c) => ({ ...c, valueWei: '1' })) });
  });

  test('a plan with only the swap is valid — a standing allowance covered it', () => {
    const single = plan({ calls: calls(false), callsHash: entryPlanCallsHashV1(calls(false)) });
    assert.equal(single.calls.length, 1);
    assert.equal(b20EntryReviewV1(single).approval.required, false);
  });
});

describe('nothing reaches submitted by accident', () => {
  test('every declared lifecycle state exists, and only prepared is produced here', () => {
    assert.deepEqual([...B20_ENTRY_LIFECYCLE_V1], [
      'prepared',
      'awaiting_wallet_approval',
      'submitted',
      'terminal',
    ]);
    assert.equal(plan().lifecycle, 'prepared');
    assert.equal(plan().submissionId, null);
  });

  test('a submitted plan must name the submission it claims', () => {
    refuses({ lifecycle: 'submitted', submissionId: null });
    refuses({ lifecycle: 'prepared', submissionId: 'sub-1' });
    assert.ok(plan({ lifecycle: 'submitted', submissionId: 'sub-1' }));
  });

  test('prepared cannot jump straight to submitted', () => {
    // It must pass through an explicit approval state, and name a submission.
    assert.ok(
      entryPlanTransitionRefusalV1({ from: 'prepared', to: 'submitted', submissionId: 'sub-1' }),
    );
    assert.ok(
      entryPlanTransitionRefusalV1({
        from: 'awaiting_wallet_approval',
        to: 'submitted',
        submissionId: null,
      }),
    );
    assert.equal(
      entryPlanTransitionRefusalV1({
        from: 'awaiting_wallet_approval',
        to: 'submitted',
        submissionId: 'sub-1',
      }),
      null,
    );
  });

  test('a terminal plan is terminal', () => {
    assert.ok(entryPlanTransitionRefusalV1({ from: 'terminal', to: 'submitted', submissionId: 's' }));
    assert.ok(
      entryPlanTransitionRefusalV1({ from: 'submitted', to: 'prepared', submissionId: null }),
    );
  });

  test('the run record starts prepared and carries no submission handle', () => {
    assert.equal(run().state, 'prepared');
    assert.equal(run().submissionId, null);
    assert.throws(() => run({ state: 'submitted', submissionId: null }));
    assert.throws(() => run({ state: 'prepared', submissionId: 'sub-1' }));
    // And it names the relationship the later machinery keys on.
    assert.equal(run().executionFamily, 'b20_opportunity_entry');
    assert.equal(run().preparedPlanId, 'plan-1');
    assert.equal(run().clearanceId, 'clearance-1');
  });
});

describe('the in-memory repository behaves exactly as Postgres must', () => {
  const repo = () => new InMemoryB20EntryPlanRepositoryV1();

  test('a preparation stores one plan and one run', async () => {
    const store = repo();
    const stored = await store.insertPreparedPlan({ plan: plan(), run: run() });
    assert.equal(stored.plan.id, 'plan-1');
    assert.equal(stored.run.preparedPlanId, 'plan-1');
    assert.equal((await store.getExecutionRun({ planId: 'plan-1', tenantId: TENANT }))?.state, 'prepared');
  });

  test('an identical retry returns the same plan, not a second one', async () => {
    const store = repo();
    const first = await store.insertPreparedPlan({ plan: plan(), run: run() });
    const second = await store.insertPreparedPlan({
      plan: plan({ id: 'plan-2' }),
      run: run({ id: 'run-2', preparedPlanId: 'plan-2' }),
    });
    assert.equal(second.plan.id, first.plan.id);
    assert.equal(second.plan.blueprintHash, first.plan.blueprintHash);
  });

  test('the same identity with different content conflicts, and the original survives', async () => {
    const store = repo();
    await store.insertPreparedPlan({ plan: plan(), run: run() });
    await assert.rejects(
      store.insertPreparedPlan({
        plan: plan({ id: 'plan-2', blueprintHash: `0x${'7'.repeat(64)}` }),
        run: run({ id: 'run-2', preparedPlanId: 'plan-2' }),
      }),
      RouteStorageConflictError,
    );
    const survivor = await store.getPreparedPlan({
      planId: 'plan-1',
      tenantId: TENANT,
      walletAddress: WALLET,
    });
    assert.equal(survivor?.blueprintHash, `0x${'d'.repeat(64)}`);
  });

  test('a different request id is a different plan', async () => {
    const store = repo();
    await store.insertPreparedPlan({ plan: plan(), run: run() });
    const second = await store.insertPreparedPlan({
      plan: plan({ id: 'plan-2', requestId: 'req-2' }),
      run: run({ id: 'run-2', preparedPlanId: 'plan-2' }),
    });
    assert.equal(second.plan.id, 'plan-2');
  });

  test('another wallet gets exactly what a nonexistent plan gets', async () => {
    const store = repo();
    await store.insertPreparedPlan({ plan: plan(), run: run() });
    assert.equal(
      await store.getPreparedPlan({
        planId: 'plan-1',
        tenantId: `eip155:8453:${OTHER_WALLET}`,
        walletAddress: OTHER_WALLET,
      }),
      null,
    );
    // Same tenant string, wrong wallet — still nothing.
    assert.equal(
      await store.getPreparedPlan({ planId: 'plan-1', tenantId: TENANT, walletAddress: OTHER_WALLET }),
      null,
    );
    assert.equal(
      await store.getPreparedPlan({ planId: 'nope', tenantId: TENANT, walletAddress: WALLET }),
      null,
    );
  });

  test('only a prepared plan may be written', async () => {
    // A lifecycle move is a separate, explicit transition — never a side
    // effect of writing a row.
    await assert.rejects(
      repo().insertPreparedPlan({
        plan: plan({ lifecycle: 'submitted', submissionId: 'sub-1' }),
        run: run(),
      }),
      RouteStorageConflictError,
    );
  });

  test('a run that names another plan, wallet or clearance is refused', async () => {
    await assert.rejects(
      repo().insertPreparedPlan({ plan: plan(), run: run({ preparedPlanId: 'other' }) }),
      RouteStorageConflictError,
    );
    await assert.rejects(
      repo().insertPreparedPlan({ plan: plan(), run: run({ clearanceId: 'other' }) }),
      RouteStorageConflictError,
    );
    await assert.rejects(
      repo().insertPreparedPlan({
        plan: plan(),
        run: run({ walletAddress: OTHER_WALLET }),
      }),
      RouteStorageConflictError,
    );
  });

  test('calls that do not match the stored hash are refused', async () => {
    // The hash is what a later reader uses to prove the stored bytes are the
    // simulated ones. A row where they disagree must never exist.
    await assert.rejects(
      repo().insertPreparedPlan({
        plan: plan({ callsHash: `0x${'0'.repeat(64)}` }),
        run: run(),
      }),
      RouteStorageConflictError,
    );
  });

  test('the idempotency identity is exactly tenant + wallet + clearance + request', () => {
    const base = {
      tenantId: TENANT,
      walletAddress: WALLET,
      clearanceId: 'clearance-1',
      requestId: 'req-1',
    };
    assert.equal(
      entryPlanIdempotencyKeyV1(base),
      entryPlanIdempotencyKeyV1({ ...base, walletAddress: WALLET.toUpperCase() }),
      'wallet case must not split an identity',
    );
    for (const field of ['tenantId', 'walletAddress', 'clearanceId', 'requestId'] as const) {
      assert.notEqual(
        entryPlanIdempotencyKeyV1(base),
        entryPlanIdempotencyKeyV1({ ...base, [field]: 'different' }),
        `${field} must be part of the identity`,
      );
    }
  });
});

describe('the Review projection shows facts, never bytes', () => {
  test('it carries no calldata, no credential and no endpoint', () => {
    const body = JSON.stringify(b20EntryReviewV1(plan()));
    for (const forbidden of [
      '0x095ea7b3',
      '0x38ed1739',
      'calldata',
      '"data"',
      '"calls"',
      'http',
      'apiKey',
      'authorization',
      'session',
      'rpc',
    ]) {
      assert.ok(!body.toLowerCase().includes(forbidden.toLowerCase()), `must not expose ${forbidden}`);
    }
  });

  test('it says the exit was simulated and will not be executed', () => {
    const review = b20EntryReviewV1(plan());
    assert.match(review.exitNotice, /entry will be executed/i);
    assert.match(review.exitNotice, /exit was simulated and will not be executed/i);
  });

  test('it never offers execution, and says why', () => {
    const review = b20EntryReviewV1(plan());
    assert.equal(review.executionAvailable, false);
    assert.equal(review.executionUnavailableReason, 'submission_not_wired');
  });

  test('it names the provider and the exact approval the user is about to grant', () => {
    const review = b20EntryReviewV1(plan());
    assert.equal(review.provider.providerName, 'Aerodrome');
    assert.deepEqual(review.approval, { required: true, amountAtomic: '100000000' });
    assert.equal(review.spend.amountAtomic, '100000000');
  });

  test('a partial sweep says viable but not best, rather than implying best', () => {
    const review = b20EntryReviewV1(plan());
    assert.equal(review.coverage, 'partial');
    assert.equal(review.viableRouteConfirmed, true);
    assert.equal(review.bestRouteConfirmed, false);
    // All three blocks the evidence came from, so a reader can date it.
    assert.equal(review.certificationBlockNumber, '49450000');
    assert.equal(review.prepareControlBlockNumber, '49450050');
    assert.equal(review.prepareSimulationBlockNumber, '49450051');
  });
});

describe('migration 0026 enforces the invariants rather than trusting the code', () => {
  const migration = () =>
    readFile(resolve(process.cwd(), '../db/drizzle/0026_t68fa_b20_entry_plans.sql'), 'utf8');

  test('it is additive — no other execution family changes shape', async () => {
    const sql = await migration();
    assert.ok(!/DROP TABLE|DELETE FROM|DROP COLUMN|ALTER TABLE|ALTER COLUMN/i.test(sql));
  });

  test('the idempotency identity is a unique index, not an application promise', async () => {
    const sql = await migration();
    assert.match(
      sql,
      /CREATE UNIQUE INDEX "b20_entry_plan_idempotency_unique"\s+ON "b20_entry_plans" \("tenant_id", "wallet_address", "clearance_id", "request_id"\)/,
    );
  });

  test('the lifecycle CHECK matches the contract exactly', async () => {
    const sql = await migration();
    const match = /b20_entry_plan_lifecycle_check"\s+CHECK \("lifecycle" IN \(([\s\S]*?)\)\)/.exec(sql);
    assert.ok(match, 'the lifecycle CHECK must be present');
    const allowed = match[1]!
      .split(',')
      .map((value) => value.trim().replace(/'/g, ''))
      .filter(Boolean);
    assert.deepEqual([...allowed].sort(), [...B20_ENTRY_LIFECYCLE_V1].sort());
  });

  test('the database refuses a submitted row with no submission id', async () => {
    const sql = await migration();
    assert.match(
      sql,
      /CHECK \(\("lifecycle" = 'submitted'\) = \("submission_id" IS NOT NULL\)\)/,
    );
    assert.match(sql, /CHECK \(\("state" = 'submitted'\) = \("submission_id" IS NOT NULL\)\)/);
  });

  test('the database pins the chain, the quote asset and a confirmed exit', async () => {
    const sql = await migration();
    assert.match(sql, /CHECK \("chain_id" = 8453\)/);
    assert.match(sql, /CHECK \("quote_asset" = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'\)/);
    assert.match(sql, /CHECK \("viable_route_confirmed" = true\)/);
    assert.match(sql, /CHECK \("position_atomic" > 0\)/);
    assert.match(sql, /"minimum_output_atomic" <= "expected_output_atomic"/);
    assert.match(sql, /CHECK \("expires_at" > "created_at"\)/);
  });

  test('one execution family, named by the database', async () => {
    const sql = await migration();
    assert.match(sql, /CHECK \("execution_family" = 'b20_opportunity_entry'\)/);
    assert.match(
      sql,
      /CREATE UNIQUE INDEX "b20_entry_execution_plan_unique"\s+ON "b20_entry_executions" \("prepared_plan_id"\)/,
    );
  });

  test('no column exists that could hold a credential or a raw transaction', async () => {
    // Comments are stripped first: the migration's prose says which of these it
    // deliberately refuses to store, and that sentence is not a column.
    const sql = (await migration())
      .split('\n')
      .filter((line) => !line.trim().startsWith('--'))
      .join('\n');
    for (const forbidden of [
      'private_key',
      'api_key',
      'rpc_url',
      'authorization',
      'signature',
      'raw_transaction',
      'provider_response',
      'session_id',
    ]) {
      assert.ok(!sql.includes(forbidden), `0026 must not have a ${forbidden} column`);
    }
  });
});
