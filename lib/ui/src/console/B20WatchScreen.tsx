import React from 'react';

import { watchRowScheduleViewV1, watchSlaViewV1, type WatchScheduleWireV1, type WatchSlaWireV1 } from './watchSlaView';
import { B20ControlWatchPanel, type B20WatchLikeV1 } from './B20Panels';
import { B20ExitCard, type ExitCheckLikeV1, type ExitProfileV1 } from './B20ExitCard';
import { B20PortfolioPanel, type B20HoldingV1 } from './B20PortfolioPanel';
import { B20ConsolePanel, type B20ConsolePanelModelV1 } from './B20ConsolePanel';
import { isNativeBalanceV1 } from './WalletBalancesCard';

void React;

// ---------------------------------------------------------------------------
// T67F — the B20 tab.
//
// The screen answers one question: did anything change about the tokens I hold?
//
// Three things it will not do:
//
//   * Rank. There is no score, no "risk level" and no ordering by anything but
//     severity of an observed change. A token with no changes is not "safe" —
//     it is a token whose controls have not moved since Miorail last looked.
//   * Fill silence. A token that could not be read says so and does not appear
//     as clean. Tokens the sweep never reached are listed by address.
//   * Imply freshness it does not have. Every group states the block range it
//     compared, and the page states when the sweep ran.
// ---------------------------------------------------------------------------

export interface B20WatchedTokenLikeV1 {
  tokenAddress: string;
  displayName: string | null;
  displaySymbol: string | null;
  outcome: 'watched' | 'not_b20' | 'unreadable';
  watch?: B20WatchLikeV1;
  controls?: {
    factoryConfirmed: boolean;
    transfersPaused: boolean;
    transferPolicyActive: boolean;
    controlsFullyRead: boolean;
    supplyCapped: boolean;
    blockNumber: string | null;
  };
  reason: string | null;
}

export interface B20TrackedTokenLikeV1 {
  tokenAddress: string;
  /** When a sweep last ATTEMPTED this token — including one that ran with
   * nobody watching, and including one that failed. Null means never tried. */
  lastSweptAt: string | null;
  lastOutcome: 'read' | 'not_b20' | 'unreadable' | null;
  /** When the controls were last actually READ. Optional so a client rendering
   * against an API that predates migration 0067 falls back exactly as before. */
  lastReadAt?: string | null;
  /** Phase 8 — what is owed on this ADDRESS, shared with every other account
   * watching it. Null until the sweep has reconciled it, which is "no promise
   * has been made" rather than "never checked". */
  schedule?: WatchScheduleWireV1 | null;
  /** Recorded transitions, newest first. What CHANGED — never the current
   * state repeated back. */
  changes?: readonly { signalId: string; kind: string; occurredAt: string }[];
}

/**
 * What a watched token's last reading says, in one line.
 *
 * The distinction this exists to keep: a token nobody has read yet says so,
 * rather than borrowing the blank space that a token with no changes occupies.
 * "Never read" and "nothing has moved" look identical if you let them.
 */
export function trackedStatusLineV1(entry: B20TrackedTokenLikeV1): string {
  if (entry.lastSweptAt === null) return 'not read yet';
  const when = entry.lastSweptAt.slice(0, 16).replace('T', ' ');
  if (entry.lastOutcome === 'not_b20') return `not a B20 token · read ${when} UTC`;
  if (entry.lastOutcome === 'unreadable') return `could not be read · tried ${when} UTC`;
  return `read ${when} UTC`;
}

// ---------------------------------------------------------------------------
// The same facts, split so a row can lay them out.
//
// `trackedStatusLineV1` packs outcome and timestamp into one string, and the
// row rendered it beside a short address and a button with nothing between
// them: `0xb20000…0101read 2026-08-15 20:33 UTC Remove`. It stays — the MCP and
// the compact contexts still want one line — but a row now asks for the pieces.
// ---------------------------------------------------------------------------

const MONTHS_V1 = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

/** "Aug 15 · 20:33 UTC", from the stored ISO instant. Parsed rather than
 * localised: the value is UTC and a browser timezone would silently move it. */
