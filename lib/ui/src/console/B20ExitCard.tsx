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
  | 'exit_capacity_below_position'
  | 'simulation_reverted'
  | 'simulated_round_trip_above_tolerance';

export type ExitViabilityV1 = 'rejected' | 'provisional' | 'qualified' | 'unmeasured';

export type ExitUnmeasuredReasonV1 =
  | 'endpoint_degraded'
  | 'simulation_unavailable'
  | 'insufficient_probe_balance'
  | 'simulation_undecodable'
  | 'controls_unread';

/** The profile the user chose. Editable, and stated beside every number it
 * produced: a card that answered for an unstated size would be answering a
 * question nobody asked. */
export interface ExitProfileV1 {
  /** Whole USDC, as typed. */
  position: string;
  /** Percent, as typed. */
  maxRoundTrip: string;
  maxSlippage: string;
}

export const EXIT_PROFILE_DEFAULTS_V1: ExitProfileV1 = {
  position: '100',
  maxRoundTrip: '3',
  maxSlippage: '3',
};

/**
 * Whole USDC to atomic units, as TEXT.
 *
 * No numeric type is involved: six zeroes are appended to the digits. A float
 * cannot hold a cent at this scale, and even BigInt is unavailable here — this
 * module is shared with the miniapp, which targets below ES2020.
 *
 * `"1.5"` is refused rather than silently truncated. A position is money, and a
 * rounding nobody asked for is not a convenience.
 */
export function usdcToAtomicV1(value: string): string | null {
  const trimmed = value.trim();
  if (!/^\d{1,7}$/.test(trimmed)) return null;
  const whole = trimmed.replace(/^0+(?=\d)/, '');
  if (whole === '0') return null;
  return `${whole}000000`;
}

/** Percent to basis points, integer only. `"3"` → 300, `"3.5"` → 350. */
export function percentToBpsV1(value: string): number | null {
  const trimmed = value.trim();
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(trimmed)) return null;
  const [whole, fraction = ''] = trimmed.split('.');
  const bps = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return bps > 0 && bps <= 10_000 ? bps : null;
}

export interface ExitCheckLikeV1 {
  status: ExitViabilityV1;
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
  /** T68D — separate from viability. A route PROVEN to work is a different
   * fact from a search that heard every candidate. */
  coverage?: 'complete' | 'partial';
  viableRouteConfirmed?: boolean;
  bestRouteConfirmed?: boolean;
  unmeasuredReason?: ExitUnmeasuredReasonV1 | null;
  /** Present only on `qualified`. The handle that opens the entry route. */
  clearanceId?: string | null;
  expiresAt?: string | null;
  simulatedRoundTripBps?: number | null;
  simulationBlockNumber?: string | null;
  simulatedReturnedAtomic?: string | null;
}

