import React from 'react';

void React;

// ---------------------------------------------------------------------------
// T68C — the exit check card.
//
// The one question a holder of a B20 token actually has: can I get back out,
// and what does it cost. Everything on this card is a measurement or a stated
// reason there is none.
//
// What it is NOT allowed to become:
//
//   * A score. There is no number out of a hundred and no colour scale. The
//     headline is a CAPABILITY statement — "qualifies for your 100 USDC / 3%
//     profile" — which is checkable against the figures beside it. "87/100" is
//     checkable against nothing.
//   * A promise. A pass says what was measured and, when the measurement was
//     optimistic, says so in the headline rather than in a footnote.
//   * Silent about its own coarseness. Exit capacity is the largest size that
//     was PROBED and came in under tolerance. When the ladder measured a single
//     point, the card says the depth is unmeasured instead of showing a number
//     that looks like a curve.
// ---------------------------------------------------------------------------

export type ExitRejectionReasonV1 =
  | 'not_b20'
  | 'controls_unreadable'
  | 'transfers_paused'
  | 'transfer_policy_may_block'
  | 'no_entry_route'
  | 'no_exit_route'
  | 'round_trip_above_tolerance'
  | 'exit_capacity_below_position';

export interface ExitCheckLikeV1 {
  status: 'qualifies' | 'rejected' | 'unmeasured';
  reason: ExitRejectionReasonV1 | null;
  measurement: 'simulated' | 'quoted_pre_entry' | null;
  optimistic: boolean;
  roundTripCostBps: number | null;
  exitCapacityAtomic: string | null;
  firstFailingAtomic: string | null;
  probeCount: number;
  capacityInformative: boolean;
  referenceSizeAtomic: string | null;
  endpointDegraded: boolean;
  controlsBlockNumber: string | null;
  checkedAt: string;
}

export interface B20ExitCardProps {
  /** Null before anything has been asked. */
  check: ExitCheckLikeV1 | null;
  /** What the user said they would put in, already formatted. */
  positionLabel: string;
  slippagePercentLabel: string;
  /** Formats a token amount for display. Injected because only the caller
   * knows the token's decimals. */
  formatTokenAmount: (atomic: string) => string;
  loading: boolean;
  /** Why no check is possible. Rendered instead of the result. */
  unavailableReason: string | null;
  onCheck: () => void;
}

/** Basis points as a percentage. Integer arithmetic: a float renders 6.3% as
 * 6.299999999999999. */
export function bpsLabelV1(bps: number): string {
  const whole = Math.trunc(bps / 100);
  const fraction = Math.abs(bps % 100);
  return fraction === 0 ? `${whole}%` : `${whole}.${String(fraction).padStart(2, '0')}%`;
}

/**
 * The sentence for each refusal.
 *
 * Every one names what was measured and what it means for a position. None of
 * them says what the token will do next, because nothing here measured that.
 */
export const EXIT_REJECTION_COPY_V1: Record<ExitRejectionReasonV1, string> = {
  not_b20: 'The B20 factory does not recognise this address, so none of the control checks apply to it.',
  controls_unreadable:
    'This token’s controls could not be fully read, so nothing here clears it. A partial read is not a pass.',
  transfers_paused: 'Transfers of this token are paused right now. A position could be bought and not sold.',
  transfer_policy_may_block:
    'A transfer policy is active on this token, so it can refuse specific addresses. B20 offers no way to list who is on it, so an exit cannot be confirmed.',
  no_entry_route: 'No route into this token exists at this size.',
  no_exit_route: 'No route out of this token exists. A position could be bought and not sold.',
  round_trip_above_tolerance: 'Going in and straight back out costs more than your tolerance allows.',
  exit_capacity_below_position:
    'The position you asked for is larger than what can be exited within your slippage tolerance.',
};

/**
 * The headline.
 *
 * A pass on an optimistic measurement carries the caveat IN the headline. Put
 * in a footnote it would be read by nobody, and the whole difference between
 * this card and a rating is that its caveats are load-bearing.
 */
