'use client';

import React, { useEffect, useRef, useState } from 'react';
import {
  stockPositionDecimalV1,
  stockPositionQuoteOpenV1,
  type StockPositionQuoteV1,
} from '@mioagent/rwa-market-reality/stock-position-quote';
import { swapProviderDisplayNameV1 } from './providerDiagnostics';

export function MyStockCashOut(props: {
  tokenAddress: string;
  tokenSymbol: string;
  overviewTokens: string;
  onMeasure: (tokenAddress: string) => Promise<StockPositionQuoteV1>;
}) {
  const [quote, setQuote] = useState<StockPositionQuoteV1 | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [now, setNow] = useState(() => new Date());
  const pending = useRef(false);
  const clock = useRef({ serverAt: 0, receivedAt: 0 });
  useEffect(() => {
    if (!quote?.expiresAt) return;
    const at = () =>
      new Date(clock.current.serverAt + Math.max(0, performance.now() - clock.current.receivedAt));
    if (!stockPositionQuoteOpenV1(quote, at())) return;
    const timer = setInterval(() => {
      const time = at();
      setNow(time);
      if (!stockPositionQuoteOpenV1(quote, time)) clearInterval(timer);
    }, 1_000);
    return () => clearInterval(timer);
  }, [quote]);
  const measure = async () => {
    if (pending.current) return;
    pending.current = true;
    setChecking(true);
    setError(null);
    const startedAt = performance.now();
    try {
      const result = await props.onMeasure(props.tokenAddress);
      if (result.tokenAddress !== props.tokenAddress)
        throw new Error('stock_cash_out_measurement_unread');
      // Server clock + monotonic elapsed time. Include the entire request
      // duration conservatively; a slow or incorrect client clock cannot
      // extend a twenty-second quote into a current price hours later.
      const receivedAt = performance.now();
      clock.current = {
        serverAt: Date.parse(result.generatedAt) + receivedAt - startedAt,
        receivedAt,
      };
      setQuote(result);
      setNow(new Date(clock.current.serverAt));
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : '';
      setError(
        message.startsWith('stock_cash_out_rate_limited')
          ? 'Too many checks for this wallet. Wait a minute and try again.'
          : 'Cash out could not be checked. This says nothing about whether your stock can be sold.',
      );
    } finally {
      pending.current = false;
      setChecking(false);
    }
  };
  const open = quote ? stockPositionQuoteOpenV1(quote, now) : false;
  const proceeds =
    quote?.returnedAtomic === null || !quote
      ? null
      : stockPositionDecimalV1(quote.returnedAtomic, 6);
  const time = (iso: string) =>
    new Date(iso).toLocaleString('en-US', {
      timeZone: 'UTC',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }) + ' UTC';
  return (
    <div className="stocks-today-cash-out">
      <div className="stocks-today-cash-out-control">
        <button
          type="button"
          className="btn sec"
          onClick={() => {
            void measure();
          }}
          disabled={checking}
        >
          {checking ? 'Checking cash out…' : quote ? 'Check cash out again' : 'Check cash out'}
        </button>
        <span className="lnote">
          Quote your entire current {props.tokenSymbol} balance into USDC.
        </span>
      </div>
      <div role="status" aria-live="polite">
        {error ? (
          <p className="lnote">
            {error} {quote ? 'The previous dated reading remains below.' : ''}
          </p>
        ) : null}
        {quote ? (
          <React.Fragment>
            {proceeds !== null ? (
              <p>
                <strong>
                  {open ? 'Router quote' : 'Last quoted'}: {proceeds} USDC
                </strong>{' '}
                for{' '}
                <span className="mono">
                  {quote.holding.tokens} {quote.tokenSymbol}
                </span>{' '}
                · before network fees
              </p>
            ) : (
              <p>
                {quote.status === 'empty'
                  ? 'No tokens were held at the block just read. No router quote was requested.'
                  : quote.status === 'no_route'
                    ? `No route for this exact balance was returned by ${quote.approvedSources.map(swapProviderDisplayNameV1).join(', ')}. This does not establish that the asset is untradeable.`
                    : 'The providers did not establish a price for this exact balance. This is a measurement gap.'}
              </p>
            )}
            {quote.observedAt ? (
              <p className="lnote">
                {quote.selectedSource
                  ? `${swapProviderDisplayNameV1(quote.selectedSource)} · `
                  : ''}
                measured {time(quote.observedAt)} ·{' '}
                {open
                  ? `expires in ${Math.max(1, Math.ceil((Date.parse(quote.expiresAt!) - now.getTime()) / 1000))}s`
                  : proceeds !== null
                    ? 'Price expired — check again for a current quote.'
                    : 'provider evidence at this time'}
              </p>
            ) : null}
            {quote.holding.tokens !== props.overviewTokens ? (
              <p className="lnote">
                The balance just read differs from the overview above. This quote uses{' '}
                {quote.holding.tokens} tokens.
              </p>
            ) : null}
            <details>
              <summary>Cash out measurement details</summary>
              <p className="lnote mono">
                {quote.holding.balanceAtomic} atoms · {quote.holding.decimals} decimals · Base block{' '}
                {BigInt(quote.holding.blockTag).toLocaleString('en-US')}
              </p>
              {quote.sources.map((source) => (
                <p className="lnote" key={source.source}>
                  {swapProviderDisplayNameV1(source.source)}: {source.status}
                  {source.errorCode ? ` · ${source.errorCode}` : ''}
                </p>
              ))}
              {quote.caveats.map((note) => (
                <p className="lnote" key={note}>
                  {note}
                </p>
              ))}
            </details>
            <p className="lnote">
              Nothing was sold. A sale needs an exact amount, fresh review and your wallet approval.
            </p>
          </React.Fragment>
        ) : null}
      </div>
    </div>
  );
}
