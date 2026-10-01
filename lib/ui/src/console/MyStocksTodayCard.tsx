'use client';

import React from 'react';
import type { StockBriefV1 } from '@mioagent/rwa-market-reality/stock-brief';
import { myDividendsViewV1 } from './dividendCalendarView';
import { multiplierDecimalV1 } from './multiplierScheduleView';
import { signalFeedViewV1 } from './rwaDiscoverView';
import type { StockPositionQuoteV1 } from '@mioagent/rwa-market-reality/stock-position-quote';
import { MyStockCashOut } from './MyStockCashOut';

export interface MyStocksTodayModelV1 {
  data: StockBriefV1 | null;
  loading: boolean;
  failed: boolean;
  refreshing: boolean;
  returning: boolean;
  onRefresh: () => void;
  walletKey?: string;
  onMeasureCashOut?: (tokenAddress: string) => Promise<StockPositionQuoteV1>;
  onMarkRead?: () => void;
  markedRead?: boolean;
  marking?: boolean;
  markFailed?: boolean;
  onView?: (view: 'unread' | 'history') => void;
  onNextPage?: () => void;
  onFirstPage?: () => void;
  isLaterPage?: boolean;
}

function money(value: string) {
  const n = Number(value);
  return n > 0 && n < 0.01
    ? 'less than $0.01'
    : `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function date(iso: string) {
  return (
    new Date(iso).toLocaleString('en-US', {
      timeZone: 'UTC',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }) + ' UTC'
  );
}

/** The holder's first stop. Links open intelligence; no click prepares a trade
 * or enrolls a watch. The public board remains below it for every visitor. */
export function MyStocksTodayCard({ model }: { model: MyStocksTodayModelV1 }) {
  const data = model.data;
  const dividendView = data ? myDividendsViewV1({ data: data.dividends, failed: false }) : null;
  const feed = data?.changes ? signalFeedViewV1(data.changes, new Date(data.generatedAt)) : null;
  const update = (card: NonNullable<typeof feed>['cards'][number]) => {
    const item = data?.inbox.items.find((row) => row.signalId === card.signalId);
    const recorded = data?.changes?.cards.find((row) => row.signalId === card.signalId);
    return (
      <li key={card.signalId}>
        <span className="stocks-today-relevance">
          {item?.relation === 'held' ? 'Related to your holdings' : 'A market you watch'}
        </span>
        <strong>
          {card.subject.label}: {card.title}
        </strong>
        <p>{card.detail}</p>
        <span className="lnote">
          Occurred {recorded ? date(recorded.occurredAt) : card.occurred}
          {recorded && recorded.recordedAt !== recorded.occurredAt
            ? ` · recorded ${date(recorded.recordedAt)}`
            : ''}
        </span>
        {item ? (
          <div className="stocks-today-change-links">
            <a href={item.inspectionHref}>Inspect this contract</a>
            {item.relatedInspectionHref ? (
              <a href={item.relatedInspectionHref}>
                {item.relation === 'held' ? 'Inspect my stock' : 'Inspect watched contract'}
              </a>
            ) : null}
          </div>
        ) : null}
      </li>
    );
  };
  return (
    <section id="my-stocks-today" className="panel stocks-today" aria-label="My stocks today">
      <div className="ph">
        <h3>My stocks today</h3>
        <button
          type="button"
          className="btn sec"
          onClick={model.onRefresh}
          disabled={model.refreshing}
        >
          {model.refreshing ? 'Reading…' : 'Refresh'}
        </button>
      </div>
      <div className="pb">
        {model.failed ? (
          <p className="lnote" role="status">
            Your overview could not be refreshed.{' '}
            {data
              ? 'The dated readings below are from the last successful read.'
              : 'This says nothing about your holdings.'}
          </p>
        ) : null}
        {!data && model.loading ? (
          <p className="lnote" role="status">
            Reading your stocks on Base…
          </p>
        ) : null}
        {data ? (
          <React.Fragment>
            <p className="lnote">
              Your wallet · balances at block {data.balanceBlock.toLocaleString('en-US')} ·{' '}
              {date(data.balanceReadAt)}
            </p>
            {data.holdings.length === 0 ? (
              <p>
                You hold none of the {data.coverage.tokenAddresses.length} Coinbase stock contracts
                read here. Explore the stocks below, or check the markets you watch.
              </p>
            ) : null}
            <div className="stocks-today-holdings">
              {data.holdings.map((holding) => {
                const mine = dividendView?.rows.find((row) => row.key === holding.tokenAddress);
                const multiplier = multiplierDecimalV1(holding.multiplierWad)
                  ?.replace(/0+$/, '')
                  .replace(/\.$/, '');
                return (
                  <article key={holding.tokenAddress} className="stocks-today-holding">
                    <div className="stocks-today-position">
                      <a href={`/stocks/${encodeURIComponent(holding.symbol.toLowerCase())}`}>
                        {holding.tokenSymbol}
                      </a>
                      <span className="mono">{holding.tokens} held</span>
                      <span>
                        {holding.reference ? (
                          <>
                            <strong>≈ {money(holding.reference.valueUsd)}</strong>
                            <span className="lnote">
                              {' '}
                              Reference value · published {date(holding.reference.publishedAt)}
                            </span>
                          </>
                        ) : (
                          <span className="lnote">Reference value unavailable</span>
                        )}
                      </span>
                    </div>
                    {model.onMeasureCashOut ? (
                      <MyStockCashOut
                        key={`${model.walletKey}:${holding.tokenAddress}`}
                        tokenAddress={holding.tokenAddress}
                        tokenSymbol={holding.tokenSymbol}
                        overviewTokens={holding.tokens}
                        onMeasure={model.onMeasureCashOut}
                      />
                    ) : null}
                    {mine?.lines[0] ? <p>{mine.lines[0]}</p> : null}
                    {holding.schedule ? (
                      <p className="stocks-today-schedule">
                        The issuer scheduled {multiplierDecimalV1(holding.schedule.multiplierWad)}{' '}
                        shares per token from {date(holding.schedule.effectiveAt)}. It is not in
                        force at the balance block.
                      </p>
                    ) : null}
                    <details>
                      <summary>Shares and dividend record</summary>
                      <p className="lnote">
                        {multiplier
                          ? `One token represented ${multiplier} shares at the balance block.`
                          : 'Shares per token could not be read at this block.'}
                      </p>
                      {holding.scheduleRead === 'unavailable' ? (
                        <p className="lnote">The pending multiplier schedule could not be read.</p>
                      ) : null}
                      {mine?.lines.slice(1).map((line) => (
                        <p key={line}>{line}</p>
                      ))}
                      <p className="lnote mono">{holding.tokenAddress}</p>
                    </details>
                  </article>
                );
              })}
            </div>
            {dividendView?.total ? <p>{dividendView.total}</p> : null}
            <div className="stocks-today-changes">
              <div className="stocks-today-changes-header">
                <h4>{data.inbox.view === 'history' ? 'Your update history' : 'Unread updates'}</h4>
                {model.onMarkRead && data.inbox.view === 'unread' ? (
                  <button
                    type="button"
                    className="btn sec"
                    onClick={model.onMarkRead}
                    disabled={
                      model.marking ||
                      !data.inbox.reviewToken ||
                      model.failed ||
                      model.refreshing ||
                      data.changesUnavailable ||
                      data.changesTruncated
                    }
                  >
                    {model.marking
                      ? 'Saving…'
                      : data.inbox.nextCursor
                        ? 'Mark this page as read'
                        : 'Mark as read'}
                  </button>
                ) : null}
              </div>
              <p className="lnote">
                Recorded changes for stocks you hold now and {data.watchedCount} watched contract
                {data.watchedCount === 1 ? '' : 's'} · from {date(data.since)}.{' '}
                {data.windowClamped ? 'This overview reaches back seven days.' : ''}
              </p>
              {model.onView ? (
                <div className="stocks-today-change-links" role="group" aria-label="Update view">
                  <button
                    className="btn sec"
                    type="button"
                    aria-pressed={data.inbox.view === 'unread'}
                    disabled={model.marking}
                    onClick={() => model.onView?.('unread')}
                  >
                    Unread
                  </button>
                  <button
                    className="btn sec"
                    type="button"
                    aria-pressed={data.inbox.view === 'history'}
                    disabled={model.marking}
                    onClick={() => model.onView?.('history')}
                  >
                    History
                  </button>
                </div>
              ) : null}
              {data.inbox.reviewedAt ? (
                <p className="lnote">
                  Last marked as read {date(data.inbox.reviewedAt)} · shared with your other clients
                  for this wallet.
                </p>
              ) : null}
              {model.markedRead ? (
                <p className="lnote" role="status">
                  Read receipt saved for this wallet in web, Base App and connected MCP.
                </p>
              ) : null}
              {model.markFailed ? (
                <p className="lnote" role="alert">
                  Could not save the read receipt. Refresh and try again; these updates remain
                  unread.
                </p>
              ) : null}
              {data.inbox.view === 'unread' ? (
                <p className="lnote">
                  Opening or refreshing does not mark updates as read. Unread entries remain beyond
                  seven days.
                </p>
              ) : null}
              {data.changesUnavailable ? (
                <p>Changes could not be read. No claim about a quiet market can be made.</p>
              ) : feed?.cards.length ? (
                <React.Fragment>
                  <p>
                    {data.inbox.heldCount} related to your holdings · {data.inbox.watchedCount} to
                    markets you watch.
                  </p>
                  <ul>{feed.cards.slice(0, 3).map(update)}</ul>
                </React.Fragment>
              ) : (
                <p>
                  {data.inbox.view === 'unread'
                    ? 'No unread update is recorded for your current stocks and watches.'
                    : 'No relevant change is recorded in this history window.'}{' '}
                  Coverage is limited to the measurements below.
                </p>
              )}
              {feed && feed.cards.length > 3 ? (
                <details>
                  <summary>{feed.cards.length - 3} more recorded changes</summary>
                  <ul>{feed.cards.slice(3).map(update)}</ul>
                </details>
              ) : null}
              {data.inbox.nextCursor && model.onNextPage ? (
                <p>
                  <button
                    className="btn sec"
                    type="button"
                    disabled={model.refreshing || model.marking}
                    onClick={model.onNextPage}
                  >
                    Older updates
                  </button>
                </p>
              ) : null}
              {model.isLaterPage && model.onFirstPage ? (
                <p>
                  <button
                    className="btn sec"
                    type="button"
                    disabled={model.refreshing || model.marking}
                    onClick={model.onFirstPage}
                  >
                    Newest updates
                  </button>
                </p>
              ) : null}
              {data.inbox.nextCursor ? (
                <p className="lnote">
                  More entries are available. Marking this page leaves other pages unread.
                </p>
              ) : null}
              {data.changesTruncated ? (
                <p className="lnote">
                  The change page is full; older changes may be missing. It cannot be marked as
                  read.
                </p>
              ) : null}
              <p className="lnote">
                Listed by when Miorail recorded them; an older event can arrive later. This does not
                establish that you held the token when it occurred.
              </p>
            </div>
            <details className="stocks-today-coverage">
              <summary>What was measured</summary>
              <p className="lnote">{data.coverage.note}</p>
              <p className="lnote">
                Reference values include the feed’s dividend multiplier. They are not sale proceeds.
                Selling your actual token amount needs a fresh quote and review.
              </p>
              {data.caveats.map((caveat) => (
                <p className="lnote" key={caveat}>
                  {caveat}
                </p>
              ))}
              {feed?.watching ? (
                <p className="lnote">{feed.watching}</p>
              ) : (
                <p className="lnote">No change-emitter coverage was read.</p>
              )}
              {feed?.corporateRecord ? <p className="lnote">{feed.corporateRecord}</p> : null}
              {feed?.notReported.map((note) => (
                <p className="lnote" key={note}>
                  {note}
                </p>
              ))}
            </details>
          </React.Fragment>
        ) : null}
      </div>
    </section>
  );
}
