import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  B20EntrySubmissionAttemptV1Schema,
  B20_ENTRY_ATTEMPT_STATUS_V1,
  B20_ENTRY_TERMINAL_OUTCOME_V1,
  InMemoryB20EntrySubmissionRepositoryV1,
  RouteStorageConflictError,
  attemptBlocksRetryV1,
  attemptTransitionRefusalV1,
  entryCanRefreshV1,
  entryCanSubmitV1,
  entryExecutionAvailableV1,
  entryUiStateV1,
  B20_ENTRY_UI_STATE_V1,
  type B20EntrySubmissionAttemptV1,
} from '../src/index.js';

// ---------------------------------------------------------------------------
// T68F-B — one wallet batch per plan, and never a generic failure.
//
// Two properties carry this file. The first is that a double click, a remount
// and a retried fetch all reach ONE attempt: the alternative costs real money.
// The second is that "the user declined" and "the chain reverted" stay distinct
// all the way down to the database, because a product that collapses them will
// eventually tell somebody their trade failed when they simply changed their
// mind.
// ---------------------------------------------------------------------------

const WALLET = '0x1111111111111111111111111111111111111111';
const TENANT = `eip155:8453:${WALLET}`;
const NOW = new Date('2026-08-03T12:00:00.000Z');

function attempt(overrides: Record<string, unknown> = {}): B20EntrySubmissionAttemptV1 {
  return B20EntrySubmissionAttemptV1Schema.parse({
    schemaVersion: 'b20-entry-submission/v1',
    id: 'attempt-1',
    tenantId: TENANT,
    walletAddress: WALLET,
    chainId: 8453,
    planId: 'plan-1',
    clearanceId: 'clearance-1',
    submittedCallsHash: `0x${'8'.repeat(64)}`,
    batchId: null,
    status: 'awaiting_wallet_approval',
    terminalOutcome: null,
    errorCode: null,
    submittedAt: null,
    reconciliation: null,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    ...overrides,
  });
}

const RECONCILED = {
  spentAtomic: '100000000',
  receivedAtomic: '4200000000000000000000',
  confirmedBlockNumber: '49450100',
  transactionHashes: [`0x${'1'.repeat(64)}`],
  evidenceHash: `0x${'7'.repeat(64)}`,
};

const submitted = (overrides: Record<string, unknown> = {}) =>
  attempt({ status: 'submitted', batchId: 'batch-1', submittedAt: NOW.toISOString(), ...overrides });

describe('an outcome must match whether anything was actually sent', () => {
  test('a terminal attempt names its outcome, and only a terminal one may', () => {
    assert.throws(() => attempt({ status: 'terminal', terminalOutcome: null }));
    assert.throws(() => attempt({ terminalOutcome: 'entry_succeeded' }));
  });

  test('a state that presupposes a batch cannot exist without its id', () => {
    // Without a batch id there is nothing to ask a status provider about.
    assert.throws(() => attempt({ status: 'submitted' }));
    assert.throws(() => attempt({ status: 'reconciling' }));
    assert.throws(() => attempt({ batchId: 'batch-1' }), /submission time/i);
  });

  test('a declined prompt cannot describe an attempt that reached the chain', () => {
    assert.throws(() =>
      submitted({ status: 'terminal', terminalOutcome: 'user_rejected' }),
    );
    assert.throws(() =>
      submitted({ status: 'terminal', terminalOutcome: 'cancelled_before_submission' }),
    );
  });

  test('a claim about a batch cannot exist without one', () => {
    for (const outcome of ['entry_succeeded', 'entry_reverted', 'submitted_unknown']) {
      assert.throws(
        () => attempt({ status: 'terminal', terminalOutcome: outcome, reconciliation: RECONCILED }),
        `${outcome} needs a batch id`,
      );
    }
  });

  test('asset evidence belongs only to a successful entry', () => {
    assert.throws(() =>
      submitted({
        status: 'terminal',
        terminalOutcome: 'entry_reverted',
        reconciliation: RECONCILED,
      }),
    );
    // And a success must say what actually arrived.
    assert.throws(() => submitted({ status: 'terminal', terminalOutcome: 'entry_succeeded' }));
    assert.ok(
      submitted({
        status: 'terminal',
        terminalOutcome: 'entry_succeeded',
        reconciliation: RECONCILED,
      }),
    );
  });

  test('there is no generic failure to fall back on', () => {
    assert.throws(() => submitted({ status: 'terminal', terminalOutcome: 'failed' }));
    assert.deepEqual([...B20_ENTRY_TERMINAL_OUTCOME_V1], [
      'entry_succeeded',
      'entry_reverted',
      'submitted_unknown',
      'reconciliation_required',
      'user_rejected',
      'cancelled_before_submission',
    ]);
  });
});

