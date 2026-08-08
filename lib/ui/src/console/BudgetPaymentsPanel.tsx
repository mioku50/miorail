import React from 'react';
import {
  budgetPaymentsViewV1,
  onboardingBusyV1,
  onboardingRetryableV1,
  spendPermissionConsentV1,
  spendPermissionOutcomeViewV1,
  type PaidIntelligenceInputV1,
  type SpendPermissionOnboardingStatusV1,
} from './budgetPayments';

void React;

// ---------------------------------------------------------------------------
// T67E §2 — the Budget & payments drawer.
//
// A drawer inside the console shell, not a page and not a nav entry. It opens
// from the panels that already state a number a user might want to change:
// Limits, Intelligence spend, the evidence cost on a Route Card, and the
// payment status on Review.
//
// The word "x402" appears exactly once, inside the technical details block. A
// user has a monthly limit and a list of charges; the settlement protocol is
// not their concern until they choose to make it one.
//
// Classes are console.css's. See consoleStyles.test.ts for why that matters.
// ---------------------------------------------------------------------------

export interface BudgetPaymentsPanelProps extends PaidIntelligenceInputV1 {
  /**
   * T71 — start the Base Spend Permission flow with the limits the user chose.
   *
   * Takes the limits because they are what the wallet is asked to authorise:
   * a button that enabled paid evidence and THEN asked for a limit would have
   * to request an allowance nobody had agreed to.
   */
  onEnablePaidEvidence?: (limits: { monthlyLimitUsdc: string; maxPerRequestUsdc: string }) => void;
  /** Where the wallet flow has got to. Drives the states between "off" and
   * "active" that a single boolean cannot express. */
  onboardingStatus?: SpendPermissionOnboardingStatusV1;
  /** One sentence about that state, from the flow itself. Never a raw wallet
   * or server message. */
  onboardingDetail?: string | null;
  /** The consent lines the SERVER produced for this grant. Preferred over the
   * locally composed ones once prepare has answered, because these are the
   * numbers the wallet will actually be asked for. */
  onboardingConsent?: readonly string[];
  /**
   * T71.1 — re-run the server's verification against the permission the wallet
   * ALREADY signed.
   *
   * Separate from `onEnablePaidEvidence` on purpose. They read alike and are
   * not: one opens a wallet and asks for a second permission, the other asks
   * the server to look at Base again. Offering the first when the second is
   * what is needed is how a user ends up with two grants for one budget.
   */
  onRetryVerification?: () => void;
  /** Whether a signed permission is in hand to re-check. */
  canRetryVerification?: boolean;
  onCreatePermission?: () => void;
  /** Both limits, as decimal USDC strings. The panel collects them; only the
   * wallet can authorise them. */
  onUpdateLimit?: (limits: { monthlyLimitUsdc: string; maxPerRequestUsdc: string }) => void;
  onPause?: () => void;
  onResume?: () => void;
  onRevoke?: () => void;
  /** Shown behind a disclosure. Nothing here is needed to use the feature. */
  technicalDetails?: readonly { label: string; value: string }[];
  chargesLoading?: boolean;
  chargesUnavailableReason?: string | null;
  /** True while a change is in flight, so the form cannot be submitted twice. */
  changePending?: boolean;
  /** Why the last change did not take. Never a raw server message. */
  changeError?: string | null;
  /**
   * Why no permission can be created here yet.
   *
   * Granting one is a WALLET action — the user's Base Account signs it and
   * Miorail never does. Until that flow exists, the honest thing is to name
   * what is missing rather than show a button that cannot work. A dead button
   * is worse than no button: it reads as a broken product rather than an
   * unfinished one.
   */
  createUnavailableReason?: string | null;
}

/** A decimal USDC amount the wire will accept. Rejected here rather than
 * server-side so the user is told before anything is sent. */
export function isUsdcAmountV1(value: string): boolean {
  return /^\d{1,7}(\.\d{1,6})?$/.test(value.trim()) && Number(value) > 0;
}

/** T71 §1's defaults, shown in the enable form so a user can accept them
 * without typing. Stated here rather than left blank: an empty field is a
 * decision the user has to make before they know what the numbers mean. */
export const DEFAULT_MONTHLY_LIMIT_USDC_V1 = '3.00';
export const DEFAULT_PER_REQUEST_USDC_V1 = '0.02';