export function trackedReadAtLabelV1(entry: B20TrackedTokenLikeV1): string {
  if (entry.lastSweptAt === null) return 'not read yet';
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(entry.lastSweptAt);
  // An unparseable stamp is shown verbatim. Guessing at one would be the same
  // class of error as showing a detection time as a launch time.
  if (!parts) return entry.lastSweptAt;
  return `${MONTHS_V1[Number(parts[2]) - 1] ?? parts[2]} ${Number(parts[3])} · ${parts[4]}:${parts[5]} UTC`;
}

// ---------------------------------------------------------------------------
// A control reading has an age, and the age is the point.
//
// The row showed `Last read  Aug 15 · 20:33 UTC` — a true, precise, and nearly
// useless fact, because reading it requires the reader to know today's date and
// do the subtraction. Meanwhile the panel below says "No control changed", and
// a reader who has not done that subtraction takes it as a statement about now.
// It is a statement about August 15.
//
// So the age leads. The absolute stamp stays, as the second line, because a
// control watch is evidence and evidence keeps its timestamp.
//
// The threshold is Miorail's, not a server contract: nothing sweeps tracked
// tokens on a schedule, so there is no `staleAfter` to read. A day is the point
// past which a control reading should not be presented as current state.
// ---------------------------------------------------------------------------
export const TRACKED_READ_STALE_AFTER_MS_V1 = 24 * 60 * 60 * 1000;

export interface TrackedReadAgeV1 {
  /** "7d ago", or null when it has never been read. */
  label: string | null;
  stale: boolean;
}

export function trackedReadAgeV1(entry: B20TrackedTokenLikeV1, now: Date): TrackedReadAgeV1 {
  if (entry.lastSweptAt === null) return { label: null, stale: false };
  const parsed = Date.parse(entry.lastSweptAt);
  // An unparseable stamp is an unknown age, and an unknown age is not a fresh
  // one — but it is not evidence of staleness either, so it claims neither.
  if (!Number.isFinite(parsed)) return { label: null, stale: false };
  const ms = Math.max(0, now.getTime() - parsed);
  const minutes = Math.floor(ms / 60_000);
  const label =
    minutes < 1
      ? 'just now'
      : minutes < 60
        ? `${minutes}m ago`
        : ms < 86_400_000
          ? `${Math.floor(ms / 3_600_000)}h ago`
          : `${Math.floor(ms / 86_400_000)}d ago`;
  return { label, stale: ms >= TRACKED_READ_STALE_AFTER_MS_V1 };
}

/** What the last reading concluded, when that is not simply "it was read".
 * Null keeps the row to two lines in the ordinary case. */
export function trackedOutcomeLabelV1(entry: B20TrackedTokenLikeV1): string | null {
  if (entry.lastSweptAt === null) return null;
  if (entry.lastOutcome === 'not_b20') return 'not a B20 token';
  if (entry.lastOutcome === 'unreadable') return 'could not be read';
  return null;
}

/**
 * The two clocks on a watched row, named for what each one times.
 *
 * The row printed five lines about time in one column, from two unrelated
 * subjects, and the result contradicted itself on production:
 *
 *     Last read
 *     21d ago  STALE
 *     Aug 15 · 20:33 UTC
 *     next check in 8m
 *     last measured 6m ago
 *
 * A reader takes that as one clock and concludes the schedule is broken. It is
 * two, and both are correct. NOTHING reads a token's controls on a timer — the
 * sweep runs when a person presses the button — while the market watch runs
 * every fifteen minutes and had measured six minutes earlier. The 21 days is
 * not a failure; it is the honest age of a reading nobody asked for again, and
 * the row never said so.
 *
 * So: two captions, each with its own subject, its own age, and — for controls —
 * the sentence that explains why the age is what it is. The failed attempt gets
 * its own line rather than overwriting the reading's label, because a failure
 * is a fact about the endpoint and the reading is a fact about the token.
 */
export interface TrackedRowClockV1 {
  id: 'controls' | 'market';
  label: string;
  state: string;
  detail: string | null;
  /** A second, quieter line: the exact stamp, or why nothing refreshes this. */
  note: string | null;
  tone: 'good' | 'neutral' | 'off' | 'warn';
}

