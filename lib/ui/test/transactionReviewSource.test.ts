import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const here = path.dirname(url.fileURLToPath(import.meta.url));
const source = readFileSync(path.join(here, '..', 'src', 'TransactionReview.tsx'), 'utf8');

test('TransactionReview never renders an active Confirm/Approve/Execute/Swap-now control', () => {
  // Button elements are fine (e.g. accordions); an execution-triggering
  // button is not. Look for <button> tags whose visible text or handler
  // suggests an execution action.
  const forbidden = /<button[^>]*>\s*(confirm|approve|execute|swap now|send)\b/i;
  assert.equal(forbidden.test(source), false);
  assert.equal(/onclick\s*=\s*\{[^}]*(confirm|approve|execute|sendcalls)/i.test(source), false);
});

test('TransactionReview source never references send_calls, x402, or Action Inbox', () => {
  const forbidden = /send_calls|wallet_sendcalls|x402|actioninbox/i;
  assert.equal(forbidden.test(source), false);
});

test('TransactionReview header text is present verbatim', () => {
  assert.ok(source.includes('Unsigned transaction review'));
});