describe('transitions fail closed and terminal is final', () => {
  const move = (
    from: B20EntrySubmissionAttemptV1,
    to: (typeof B20_ENTRY_ATTEMPT_STATUS_V1)[number],
    terminalOutcome: (typeof B20_ENTRY_TERMINAL_OUTCOME_V1)[number] | null = null,
    batchId: string | null = null,
  ) => attemptTransitionRefusalV1({ from, to, terminalOutcome, batchId });

  test('a terminal attempt never reopens', () => {
    const done = submitted({
      status: 'terminal',
      terminalOutcome: 'entry_succeeded',
      reconciliation: RECONCILED,
    });
    assert.ok(move(done, 'submitted', null, 'batch-2'));
    assert.ok(move(done, 'reconciling'));
    assert.ok(move(done, 'terminal', 'entry_reverted'));
  });

  test('a submission must name the batch it created', () => {
    assert.ok(move(attempt(), 'submitted'));
    assert.equal(move(attempt(), 'submitted', null, 'batch-1'), null);
  });

  test('a known batch id is never replaced', () => {
    // Replacing it would silently repoint the record at another transaction.
    assert.ok(move(submitted(), 'reconciling', null, 'batch-2'));
    assert.equal(move(submitted(), 'reconciling', null, 'batch-1'), null);
  });

  test('a rejection cannot be recorded once the wallet returned a batch', () => {
    assert.ok(move(submitted(), 'terminal', 'user_rejected'));
    assert.equal(move(attempt(), 'terminal', 'user_rejected'), null);
  });

  test('an awaiting attempt cannot skip to reconciling', () => {
    assert.ok(move(attempt(), 'reconciling'));
  });
});

describe('one live attempt per plan', () => {
  const repo = () => new InMemoryB20EntrySubmissionRepositoryV1();

  test('a repeated create for the same attempt returns it, and creates nothing', async () => {
    const store = repo();
    const first = await store.createAttempt(attempt());
    const second = await store.createAttempt(attempt());
    assert.equal(second.id, first.id);
  });

  test('a second attempt while one is live is refused', async () => {
    // The failure this whole file exists to prevent: two wallet batches.
    const store = repo();
    await store.createAttempt(attempt());
    await assert.rejects(store.createAttempt(attempt({ id: 'attempt-2' })), RouteStorageConflictError);
  });

  test('a submitted plan cannot be submitted again, ever', async () => {
    const store = repo();
    await store.createAttempt(attempt());
    await store.updateAttempt({
      attemptId: 'attempt-1',
      tenantId: TENANT,
      status: 'submitted',
      batchId: 'batch-1',
      now: NOW,
    });
    await assert.rejects(store.createAttempt(attempt({ id: 'attempt-2' })), RouteStorageConflictError);
  });

  test('a declined prompt sent nothing, so the user may try again', async () => {
    const store = repo();
    await store.createAttempt(attempt());
    await store.updateAttempt({
      attemptId: 'attempt-1',
      tenantId: TENANT,
      status: 'terminal',
      terminalOutcome: 'user_rejected',
      now: NOW,
    });
    const retry = await store.createAttempt(
      attempt({ id: 'attempt-2', createdAt: new Date(NOW.getTime() + 1000).toISOString() }),
    );
    assert.equal(retry.id, 'attempt-2');
  });

  test('an unresolved result blocks retry — a batch may be in flight', async () => {
    const store = repo();
    await store.createAttempt(attempt());
    await store.updateAttempt({
      attemptId: 'attempt-1',
      tenantId: TENANT,
      status: 'submitted',
      batchId: 'batch-1',
      now: NOW,
    });
    const unresolved = await store.updateAttempt({
      attemptId: 'attempt-1',
      tenantId: TENANT,
      status: 'terminal',
      terminalOutcome: 'submitted_unknown',
      now: NOW,
    });
    assert.ok(attemptBlocksRetryV1(unresolved!));
    await assert.rejects(store.createAttempt(attempt({ id: 'attempt-3' })), RouteStorageConflictError);
  });

  test('another wallet cannot read the attempt', async () => {
    const store = repo();
    await store.createAttempt(attempt());
    assert.equal(
      await store.getAttempt({
        attemptId: 'attempt-1',
        tenantId: TENANT,
        walletAddress: '0x2222222222222222222222222222222222222222',
      }),
      null,
    );
  });

  test('a submission time appears with the batch id, not before', async () => {
    const store = repo();
    await store.createAttempt(attempt());
    const after = await store.updateAttempt({
      attemptId: 'attempt-1',
      tenantId: TENANT,
      status: 'submitted',
      batchId: 'batch-1',
      now: NOW,
    });
    assert.equal(after?.submittedAt, NOW.toISOString());
    assert.equal(after?.batchId, 'batch-1');
  });
});

