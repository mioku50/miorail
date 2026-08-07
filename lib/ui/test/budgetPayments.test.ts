import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import url from 'node:url';

import {
  isUsdcAmountV1,
} from '../src/console/BudgetPaymentsPanel';
import {
  budgetPaymentsViewV1,
  onboardingBusyV1,
  onboardingRetryableV1,
  paidIntelligenceStateV1,
  paidIntelligenceViewV1,
  spendPermissionConsentV1,
  SPEND_PERMISSION_ONBOARDING_STATES_V1,
  type BudgetProjectionLikeV1,
  type ChargeSummaryLikeV1,
  type PaidIntelligenceStateV1,
} from '../src/console/budgetPayments';

// ---------------------------------------------------------------------------
// T67E §2. "Intelligence Budget is off" was one string standing in for eight
// different situations, four of which a user can fix in seconds and four of
// which they cannot fix at all.
// ---------------------------------------------------------------------------

const here = path.dirname(url.fileURLToPath(import.meta.url));

function budget(overrides: Partial<BudgetProjectionLikeV1> = {}): BudgetProjectionLikeV1 {
  return {
    status: 'active',
    monthlyLimitUsdc: '3.00',
    spentUsdc: '0.42',
    reservedUsdc: '0.01',
    remainingUsdc: '2.57',
    maxPerRequestUsdc: '0.02',
    allowedCategories: ['simulation', 'contract_risk'],
    linkedSpendPermissionId: 'perm-1',
    periodEndsAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
}

function charge(overrides: Partial<ChargeSummaryLikeV1> = {}): ChargeSummaryLikeV1 {
  return {
    chargeId: 'charge-1',
    status: 'settled',
    service: 'Alchemy simulation',
    providerName: 'Alchemy',
    category: 'simulation',
    quotedUsdc: '0.010',
    chargedUsdc: '0.010',
    fundingMode: 'spend_permission',
    createdAt: '2026-08-01T10:00:00.000Z',
    ...overrides,
  };
}

const ready = { featureEnabled: true, settleReady: true, budget: budget(), charges: [] as ChargeSummaryLikeV1[] };

describe('§2.4 — the eight states are eight states', () => {
  test('no two states share a sentence', () => {
    // The whole defect: collapsing these meant nobody could tell which they
    // were in, and four of them are fixable in seconds.
    const states: PaidIntelligenceStateV1[] = [
      'feature_disabled', 'settlement_unavailable', 'permission_missing', 'paused',
      'budget_exceeded', 'max_per_call_exceeded', 'provider_unavailable',
      'payment_settled_service_failed', 'reconciliation_required', 'ready',
    ];
    const details = states.map((state) => paidIntelligenceViewV1(state).detail);
    assert.equal(new Set(details).size, states.length, 'two states say the same thing');
  });

  test('a switched-off feature is not a failure', () => {
    const state = paidIntelligenceStateV1({ ...ready, featureEnabled: false });
    assert.equal(state, 'feature_disabled');
    assert.match(paidIntelligenceViewV1(state).detail, /Route comparison, scoring and proofs are unaffected/);
  });

  test('configured-but-unsettleable is its own state', () => {
    // The T67X-A1 shape: everything "configured", and the first real payment
    // failing at settle — after the user had signed.
    assert.equal(paidIntelligenceStateV1({ ...ready, settleReady: false }), 'settlement_unavailable');
  });

  test('no permission is fixable by the user; no settlement is not', () => {
    // Offering an action for a server the user does not administer sends them
    // to fix something they cannot reach.
    assert.equal(paidIntelligenceViewV1('permission_missing').action, 'create_permission');
    assert.equal(paidIntelligenceViewV1('settlement_unavailable').action, null);
    assert.equal(paidIntelligenceViewV1('feature_disabled').action, null);
  });

  test('a paused permission is not a missing one', () => {
    assert.equal(paidIntelligenceStateV1({ ...ready, budget: budget({ status: 'paused' }) }), 'paused');
  });

  test('T71 — revoked is its own state, expired reads as missing', () => {
    // These used to collapse together. "You turned this off" and "you have not
    // set this up" are different sentences, and a user who deliberately
    // revoked should see that their action took rather than a screen that
    // looks like it forgot. Expiry stays `permission_missing` because the user
    // did not do anything — time did.
    assert.equal(paidIntelligenceStateV1({ ...ready, budget: budget({ status: 'revoked' }) }), 'revoked');
    assert.equal(
      paidIntelligenceStateV1({ ...ready, budget: budget({ status: 'expired' }) }),
      'permission_missing',
    );
    assert.equal(paidIntelligenceStateV1({ ...ready, budget: null }), 'permission_missing');
  });

  test('T71 — a revoked permission still offers a way back on', () => {
    const view = paidIntelligenceViewV1('revoked');
    assert.equal(view.action, 'create_permission');
    assert.equal(view.moneyAtRisk, false);
    // And it is honest about the half Miorail cannot do for them.
    assert.match(view.detail, /remove it there to withdraw it on chain/i);
  });

  test('a spent budget is its own state', () => {
    assert.equal(
      paidIntelligenceStateV1({ ...ready, budget: budget({ remainingUsdc: '0' }) }),
      'budget_exceeded',
    );
  });

  test('only two states admit money is at risk', () => {
    const atRisk = (['payment_settled_service_failed', 'reconciliation_required'] as const).every(
      (state) => paidIntelligenceViewV1(state).moneyAtRisk,
    );
    assert.equal(atRisk, true);
    for (const state of ['feature_disabled', 'permission_missing', 'budget_exceeded', 'ready'] as const) {
      assert.equal(paidIntelligenceViewV1(state).moneyAtRisk, false, state);
    }
  });

  test('a settled-but-undelivered charge says the user was charged', () => {
    const view = paidIntelligenceViewV1('payment_settled_service_failed');
    assert.match(view.detail, /You were charged and did not receive the evidence/);
  });
});

describe('the priority order', () => {
  test('an unresolved charge outranks a spent budget', () => {
    // One has cost the user money; the other has only stopped them spending
    // more. They must not be reported in the wrong order.
    const state = paidIntelligenceStateV1({
      ...ready,
      budget: budget({ remainingUsdc: '0' }),
      charges: [charge({ status: 'reconciliation_required' })],
    });
    assert.equal(state, 'reconciliation_required');
  });

  test('a switched-off gate outranks everything', () => {
    // With the gate off, none of the rest was even attempted.
    const state = paidIntelligenceStateV1({
      featureEnabled: false,
      settleReady: false,
      budget: null,
      charges: [charge({ status: 'reconciliation_required' })],
    });
    assert.equal(state, 'feature_disabled');
  });

  test('a settled charge changes nothing', () => {
    assert.equal(paidIntelligenceStateV1({ ...ready, charges: [charge()] }), 'ready');
  });
});

describe('the drawer view', () => {
  test('reserved is never folded into spent or remaining', () => {
    // It is money committed and not yet gone. Folding it into either figure
    // makes one of them wrong.
    const view = budgetPaymentsViewV1(ready);
    const labels = view.rows!.map((row) => row.label);
    assert.ok(labels.includes('Spent'));
    assert.ok(labels.includes('Reserved'));
    assert.ok(labels.includes('Remaining'));
    assert.equal(view.rows!.find((row) => row.label === 'Reserved')!.value, '0.01 USDC');
  });

  test('no budget renders no table of zeros', () => {
    // "0.00 / 0.00" reads like a configured budget that happens to be empty.
    const view = budgetPaymentsViewV1({ ...ready, budget: null });
    assert.equal(view.rows, null);
    assert.equal(view.usedPercent, 0);
    assert.match(view.recipientLabel, /nobody/);
  });

  test('a quote is never shown as if it were charged', () => {
    const view = budgetPaymentsViewV1({
      ...ready,
      charges: [charge({ status: 'quoted', chargedUsdc: null, quotedUsdc: '0.010' })],
    });
    assert.equal(view.charges[0]!.amount, '0.010 USDC quoted');
  });

  test('a failed charge says it was not charged', () => {
    const view = budgetPaymentsViewV1({ ...ready, charges: [charge({ status: 'failed' })] });
    assert.match(view.charges[0]!.status, /not charged/);
  });

  test('a reconciliation row is flagged for attention', () => {
    const view = budgetPaymentsViewV1({
      ...ready,
      charges: [charge({ status: 'reconciliation_required' })],
    });
    assert.equal(view.charges[0]!.needsAttention, true);
  });

  test('categories are words, not enum tokens', () => {
    assert.deepEqual(budgetPaymentsViewV1(ready).allowedCategories, ['Simulation', 'Contract risk']);
  });
});

describe('consent before a permission exists', () => {
  test('the three sentences are in the user’s units, and include the exit', () => {
    const lines = spendPermissionConsentV1({ monthlyLimitUsdc: '3', maxPerRequestUsdc: '0.02' });
    assert.deepEqual(lines, [
      'Miorail may charge up to 3 USDC per month.',
      'No single request may cost more than 0.02 USDC.',
      'You can revoke this permission from Miorail at any time.',
    ]);
    // A permission a user cannot find their way out of is not consent.
    assert.match(lines[2]!, /revoke/);
  });

  test('the consent text names no protocol', () => {
    const joined = spendPermissionConsentV1({ monthlyLimitUsdc: '3', maxPerRequestUsdc: '0.02' }).join(' ');
    for (const jargon of ['x402', 'facilitator', 'EIP', 'settle', 'nonce']) {
      assert.ok(!joined.toLowerCase().includes(jargon.toLowerCase()), `consent leaks "${jargon}"`);
    }
  });
});

describe('§2.1 — this is not a technical menu', () => {
  test('no surface adds a top-level x402 or Spend Permission entry', () => {
    const routes = readFileSync(path.join(here, '../../../artifacts/interface/src/app/routes.tsx'), 'utf8');
    for (const banned of ['x402', 'Spend Permission', 'Payments protocol', 'Fuel']) {
      assert.ok(!routes.includes(banned), `routes.tsx exposes "${banned}" as navigation`);
    }
  });

  test('the panel keeps protocol vocabulary out of the visible copy', () => {
    const source = readFileSync(path.join(here, '../src/console/BudgetPaymentsPanel.tsx'), 'utf8');
    // It may appear once, inside the technical-details disclosure.
    const visible = source.slice(0, source.indexOf('Technical details'));
    assert.ok(!/>[^<]*x402/i.test(visible), 'x402 appears in the panel’s primary copy');
  });

  test('the full panel is reachable on every surface', () => {
    // T70 §2 — on the web it moved from a mid-flow drawer to Settings, because
    // it was the first card on Routes and the largest block in the drawer, and
    // it is a thing you read once when something is wrong. Base App has no
    // Settings section in its four-up bar, so there it is still the drawer.
    const web = readFileSync(path.join(here, '../../../artifacts/interface/src/features/settings/SettingsPage.tsx'), 'utf8');
    assert.ok(web.includes('BudgetPaymentsPanel'), 'Settings does not mount the panel');
    const mini = readFileSync(path.join(here, '../../../artifacts/miniapp/app/components/MiniConsole.tsx'), 'utf8');
    assert.ok(mini.includes('BudgetPaymentsPanel'), 'the miniapp does not mount the panel');
    assert.ok(mini.includes('budgetOpen'), 'the miniapp has no way to open it');
  });

  test('the flow surfaces carry a status line and no panel', () => {
    // §9.3 — Budget is off the top of Home and Routes. What is left is one
    // line: the state, that free comparison still works, and a way through.
    for (const [surface, file] of [
      ['routes', '../../../artifacts/interface/src/features/console/RouteIntelligenceConsole.tsx'],
      ['opportunities', '../../../artifacts/interface/src/features/opportunities/OpportunitiesPage.tsx'],
    ] as const) {
      const source = readFileSync(path.join(here, file), 'utf8');
      assert.ok(!source.includes('<BudgetPaymentsPanel'), `${surface} still renders the full panel`);
    }
    const routes = readFileSync(path.join(here, '../../../artifacts/interface/src/features/console/RouteIntelligenceConsole.tsx'), 'utf8');
    assert.ok(routes.includes('paidEvidenceStripV1'), 'Routes lost the compact status entirely');
  });
});

describe('the console vocabulary', () => {
  test('no console source still says "Intelligence Budget is off"', () => {
    // The single string this whole section replaces.
    const dir = path.join(here, '..', 'src', 'console');
    const offenders = readdirSync(dir).filter((name) => {
      if (!/\.tsx?$/.test(name)) return false;
      // Comments may name the string they exist to explain; rendered copy may not.
      const stripped = readFileSync(path.join(dir, name), 'utf8')
        .replace(/\/\/[^\n]*/g, '')
        .replace(/\/\*[\s\S]*?\*\//g, '');
      return stripped.includes('Intelligence Budget is off');
    });
    assert.deepEqual(offenders, []);
  });
});

describe('the drawer offers controls, not just a status', () => {
  const panelDir = path.dirname(url.fileURLToPath(import.meta.url));
  const panel = readFileSync(path.join(panelDir, '../src/console/BudgetPaymentsPanel.tsx'), 'utf8');
  // The writes live where the panel lives: Settings.
  const console_ = readFileSync(
    path.join(panelDir, '../../../artifacts/interface/src/features/settings/SettingsPage.tsx'),
    'utf8',
  );

  test('the limits are an actual field, not a promise of one', () => {
    // The bug: the drawer rendered a status and no control at all, while the
    // left rail told the user to "set a spending limit — it takes one field".
    assert.match(panel, /name="monthly"/);
    assert.match(panel, /name="per-request"/);
    assert.match(panel, /Save limits/);
  });

  test('an amount the wire would refuse is refused before it is sent', () => {
    assert.equal(isUsdcAmountV1('3.00'), true);
    assert.equal(isUsdcAmountV1('0.02'), true);
    assert.equal(isUsdcAmountV1('0'), false);
    assert.equal(isUsdcAmountV1('-1'), false);
    assert.equal(isUsdcAmountV1('abc'), false);
    assert.equal(isUsdcAmountV1(''), false);
  });

  test('the console actually calls the writes T60 shipped', () => {
    // All three existed and no surface had ever called one.
    assert.match(console_, /useUpdateIntelligenceBudget/);
    assert.match(console_, /useRevokeIntelligenceBudget/);
    assert.match(console_, /onUpdateLimit=/);
    assert.match(console_, /onRevoke=/);
  });

  test('T71 — a permission is never recorded without the wallet that grants it', () => {
    // This used to assert that no create flow existed at all, which was the
    // honest thing while the wallet half was missing. Now the flow exists, and
    // the invariant it has to keep is stronger: the ONLY way Settings can
    // create a budget is through the wallet grant, whose result the server
    // verifies on chain.
    assert.match(console_, /onEnablePaidEvidence=/);
    assert.match(console_, /useSpendPermissionGrant/);

    // `useCreateIntelligenceBudget` takes a spendPermissionId and no proof of
    // it. Wiring a button to that alone would record a permission the user's
    // Base Account never signed — which is exactly what the old test was
    // guarding against, and it stays guarded.
    assert.ok(
      !/useCreateIntelligenceBudget/.test(console_),
      'Settings reached the bookkeeping-only create endpoint',
    );
  });

  test('T71 — the panel collects both limits before opening a wallet', () => {
    // A permission for an allowance the user never saw is not consent, however
    // clearly the wallet renders it.
    assert.match(panel, /enable-monthly/);
    assert.match(panel, /enable-per-request/);
    assert.match(panel, /Enable paid evidence/);
    // And it refuses a per-request cap above the monthly limit client-side, so
    // the user is told before a prompt opens rather than after.
    assert.match(panel, /Number\(perRequest\) > Number\(monthly\)/);
  });

  test('T71 — pause and revoke are only offered where they mean something', () => {
    // Pausing something already paused, or revoking something already revoked,
    // is a button that does nothing and reads as a broken product.
    assert.match(panel, /props\.budget\?\.status === 'active' && props\.onPause/);
    assert.match(panel, /props\.budget\.status !== 'revoked' && props\.onRevoke/);
  });

  test('a failed change never echoes the server message', () => {
    // A server error can carry an endpoint, and an endpoint can carry a key.
    assert.match(console_, /That change could not be saved/);
  });
});

describe('T71 — the onboarding states stay in step with the flow that produces them', () => {
  test('lib/ui names exactly the states the wallet hook can be in', () => {
    // lib/ui declares its own copy rather than importing @mioagent/wallet-actions:
    // a panel should not pull a wallet SDK into the miniapp bundle to name a
    // string. The copy is only safe while something fails when it drifts.
    const hook = readFileSync(
      path.join(here, '..', '..', 'wallet-actions', 'src', 'useSpendPermissionOnboarding.ts'),
      'utf8',
    );
    const declared = hook
      .slice(hook.indexOf('export type SpendPermissionFlowStatusV1'), hook.indexOf('/** What the server told us'))
      .match(/'([a-z_]+)'/g)!
      .map((quoted) => quoted.replaceAll("'", ''))
      .sort();
    assert.deepEqual([...SPEND_PERMISSION_ONBOARDING_STATES_V1].sort(), declared);
  });

  test('only the states where nothing is in flight offer to start again', () => {
    for (const status of ['preparing', 'awaiting_wallet', 'verifying'] as const) {
      assert.equal(onboardingBusyV1(status), true, `${status} allowed a second prompt`);
    }
    for (const status of ['idle', 'active', 'wallet_rejected', 'verification_failed'] as const) {
      assert.equal(onboardingBusyV1(status), false);
    }
  });

  test('a declined prompt is retryable and a wrong token is not', () => {
    // Signing the same wrong thing again produces the same wrong thing; a user
    // who simply changed their mind should be offered another go.
    assert.equal(onboardingRetryableV1('wallet_rejected'), true);
    assert.equal(onboardingRetryableV1('verification_retryable'), true);
    assert.equal(onboardingRetryableV1('verification_failed'), false);
    assert.equal(onboardingRetryableV1('active'), false);
  });
});