export function BudgetPaymentsPanel(props: BudgetPaymentsPanelProps): React.ReactElement {
  const view = budgetPaymentsViewV1(props);
  const { status } = view;
  const onboardingBusy = onboardingBusyV1(props.onboardingStatus);
  // T71.1 §2 — when the wallet flow has reached an outcome, the outcome is what
  // the panel says. Otherwise a refused confirmation renders as "Not
  // configured", which describes the user's situation as absence and offers
  // them the button they just pressed.
  const outcome = spendPermissionOutcomeViewV1(props.onboardingStatus);
  const outcomeDetail = outcome ? (props.onboardingDetail ?? outcome.fallbackDetail) : props.onboardingDetail;
  const onboardingWarn = outcome?.tone === 'warn';
  // Once the server has said what it will ask for, those are the numbers shown.
  // The locally composed lines are a placeholder for before that point.
  const consent =
    props.onboardingConsent && props.onboardingConsent.length > 0
      ? [...props.onboardingConsent]
      : spendPermissionConsentV1({
          monthlyLimitUsdc: props.budget?.monthlyLimitUsdc ?? DEFAULT_MONTHLY_LIMIT_USDC_V1,
          maxPerRequestUsdc: props.budget?.maxPerRequestUsdc ?? DEFAULT_PER_REQUEST_USDC_V1,
        });

  return (
    <section className="panel" aria-label="Budget and payments">
      <div className="ph">
        <h3>Budget &amp; payments</h3>
        <span className="sub">{outcome ? outcome.label : status.label}</span>
      </div>
      <div className="pb">
        {/* First, above everything, and never collapsed into the budget's own
            state: what the server said about the permission this user just
            signed. */}
        {outcome && outcomeDetail && (
          <p className={onboardingWarn ? 'note warn' : 'note'}>{outcomeDetail}</p>
        )}
        {outcome?.offerRetryVerification && props.onRetryVerification && props.canRetryVerification && (
          <div className="ctarow">
            <button type="button" className="btn" disabled={onboardingBusy} onClick={props.onRetryVerification}>
              {onboardingBusy ? 'Checking…' : 'Retry verification'}
            </button>
            {/* Said plainly, because the alternative button on this panel does
                exactly that and the two must not be confused. */}
            <span className="nt">This re-checks the permission you already signed. Your wallet will not open again.</span>
          </div>
        )}
        <p className={status.moneyAtRisk ? 'note warn' : 'note'}>{status.detail}</p>

        {view.rows ? (
          <>
            <div>
              {view.rows.map((row) => (
                <div className="kv" key={row.label}>
                  <span className="k">{row.label}</span>
                  <span className="v mono">{row.value}</span>
                </div>
              ))}
            </div>
            <div className="usebar">
              <span style={{ width: `${view.usedPercent}%` }} />
            </div>
          </>
        ) : (
          // No table of zeros. An empty budget rendered as "0.00 / 0.00" reads
          // like a configured budget that happens to be empty.
          <p className="empty">No spending permission exists yet, so there is no budget to show.</p>
        )}

        {view.allowedCategories.length > 0 && (
          <div>
            <div className="kv">
              <span className="k">Allowed categories</span>
              <span className="v">{view.allowedCategories.join(', ')}</span>
            </div>
            <div className="kv">
              <span className="k">Permission recipient</span>
              <span className="v">{view.recipientLabel}</span>
            </div>
          </div>
        )}

        {/* The limits, as an actual form. This panel used to state a number and
            offer no way to change it, while the left rail said "set a spending
            limit — it takes one field". There was no field. */}
        {props.onUpdateLimit && props.budget && props.budget.status !== 'revoked' && (
          <form
            className="kv"
            onSubmit={(event) => {
              event.preventDefault();
              const form = event.currentTarget;
              const monthly = String(new FormData(form).get('monthly') ?? '').trim();
              const perRequest = String(new FormData(form).get('per-request') ?? '').trim();
              if (!isUsdcAmountV1(monthly) || !isUsdcAmountV1(perRequest)) return;
              props.onUpdateLimit?.({ monthlyLimitUsdc: monthly, maxPerRequestUsdc: perRequest });
            }}
          >
            <div>
              <span className="k">Monthly limit (USDC)</span>
              <input
                className="goalinput"
                name="monthly"
                aria-label="Monthly limit in USDC"
                defaultValue={props.budget.monthlyLimitUsdc}
                inputMode="decimal"
              />
            </div>
            <div>
              <span>Max per request (USDC)</span>
              <input
                className="goalinput"
                name="per-request"
                aria-label="Maximum per request in USDC"
                defaultValue={props.budget.maxPerRequestUsdc}
                inputMode="decimal"
              />
            </div>
            <div>
              <button type="submit" className="btn" disabled={props.changePending === true}>
                {props.changePending ? 'Saving…' : 'Save limits'}
              </button>
            </div>
          </form>
        )}

        {props.changeError && <p className="note warn">{props.changeError}</p>}

        {/* T71 — enabling paid evidence, with the two numbers the wallet is
            about to be asked to authorise. They are collected BEFORE the
            prompt: a permission for an allowance the user never saw is not
            consent, however clearly the wallet renders it. */}
        {status.action === 'create_permission' && props.onEnablePaidEvidence && (
          <form
            className="kv"
            onSubmit={(event) => {
              event.preventDefault();
              const data = new FormData(event.currentTarget);
              const monthly = String(data.get('enable-monthly') ?? '').trim();
              const perRequest = String(data.get('enable-per-request') ?? '').trim();
              if (!isUsdcAmountV1(monthly) || !isUsdcAmountV1(perRequest)) return;
              if (Number(perRequest) > Number(monthly)) return;
              props.onEnablePaidEvidence?.({ monthlyLimitUsdc: monthly, maxPerRequestUsdc: perRequest });
            }}
          >
            <div>
              <span className="k">Monthly limit (USDC)</span>
              <input
                className="goalinput"
                name="enable-monthly"
                aria-label="Monthly limit in USDC"
                defaultValue={DEFAULT_MONTHLY_LIMIT_USDC_V1}
                inputMode="decimal"
              />
            </div>
            <div>
              <span>Max per request (USDC)</span>
              <input
                className="goalinput"
                name="enable-per-request"
                aria-label="Maximum per request in USDC"
                defaultValue={DEFAULT_PER_REQUEST_USDC_V1}
                inputMode="decimal"
              />
            </div>
            <div>
              <button
                type="submit"
                className={props.canRetryVerification ? 'btn sec' : 'btn'}
                disabled={onboardingBusy}
              >
                {onboardingBusy
                  ? 'Waiting for your wallet…'
                  : // T71.1 — when a signed permission is waiting to be
                    // re-checked, this button is the OTHER thing: it opens the
                    // wallet and asks for a second permission. It stays
                    // available, because a retry that never succeeds must not
                    // trap anyone, but it stops calling itself "try again" —
                    // that is what the check above it does.
                    props.canRetryVerification
                    ? 'Sign a new permission instead'
                    : // A declined prompt and an unreachable chain both leave the
                      // user exactly where they started, so the button says so
                      // rather than repeating an offer they just turned down.
                      onboardingRetryableV1(props.onboardingStatus)
                      ? 'Try again'
                      : 'Enable paid evidence'}
              </button>
            </div>
          </form>
        )}


        <div className="ctarow">
          {status.action === 'create_permission' && !props.onEnablePaidEvidence &&
            (props.onCreatePermission ? (
              <button type="button" className="btn" onClick={props.onCreatePermission}>
                Create permission
              </button>
            ) : (
              // Named, not hidden and not faked. See `createUnavailableReason`.
              <span className="nt warn">
                {props.createUnavailableReason ??
                  'Enabling paid evidence needs a wallet, and this surface has none connected.'}
              </span>
            ))}
          {status.action === 'resume' && props.onResume && (
            <button type="button" className="btn" onClick={props.onResume}>
              Resume paid services
            </button>
          )}
          {/* Pausing something already paused, or already revoked, is not an
              action — it is a button that does nothing and reads as broken. */}
          {props.budget?.status === 'active' && props.onPause && (
            <button type="button" className="btn sec" disabled={props.changePending === true} onClick={props.onPause}>
              Pause paid services
            </button>
          )}
          {props.budget && props.budget.status !== 'revoked' && props.onRevoke && (
            <button
              type="button"
              className="btn sec"
              disabled={props.changePending === true}
              onClick={props.onRevoke}
            >
              Revoke permission
            </button>
          )}
          {/* Never a signature from the server. The wallet confirms; Miorail
              only ever prepares. */}
          <span className="nt">Your Base Account confirms every change. Miorail never signs for you.</span>
        </div>

        {status.action === 'create_permission' && (
          <div className="note">
            {consent.map((line) => (
              <p className="lnote" key={line}>
                {line}
              </p>
            ))}
          </div>
        )}
      </div>

      <div className="ph">
        <h3>Recent charges</h3>
        <span className="sub">{view.charges.length === 0 ? 'none yet' : `${view.charges.length} shown`}</span>
      </div>
      <div className="pb tight">
        {props.chargesLoading ? (
          <p className="note">Reading your charges…</p>
        ) : props.chargesUnavailableReason ? (
          <p className="note">{props.chargesUnavailableReason}</p>
        ) : view.charges.length === 0 ? (
          <p className="empty">Nothing has been charged to this wallet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Service</th>
                <th>Amount</th>
                <th className="r">Status</th>
              </tr>
            </thead>
            <tbody>
              {view.charges.map((charge) => (
                <tr key={charge.id}>
                  <td className="nm">{charge.title}</td>
                  <td className="mono">{charge.amount}</td>
                  <td className={`r${charge.needsAttention ? ' warn' : ''}`}>{charge.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {(props.technicalDetails ?? []).length > 0 && (
        <div className="pb tight">
          <details>
            <summary className="lnote">Technical details</summary>
            <div>
              {(props.technicalDetails ?? []).map((row) => (
                <div className="kv" key={row.label}>
                  <span className="k">{row.label}</span>
                  <span className="v mono">{row.value}</span>
                </div>
              ))}
            </div>
          </details>
        </div>
      )}
    </section>
  );
}