describe('one state, computed on the server, shared by both surfaces', () => {
  const plan = (overrides: Record<string, unknown> = {}) =>
    ({
      lifecycle: 'prepared',
      expiresAt: new Date(NOW.getTime() + 300_000).toISOString(),
      ...overrides,
    }) as never;

  const state = (attemptRow: B20EntrySubmissionAttemptV1 | null, planOverrides = {}) =>
    entryUiStateV1({ plan: plan(planOverrides), attempt: attemptRow, now: NOW });

  test('a fresh plan with no attempt is at Review', () => {
    assert.equal(state(null), 'review');
    assert.equal(entryCanSubmitV1('review'), true);
  });

  test('the attempt wins over the plan, so a refresh never returns to Review', () => {
    assert.equal(state(submitted()), 'submitted');
    assert.equal(entryCanSubmitV1('submitted'), false, 'no second submit button');
    assert.equal(entryCanRefreshV1('submitted'), true);
  });

  test('every terminal outcome has its own state', () => {
    const cases: Array<[string, string]> = [
      ['entry_succeeded', 'entry_succeeded'],
      ['entry_reverted', 'entry_reverted'],
      ['submitted_unknown', 'submitted_unknown'],
      ['reconciliation_required', 'reconciliation_required'],
    ];
    for (const [outcome, expected] of cases) {
      const row = submitted({
        status: 'terminal',
        terminalOutcome: outcome,
        reconciliation: outcome === 'entry_succeeded' ? RECONCILED : null,
      });
      assert.equal(state(row), expected);
    }
  });

  test('a user rejection is not a revert, and may return to Review', () => {
    const rejected = attempt({ status: 'terminal', terminalOutcome: 'user_rejected' });
    assert.equal(state(rejected), 'user_rejected');
    assert.notEqual(state(rejected), 'entry_reverted');
    assert.equal(entryCanSubmitV1('user_rejected'), true);
  });

  test('an unresolved submission offers a refresh and never a second Buy', () => {
    const unknown = submitted({ status: 'terminal', terminalOutcome: 'submitted_unknown' });
    assert.equal(state(unknown), 'submitted_unknown');
    assert.equal(entryCanSubmitV1('submitted_unknown'), false);
    assert.equal(entryCanRefreshV1('submitted_unknown'), true);
  });

  test('a terminal on-chain result offers neither', () => {
    for (const done of ['entry_succeeded', 'entry_reverted', 'reconciliation_required'] as const) {
      assert.equal(entryCanSubmitV1(done), false);
      assert.equal(entryCanRefreshV1(done), false);
    }
  });

  test('expiry is derived, and an expired plan is not submittable', () => {
    const expired = { expiresAt: new Date(NOW.getTime() - 1).toISOString() };
    assert.equal(state(null, expired), 'expired');
    assert.equal(entryCanSubmitV1('expired'), false);
    // But an expired plan that already went to chain still shows what happened.
    assert.equal(
      state(submitted({ status: 'terminal', terminalOutcome: 'entry_reverted' }), expired),
      'entry_reverted',
    );
  });

  test('every declared state is reachable by name', () => {
    assert.equal(B20_ENTRY_UI_STATE_V1.length, 11);
    for (const value of B20_ENTRY_UI_STATE_V1) assert.equal(typeof value, 'string');
  });
});