export interface B20ExitCardProps {
  /** Null before anything has been asked. */
  check: ExitCheckLikeV1 | null;
  /** The profile as the user has it typed. */
  profile: ExitProfileV1;
  onProfileChange: (profile: ExitProfileV1) => void;
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
  /** Runs the sequential simulation. The only path to a confirmed exit. */
  onSimulate: () => void;
  simulating: boolean;
  /**
   * Hands a CONFIRMED opportunity to the existing execution path.
   *
   * Absent on every state but `qualified`, and the card renders no such control
   * without it — a provisional result must not have an entry plan behind it,
   * and the way to guarantee that is for the button not to exist.
   */
  onBuildEntryPlan?: (clearanceId: string) => void;
  /** Threaded in rather than read from the clock so a stale clearance renders
   * identically in a test and in a browser. */
  now?: Date;
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
export const EXIT_UNMEASURED_COPY_V1: Record<ExitUnmeasuredReasonV1, string> = {
  endpoint_degraded:
    'Too many router quotes went unanswered to conclude anything. Try again in a moment.',
  simulation_unavailable: 'The simulation provider did not answer, so nothing could be certified.',
  insufficient_probe_balance:
    'This wallet does not hold enough USDC to simulate the position you asked about. That is about the wallet, not the token.',
  simulation_undecodable:
    'The simulation ran but its asset movements could not be decoded, so the round trip could not be proven.',
  controls_unread: 'This token’s controls have not been read yet, and nothing clears without them.',
};

export const EXIT_REJECTION_COPY_V1: Record<ExitRejectionReasonV1, string> = {
  not_b20: 'The B20 factory does not recognise this address, so none of the control checks apply to it.',
  controls_unreadable:
    'This token’s controls could not be fully read, so nothing here clears it. A partial read is not a pass.',
  transfers_paused: 'Transfers of this token are paused right now. A position could be bought and not sold.',
  transfer_policy_may_block:
    'A transfer policy is active on this token, so it can refuse specific addresses. B20 offers no way to list who is on it, so an exit cannot be confirmed.',
  no_entry_route: 'No route into this token exists at this size.',
  // Measured, 2026-08-09: the sale reverts with Uniswap v4 core's
  // `NotEnoughLiquidity(poolId)` — the pool prices a buy and has nothing to
  // sell into. That is a DEPTH condition at one size and one moment, not a
  // permission and not a permanent property, so the wording no longer claims
  // that no route exists anywhere or that the position can never be sold.
  no_exit_route:
    'Entry priced; no sale could be priced at the measured size. Measured at one size, at one moment — not proof that no route exists anywhere.',
  round_trip_above_tolerance:
    'Even quoted before the entry moves the pool — the flattering direction — the round trip costs more than your limit allows.',
  simulation_reverted:
    'One of the four steps reverted when simulated against the live chain. The round trip does not execute as quoted.',
  simulated_round_trip_above_tolerance:
    'Simulated end to end, the round trip costs more than your limit allows.',
  exit_capacity_below_position:
    'The position you asked for is larger than what can be exited within your slippage tolerance.',
};

/**
 * Whether the entry control may exist at all.
 *
 * Five conditions, and all of them are necessary. The last one is the reason
 * this is a function rather than an inline `&&`: a build with no execution path
 * wired must render NO control, not a disabled one. A greyed-out button is one
 * refactor away from being enabled by accident, and this is the button that
 * spends money.
 */
export function entryPlanAvailableV1(input: {
  check: ExitCheckLikeV1 | null;
  now: Date;
  handlerWired: boolean;
}): boolean {
  const check = input.check;
  if (!check || check.status !== 'qualified') return false;
  if (!check.clearanceId) return false;
  if (!input.handlerWired) return false;
  if (!check.expiresAt) return false;
  return Date.parse(check.expiresAt) > input.now.getTime();
}

/** A qualified result whose clearance has run out. Distinct from "not
 * qualified": the answer was earned and then went stale, and re-running is a
 * different instruction from re-checking. */
export function clearanceExpiredV1(input: { check: ExitCheckLikeV1 | null; now: Date }): boolean {
  const check = input.check;
  if (!check || check.status !== 'qualified') return false;
  if (!check.expiresAt) return false;
  return Date.parse(check.expiresAt) <= input.now.getTime();
}

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
    // Deliberately not a rejection. A throttled search that found nothing is
    // the endpoint, not the token — reported as a refusal it would read as
    // "you cannot sell this", which is a claim nothing here measured.
    return check.unmeasuredReason
      ? EXIT_UNMEASURED_COPY_V1[check.unmeasuredReason]
      : 'Not measured — a check this needs did not answer. Nothing here is a statement about the token.';
  }
  if (check.status === 'rejected') {
    return check.reason ? EXIT_REJECTION_COPY_V1[check.reason] : 'This position was not cleared.';
  }
  if (check.status === 'provisional') {
    // T68D. The exit was priced against a pool the entry had not touched, so
    // this is a bound and not a result. There is no entry plan behind it.
    return `Provisional exit for your ${profile.positionLabel} / ${profile.slippagePercentLabel} profile — the exit was quoted before the entry moved the pool, so the real round trip is worse. Nothing has been simulated yet.`;
  }
  const base = `Exit confirmed for your ${profile.positionLabel} / ${profile.slippagePercentLabel} profile`;
  if (check.viableRouteConfirmed && check.bestRouteConfirmed === false) {
    // Never collapsed into "no exit exists" or into "best route". Both would be
    // claims nothing measured.
    return `${base}. Viable route confirmed · best route not confirmed — some route candidates did not answer.`;
  }
  return base;
}

