import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import url from 'node:url';

import {
  ENTRY_ERROR_COPY_V1,
  ENTRY_STATE_COPY_V1,
  formatAtomicV1,
} from '../src/console/B20EntryReviewCard';

const here = path.dirname(url.fileURLToPath(import.meta.url));
const cardSource = readFileSync(
  path.join(here, '..', 'src', 'console', 'B20EntryReviewCard.tsx'),
  'utf8',
);

// ---------------------------------------------------------------------------
// T68F-B §5/§13 — what the Review screen may and may not say.
//
// The copy is the product here. A card that renders the right numbers under the
// wrong sentence is worse than one that renders nothing: it tells somebody a
// token is safe, or that their money is coming back.
// ---------------------------------------------------------------------------

describe('the Review screen states what was and was not measured', () => {
  test('every state a surface may render has copy', () => {
    for (const state of [
      'preparing',
      'review',
      'expired',
      'awaiting_wallet_approval',
      'user_rejected',
      'submitted',
      'reconciling',
      'entry_succeeded',
      'entry_reverted',
      'submitted_unknown',
      'reconciliation_required',
    ]) {
      const copy = ENTRY_STATE_COPY_V1[state];
      assert.ok(copy, `${state} has no copy, so it would render as an unlabelled card`);
      assert.ok(copy.detail.length > 30, `${state} needs a real sentence`);
    }
  });

  test('a revert is never described as a verdict on the token', () => {
    const reverted = ENTRY_STATE_COPY_V1.entry_reverted!.detail;
    assert.match(reverted, /not a verdict on the token/i);
    for (const forbidden of ['unsafe', 'scam', 'malicious', 'rug']) {
      assert.ok(!reverted.toLowerCase().includes(forbidden), `must not say "${forbidden}"`);
    }
  });

  test('a rejection says nothing was sent, and is not a failure', () => {
    const rejected = ENTRY_STATE_COPY_V1.user_rejected!.detail;
    assert.match(rejected, /nothing was sent/i);
    assert.ok(!/revert/i.test(rejected));
  });

  test('an unresolved status tells the user not to submit again', () => {
    const unknown = ENTRY_STATE_COPY_V1.submitted_unknown!.detail;
    assert.match(unknown, /refresh/i);
    assert.match(unknown, /do not submit again/i);
    assert.match(unknown, /still be in flight/i);
  });

  test('no state claims the token is safe or promises a future exit', () => {
    for (const [state, copy] of Object.entries(ENTRY_STATE_COPY_V1)) {
      const text = `${copy.title} ${copy.detail}`.toLowerCase();
      for (const forbidden of ['is safe', 'guaranteed', 'you can always sell', 'will be able to exit']) {
        assert.ok(!text.includes(forbidden), `${state} must not say "${forbidden}"`);
      }
    }
  });

  test('a success says the exit was simulated only', () => {
    assert.match(ENTRY_STATE_COPY_V1.entry_succeeded!.detail, /exit was simulated only/i);
  });

  test('every reconciliation refusal is explained in words', () => {
    for (const code of [
      'wrong_token_received',
      'another_recipient',
      'spend_above_profile',
      'output_below_minimum',
      'no_token_received',
      'status_provider_unavailable',
    ]) {
      assert.ok(ENTRY_ERROR_COPY_V1[code], `${code} would render as a bare code`);
    }
    // The one that matters most: an approval alone is not an entry.
    assert.match(ENTRY_ERROR_COPY_V1.no_token_received!, /approval on its own is not an entry/i);
  });
});

