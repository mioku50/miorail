import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { deriveBlueprintLifecycleV1 } from '../src/lifecycle.js';

const RECEIPT = { transactionHash: `0x${'ab'.repeat(32)}`, status: 'success', blockNumber: null, gasUsed: null } as const;

test('lifecycle: blueprint status passes through before approval', () => {
  for (const status of ['draft', 'ready_for_review', 'expired', 'invalid'] as const) {
    assert.equal(deriveBlueprintLifecycleV1({ blueprint: { status }, proof: null, events: [] }), status);
  }
});

test('lifecycle: approved without a proof or submission stays approved', () => {
  assert.equal(
    deriveBlueprintLifecycleV1({ blueprint: { status: 'approved' }, proof: null, events: [] }),
    'approved',
  );
  assert.equal(
    deriveBlueprintLifecycleV1({
      blueprint: { status: 'approved' },
      proof: { finalStatus: 'pending', receipts: [] },
      events: [{ eventType: 'calls_approved', payload: {} }],
    }),
    'approved',
  );
});

test('lifecycle: submitted, submitted_unknown, confirmed, failed, cancelled derive from proof and events', () => {
  const approved = { status: 'approved' } as const;
  assert.equal(
    deriveBlueprintLifecycleV1({
      blueprint: approved,
      proof: { finalStatus: 'pending', receipts: [] },
      events: [
        { eventType: 'calls_approved', payload: {} },
        { eventType: 'submitted', payload: { batchId: 'batch-1', status: 'submitted' } },
      ],
    }),
    'submitted',
  );
  assert.equal(
    deriveBlueprintLifecycleV1({
      blueprint: approved,
      proof: { finalStatus: 'pending', receipts: [] },
      events: [{ eventType: 'submitted', payload: { batchId: 'batch-1', status: 'submitted_unknown' } }],
    }),
    'submitted_unknown',
  );
  assert.equal(
    deriveBlueprintLifecycleV1({
      blueprint: approved,
      proof: { finalStatus: 'pending', receipts: [RECEIPT] },
      events: [{ eventType: 'submitted', payload: { batchId: 'batch-1', status: 'submitted' } }],
    }),
    'confirmed',
  );
  assert.equal(
    deriveBlueprintLifecycleV1({
      blueprint: approved,
      proof: { finalStatus: 'failed', receipts: [] },
      events: [],
    }),
    'failed',
  );
  assert.equal(
    deriveBlueprintLifecycleV1({
      blueprint: approved,
      proof: { finalStatus: 'cancelled', receipts: [] },
      events: [],
    }),
    'cancelled',
  );
});

test('lifecycle: a reverted receipt reads as failed, an unknown-only receipt never as confirmed', () => {
  const approved = { status: 'approved' } as const;
  const reverted = { transactionHash: `0x${'cd'.repeat(32)}`, status: 'reverted', blockNumber: null, gasUsed: null } as const;
  const unknown = { transactionHash: `0x${'ef'.repeat(32)}`, status: 'unknown', blockNumber: null, gasUsed: null } as const;

  assert.equal(
    deriveBlueprintLifecycleV1({
      blueprint: approved,
      proof: { finalStatus: 'pending', receipts: [reverted] },
      events: [{ eventType: 'submitted', payload: { batchId: 'batch-1', status: 'submitted' } }],
    }),
    'failed',
  );
  // An unknown-only receipt is not evidence of success — falls back to the
  // submitted-event state rather than confirmed.
  assert.equal(
    deriveBlueprintLifecycleV1({
      blueprint: approved,
      proof: { finalStatus: 'pending', receipts: [unknown] },
      events: [{ eventType: 'submitted', payload: { batchId: 'batch-1', status: 'submitted' } }],
    }),
    'submitted',
  );
  // Success wins even when a sibling receipt reverted (partial batches are a
  // T58 concern; here any success is confirmation of the atomic batch).
  assert.equal(
    deriveBlueprintLifecycleV1({
      blueprint: approved,
      proof: { finalStatus: 'pending', receipts: [reverted, { ...unknown, status: 'success' }] },
      events: [],
    }),
    'confirmed',
  );
});

test('T57 composer sources never reference Base MCP send_calls, x402, or Action Inbox', () => {
  const here = path.dirname(url.fileURLToPath(import.meta.url));
  const forbidden = /send_calls|wallet_sendcalls|x402|actioninbox/i;
  for (const file of ['approval.ts', 'submission.ts', 'lifecycle.ts']) {
    const content = readFileSync(path.join(here, '..', 'src', file), 'utf8');
    assert.equal(forbidden.test(content), false, `${file} must not reference forbidden execution surfaces`);
  }
});
