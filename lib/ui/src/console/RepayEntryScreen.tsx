import React, { useEffect, useId, useRef, useState } from 'react';
import { lendingRequestV1 } from '@mioagent/api-client-react';
import { tokenDecimalV1 } from './stockSellAmount';
import { REPAY_COLLATERALS_V1, repayCanReturnV1, repayCapacityViewV1, repayExactCoversDebtV1, repayExactWholeDebtTextV1, repayIntentAmountsV1, repayMaxV1, repayShortTextV1,
  type RepayCapacityWireV1, type RepayModeV1 } from './repayEntry';

void React;

interface EntryStateV1 {
  owner: string; asset: string | null; mode: RepayModeV1; amount: string; maximum: string;
  read: RepayCapacityWireV1 | null; reading: boolean; preparing: boolean; error: string | null;
}
const initial = (owner: string, asset: string | null): EntryStateV1 => ({ owner, asset, mode: 'assets', amount: '', maximum: '',
  read: null, reading: false, preparing: false, error: null });
export interface RepayEntryModelV1 {
  signedIn: boolean; signInHref: string; asset: string | null; mode: RepayModeV1; amount: string; maximum: string;
  read: RepayCapacityWireV1 | null; reading: boolean; preparing: boolean; error: string | null;
  /** The read shows an Aave V4 deposit, which Repay all can take back. */
  canReturn: boolean;
  onAsset: (asset: string) => void; onMode: (mode: RepayModeV1) => void;
  onAmount: (value: string) => void; onMaximum: (value: string) => void; onRead: () => void; onReview: () => void;
  /** Nothing owed: prepares the stock's return alone. */
  onTakeBack: () => void;
  /** Fills the field from the position just read: for Repay all, the wallet's
   * USDC as the bound; for an exact amount, the wallet's USDC when it is short
   * of the debt, and otherwise Repay all, since only it repays all of a debt. */
  onMax: () => void;
}

/** One explicit position read, then a signed question. Neither this form nor
 * its host constructs calldata or requests a wallet signature. */