describe('the card renders the server’s decision and never its own', () => {
  test('the confirm control needs the server’s permission AND a handler', () => {
    // Three conditions, all necessary. Dropping any one of them is how a
    // second Buy button appears for an in-flight transaction.
    assert.match(
      cardSource,
      /const showConfirm =\s*status\.canSubmit && review\.executionAvailable && Boolean\(props\.onConfirm\)/,
    );
  });

  test('no control is rendered when no path is wired, rather than a disabled one', () => {
    // A greyed-out button is one refactor away from being enabled by accident,
    // and this is the button that spends money.
    assert.match(cardSource, /\{showConfirm && \(/);
    assert.ok(!/disabled=\{!showConfirm\}/.test(cardSource));
  });

  test('the card never recomputes whether it may submit', () => {
    for (const forbidden of ['canSubmitV1(', 'entryCanSubmitV1', 'lifecycle ===', 'Date.parse(review.expiresAt)']) {
      assert.ok(!cardSource.includes(forbidden), `the card must not re-derive with ${forbidden}`);
    }
  });

  test('the mandatory exit notice is rendered verbatim from the projection', () => {
    // Rendered, never retyped: the sentence is the server's and must not drift.
    assert.match(cardSource, /\{review\.exitNotice\}/);
    assert.ok(!cardSource.includes('will not be executed by this action'));
  });

  test('a partial sweep says best-route was not confirmed', () => {
    assert.match(cardSource, /!review\.bestRouteConfirmed && \(/);
    assert.match(cardSource, /a cheaper route may exist and was not measured/);
  });

  test('the card holds no calldata and builds nothing', () => {
    for (const forbidden of ['sendCalls', 'encodeFunctionData', '0x095ea7b3', 'calldata', 'payload.calls']) {
      assert.ok(!cardSource.includes(forbidden), `the card must not touch ${forbidden}`);
    }
  });
});

describe('amounts are formatted without BigInt literals', () => {
  test('the shared package stays below ES2020, because the miniapp does', () => {
    const consoleDir = path.join(here, '..', 'src', 'console');
    for (const name of readdirSync(consoleDir).filter((file) => file.endsWith('.tsx'))) {
      const source = readFileSync(path.join(consoleDir, name), 'utf8');
      assert.ok(!/\b\d+n\b/.test(source), `${name} uses a BigInt literal, which the miniapp cannot compile`);
    }
  });

  test('atomic amounts render as readable decimals', () => {
    assert.equal(formatAtomicV1('100000000', 6, 2), '100');
    assert.equal(formatAtomicV1('1234567', 6, 2), '1.23');
    assert.equal(formatAtomicV1('4200000000000000000000', 18), '4,200');
    assert.equal(formatAtomicV1('0', 18), '0');
    // Never invents precision it does not have.
    assert.equal(formatAtomicV1('not-a-number', 6), 'not-a-number');
  });
});

describe('the two surfaces share one projection', () => {
  const interfacePage = readFileSync(
    path.join(here, '..', '..', '..', 'artifacts', 'interface', 'src', 'features', 'b20', 'B20WatchPage.tsx'),
    'utf8',
  );

  test('the interface renders the shared card rather than its own', () => {
    assert.match(interfacePage, /B20EntryReviewCard/);
    assert.match(interfacePage, /from '@mioagent\/ui'/);
  });

  test('the interface never decides for itself whether it may submit', () => {
    // It passes the handler only when the server said so, and the card checks
    // `status.canSubmit` on top of that.
    assert.match(interfacePage, /onConfirm=\{entryReview\.executionAvailable \? confirmInWallet : undefined\}/);
  });

  test('the interface passes the server payload through untouched', () => {
    assert.match(interfacePage, /calls: begun\.payload\.calls as never/);
    for (const forbidden of ['encodeFunctionData', 'new Interface(', '0x095ea7b3', 'router:']) {
      assert.ok(!interfacePage.includes(forbidden), `must not build ${forbidden} in the browser`);
    }
  });

  test('a wallet rejection is reported as a rejection, never as a result', () => {
    assert.match(interfacePage, /isWalletRejectionError\(error\) \? 'user_rejected' : 'wallet_failed'/);
    // The client may never claim a transaction succeeded.
    assert.ok(!/result: 'entry_succeeded'/.test(interfacePage));
    assert.ok(!/result: 'confirmed'/.test(interfacePage));
  });

  test('a wallet that names no batch is recorded as failed, never as sent', () => {
    assert.match(interfacePage, /result: 'wallet_failed',\s*batchId: null,/);
  });
});
