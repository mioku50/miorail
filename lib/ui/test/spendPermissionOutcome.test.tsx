import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { BudgetPaymentsPanel } from '../src/console/BudgetPaymentsPanel';
import {
  SPEND_PERMISSION_ONBOARDING_STATES_V1,
  spendPermissionOutcomeViewV1,
  type SpendPermissionOnboardingStatusV1,
} from '../src/console/budgetPayments';

void React;

// ---------------------------------------------------------------------------
// T71.1 §7 — a confirmation that did not activate can never read as absence.
//
// The bug this locks down: a real wallet signed, the server refused the
// confirmation with `not_approved_onchain`, answered HTTP 200 because that is a
// typed outcome rather than an error, and the panel — which takes its status
// from the budget, and had no budget — printed "Not configured". The same words
// it shows someone who has never granted anything. The user reloaded the page
// and got the same sentence again, with no way to tell the two situations
// apart and no way forward except a second wallet prompt.
//
// So every one of these tests renders the panel and reads what a user would
// actually see.
// ---------------------------------------------------------------------------

/** The situation exactly: a signed permission, no budget, a server refusal. */
function panel(overrides: Record<string, unknown> = {}) {
  return renderToStaticMarkup(
    <BudgetPaymentsPanel
      featureEnabled
      settleReady
      budget={null}
      charges={[]}
      onEnablePaidEvidence={() => {}}
      {...overrides}
    />,
  );
}

const NOT_YET_DETAIL = 'Base has not confirmed this permission yet. Nothing has been charged.';

describe('T71.1 — the confirm outcome is what the panel says', () => {
  test('a retryable refusal does not render as "Not configured"', () => {
    const html = panel({
      onboardingStatus: 'verification_retryable' as SpendPermissionOnboardingStatusV1,
      onboardingDetail: NOT_YET_DETAIL,
      canRetryVerification: true,
      onRetryVerification: () => {},
    });
    assert.ok(!html.includes('Not configured'), 'the absence label must not survive an outcome');
    assert.ok(html.includes('Not confirmed yet'), 'the header names the outcome');
    assert.ok(html.includes(NOT_YET_DETAIL), 'the server’s own sentence is shown');
  });

  test('a permanent refusal does not render as "Not configured" either', () => {
    const html = panel({
      onboardingStatus: 'verification_failed' as SpendPermissionOnboardingStatusV1,
      onboardingDetail: 'That permission is for a different token, so Miorail did not accept it.',
    });
    assert.ok(!html.includes('Not configured'));
    assert.ok(html.includes('Verification failed'));
    assert.ok(html.includes('different token'));
  });

  test('no outcome carries no sentence of its own — the server detail is always rendered', () => {
    for (const status of SPEND_PERMISSION_ONBOARDING_STATES_V1) {
      const view = spendPermissionOutcomeViewV1(status);
      if (!view) continue;
      const detail = `server said something about ${status}`;
      const html = panel({ onboardingStatus: status, onboardingDetail: detail });
      assert.ok(html.includes(detail), `${status} dropped the server detail`);
      assert.ok(html.includes(view.label), `${status} dropped its label`);
    }
  });

  test('an outcome with no server sentence still says something true', () => {
    for (const status of SPEND_PERMISSION_ONBOARDING_STATES_V1) {
      const view = spendPermissionOutcomeViewV1(status);
      if (!view) continue;
      // `onboardingDetail` is null while the flow is between states, and a blank
      // panel is exactly the failure being fixed.
      const html = panel({ onboardingStatus: status, onboardingDetail: null });
      assert.ok(html.includes(view.fallbackDetail), `${status} rendered nothing`);
    }
  });

  test('a retryable outcome offers a check, and says the wallet will not reopen', () => {
    const html = panel({
      onboardingStatus: 'verification_retryable' as SpendPermissionOnboardingStatusV1,
      onboardingDetail: NOT_YET_DETAIL,
      canRetryVerification: true,
      onRetryVerification: () => {},
    });
    assert.ok(html.includes('Retry verification'));
    assert.ok(html.includes('Your wallet will not open again'));
  });

  test('the enable button stops calling itself a retry while a signed permission waits', () => {
    const html = panel({
      onboardingStatus: 'verification_retryable' as SpendPermissionOnboardingStatusV1,
      onboardingDetail: NOT_YET_DETAIL,
      canRetryVerification: true,
      onRetryVerification: () => {},
    });
    // Two different actions must not share a name. One re-checks; the other
    // opens a wallet and asks for a second permission.
    assert.ok(html.includes('Sign a new permission instead'));
    assert.ok(!html.includes('>Try again<'));
  });

  test('a permanent refusal offers no retry, because signing it again changes nothing', () => {
    const html = panel({
      onboardingStatus: 'verification_failed' as SpendPermissionOnboardingStatusV1,
      onboardingDetail: 'wrong token',
      canRetryVerification: true,
      onRetryVerification: () => {},
    });
    assert.ok(!html.includes('Retry verification'));
    assert.equal(spendPermissionOutcomeViewV1('verification_failed')?.offerRetryVerification, false);
  });

  test('no retry button without a signed permission to re-check', () => {
    const html = panel({
      onboardingStatus: 'verification_retryable' as SpendPermissionOnboardingStatusV1,
      onboardingDetail: NOT_YET_DETAIL,
      canRetryVerification: false,
      onRetryVerification: () => {},
    });
    assert.ok(!html.includes('Retry verification'), 'nothing is held, so there is nothing to check');
  });

  test('an activated budget lets the budget speak — the flow adds nothing', () => {
    assert.equal(spendPermissionOutcomeViewV1('active'), null);
    const html = panel({
      onboardingStatus: 'active' as SpendPermissionOnboardingStatusV1,
      budget: {
        budgetId: 'budget-1',
        status: 'active',
        monthlyLimitUsdc: '3.00',
        spentUsdc: '0',
        reservedUsdc: '0',
        remainingUsdc: '3.00',
        maxPerRequestUsdc: '0.02',
        allowedCategories: ['simulation'],
        periodEndsAt: '2026-09-08T00:00:00.000Z',
      },
    });
    assert.ok(!html.includes('Not configured'));
    assert.ok(html.includes('Active'));
  });

  test('a wallet that was never opened still reads as "Not configured"', () => {
    // The label is right for the situation it was written for, and this is that
    // situation: nothing signed, nothing refused, nothing pending.
    const html = panel({ onboardingStatus: 'idle' as SpendPermissionOnboardingStatusV1 });
    assert.ok(html.includes('Not configured'));
  });

  test('a warned outcome is styled as a warning, an ordinary one is not', () => {
    assert.equal(spendPermissionOutcomeViewV1('verification_retryable')?.tone, 'warn');
    assert.equal(spendPermissionOutcomeViewV1('verification_failed')?.tone, 'warn');
    // A declined prompt is a decision, not a fault.
    assert.equal(spendPermissionOutcomeViewV1('wallet_rejected')?.tone, 'info');
    assert.equal(spendPermissionOutcomeViewV1('awaiting_wallet')?.tone, 'info');
  });
});
