import React, { useEffect, useId, useRef, useState } from 'react';
import { lendingRequestV1 } from '@mioagent/api-client-react';
import { tokenDecimalV1 } from './stockSellAmount';
import { REPAY_COLLATERALS_V1, repayCapacityViewV1, repayIntentAmountsV1, type RepayCapacityWireV1 } from './repayEntry';

void React;

interface EntryStateV1 {
  owner: string; asset: string | null; mode: 'assets' | 'all'; amount: string; maximum: string;
  read: RepayCapacityWireV1 | null; reading: boolean; preparing: boolean; error: string | null;
}
const initial = (owner: string, asset: string | null): EntryStateV1 => ({ owner, asset, mode: 'assets', amount: '', maximum: '',
  read: null, reading: false, preparing: false, error: null });
export interface RepayEntryModelV1 {
  signedIn: boolean; signInHref: string; asset: string | null; mode: 'assets' | 'all'; amount: string; maximum: string;
  read: RepayCapacityWireV1 | null; reading: boolean; preparing: boolean; error: string | null;
  onAsset: (asset: string) => void; onMode: (mode: 'assets' | 'all') => void;
  onAmount: (value: string) => void; onMaximum: (value: string) => void; onRead: () => void; onReview: () => void;
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
  const onReview = async () => {
    if (!owner || !chosen || !read || read.debtAtomic === '0' || busy.current) return;
    const amounts = repayIntentAmountsV1({ mode: active.mode, amount: active.amount, maximum: active.maximum, walletUsdcAtomic: read.walletUsdcAtomic });
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
    onAsset: asset => { if (!busy.current && REPAY_COLLATERALS_V1.some(row => row.id === asset)) patch({ asset, read: null, error: null }); },
    onMode: mode => { if (!busy.current) patch({ mode, error: null }); },
    onAmount: amount => { if (!busy.current) patch({ amount, error: null }); },
    onMaximum: maximum => { if (!busy.current) patch({ maximum, error: null }); },
    onRead: () => void onRead(), onReview: () => void onReview(),
  } };
}

export function RepayEntryScreen({ model }: { model: RepayEntryModelV1 }) {
  const id = useId(), busy = model.reading || model.preparing;
  const asset = REPAY_COLLATERALS_V1.find(row => row.id === model.asset);
  return <div className="still-borrow">
    <div className="still-section"><h1>Repay</h1><p className="still-sub">Reduce debt with USDC. Keep your collateral deposited.</p></div>
    {!model.signedIn ? <section className="still-section still-card"><p className="still-sub">Sign in to read your repayment position.</p><a className="still-btn" href={model.signInHref}>Sign in</a></section> : <>
      {model.error ? <p className="still-section still-warn" role="alert">{model.error}</p> : null}
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
          {model.read ? <dl className="still-borrow-facts">
            <div><dt>Debt read</dt><dd className="mono">{tokenDecimalV1(model.read.debtAtomic, 6)} USDC</dd></div>
            <div><dt>USDC in your wallet</dt><dd className="mono">{tokenDecimalV1(model.read.walletUsdcAtomic, 6)} USDC</dd></div>
            <div><dt>Base block</dt><dd className="mono">{model.read.blockNumber.toLocaleString('en-US')}</dd></div>
          </dl> : <p className="still-note">Choose a market and explicitly read its debt and wallet USDC. No token is moved by this read.</p>}
        </section>
        <section className="still-card still-borrow-step" aria-labelledby={`${id}-repay-title`}>
          <h2 id={`${id}-repay-title`}>Choose the repayment.</h2>
          {model.read?.debtAtomic === '0' ? <p className="still-note">No debt was recorded in this market at the reading block.</p> : <form onSubmit={event => { event.preventDefault(); model.onReview(); }}>
            <fieldset disabled={busy || !model.read} style={{ border: 0, padding: 0, margin: 0 }}>
              <legend className="still-borrow-label">Repayment mode</legend>
              <div className="still-borrow-assets">
                <button className="still-borrow-choice" type="button" aria-pressed={model.mode === 'assets'} onClick={() => model.onMode('assets')}>Exact USDC</button>
                <button className="still-borrow-choice" type="button" aria-pressed={model.mode === 'all'} onClick={() => model.onMode('all')}>Repay all debt</button>
              </div>
              <label className="still-borrow-label" htmlFor={`${id}-amount`}>{model.mode === 'assets' ? 'USDC to repay' : 'Maximum USDC funding'}</label>
              <div className="still-borrow-amount"><input id={`${id}-amount`} type="text" inputMode="decimal" autoComplete="off" spellCheck={false}
                value={model.mode === 'assets' ? model.amount : model.maximum} aria-describedby={`${id}-funding-note`}
                onChange={event => model.mode === 'assets' ? model.onAmount(event.target.value) : model.onMaximum(event.target.value)} /><span>USDC</span></div>
              <p className="still-note" id={`${id}-funding-note`}>{model.mode === 'all'
                ? 'Enter your own maximum. Interest can change the exact debt. The contract cannot spend more than this bound; unused funding is returned or stays in your wallet.'
                : 'This exact amount is also your maximum USDC debit. Amounts are never rounded.'}</p>
              <button type="submit" className="still-btn" disabled={!model.read || busy || !(model.mode === 'assets' ? model.amount : model.maximum).trim()}>{model.preparing ? 'Preparing review…' : 'Review repayment'}</button>
            </fieldset>
          </form>}
          <p className="still-note">The review checks the exact position again and simulates the calls. Only your wallet can approve the repayment.</p>
        </section>
      </div>
    </>}
  </div>;
}
