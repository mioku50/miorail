import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { WALLET_HANDOFF_UNRESOLVED_V1, walletConfirmOutcomeV1 } from './useWalletConfirmAction';

const here = path.dirname(fileURLToPath(import.meta.url));

// Audit WAL-7 (2026-11-10): the Action Inbox called any error with "close", "cancel", "reject" or
// "denied" in its words a cancellation, and the server then recorded a transfer that may have gone
// as cancelled.
test('what a failed wallet request proves is read from its code, never from its words', () => {
  // The wallet's own code for the person's No, at any depth.
  assert.equal(walletConfirmOutcomeV1(Object.assign(new Error('User rejected the request.'), { code: 4001 })), 'cancelled');
  assert.equal(walletConfirmOutcomeV1({ name: 'UserRejectedRequestError' }), 'cancelled');
  assert.equal(walletConfirmOutcomeV1({ message: 'x', cause: { cause: { code: 4001 } } }), 'cancelled');
  // A refusal that shows nothing was sent: the wallet cannot do it, or it was never asked.
  assert.equal(walletConfirmOutcomeV1(Object.assign(new Error('x'), { code: 4200 })), 'not_sent');
  assert.equal(walletConfirmOutcomeV1(Object.assign(new Error('x'), { name: 'WalletConnectionNotReadyError' })), 'not_sent');
  assert.equal(walletConfirmOutcomeV1(Object.assign(new Error('x'), { name: 'WalletAccountChangedError', expected: `0x${'1'.repeat(40)}` })), 'not_sent');
  assert.equal(walletConfirmOutcomeV1(Object.assign(new Error('Account "0x00" not found'), { name: 'ConnectorAccountNotFoundError' })), 'not_sent');
  // Words alone prove nothing: each of these used to be a cancellation.
  for (const words of ['WebSocket connection closed', 'Request cancelled by relay', 'request rejected: rate limit', 'Access denied by provider', 'wallet response lost', 'timeout']) {
    assert.equal(walletConfirmOutcomeV1(new Error(words)), 'unknown', words);
  }
  assert.equal(walletConfirmOutcomeV1('boom'), 'unknown');
  assert.equal(walletConfirmOutcomeV1(null), 'unknown');
});

test('the confirm flow records nothing before the handoff, reports the unknown as unknown, and asks again only on the person’s word', () => {
  // Structural: the hook drives wagmi, which these tests do not mount.
  const hook = readFileSync(path.join(here, 'useWalletConfirmAction.ts'), 'utf8');
  // The live-account check comes before the server is asked to hand anything over.
  assert.ok(hook.indexOf('await requireLiveWalletAccountV1(config, address);') < hook.indexOf('await prepareAction.mutateAsync('));
  // A failure before the handoff is reported to nobody.
  assert.match(hook, /if \(!handed\) \{\s*setStatus\('failed'\);\s*setError\(walletSubmissionFailureMessageV1\(e\)\);\s*return;\s*\}/);
  // After it: 4001 for the person's No, 500 for a refusal that sent nothing, 0 for an answer that proves nothing.
  assert.match(hook, /status: isCancelled \? 4001 : outcome === 'not_sent' \? 500 : 0,/);
  assert.doesNotMatch(hook, /includes\('close'\)|includes\('cancel'\)|includes\('denied'\)/);
  // `again` leaves the page only from the button that says nothing was sent.
  assert.match(hook, /\.\.\.\(options\.again === true \? \{ again: true \} : \{\}\)/);
  assert.match(hook, /setHandedBefore\(\(prepared as \{ code\?: unknown \}\)\.code === WALLET_HANDOFF_UNRESOLVED_V1\)/);
  assert.equal(WALLET_HANDOFF_UNRESOLVED_V1, 'wallet_handoff_unresolved');
  const button = readFileSync(path.join(here, 'WalletConfirmButton.tsx'), 'utf8');
  assert.equal(button.match(/confirm\(\{ again: true \}\)/g)?.length, 1);
  assert.match(button, /\{handedBefore && !busy \? \(/);
  assert.match(button, /I checked: nothing was sent\. Ask my wallet again/);
  // The plain press never carries it.
  assert.match(button, /onClick=\{\(\) => \{\s*void confirm\(\);\s*\}\}/);
});