export function trackedRowClocksV1(
  entry: B20TrackedTokenLikeV1,
  now: Date,
): { clocks: TrackedRowClockV1[]; failure: string | null } {
  // Prefer the evidence clock. Falling back to the sweep clock is correct only
  // when the last sweep WAS the read; otherwise the instant belongs to a
  // different event and using it would age the wrong thing.
  const readAt =
    entry.lastReadAt ?? (entry.lastOutcome === 'read' ? entry.lastSweptAt : null);
  const readAge = trackedReadAgeV1({ ...entry, lastSweptAt: readAt }, now);
  const controls: TrackedRowClockV1 =
    readAt === null
      ? {
          id: 'controls',
          label: 'Controls',
          state: 'Not read yet',
          detail: null,
          note: 'read only when you press Read B20 controls',
          tone: 'off',
        }
      : {
          id: 'controls',
          label: 'Controls',
          state: `Read ${readAge.label ?? 'at an unknown time'}`,
          detail: trackedReadAtLabelV1({ ...entry, lastSweptAt: readAt }),
          // The missing sentence. An age with no explanation reads as a broken
          // schedule; there is no schedule, and that is the explanation.
          note: readAge.stale ? 'nothing re-reads controls on a timer' : null,
          tone: readAge.stale ? 'warn' : 'good',
        };

  const schedule = entry.schedule ?? null;
  const promise = schedule === null ? null : watchRowScheduleViewV1(schedule, now);
  const market: TrackedRowClockV1 =
    promise === null
      ? {
          id: 'market',
          label: 'Market watch',
          state: 'Not scheduled',
          detail: null,
          note: null,
          tone: 'off',
        }
      : {
          id: 'market',
          label: 'Market watch',
          // Capitalised where the schedule view returns a sentence fragment:
          // this is a caption, not prose.
          state: promise.lastCompleted.replace(/^last measured/, 'Measured').replace(/^nothing measured yet$/, 'Nothing measured yet'),
          detail: promise.next,
          note: null,
          tone: promise.tone,
        };

  // One failure line for the row, attributed to the clock it belongs to. The
  // controls attempt wins when it is the newer of the two, because that is the
  // one a reader is about to misread as the reading itself.
  const controlsFailed = entry.lastOutcome !== null && entry.lastOutcome !== 'read';
  const failure = controlsFailed
    ? entry.lastOutcome === 'not_b20'
      ? `Last attempt ${trackedReadAgeV1(entry, now).label ?? ''} found this is not a B20 token. Nothing about controls was established.`.replace('  ', ' ')
      : `Last attempt ${trackedReadAgeV1(entry, now).label ?? ''} could not read this contract. That is about the endpoint, not the token — the reading above still stands.`.replace('  ', ' ')
    : (promise?.lastFailure ?? null);

  return { clocks: [controls, market], failure };
}

/**
 * A display symbol for a watched address, from data already on this screen.
 *
 * Three sources, in the order of how much this page knows about the token: the
 * control watch reads the token's own name, the portfolio panel carries one for
 * every B20 holding it joined, and the wallet balances carry one for everything
 * a token provider reported.
 *
 * The third was the one missing, and it is the one that matters most: the
 * portfolio and the control watch are both EMPTY until a sweep runs, while the
 * balances card is populated on load — so a wallet showing "MIO 19210.9481" at
 * the top of the page still had a bare `0xb200…0101` in its watchlist below.
 *
 * Nothing here fetches. An address none of the three has seen keeps the address
 * as its label: a watchlist entry is something the user typed, and inventing a
 * name for it would be worse than showing what they pasted.
 */
