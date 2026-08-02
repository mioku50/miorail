import React from 'react';
import { shortAddressV1 } from './B20WatchScreen';

void React;

// ---------------------------------------------------------------------------
// T68 — the B20 portfolio.
//
// The B20 tokens a wallet actually holds, each as a card that answers the only
// question a holder has: what can this thing do to my position, and has it done
// anything since I last looked.
//
// The card is built around an ABSENCE rule. Every line is either a value read
// at a stated block or a stated reason there is no value. There is no badge, no
// colour scale and no aggregate — a holder who wants "is it safe" is told what
// the controls PERMIT and what state they were in, which is the only thing this
// data supports.
// ---------------------------------------------------------------------------

export interface B20ExitControlsLikeV1 {
  factoryConfirmed: boolean;
  transfersPaused: boolean;
  transferPolicyActive: boolean;
  controlsFullyRead: boolean;
  supplyCapped: boolean;
  blockNumber: string | null;
}

export interface B20HoldingV1 {
  tokenAddress: string;
  name: string | null;
  symbol: string | null;
  /** Formatted balance, as the portfolio reported it. */
  balanceLabel: string;
  /** Null when no price source covered this token — shown as a stated absence,
   * never as $0. */
  usdLabel: string | null;
  controls: B20ExitControlsLikeV1 | null;
  /** Count of changes since the previous reading, and whether any is acute. */
  changeCount: number;
  hasAcuteChange: boolean;
  /** Null when the token has never been read. */
  lastReadBlock: string | null;
}

/** One control line: what it permits, and what state it is in right now. */
interface ControlLineV1 {
  label: string;
  state: string;
  /** True when this line is something the holder is exposed to now. */
  alarming: boolean;
}

export function controlLinesV1(controls: B20ExitControlsLikeV1 | null): ControlLineV1[] {
  if (!controls) return [];
  return [
    {
      label: 'Transfers',
      state: controls.transfersPaused ? 'paused — cannot be sold' : 'currently open',
      alarming: controls.transfersPaused,
    },
    {
      label: 'Transfer policy',
      // Never "you are blocked". B20 offers no way to enumerate a policy, so
      // the honest statement is that a gate exists.
      state: controls.transferPolicyActive
        ? 'active — specific addresses can be refused'
        : 'none — no address gate',
      alarming: controls.transferPolicyActive,
    },
    {
      label: 'Supply',
      state: controls.supplyCapped ? 'capped on chain' : 'no cap — unbounded issuance',
      alarming: !controls.supplyCapped,
    },
    {
      label: 'Read',
      state: controls.controlsFullyRead
        ? `complete at block ${controls.blockNumber ?? 'unknown'}`
        : 'incomplete — some controls did not answer',
      alarming: !controls.controlsFullyRead,
    },
  ];
}

export interface B20PortfolioPanelProps {
  holdings: readonly B20HoldingV1[];
  /** Non-B20 tokens in the wallet. Counted, not listed: this panel is about
   * B20, and a long list of ordinary tokens would bury it. */
  otherTokenCount: number;
  /** Null when a sweep has run. Otherwise says why there is nothing yet. */
  emptyReason: string | null;
  onOpenToken?: (tokenAddress: string) => void;
  /** T68C — asks the exit question for one holding. */
  onCheckExit?: (tokenAddress: string) => void;
  /** The token the exit card below is currently about, so a holding does not
   * offer to re-run a check whose answer is already on screen. */
  exitCheckedToken?: string | null;
}

export function B20PortfolioPanel({
  holdings,
  otherTokenCount,
  emptyReason,
  onOpenToken,
  onCheckExit,
  exitCheckedToken,
}: B20PortfolioPanelProps): React.ReactElement {
  return (
    <div className="panel">
      <div className="ph">
        <h3>Your B20 tokens</h3>
        <span className="sub">
          {holdings.length === 0
            ? 'none found'
            : `${holdings.length} held · ${otherTokenCount} other token${otherTokenCount === 1 ? '' : 's'} in this wallet`}
        </span>
      </div>
      <div className="pb tight">
        {holdings.length === 0 ? (
          <p className="empty">{emptyReason ?? 'No B20 tokens were found in this wallet.'}</p>
        ) : (
          <div className="cardrows">
            {holdings.map((holding) => {
              const lines = controlLinesV1(holding.controls);
              return (
                <div className="cardrow" key={holding.tokenAddress}>
                  <div className="cr-top">
                    <span className="cr-name">
                      {holding.symbol ?? shortAddressV1(holding.tokenAddress)}
                      {holding.name ? ` · ${holding.name}` : ''}
                    </span>
                    {/* An acute change is the one thing that earns a pill here.
                        Everything else is a row below. */}
                    {holding.hasAcuteChange && <span className="tag b">changed</span>}
                  </div>
                  <div className="cr-nums">
                    <div>
                      <span className="cr-k">Balance</span>
                      <span className="cr-v mono">{holding.balanceLabel}</span>
                    </div>
                    <div>
                      <span className="cr-k">Value</span>
                      {/* A missing price is stated, never rendered as $0 — a
                          zero would read as "worthless", which is a claim. */}
                      <span className="cr-v mono">{holding.usdLabel ?? 'no price source'}</span>
                    </div>
                    <div>
                      <span className="cr-k">Changes</span>
                      <span className="cr-v mono">
                        {holding.lastReadBlock === null
                          ? 'never read'
                          : holding.changeCount === 0
                            ? 'none since last read'
                            : `${holding.changeCount} since last read`}
                      </span>
                    </div>
                  </div>
                  {lines.length === 0 ? (
                    <p className="cr-why">Controls have not been read for this token yet.</p>
                  ) : (
                    <div className="kv">
                      {lines.map((line) => (
                        <div key={line.label}>
                          <span>{line.label}</span>
                          <span className={line.alarming ? 'warn' : undefined}>{line.state}</span>
                        </div>
                      ))}
                    </div>
                  )}
                  {onCheckExit && (
                    // Before "swap this token", because whether you can get
                    // back out is prior to deciding to go in.
                    <button
                      type="button"
                      className="btn sec"
                      onClick={() => onCheckExit(holding.tokenAddress)}
                    >
                      {exitCheckedToken === holding.tokenAddress ? 'Re-check exit' : 'Can I get out?'}
                    </button>
                  )}
                  {onOpenToken && (
                    <button
                      type="button"
                      className="btn sec"
                      onClick={() => onOpenToken(holding.tokenAddress)}
                    >
                      Swap this token
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
