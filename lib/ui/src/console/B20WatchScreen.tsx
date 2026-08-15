import React from 'react';
import { B20ControlWatchPanel, type B20WatchLikeV1 } from './B20Panels';
import { B20ExitCard, type ExitCheckLikeV1, type ExitProfileV1 } from './B20ExitCard';
import { B20PortfolioPanel, type B20HoldingV1 } from './B20PortfolioPanel';
import { B20ConsolePanel, type B20ConsolePanelModelV1 } from './B20ConsolePanel';

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
  /** When a sweep last read this token — including one that ran with nobody
   * watching. Null means never read, which is not the same as unchanged. */
  lastSweptAt: string | null;
  lastOutcome: 'read' | 'not_b20' | 'unreadable' | null;
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

export interface B20WatchScreenModelV1 {
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
            ? 'Nothing has been checked yet — press Check now to read this wallet’s tokens.'
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
          <h3>Watched tokens</h3>
          <span className="sub">
            {model.trackedTokens.length === 0
              ? 'none added'
              : `${model.trackedTokens.length} watched${
                  model.trackRemaining === null ? '' : ` · ${model.trackRemaining} slot${model.trackRemaining === 1 ? '' : 's'} left`
                }`}
          </span>
        </div>
        <div className="pb">
          <p className="note">
            Balance providers do not index B20 — the tokens are precompiles, and a wallet holding one
            is reported as holding nothing. Paste a token address to watch it regardless.
          </p>
          {/* The retention claim, and the only one this page is allowed to
              make: Miorail reads these when nobody is here. Each row says when
              it last did, so the claim is checkable rather than reassuring. */}
          <p className="lnote">
            Miorail reads these on its own and records what changed. Opening this page is not what
            makes that happen.
          </p>
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
          {model.trackedTokens.length > 0 && (
            <div className="kv">
              {model.trackedTokens.map((entry) => (
                <div key={entry.tokenAddress}>
                  <span className="v mono">{shortAddressV1(entry.tokenAddress)}</span>
                  <span className={entry.lastOutcome === 'unreadable' ? 'warn' : undefined}>
                    {trackedStatusLineV1(entry)}
                  </span>
                  <button
                    type="button"
                    className="btn sec"
                    onClick={() => model.onUntrackToken(entry.tokenAddress)}
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
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
