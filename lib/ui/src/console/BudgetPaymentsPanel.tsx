import React from 'react';
import {
  budgetPaymentsViewV1,
  spendPermissionConsentV1,
  type PaidIntelligenceInputV1,
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

export function BudgetPaymentsPanel(props: BudgetPaymentsPanelProps): React.ReactElement {
  const view = budgetPaymentsViewV1(props);
  const { status } = view;
  const consent = spendPermissionConsentV1({
    monthlyLimitUsdc: props.budget?.monthlyLimitUsdc ?? '3.00',
    maxPerRequestUsdc: props.budget?.maxPerRequestUsdc ?? '0.02',
  });

  return (
    <section className="panel" aria-label="Budget and payments">
      <div className="ph">
        <h3>Budget &amp; payments</h3>
        <span className="sub">{status.label}</span>
      </div>
      <div className="pb">
        <p className={status.moneyAtRisk ? 'note warn' : 'note'}>{status.detail}</p>

        {view.rows ? (
          <>
            <div className="kv">
              {view.rows.map((row) => (
                <div key={row.label}>
                  <span>{row.label}</span>
                  <span className="mono">{row.value}</span>
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
          <div className="kv">
            <div>
              <span>Allowed categories</span>
              <span>{view.allowedCategories.join(', ')}</span>
            </div>
            <div>
              <span>Permission recipient</span>
              <span>{view.recipientLabel}</span>
            </div>
          </div>
        )}

        {/* The limits, as an actual form. This panel used to state a number and
            offer no way to change it, while the left rail said "set a spending
            limit — it takes one field". There was no field. */}
        {props.onUpdateLimit && props.budget && (
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
              <span>Monthly limit (USDC)</span>
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

        <div className="ctarow">
          {status.action === 'create_permission' &&
            (props.onCreatePermission ? (
              <button type="button" className="btn" onClick={props.onCreatePermission}>
                Create permission
              </button>
            ) : (
              // Named, not hidden and not faked. See `createUnavailableReason`.
              <span className="nt warn">
                {props.createUnavailableReason ??
                  'Granting a spending permission is a wallet action, and that flow is not built yet.'}
              </span>
            ))}
          {status.action === 'resume' && props.onResume && (
            <button type="button" className="btn" onClick={props.onResume}>
              Resume paid services
            </button>
          )}
          {view.rows && props.onPause && status.action !== 'resume' && (
            <button type="button" className="btn sec" onClick={props.onPause}>
              Pause paid services
            </button>
          )}
          {view.rows && props.onRevoke && (
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
            <div className="kv">
              {(props.technicalDetails ?? []).map((row) => (
                <div key={row.label}>
                  <span>{row.label}</span>
                  <span className="mono">{row.value}</span>
                </div>
              ))}
            </div>
          </details>
        </div>
      )}
    </section>
  );
}