export function useRepayEntryConsoleV1(input: {
  signedIn: boolean; walletIdentity: string | null; initialAsset?: string | null; signInHref: string;
  onReview: (href: string) => void;
}): { model: RepayEntryModelV1 } {
  const owner = input.signedIn ? input.walletIdentity?.toLowerCase() ?? '' : '';
  const firstAsset = REPAY_COLLATERALS_V1.some(asset => asset.id === input.initialAsset) ? input.initialAsset! : null;
  const [state, setState] = useState<EntryStateV1>(() => initial(owner, firstAsset));
  const active = state.owner === owner ? state : initial(owner, firstAsset);
  const chosen = REPAY_COLLATERALS_V1.find(asset => asset.id === active.asset) ?? null;
  const identity = JSON.stringify([owner, active.asset, active.mode, active.amount, active.maximum]);
  const current = useRef(identity); current.current = identity;
  const alive = useRef(true), busy = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { setState(old => old.owner === owner ? old : initial(owner, firstAsset)); }, [firstAsset, owner]);
  const patch = (next: Partial<EntryStateV1>) => setState(previous => ({ ...(previous.owner === owner ? previous : initial(owner, firstAsset)), ...next }));
  const read = active.read?.collateralTokenAddress === chosen?.token ? active.read : null;
  const onRead = async () => {
    if (!owner || !chosen || busy.current) return;
    busy.current = true; const openedFor = identity; patch({ reading: true, error: null, read: null });
    try {
      const answer = repayCapacityViewV1(await lendingRequestV1(`/api/route-intelligence/rwa/repay/capacity?token=${chosen.token}`), chosen.token);
      if (alive.current && current.current === openedFor) patch({ read: answer.read, error: answer.error });
    } catch { if (alive.current && current.current === openedFor) patch({ error: 'The repayment position could not be read. Nothing was prepared.' }); }
    finally { busy.current = false; if (alive.current && current.current === openedFor) patch({ reading: false }); }
  };
  const onReview = async (mode: RepayModeV1 = active.mode) => {
    if (!owner || !chosen || !read || busy.current || (mode === 'return' ? !repayCanReturnV1(read) : read.debtAtomic === '0')) return;
    const amounts = repayIntentAmountsV1({ mode, amount: active.amount, maximum: active.maximum, walletUsdcAtomic: read.walletUsdcAtomic, debtAtomic: read.debtAtomic,
      blockNumber: read.blockNumber, venue: read.venue });
    if (!amounts.intent) { patch({ error: amounts.error }); return; }
    busy.current = true; const openedFor = identity; patch({ preparing: true, error: null });
    try {
      const result = await lendingRequestV1<{ reviewUrl?: unknown; expiresAt?: unknown }>('/api/route-intelligence/rwa/repay/intent', {
        method: 'POST', body: JSON.stringify({ collateralTokenAddress: chosen.token, ...amounts.intent }),
      });
      if (!alive.current || current.current !== openedFor) return;
      if (typeof result.reviewUrl !== 'string' || !/^\/lending\/miorail-lending-v1\.[a-zA-Z0-9_.-]+$/.test(result.reviewUrl) ||
          typeof result.expiresAt !== 'string' || !(Date.parse(result.expiresAt) > Date.now())) {
        patch({ error: 'The repayment review link was not valid or expired. Read the position again.' }); return;
      }
      input.onReview(result.reviewUrl);
    } catch { if (alive.current && current.current === openedFor) patch({ error: 'The repayment review could not be prepared. Read the position again before trying to review it.' }); }
    finally { busy.current = false; if (alive.current && current.current === openedFor) patch({ preparing: false }); }
  };
  return { model: { signedIn: Boolean(owner), signInHref: input.signInHref, asset: active.asset, mode: active.mode,
    amount: active.amount, maximum: active.maximum, read, reading: active.reading, preparing: active.preparing, error: active.error,
    canReturn: repayCanReturnV1(read),
    onAsset: asset => { if (!busy.current && REPAY_COLLATERALS_V1.some(row => row.id === asset)) patch({ asset, read: null, error: null }); },
    onMode: mode => { if (!busy.current) patch({ mode, error: null }); },
    onAmount: amount => { if (!busy.current) patch({ amount, error: null }); },
    onMaximum: maximum => { if (!busy.current) patch({ maximum, error: null }); },
    onRead: () => void onRead(), onReview: () => void onReview(), onTakeBack: () => void onReview('return'),
    onMax: () => {
      if (busy.current || !read) return;
      const max = repayMaxV1(read, active.mode), value = tokenDecimalV1(max.atomic, 6);
      patch(max.mode === 'assets' ? { amount: value, error: null } : { mode: max.mode, maximum: value, error: null });
    },
  } };
}