export function B20ExitCard({
  check,
  profile,
  onProfileChange,
  positionLabel,
  slippagePercentLabel,
  formatTokenAmount,
  loading,
  unavailableReason,
  onCheck,
  onSimulate,
  simulating,
  onBuildEntryPlan,
  now,
}: B20ExitCardProps): React.ReactElement {
  const at = now ?? new Date();
  const entryAvailable = entryPlanAvailableV1({
    check,
    now: at,
    handlerWired: Boolean(onBuildEntryPlan),
  });
  const expired = clearanceExpiredV1({ check, now: at });
  return (
    <div className="panel">
      <div className="ph">
        <h3>Can I get back out?</h3>
        <span className="sub">{check === null ? 'not checked' : check.status}</span>
        <span className="rt">
          <button type="button" className="btn" onClick={onCheck} disabled={loading || simulating}>
            {loading ? 'Quoting the router…' : 'Check exit'}
          </button>
        </span>
      </div>
      <div className="pb">
        <p className="note">
          Buying is easy to check and easy to do. This asks the other question: at your size, does a
          route out exist, and what does the round trip cost.
        </p>

        {/* T68D — the profile is the user's. Every number below is an answer to
            exactly these three, and changing any of them is a new question. */}
        <div>
          <div className="kv">
            <span className="k">Position (USDC)</span>
            <input
              className="goalinput"
              aria-label="Position size in USDC"
              inputMode="numeric"
              value={profile.position}
              onChange={(event) => onProfileChange({ ...profile, position: event.target.value })}
            />
          </div>
          <div className="kv">
            <span className="k">Max round trip (%)</span>
            <input
              className="goalinput"
              aria-label="Maximum round-trip cost in percent"
              inputMode="decimal"
              value={profile.maxRoundTrip}
              onChange={(event) => onProfileChange({ ...profile, maxRoundTrip: event.target.value })}
            />
          </div>
          <div className="kv">
            <span className="k">Max exit slippage (%)</span>
            <input
              className="goalinput"
              aria-label="Maximum exit slippage in percent"
              inputMode="decimal"
              value={profile.maxSlippage}
              onChange={(event) => onProfileChange({ ...profile, maxSlippage: event.target.value })}
            />
          </div>
        </div>

        {unavailableReason ? (
          <p className="note warn">{unavailableReason}</p>
        ) : check === null ? (
          <p className="empty">Nothing has been checked yet.</p>
        ) : (
          <>
            <p className={check.status === 'qualified' ? 'nm' : 'nm warn'}>
              {exitHeadlineV1(check, { positionLabel, slippagePercentLabel })}
            </p>

            <div className="ctarow">
              {check.status === 'provisional' && (
                // The only action a provisional result offers. There is no
                // "build entry plan" here, and there is no prop to render one.
                <button type="button" className="btn" onClick={onSimulate} disabled={simulating}>
                  {simulating ? 'Simulating both legs…' : 'Run full simulation'}
                </button>
              )}
              {check.status === 'unmeasured' && (
                <button type="button" className="btn sec" onClick={onCheck} disabled={loading}>
                  Try again
                </button>
              )}
              {entryAvailable && (
                <button
                  type="button"
                  className="btn"
                  onClick={() => onBuildEntryPlan?.(check.clearanceId!)}
                >
                  Build entry plan
                </button>
              )}
              {expired && (
                // Earned, then went stale. Re-running is a different
                // instruction from re-checking, and the copy says which.
                <button type="button" className="btn" onClick={onSimulate} disabled={simulating}>
                  Qualification expired — run again
                </button>
              )}
            </div>

            {check.status === 'qualified' && (
              <div>
                <div className="kv">
                  <span className="k">Simulated round trip</span>
                  <span className="v mono">
                    {check.simulatedRoundTripBps === null || check.simulatedRoundTripBps === undefined
                      ? 'not measured'
                      : bpsLabelV1(check.simulatedRoundTripBps)}
                  </span>
                </div>
                <div className="kv">
                  <span className="k">Simulated at</span>
                  <span className="v mono">
                    {check.simulationBlockNumber ? `block ${check.simulationBlockNumber}` : 'no block'}
                  </span>
                </div>
                <div className="kv">
                  <span className="k">Clearance expires</span>
                  {/* Short-lived by design: pools move, and a clearance that
                      outlived the state it certified would authorise a trade
                      against numbers nobody measured. */}
                  <span className="v mono">{check.expiresAt ?? 'not issued'}</span>
                </div>
              </div>
            )}

            <div>
              <div className="kv">
                <span className="k">Round trip</span>
                <span className="v mono">
                  {check.roundTripCostBps === null
                    ? 'not measured'
                    : `${bpsLabelV1(check.roundTripCostBps)} of ${positionLabel}`}
                </span>
              </div>
              <div className="kv">
                <span className="k">Exit capacity</span>
                {/* Never interpolated. This is the largest size that was
                    actually probed and came in under tolerance. */}
                <span className="v mono">
                  {check.exitCapacityAtomic === null
                    ? 'none at this tolerance'
                    : `${formatTokenAmount(check.exitCapacityAtomic)} within ${slippagePercentLabel}`}
                </span>
              </div>
              {check.firstFailingAtomic !== null && (
                <div className="kv">
                  <span className="k">First size over tolerance</span>
                  <span className="v mono">{formatTokenAmount(check.firstFailingAtomic)}</span>
                </div>
              )}
              <div className="kv">
                <span className="k">Sizes probed</span>
                <span className={check.capacityInformative ? undefined : 'warn'}>
                  {check.probeCount === 0
                    ? 'none priced'
                    : check.capacityInformative
                      ? `${check.probeCount} measured`
                      : `${check.probeCount} measured — too few to describe depth`}
                </span>
              </div>
              <div className="kv">
                <span className="k">Controls read at</span>
                <span className="v mono">
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