export function trackedTokenSymbolV1(
  tokenAddress: string,
  source: {
    tokens: readonly { tokenAddress: string; displaySymbol: string | null; displayName: string | null }[];
    holdings: readonly { tokenAddress: string; symbol: string | null }[];
    /** Wallet balances, keyed by the provider's `address` field. Optional so a
     * host that has not wired it behaves exactly as before. */
    walletTokens?: readonly { address: string; symbol?: string | null; name?: string | null }[];
  },
): string | null {
  const address = tokenAddress.toLowerCase();
  const watched = source.tokens.find((token) => token.tokenAddress.toLowerCase() === address);
  if (watched?.displaySymbol) return watched.displaySymbol;
  if (watched?.displayName) return watched.displayName;
  const held = source.holdings.find((holding) => holding.tokenAddress.toLowerCase() === address);
  if (held?.symbol) return held.symbol;
  // `native` is the provider's pseudo-address for ETH, not a contract. Guarded
  // rather than relied upon to never collide: this function takes a string, and
  // a lookup that can return "ETH" for anything but a real ETH row is a wrong
  // name printed with confidence.
  if (isNativeBalanceV1(address)) return null;
  const balance = (source.walletTokens ?? []).find(
    (token) =>
      typeof token.address === 'string' &&
      !isNativeBalanceV1(token.address) &&
      token.address.toLowerCase() === address,
  );
  return balance?.symbol ?? balance?.name ?? null;
}

export interface B20WatchScreenModelV1 {
  /** Injected so an age never depends on when a test happens to run. */
  now: Date;
  tokens: readonly B20WatchedTokenLikeV1[];
  /** T68 — addresses the user added by hand, persisted between visits.
   *
   * This is not a convenience. No balance provider indexes B20 — the tokens are
   * precompiles whose `eth_getCode` returns one byte — so a wallet holding one
   * is reported as holding nothing, and a portfolio-driven sweep never learns
   * the address exists. Typing it in is the only complete path.
   *
   * T68B — each entry now carries when MIORAIL last read it, which is a
   * different fact from when this browser last asked. */
  trackedTokens: readonly B20TrackedTokenLikeV1[];
  /** Phase 8 — the promise, and the arithmetic behind it. Null on a build
   * whose server does not send one. */
  watchSla?: WatchSlaWireV1 | null;
  /** Enrols the official corpus. Absent when the surface is not wired — a
   * control that leads to a refusal is worse than an absent one. */
  onWatchOfficialAssets?: (() => void) | null;
  /** Addresses this page has already read a balance for and which are not yet
   * watched. Suggested, never enrolled: reading a wallet changes what the
   * operator pays for and what the account discloses. */
  suggestedFromHoldings?: readonly string[];
  /** How many more the account may add. Stated before a user types an address
   * and is refused. */
  trackRemaining: number | null;
  /** Why the list could not be loaded or changed. Never a claim about a token. */
  trackError: string | null;
  onTrackToken: (tokenAddress: string) => void;
  onUntrackToken: (tokenAddress: string) => void;
  /** T68 — the B20 tokens this wallet holds, joined with their balances. */
  holdings: readonly B20HoldingV1[];
  /**
   * Stage 08 — the global console, with the Portfolio scope available.
   *
   * It renders here rather than only on Discover because this is the page that
   * has read the wallet. Discover shows the same panel with three public
   * scopes; the fourth appears where the holdings actually are.
   */
  console?: B20ConsolePanelModelV1;
  /** Non-B20 tokens in the wallet, counted rather than listed. */
  otherTokenCount: number;
  /**
   * The wallet balances this page already renders above, used ONLY to name a
   * watched address. Optional while a host rolls forward.
   *
   * No request is made for it and none should be: this is the label, and a
   * label is not worth an RPC. An address the provider never reported keeps the
   * address as its name.
   */
  walletTokens?: readonly { address: string; symbol?: string | null; name?: string | null }[];
  onOpenToken?: (tokenAddress: string, amountDecimal: string | null) => void;
  /** T68C — the exit check, for the one token it was last run on. One at a
   * time on purpose: each check is a dozen-odd metered router calls, and a
   * page that ran one per holding on mount would be a page nobody could
   * afford to open. */
  exit: {
    tokenAddress: string | null;
    check: ExitCheckLikeV1 | null;
    profile: ExitProfileV1;
    onProfileChange: (profile: ExitProfileV1) => void;
    positionLabel: string;
    slippagePercentLabel: string;
    formatTokenAmount: (atomic: string) => string;
    loading: boolean;
    simulating: boolean;
    /** Decimal USDC, or null when this server does not charge for it. */
    simulationPriceUsdc?: string | null;
    unavailableReason: string | null;
    onCheck: (tokenAddress: string) => void;
    onSimulate: (tokenAddress: string) => void;
    /** Absent unless this build has an execution path to hand a confirmed
     * opportunity to. The card renders no entry control without it. */
    onBuildEntryPlan?: (input: { tokenAddress: string; clearanceId: string }) => void;
  };
  notChecked: readonly string[];
  checkedAt: string | null;
  loading: boolean;
  /** Why no sweep is possible. Rendered instead of the list. */
  unavailableReason: string | null;
  onSweep: () => void;
  /** How many unique wallet/watchlist addresses were queued for the bounded
   * sweep. These are candidates until the B20 factory confirms them. */
  candidateCount: number;
}