export function exitHeadlineV1(
  check: ExitCheckLikeV1,
  profile: { positionLabel: string; slippagePercentLabel: string },
): string {
  if (check.status === 'unmeasured') {
    // Deliberately not a rejection. A throttled route search that found nothing
    // is the endpoint, not the token — reported as a refusal it would read as
    // "you cannot sell this", which is a claim nothing here measured.
    return 'Not measured — too many quotes went unanswered to say anything about this token. Try again in a moment.';
  }
  if (check.status === 'rejected') {
    return check.reason ? EXIT_REJECTION_COPY_V1[check.reason] : 'This position was not cleared.';
  }
  const base = `Qualifies for your ${profile.positionLabel} / ${profile.slippagePercentLabel} profile`;
  return check.optimistic
    ? `${base} — measured on an exit quote taken before the entry moves the pool, so the real round trip is worse`
    : base;
}

export function B20ExitCard({
  check,
  positionLabel,
  slippagePercentLabel,
  formatTokenAmount,
  loading,
  unavailableReason,
  onCheck,
}: B20ExitCardProps): React.ReactElement {
  return (
    <div className="panel">
      <div className="ph">
        <h3>Can I get back out?</h3>
        <span className="sub">
          {check === null ? 'not checked' : check.status}
        </span>
        <span className="rt">
          <button type="button" className="btn" onClick={onCheck} disabled={loading}>
            {loading ? 'Quoting the router…' : 'Check exit'}
          </button>
        </span>
      </div>
      <div className="pb">
        <p className="note">
          Buying is easy to check and easy to do. This asks the other question: at your size, does a
          route out exist, and what does the round trip cost.
        </p>

        {unavailableReason ? (
          <p className="note warn">{unavailableReason}</p>
        ) : check === null ? (
          <p className="empty">Nothing has been checked yet.</p>
        ) : (
          <>
            <p className={check.status === 'qualifies' ? 'nm' : 'nm warn'}>
              {exitHeadlineV1(check, { positionLabel, slippagePercentLabel })}
            </p>

            <div className="kv">
              <div>
                <span>Round trip</span>
                <span className="mono">
                  {check.roundTripCostBps === null
                    ? 'not measured'
                    : `${bpsLabelV1(check.roundTripCostBps)} of ${positionLabel}`}
                </span>
              </div>
              <div>
                <span>Exit capacity</span>
                {/* Never interpolated. This is the largest size that was
                    actually probed and came in under tolerance. */}
                <span className="mono">
                  {check.exitCapacityAtomic === null
                    ? 'none at this tolerance'
                    : `${formatTokenAmount(check.exitCapacityAtomic)} within ${slippagePercentLabel}`}
                </span>
              </div>
              {check.firstFailingAtomic !== null && (
                <div>
                  <span>First size over tolerance</span>
                  <span className="mono">{formatTokenAmount(check.firstFailingAtomic)}</span>
                </div>
              )}
              <div>
                <span>Sizes probed</span>
                <span className={check.capacityInformative ? undefined : 'warn'}>
                  {check.probeCount === 0
                    ? 'none priced'
                    : check.capacityInformative
                      ? `${check.probeCount} measured`
                      : `${check.probeCount} measured — too few to describe depth`}
                </span>
              </div>
              <div>
                <span>Controls read at</span>
                <span className="mono">
                  {check.controlsBlockNumber === null ? 'no block' : `block ${check.controlsBlockNumber}`}
                </span>
              </div>
            </div>

            {check.referenceSizeAtomic !== null && (
              // Without this line a reader would take an understated figure for
              // an absolute one.
              <p className="lnote">
                Price impact is measured against the smallest size that priced (
                {formatTokenAmount(check.referenceSizeAtomic)}), not against a mid price, so every
                figure here understates the true cost by whatever that smallest quote already paid.
              </p>
            )}

            {check.endpointDegraded && (
              <p className="note warn">
                Some quotes did not come back. That is the endpoint, not the token — an incomplete
                read is not a finding about liquidity.
              </p>
            )}

            <p className="lnote">
              Quoted, not simulated. The router was asked what comes out; nothing was executed, and
              no transaction was prepared.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
