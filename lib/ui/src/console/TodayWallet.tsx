import React, { useId, useState } from 'react';
import {
  balanceUsdLabelV1,
  isNativeBalanceV1,
  walletBalanceRowsV1,
  walletRegistryMarkViewV1,
  type WalletBalanceEntryV1,
  type WalletBalancesModelV1,
} from './WalletBalancesCard';
import { todayWalletCheckV1, type TodayHoldingQuoteV1 } from './todayView';

void React;

/** Search only the portfolio already on screen. Symbols are display metadata;
 * the address remains the key and the destination of every investigation. */
export function searchWalletBalancesV1(rows: readonly WalletBalanceEntryV1[], query: string): WalletBalanceEntryV1[] {
  const term = query.trim().toLowerCase();
  return rows.filter(row => !term || [row.symbol, row.name, row.address, row.registry?.ticker]
    .some(value => value?.toLowerCase().includes(term)));
}

/** A token's face where the Stocks board has one: Coinbase's icon, or the
 * first letter. Nothing for a token the board does not know. */
function TokenFace({ quote, symbol, size }: { quote: TodayHoldingQuoteV1 | null | undefined; symbol: string; size: 'sm' | 'lg' }) {
  if (!quote) return null;
  const className = size === 'lg' ? 'mr-stock-icon' : 'mr-choice-icon';
  return quote.iconPath
    ? <img className={className} src={quote.iconPath} alt="" width={size === 'lg' ? 40 : 24} height={size === 'lg' ? 40 : 24}
      loading="lazy" decoding="async" />
    : <span className={`${className} mr-choice-letter`} aria-hidden="true">{symbol.slice(0, 1)}</span>;
}

export function TodayWallet({ model, onInvestigate, quotes }: {
  model: WalletBalancesModelV1;
  onInvestigate: (tokenAddress: string) => void;
  /** The Stocks board's icons, by token address; absent, rows show names alone. */
  quotes?: ReadonlyMap<string, TodayHoldingQuoteV1> | null;
}) {
  const [query, setQuery] = useState('');
  const searchId = useId();
  const { shown, hiddenZero, hiddenSpam } = walletBalanceRowsV1(model.rows);
  const check = todayWalletCheckV1(shown);
  const filtered = searchWalletBalancesV1(shown, query);

  return <section className="today-wallet" aria-label="My wallet">
    <header className="today-wallet-head">
      <div><p className="eyebrow">Your Base wallet</p><h3>My wallet</h3></div>
      <span className="lnote">Balances and identity checks</span>
    </header>
    {model.unavailableReason ? <p className="lnote" role="status">{model.unavailableReason}</p>
      : model.loading ? <p className="lnote" role="status">Reading balances…</p>
        : <>
          <dl className="today-wallet-counts">
            <div><dt>{check.official.length === 1 ? 'Official stock' : 'Official stocks'}</dt><dd>{check.official.length}</dd>
              {/* Which ones, by face: a count alone does not say what is held. */}
              {check.official.length > 0 ? <dd className="today-wallet-held">
                {check.official.map(token => <span key={token.address} className="today-wallet-chip">
                  <TokenFace quote={quotes?.get(token.address)} symbol={token.symbol} size="sm" />{token.symbol}
                </span>)}
              </dd> : null}
            </div>
            <div data-tone={check.lookalikes.length > 0 ? 'attention' : undefined}>
              <dt>{check.lookalikes.length === 1 ? 'Address mismatch' : 'Address mismatches'}</dt><dd>{check.lookalikes.length}</dd>
            </div>
            <div><dt>Outside reviewed coverage</dt><dd>{check.unchecked.length}</dd></div>
          </dl>
          {shown.length === 0 ? <p className="lnote">No balances to display.
            {hiddenSpam > 0 ? ` ${hiddenSpam} flagged as spam and hidden.` : ''}</p>
            : <details className="today-wallet-all">
              <summary>View all · {shown.length} {shown.length === 1 ? 'balance' : 'balances'}</summary>
              <div className="today-wallet-search">
                <label htmlFor={searchId}>Search by symbol or address</label>
                <input id={searchId} type="search" value={query} autoComplete="off"
                  placeholder="Symbol or contract address" onChange={event => setQuery(event.currentTarget.value)} />
                <p className="lnote" role="status">{filtered.length} of {shown.length} balances</p>
              </div>
              <ul className="today-wallet-list">
                {filtered.map(row => {
                  const native = isNativeBalanceV1(row.address);
                  const mark = walletRegistryMarkViewV1(row.registry);
                  const value = row.usdValue == null || row.usdValue === '' ? NaN : Number(row.usdValue);
                  const usd = value > 0 && value < 0.01 ? 'less than $0.01' : balanceUsdLabelV1(row.usdValue);
                  return <li key={row.address.toLowerCase()} data-tone={mark?.tone === 'a' ? 'attention' : undefined}>
                    <div className="today-wallet-row">
                      <div><TokenFace quote={quotes?.get(row.address.toLowerCase())} symbol={row.symbol} size="sm" />
                        <strong>{row.symbol}</strong>
                        {mark ? <span className={`tag${mark.tone === 'a' ? ' a' : ''}`} title={mark.title}>{mark.label}</span>
                          : <span className="tag">{native ? 'native' : row.verified ? 'Provider verified' : 'Outside reviewed coverage'}</span>}
                      </div>
                      <div className="today-wallet-value mono">{row.balanceFormatted?.trim() || '—'}
                        {usd ? <span className="usd">≈ {usd}</span> : null}
                      </div>
                    </div>
                    {!native ? <div className="today-wallet-address">
                      <span className="mono">{row.address}</span>
                      <button type="button" className="btn sec" onClick={() => onInvestigate(row.address)}
                        aria-label={`Check ${row.symbol} at ${row.address}`}>Check</button>
                    </div> : null}
                  </li>;
                })}
              </ul>
              {filtered.length === 0 ? <p className="lnote">No balance matches this search.</p> : null}
              <p className="lnote">An official address is an issuer identity match. Outside coverage is not a risk finding.
                {hiddenSpam > 0 ? ` ${hiddenSpam} flagged as spam and hidden.` : ''}
                {hiddenZero > 0 ? ` ${hiddenZero} zero balances hidden.` : ''}
              </p>
            </details>}
        </>}
  </section>;
}
