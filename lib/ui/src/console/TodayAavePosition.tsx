'use client';

import React from 'react';
import type { MirrorReport } from '@mioagent/still-engine/report';
import { AAVE_V4_BASE_PAGE_V1 } from '@mioagent/rwa-issuer/aaveV4';
import { tokenDecimalV1 } from './stockSellAmount';

void React;

export interface TodayAavePositionModelV1 {
  /** The signed-in wallet's Mirror: its Aave V4 position read from Base at one block. */
  data: MirrorReport | null;
  loading: boolean;
  failed: boolean;
  onRead: () => void;
}

// BigInt() rather than literals: the miniapp compiles this package below ES2020.
const HUNDRED = BigInt(100);

function money(cents: string | null): string {
  if (cents === null || !/^\d+$/.test(cents)) return 'Not read';
  const value = BigInt(cents);
  return `$${(value / HUNDRED).toLocaleString('en-US')}.${(value % HUNDRED).toString().padStart(2, '0')}`;
}

/** Pledged tokens at the line's own oracle price, rounded down to the cent. */
function pledgedCents(line: MirrorReport['assets'][number]): bigint | null {
  if (!line.pledged || line.priceCents === null) return null;
  return (BigInt(line.pledged.raw) * BigInt(line.priceCents)) / BigInt(10) ** BigInt(line.pledged.decimals);
}

export function TodayAavePosition({ model }: { model: TodayAavePositionModelV1 }) {
  const data = model.data;
  const venue = data?.venues.find((v) => v.venue === 'aave-v4') ?? null;
  const pledged = (data?.assets ?? []).filter((line) => line.venue === 'aave-v4' && line.pledged !== null && line.pledged.raw !== '0');
  const pledgedValues = pledged.map(pledgedCents);
  const collateral = pledgedValues.some((v) => v === null) ? null : pledgedValues.reduce<bigint>((sum, v) => sum + v!, BigInt(0)).toString();
  const empty = venue === null || (pledged.length === 0 && venue.debtCents === '0' && venue.failed.length === 0);
  const health = venue?.safety ? Number(BigInt(venue.safety.healthFactor) / BigInt(10) ** BigInt(14)) / 10_000 : null;
  const atRisk = venue?.safety ? venue.safety.state === 'act' || venue.safety.state === 'liquidation' : false;
  const failed = data ? [...new Set([...(venue?.failed ?? []), ...pledged.flatMap((line) => line.failed)])] : [];
  return <details className="today-details">
    <summary>Your Aave v4 stock position</summary>
    <div className="cardrow">
      <p className="lnote">Coinbase stocks on Base · Aave v4 Coinbase Stocks market. Read your pledged stocks, your debt and how far prices can fall, from Base itself.</p>
      <div className="card-actions">
        <button type="button" className="btn sec" disabled={model.loading} onClick={model.onRead}>
          {model.loading ? 'Reading Aave…' : data ? 'Read again' : 'Read my Aave position'}
        </button>
        <a className="btn sec" href={AAVE_V4_BASE_PAGE_V1} target="_blank" rel="noopener noreferrer">Open market on Aave</a>
      </div>
      {model.failed ? <p className="note warn" role="status">Your Aave position could not be refreshed. This does not mean you have no position.
        {data ? ' The dated reading below is the previous result.' : ''}</p> : null}
      {!data && !model.failed ? <p className="lnote">Nothing has been read here yet. Opening this section does not read your position.</p> : null}
      {data ? <>
        <p className="lnote">Read from Base at block {Number(data.reading.block).toLocaleString('en-US')}, {new Date(data.reading.blockTime).toLocaleString('en-US', { timeZone: 'UTC' })} UTC · Aave v4 Coinbase Stocks market only.</p>
        {empty ? <p>No pledged stocks and no debt in this Aave v4 market. Other Aave markets were not checked.</p> : <>
          <dl className="today-aave-facts">
            <div className="qrow"><dt>Pledged</dt><dd>{pledged.length === 0 ? 'Nothing' : pledged.map((line) => line.symbol).join(', ')}</dd></div>
            <div className="qrow"><dt>Collateral value</dt><dd>{money(collateral)}</dd></div>
            <div className="qrow"><dt>Debt</dt><dd>{venue!.debtAtomic != null && BigInt(venue!.debtAtomic) > BigInt(0) && BigInt(venue!.debtAtomic) < BigInt(10_000) ? `${tokenDecimalV1(venue!.debtAtomic, 6)} USDC` : money(venue!.debtCents)}</dd></div>
            <div className="qrow"><dt>Borrow rate</dt><dd>{venue!.borrowRateBps === null ? 'Not read' : `${venue!.borrowRateBps / 100}% a year, variable`}</dd></div>
            <div className="qrow"><dt>Health factor</dt><dd>{venue!.debtCents === '0' ? 'No debt' : health === null ? 'Not read' : health.toLocaleString('en-US', { maximumFractionDigits: 4 })}</dd></div>
            {venue!.safety ? <div className="qrow"><dt>Prices can fall</dt><dd>{`${Math.floor(venue!.safety.marginBps / 100)}% together before liquidation`}</dd></div> : null}
            {venue!.liquidationPrices.map((price) => <div className="qrow" key={price.asset}>
              <dt>{`Liquidation price, ${price.asset}`}</dt>
              <dd>{price.unreachable ? 'None: the rest of your collateral covers the debt' : `Below ${money(price.priceCents)} if only it moved`}</dd>
            </div>)}
            <div className="qrow"><dt>Still’s limit left</dt><dd>{money(venue!.availableCents)}</dd></div>
          </dl>
          <p className={atRisk ? 'note warn' : 'lnote'}>Liquidation can start when the health factor falls to 1. Prices, interest and Aave’s settings move it.</p>
          <p className="lnote">Values use Aave’s own oracle prices at that block. Still lends at half of Aave’s limit; any borrow is read and checked again before you sign.</p>
        </>}
        {failed.length > 0 ? <p className="note warn">Not read this time: {failed.join(', ')}. Figures that depend on them are left out.</p> : null}
      </> : null}
    </div>
  </details>;
}