function tokenLabelV1(token: B20WatchedTokenLikeV1): string {
  if (token.displaySymbol && token.displayName) return `${token.displayName} (${token.displaySymbol})`;
  return token.displaySymbol ?? token.displayName ?? shortAddressV1(token.tokenAddress);
}

export function shortAddressV1(address: string): string {
  return address.length > 12 ? `${address.slice(0, 8)}…${address.slice(-4)}` : address;
}

/** Tokens that actually changed, most severe first. The ordering is over
 * OBSERVED changes and nothing else — there is no ranking of tokens. */
export function changedTokensV1(
  tokens: readonly B20WatchedTokenLikeV1[],
): B20WatchedTokenLikeV1[] {
  const withChanges = tokens.filter(
    (token) => token.watch?.status === 'compared' && token.watch.changes.length > 0,
  );
  const acute = (token: B20WatchedTokenLikeV1) =>
    token.watch?.changes.some((change) => change.severity === 'acute') ? 0 : 1;
  return withChanges.sort(
    (left, right) =>
      acute(left) - acute(right) ||
      (right.watch?.changes.length ?? 0) - (left.watch?.changes.length ?? 0),
  );
}

export function B20WatchScreen(model: B20WatchScreenModelV1): React.ReactElement {
  const changed = changedTokensV1(model.tokens);
  const steady = model.tokens.filter(
    (token) => token.watch?.status === 'compared' && token.watch.changes.length === 0,
  );
  const baseline = model.tokens.filter((token) => token.watch?.status === 'first_observation');
  const unreadable = model.tokens.filter((token) => token.outcome === 'unreadable');
  const notB20 = model.tokens.filter((token) => token.outcome === 'not_b20');

  return (
    <section aria-label="B20 control watch">
      {/* The portfolio comes first: what you hold outranks what you could
          check. A user opens this tab because of a position, not a sweep. */}
      <B20PortfolioPanel
        holdings={model.holdings}
        otherTokenCount={model.otherTokenCount}
        emptyReason={
          model.checkedAt === null
            // The button is called "Read B20 controls". It has been for a
            // while; this sentence still sent people looking for a "Check now"
            // that is not on the page.
            ? 'Nothing has been checked yet — press Read B20 controls to read this wallet’s tokens.'
            : model.unavailableReason
        }
        checked={model.checkedAt !== null}
        loading={model.loading}
        onCheckWallet={model.onSweep}
        onOpenToken={model.onOpenToken}
        onCheckExit={model.exit.onCheck}
        exitCheckedToken={model.exit.tokenAddress}
      />

      {/* Directly under the holdings it ranks. The Portfolio scope reads the
          same tokens the panel above lists, and appears only because this page
          has read them. */}
      {model.console && <B20ConsolePanel {...model.console} />}

      {/* Second, because it answers a question you only have once you hold
          something — and because it is the only card here that costs money to
          fill in. */}
      <B20ExitCard
        check={model.exit.check}
        tokenLabel={
          model.exit.tokenAddress === null
            ? null
            : (model.holdings.find((holding) => holding.tokenAddress === model.exit.tokenAddress)?.symbol
              ?? shortAddressV1(model.exit.tokenAddress))
        }
        tokenDecimals={
          model.exit.tokenAddress === null
            ? null
            : (model.holdings.find((holding) => holding.tokenAddress === model.exit.tokenAddress)?.decimals ?? null)
        }
        profile={model.exit.profile}
        onProfileChange={model.exit.onProfileChange}
        positionLabel={model.exit.positionLabel}
        slippagePercentLabel={model.exit.slippagePercentLabel}
        formatTokenAmount={model.exit.formatTokenAmount}
        loading={model.exit.loading}
        unavailableReason={model.exit.unavailableReason}
        simulating={model.exit.simulating}
        simulationPriceUsdc={model.exit.simulationPriceUsdc ?? null}
        onCheck={() => {
          if (model.exit.tokenAddress) model.exit.onCheck(model.exit.tokenAddress);
        }}
        onSimulate={() => {
          if (model.exit.tokenAddress) model.exit.onSimulate(model.exit.tokenAddress);
        }}
        onBuildEntryPlan={
          model.exit.onBuildEntryPlan && model.exit.tokenAddress
            ? (clearanceId) =>
                model.exit.onBuildEntryPlan?.({
                  tokenAddress: model.exit.tokenAddress!,
                  clearanceId,
                })
            : undefined
        }
      />

      <div className="panel">
        <div className="ph">
          <h3>Track B20 tokens</h3>
          <span className="sub">
            {model.trackedTokens.length === 0
              ? 'none added'
              : `${model.trackedTokens.length} watched${
                  model.trackRemaining === null ? '' : ` · ${model.trackRemaining} slot${model.trackRemaining === 1 ? '' : 's'} left`
                }`}
          </span>
        </div>
        <div className="pb">
          {/* What to do, in one line. The reason a B20 address has to be typed
              at all is a real and non-obvious fact, but it is the answer to a
              question rather than the first thing to read — so it sits under
              the question a reader would actually ask. */}
          <p className="note">Add a B20 address to monitor its controls and changes.</p>
          <details className="discover-guide">
            <summary>Why do I need to add an address?</summary>
            <p>
              Balance providers do not index B20 — the tokens are precompiles, and a wallet holding one
              is reported as holding nothing. Miorail never receives the address from a balance
              lookup, so pasting it here is the only complete path.
            </p>
            {/* The retention claim, and the only one this page is allowed to
                make: Miorail reads these when nobody is here. Each row says when
                it last did, so the claim is checkable rather than reassuring. */}
            <p>
              Miorail reads these on its own and records what changed. Opening this page is not what
              makes that happen.
            </p>
          </details>
          {model.trackError && <p className="note warn">{model.trackError}</p>}
          <form
            className="goalline"
            onSubmit={(event) => {
              event.preventDefault();
              const field = event.currentTarget.elements.namedItem('b20-address');
              const value = field instanceof HTMLInputElement ? field.value.trim() : '';
              if (!/^0x[0-9a-fA-F]{40}$/.test(value)) return;
              model.onTrackToken(value.toLowerCase());
              if (field instanceof HTMLInputElement) field.value = '';
            }}
          >
            <input
              className="goalinput"
              name="b20-address"
              aria-label="B20 token address"
              placeholder="0xB200…"
              pattern="^0x[0-9a-fA-F]{40}$"
            />
            <button type="submit" className="btn">
              Track
            </button>
          </form>
          {/* The promise, stated once above the list rather than repeated on
              every row. Both halves of "checked every 30 minutes · next check
              in 11 minutes" come from the same stored schedule, so they cannot
              disagree the day the list grows. */}
          {model.watchSla && (
            <>
              <p className={watchSlaViewV1(model.watchSla).tone === 'warn' ? 'note warn' : 'lnote'}>
                <strong>{watchSlaViewV1(model.watchSla).headline}</strong>{' '}
                {watchSlaViewV1(model.watchSla).detail}
              </p>
            </>
          )}

          {(model.onWatchOfficialAssets || (model.suggestedFromHoldings?.length ?? 0) > 0) && (
            <div className="ctarow">
              {model.onWatchOfficialAssets && (
                <button type="button" className="btn sec" onClick={model.onWatchOfficialAssets}>
                  Watch every official asset
                </button>
              )}
              {(model.suggestedFromHoldings?.length ?? 0) > 0 && (
                <span className="nt">
                  {model.suggestedFromHoldings!.length} token
                  {model.suggestedFromHoldings!.length === 1 ? '' : 's'} you hold are not watched —
                  add them from the list above. Miorail does not enrol a wallet’s positions on its
                  own.
                </span>
              )}
            </div>
          )}

          {model.trackedTokens.length > 0 && (
            <ul className="watchrows">
              {model.trackedTokens.map((entry) => {
                // A symbol only if one is already on this screen. Nothing here
                // fetches: the control watch and the portfolio both carry
                // display names for addresses they have read, and an address
                // neither has seen keeps the address as its own name.
                const symbol = trackedTokenSymbolV1(entry.tokenAddress, model);
                const outcome = trackedOutcomeLabelV1(entry);
                const age = trackedReadAgeV1(
                  { ...entry, lastSweptAt: entry.lastReadAt ?? (entry.lastOutcome === 'read' ? entry.lastSweptAt : null) },
                  model.now,
                );
                const { clocks, failure } = trackedRowClocksV1(entry, model.now);
                return (
                  <li className="watchrow" key={entry.tokenAddress}>
                    <div className="watchrow-id">
                      {symbol ? (
                        <>
                          <strong className="watchrow-name">{symbol}</strong>
                          <span className="watchrow-addr mono">{shortAddressV1(entry.tokenAddress)}</span>
                        </>
                      ) : (
                        <strong className="watchrow-name mono">{shortAddressV1(entry.tokenAddress)}</strong>
                      )}
                    </div>
                    <div className="watchrow-read">
                      {/* Two clocks, named. They were five lines in one column
                          from two unrelated subjects, and on production the
                          stack read "Last read 21d ago STALE" directly above
                          "last measured 6m ago" — which a reader takes as one
                          clock contradicting itself. Both were true: nothing
                          re-reads controls on a timer, and the market watch had
                          run six minutes earlier. */}
                      <ul className="watchrow-clocks" aria-label="What was read, and when">
                        {clocks.map((clock) => (
                          <li key={clock.id} data-tone={clock.tone}>
                            <span className="watchrow-clock-k">{clock.label}</span>
                            <strong className="watchrow-clock-v">
                              {clock.state}
                              {clock.id === 'controls' && age.stale && <span className="tag a">STALE</span>}
                            </strong>
                            {clock.detail && (
                              <span className="watchrow-clock-d">{clock.detail}</span>
                            )}
                            {clock.note && <span className="watchrow-clock-d">{clock.note}</span>}
                          </li>
                        ))}
                      </ul>
                      {/* The failed attempt, on its own line rather than
                          overwriting the reading's label. A failure is a fact
                          about the endpoint; the reading is a fact about the
                          token, and it survives. */}
                      {failure && <span className="watchrow-note warn">{failure}</span>}
                      {/* "not a B20 token" is an answer about the address, kept
                          when it is not already the failure line above. */}
                      {outcome && !failure && <span className="watchrow-note">{outcome}</span>}
                      {(entry.changes?.length ?? 0) > 0 && (
                        <span className="watchrow-note">
                          {entry.changes!.length} recorded change
                          {entry.changes!.length === 1 ? '' : 's'}, newest{' '}
                          {entry.changes![0]!.kind.replace(/_/g, ' ')}
                        </span>
                      )}
                    </div>
                    <div className="watchrow-acts">
                      {/* Re-reads through the same sweep the panel's own button
                          runs — there is no per-token read endpoint, and
                          inventing a label for one would promise a narrower
                          action than actually happens. */}
                      <button
                        type="button"
                        className="btn sec"
                        onClick={model.onSweep}
                        disabled={model.loading}
                      >
                        {model.loading ? 'Reading…' : 'Read again'}
                      </button>
                      <button
                        type="button"
                        className="btn sec watchrow-remove"
                        onClick={() => model.onUntrackToken(entry.tokenAddress)}
                      >
                        Remove
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>

      <div className="panel">
        <div className="ph">
          <h3>B20 control watch</h3>
          <span className="sub">
            {model.tokens.length === 0
              ? `${model.candidateCount} wallet/watchlist address${model.candidateCount === 1 ? '' : 'es'} queued`
              : `${model.tokens.length} of ${model.candidateCount} candidate${model.candidateCount === 1 ? '' : 's'} checked`}
          </span>
          <span className="rt">
            <button type="button" className="btn" onClick={model.onSweep} disabled={model.loading}>
              {model.loading ? 'Reading B20 controls…' : 'Read B20 controls'}
            </button>
          </span>
        </div>
        <div className="pb">
          <p className="note">
            What a token’s controls did since Miorail last read them. Miorail cannot see who holds a
            role — B20 offers no way to list role holders — so this reports what changed, never who
            changed it.
          </p>
          {model.unavailableReason ? (
            <p className="note">{model.unavailableReason}</p>
          ) : model.checkedAt ? (
            <p className="lnote">Last checked {model.checkedAt}.</p>
          ) : (
            <p className="empty">Nothing has been checked yet.</p>
          )}
          {model.notChecked.length > 0 && (
            <p className="note warn">
              {model.notChecked.length} token{model.notChecked.length === 1 ? ' was' : 's were'} not
              reached: {model.notChecked.map(shortAddressV1).join(', ')}. They were not checked, which
              is not the same as unchanged.
            </p>
          )}
        </div>
      </div>

      {changed.length > 0 && (
        <div className="panel">
          <div className="ph">
            <h3>Changed</h3>
            <span className="sub">most exposed first</span>
          </div>
          <div className="pb tight">
            {changed.map((token) => (
              <div key={token.tokenAddress}>
                <p className="nm">{tokenLabelV1(token)}</p>
                <p className="lnote mono">{token.tokenAddress}</p>
                <B20ControlWatchPanel watch={token.watch ?? null} />
              </div>
            ))}
          </div>
        </div>
      )}

      {steady.length > 0 && (
        <div className="panel">
          <div className="ph">
            <h3>No change</h3>
            <span className="sub">{steady.length} compared</span>
          </div>
          <div className="pb tight">
            {/* Not "safe". These are tokens whose controls have not moved since
                the previous reading, and the block range says between when. */}
            {steady.map((token) => (
              <div className="kv" key={token.tokenAddress}>
                <span className="k">{tokenLabelV1(token)}</span>
                <span className="v mono">
                  {token.watch?.fromBlock ?? '—'} → {token.watch?.toBlock ?? '—'}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {baseline.length > 0 && (
        <div className="panel">
          <div className="ph">
            <h3>First reading</h3>
            <span className="sub">{baseline.length} recorded</span>
          </div>
          <div className="pb tight">
            <p className="note">
              These were read for the first time, so there is nothing to compare them against yet.
              The next check will compare against this reading.
            </p>
            {baseline.map((token) => (
              <div className="kv" key={token.tokenAddress}>
                <span className="k">{tokenLabelV1(token)}</span>
                <span className="v mono">block {token.watch?.toBlock ?? '—'}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {unreadable.length > 0 && (
        <div className="panel">
          <div className="ph">
            <h3>Could not be read</h3>
            <span className="sub">{unreadable.length}</span>
          </div>
          <div className="pb tight">
            {unreadable.map((token) => (
              <div className="kv" key={token.tokenAddress}>
                <span className="v mono">{shortAddressV1(token.tokenAddress)}</span>
                <span className="v">{token.reason ?? 'no reason reported'}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {notB20.length > 0 && (
        <div className="panel">
          <div className="ph">
            <h3>Not B20</h3>
            <span className="sub">{notB20.length}</span>
          </div>
          <div className="pb tight">
            {/* An ordinary answer, not a finding. Most tokens in a wallet are
                not B20, and this card makes no claim about them either way. */}
            <p className="note">
              These are not B20 tokens, so they have no B20 controls to watch. Ordinary ERC-20
              analysis is not part of this page.
            </p>
            <p className="lnote">{notB20.map((token) => tokenLabelV1(token)).join(', ')}</p>
          </div>
        </div>
      )}
    </section>
  );
}
