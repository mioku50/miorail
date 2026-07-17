import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { baseExplorerTxUrl, SubmissionStatus, type SubmissionStatusState } from '../src/SubmissionStatus';

const here = path.dirname(url.fileURLToPath(import.meta.url));

test('baseExplorerTxUrl accepts only lowercase 32-byte hex hashes', () => {
  const hash = `0x${'ab'.repeat(32)}`;
  assert.equal(baseExplorerTxUrl(hash), `https://basescan.org/tx/${hash}`);
  assert.equal(baseExplorerTxUrl(hash.toUpperCase()), null);
  assert.equal(baseExplorerTxUrl('0x1234'), null);
  assert.equal(baseExplorerTxUrl(''), null);
  assert.equal(baseExplorerTxUrl(`0x${'zz'.repeat(32)}`), null);
  assert.equal(baseExplorerTxUrl(`0x${'ab'.repeat(33)}`), null);
});

test('SubmissionStatus covers every submission state with honest copy', () => {
  const states: SubmissionStatusState[] = [
    'idle', 'approving', 'submitting', 'submitted', 'confirmed',
    'submitted_unknown', 'failed', 'cancelled', 'blocked', 'expired',
  ];
  for (const state of states) {
    const element = SubmissionStatus({ state });
    assert.ok(element, `SubmissionStatus must render for state ${state}`);
    const serialized = JSON.stringify(element);
    assert.ok(serialized.includes(`"data-submission-state":"${state}"`), `state marker missing for ${state}`);
  }
});

test('SubmissionStatus links a valid transaction hash to the explorer and leaves invalid hashes as text', () => {
  const valid = `0x${'ab'.repeat(32)}`;
  const rendered = JSON.stringify(
    SubmissionStatus({ state: 'confirmed', batchId: 'batch-1', transactionHashes: [valid, '0xdead'] }),
  );
  assert.ok(rendered.includes(`https://basescan.org/tx/${valid}`));
  assert.ok(rendered.includes('batch-1'));
  assert.ok(rendered.includes('0xdead'));
  assert.ok(!rendered.includes('https://basescan.org/tx/0xdead'));
});

test('the submission slot renders only under a prepared review', () => {
  const source = readFileSync(path.join(here, '..', 'src', 'RoutePlan.tsx'), 'utf8');
  assert.ok(
    /transactionReview\.outcome === 'prepared' && transactionSubmission/.test(source),
    'the transactionSubmission slot must be gated on a prepared review outcome',
  );
});

test('SubmissionStatus source stays wagmi-free and never references forbidden surfaces', () => {
  const source = readFileSync(path.join(here, '..', 'src', 'SubmissionStatus.tsx'), 'utf8');
  assert.equal(/from 'wagmi'|from "wagmi"/.test(source), false);
  assert.equal(/send_calls|wallet_sendcalls|x402|actioninbox/i.test(source), false);
});