export function RepayEntryScreen({ model }: { model: RepayEntryModelV1 }) {
  const id = useId(), busy = model.reading || model.preparing;
  const asset = REPAY_COLLATERALS_V1.find(row => row.id === model.asset);
  const symbol = model.read?.collateralSymbol ?? asset?.symbol ?? '';
  const venue = (model.read?.venue ?? asset?.venue) === 'morpho' ? 'Morpho' : 'Aave V4';
  const deposit = model.read?.collateralAtomic !== undefined ? `${tokenDecimalV1(model.read.collateralAtomic, model.read.collateralDecimals)} ${model.read.collateralSymbol}` : null;
  // A loan is repaid in USDC from this wallet: say so before a field asks for an amount it cannot cover.
  const short = model.read !== null && BigInt(model.read.walletUsdcAtomic) < BigInt(model.read.debtAtomic);
  // Repay all cannot be prepared short of the debt: the reason sits by the button it disables.
  const shortForAll = model.read && model.mode !== 'assets' ? repayShortTextV1(model.read) : null;
  // A review that could not be prepared is said where the person pressed, not above the fold.
  const errorAtForm = model.error !== null && model.read !== null && model.read.debtAtomic !== '0';
  // An exact amount at or above the debt is Repay all's, said before the review could refuse it (2026-11-07).
  const wholeDebt = model.read !== null && model.mode === 'assets' ? repayExactCoversDebtV1(model.amount, model.read.debtAtomic) : false;
  return <div className="still-borrow">
    <div className="still-section"><h1 className="still-word">Repay</h1><p className="still-sub">Reduce debt with USDC, or repay all of a loan and take its collateral back to your wallet.</p></div>
    {!model.signedIn ? <section className="still-section still-card"><p className="still-sub">Sign in to read your repayment position.</p><a className="still-btn" href={model.signInHref}>Sign in</a></section> : <>
      {model.error && !errorAtForm ? <p className="still-section still-warn" role="alert">{model.error}</p> : null}
      <div className="still-borrow-grid">
        <section className="still-card still-borrow-step" aria-labelledby={`${id}-position-title`}>
          <h2 id={`${id}-position-title`}>Read your position.</h2>
          <form onSubmit={event => { event.preventDefault(); model.onRead(); }}>
            <label className="still-borrow-label" htmlFor={`${id}-asset`}>Collateral market</label>
            <select id={`${id}-asset`} value={model.asset ?? ''} disabled={busy} onChange={event => model.onAsset(event.target.value)}
              style={{ width: '100%', minHeight: 48, padding: '8px 12px', borderRadius: 12, border: '1px solid var(--sm-line)', background: 'var(--sm-card)', color: 'var(--sm-ink)', font: 'inherit' }}>
              <option value="" disabled>Choose a market</option>
              {REPAY_COLLATERALS_V1.map(row => <option key={row.id} value={row.id}>{row.symbol} · {row.venue === 'morpho' ? 'Morpho' : 'Aave V4'}</option>)}
            </select>
            <button type="submit" className="still-btn" disabled={busy || !asset}>{model.reading ? 'Reading position…' : 'Read repayment position'}</button>
          </form>
          {model.read ? <>
            <dl className="still-borrow-facts">
              <div><dt>Debt read</dt><dd className="mono">{tokenDecimalV1(model.read.debtAtomic, 6)} USDC</dd></div>
              <div><dt>USDC in your wallet</dt><dd className="mono">{tokenDecimalV1(model.read.walletUsdcAtomic, 6)} USDC</dd></div>
              {deposit ? <div><dt>Deposited in {venue}</dt><dd className="mono">{deposit}</dd></div> : null}
              <div><dt>Base block</dt><dd className="mono">{model.read.blockNumber.toLocaleString('en-US')}</dd></div>
            </dl>
            {BigInt(model.read.debtAtomic) > BigInt(0) && BigInt(model.read.debtAtomic) < BigInt(10_000) ? <p className="still-note">Exact micro-debt of {tokenDecimalV1(model.read.debtAtomic, 6)} USDC ({model.read.debtAtomic} atomic USDC) is shown without rounding to zero. Use Repay all debt to clear residual shares completely.</p> : null}
          </> : <p className="still-note">Choose a market and explicitly read its debt and wallet USDC. No token is moved by this read.</p>}
        </section>
        <section className="still-card still-borrow-step" aria-labelledby={`${id}-repay-title`}>
          <h2 id={`${id}-repay-title`}>Choose the repayment.</h2>
          {model.read?.debtAtomic === '0' ? model.canReturn ? <>
            <p className="still-note">No debt is open in this market. Your {deposit} is still deposited in {venue}, and it can come back to your wallet now, with no USDC.</p>
            <button type="button" className="still-btn" disabled={busy} onClick={model.onTakeBack}>{model.preparing ? 'Preparing review…' : `Take back ${symbol}`}</button>
          </> : <p className="still-note">No debt was recorded in this market at the reading block.</p> : <>
          {short && model.read && model.mode === 'assets' ? <p className="still-warn" role="note">
            This wallet holds {tokenDecimalV1(model.read.walletUsdcAtomic, 6)} USDC on Base, and the debt is {tokenDecimalV1(model.read.debtAtomic, 6)} USDC.
            A loan is repaid in USDC from this wallet: add at least the debt, and a little more for the interest that keeps accruing, then read the position again.
            {model.mode === 'assets' ? ' An exact repayment can be smaller than the debt.' : null}
          </p> : null}
          <form onSubmit={event => { event.preventDefault(); model.onReview(); }}>
            <fieldset disabled={busy || !model.read} style={{ border: 0, padding: 0, margin: 0 }}>
              <legend className="still-borrow-label">Repayment mode</legend>
              <div className="still-borrow-assets">
                <button className="still-borrow-choice" type="button" aria-pressed={model.mode === 'assets'} onClick={() => model.onMode('assets')}>Exact USDC</button>
                <button className="still-borrow-choice" type="button" aria-pressed={model.mode === 'all'} onClick={() => model.onMode('all')}>Repay all debt</button>
                {model.canReturn ? <button className="still-borrow-choice" type="button" aria-pressed={model.mode === 'return'} onClick={() => model.onMode('return')}>Repay all, take back {symbol}</button> : null}
              </div>
              {/* 2026-11-07, the operator, twice: the bound below read as a second, larger debt. What is paid comes first. */}
              {model.mode !== 'assets' && model.read ? <p className="still-sub">You pay the whole debt: <strong className="mono">{tokenDecimalV1(model.read.debtAtomic, 6)} USDC</strong> at
                block {model.read.blockNumber.toLocaleString('en-US')}, plus the interest until your transaction lands.</p> : null}
              <label className="still-borrow-label" htmlFor={`${id}-amount`}>{model.mode === 'assets' ? 'USDC to repay' : 'Most USDC it may take'}</label>
              <div className="still-borrow-amount has-max"><input id={`${id}-amount`} type="text" inputMode="decimal" autoComplete="off" spellCheck={false}
                value={model.mode === 'assets' ? model.amount : model.maximum} aria-describedby={`${id}-funding-note`}
                onChange={event => model.mode === 'assets' ? model.onAmount(event.target.value) : model.onMaximum(event.target.value)} />
                <button type="button" className="still-borrow-max" onClick={model.onMax}
                  title={model.mode === 'assets' ? 'The USDC in your wallet, up to the debt. All of the debt is repaid with Repay all debt, so Max moves there when your wallet covers it' : 'All the USDC in your wallet, as the most this can take'}>Max</button>
                <span>USDC</span></div>
              <p className="still-note" id={`${id}-funding-note`}>{model.mode === 'assets'
                ? 'Exactly this amount is repaid, and it is also the most your wallet pays. It has to be less than the debt: to repay all of it, choose Repay all debt. Amounts are never rounded.'
                : `Enter your own maximum: it is a cap, not the payment. The contract cannot take more than it, and what is not needed stays in your wallet.${
                  model.mode === 'return' ? ` Then your ${deposit ?? symbol} comes back to this wallet in the same review.` : ''}`}</p>
              {wholeDebt && model.read ? <div className="still-warn" role="note"><p style={{ margin: 0 }}>{repayExactWholeDebtTextV1(model.read)}</p>
                <button type="button" className="still-btn sec" onClick={() => model.onMode('all')}>Repay all debt instead</button></div> : null}
              {shortForAll ? <p className="still-warn" role="note">{shortForAll}</p> : null}
              {errorAtForm && model.error !== shortForAll ? <p className="still-warn" role="alert">{model.error}</p> : null}
              <button type="submit" className="still-btn" disabled={!model.read || busy || shortForAll !== null || wholeDebt || !(model.mode === 'assets' ? model.amount : model.maximum).trim()}>{model.preparing ? 'Preparing review…' : 'Review repayment'}</button>
            </fieldset>
          </form></>}
          <p className="still-note">The review checks the exact position again and simulates the calls. Only your wallet can approve the repayment.</p>
        </section>
      </div>
    </>}
  </div>;
}