describe('execution availability is a fact about the surface', () => {
  test('every capability must be present', () => {
    assert.equal(
      entryExecutionAvailableV1({
        submissionRouteWired: true,
        walletIntegrationWired: true,
        reconciliationWired: true,
      }),
      true,
    );
    for (const missing of [
      'submissionRouteWired',
      'walletIntegrationWired',
      'reconciliationWired',
    ] as const) {
      assert.equal(
        entryExecutionAvailableV1({
          submissionRouteWired: true,
          walletIntegrationWired: true,
          reconciliationWired: true,
          [missing]: false,
        }),
        false,
        `${missing} must be required`,
      );
    }
  });

  test('no capabilities at all is never available', () => {
    // Never inferred from a plan holding unsigned calls.
    assert.equal(entryExecutionAvailableV1(null), false);
    assert.equal(entryExecutionAvailableV1(undefined), false);
  });
});

describe('migration 0027 enforces what the contract enforces', () => {
  const migration = () =>
    readFile(resolve(process.cwd(), '../db/drizzle/0027_t68fb_b20_entry_submissions.sql'), 'utf8');

  test('it is additive, and does not touch migration 0026', async () => {
    const sql = await migration();
    assert.ok(!/DROP TABLE|DELETE FROM|DROP COLUMN|ALTER TABLE|ALTER COLUMN|DROP CONSTRAINT/i.test(sql));
  });

  test('one live attempt per plan is a database guarantee', async () => {
    const sql = await migration();
    assert.match(
      sql,
      /CREATE UNIQUE INDEX "b20_entry_submission_live_unique"[\s\S]*?WHERE "terminal_outcome" IS NULL[\s\S]*?NOT IN \('user_rejected', 'cancelled_before_submission'\)/,
    );
  });

  test('one wallet batch belongs to exactly one attempt', async () => {
    const sql = await migration();
    assert.match(
      sql,
      /CREATE UNIQUE INDEX "b20_entry_submission_batch_unique"[\s\S]*?WHERE "batch_id" IS NOT NULL/,
    );
  });

  test('the status and outcome CHECKs match the contract exactly', async () => {
    const sql = await migration();
    const statuses = /b20_entry_submission_status_check" CHECK \("status" IN \(([\s\S]*?)\)\)/.exec(sql);
    assert.ok(statuses);
    assert.deepEqual(
      statuses[1]!.split(',').map((v) => v.trim().replace(/'/g, '')).filter(Boolean).sort(),
      [...B20_ENTRY_ATTEMPT_STATUS_V1].sort(),
    );
    const outcomes = /"terminal_outcome" IN \(([\s\S]*?)\)\s*\)/.exec(sql);
    assert.ok(outcomes);
    assert.deepEqual(
      outcomes[1]!.split(',').map((v) => v.trim().replace(/'/g, '')).filter(Boolean).sort(),
      [...B20_ENTRY_TERMINAL_OUTCOME_V1].sort(),
    );
  });

  test('the database refuses a state that presupposes a batch without one', async () => {
    const sql = await migration();
    assert.match(sql, /"status" NOT IN \('submitted', 'reconciling'\) OR "batch_id" IS NOT NULL/);
    assert.match(sql, /\("status" = 'terminal'\) = \("terminal_outcome" IS NOT NULL\)/);
  });

  test('no column exists that could hold a credential or a raw transaction', async () => {
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
      assert.ok(!sql.includes(forbidden), `0027 must not have a ${forbidden} column`);
    }
  });
});
