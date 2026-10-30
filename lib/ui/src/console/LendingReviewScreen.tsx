import React from 'react';
import { tokenDecimalV1 } from './stockSellAmount';
import { lendingExecutionCopyV1 } from './lendingReviewView';
import type { LendingReviewConsoleModelV1 } from './useLendingReviewConsole';

void React;

/** One review for both web and Base App. Values and verdicts belong to the
 * server; the screen formats exact decimals and never recalculates risk. */
export function LendingReviewScreen({ model }: { model: LendingReviewConsoleModelV1 }) {
  if (model.loading) return <p className="still-section still-note" role="status">Reading the position and simulating the exact calls…</p>;
  if (model.error) return <p className="still-section still-warn" role="alert">{model.error}</p>;
  if (!model.body) return <p className="still-section still-note">There is no lending review to display.</p>;
  const body = model.body, facts = body.facts;
  const repay = facts?.operation === 'repay';
  const title = facts ? repay ? 'Review repayment' : 'Review loan' : 'Lending review';
  const asset = (value: string) => facts ? `${tokenDecimalV1(value, facts.collateralDecimals)} ${facts.collateralSymbol}` : value;
  const usdc = (value: string) => `${tokenDecimalV1(value, 6)} USDC`;
  const health = (value: string | null | undefined) => value == null ? 'Not read' : tokenDecimalV1(value, 18);
  const knownState = model.execution?.state ?? (body.state === 'refused' ? body.executionState : null);
  const blocked = Boolean(model.submissionLock || model.batchId || (knownState && knownState !== 'ready'));
  return (
    <div className="still-section still-lending-review">
      <div className="still-eyebrow">{facts ? facts.venue === 'aave-v4' ? 'Aave V4 · Base' : 'Morpho · Base' : 'Base lending'}</div>
      <h1>{title}</h1>
      <p className="still-sub">Read the measured terms before anything is signed.</p>
      {body.state === 'refused' ? <p className="still-warn" role="alert">{body.detail}</p> : null}
      {facts ? <>
        <p className="still-note mono" style={{ overflowWrap: 'anywhere' }}>{facts.marketId}</p>
        {facts.nativeFunding ? <div className="still-card">
          <p className="still-sub">Wrap and pledge exactly {tokenDecimalV1(facts.nativeFunding.maximumNativeAssets,18)} ETH.</p>
          <p className="still-note">Wallet-held WETH is not spent. The measured ETH remaining is {tokenDecimalV1(facts.nativeFunding.balanceAfterAssets,18)} ETH before wallet/network fees.</p>
          <p className="still-note">At least {tokenDecimalV1(facts.nativeFunding.reserveAssets,18)} ETH is kept out of the collateral for fees. The final fee is not quoted here; your wallet calculates it before approval.</p>
        </div> : null}
        <p className="still-note">Position read at Base block {facts.blockNumber.toLocaleString('en-US')}.</p>
        <table className="mr-borrow-table" aria-label={`Position before and after ${repay ? 'repayment' : 'borrowing'}`}>
          <thead><tr><th scope="col">Position</th><th scope="col">Before</th>{body.state === 'ready' ? <th scope="col">Simulated after</th> : null}</tr></thead>
          <tbody>
            <tr><th scope="row">Debt</th><td className="mono">{usdc(facts.debtBeforeAssets)}</td>{body.state === 'ready' ? <td className="mono">{usdc(facts.debtAfterAssets)}</td> : null}</tr>
            <tr><th scope="row">Collateral</th><td className="mono">{asset(facts.collateralBeforeAssets)}</td>{body.state === 'ready' ? <td className="mono">{asset(facts.collateralAfterAssets)}</td> : null}</tr>
            <tr><th scope="row">Health ratio</th><td className="mono">{health(facts.healthBeforeWad)}</td>{body.state === 'ready' ? <td className="mono">{health(facts.healthAfterWad)}</td> : null}</tr>
          </tbody>
        </table>
        {body.state === 'ready' ? <>
          {repay ? <>
            <p className="still-sub">{facts.amountMode === 'all' ? 'Repay the entire debt position at execution.' : <>Repay exactly {usdc(facts.requestedAssets!)}.</>}</p>
            <p className="still-sub">Maximum USDC funding: <strong>{usdc(facts.maximumDebitAssets)}</strong>.</p>
            <p className="still-note">Your wallet must hold that maximum. Unused funding is returned or remains in your wallet. Your collateral stays deposited.</p>
          </> : <>
            <p className="still-sub">Borrow {facts.requestedAssets === null ? 'the measured amount' : usdc(facts.requestedAssets)} to this wallet.</p>
            <p className="still-note">New collateral selected: {asset(facts.collateralSupplyAssets)}. Borrowing creates debt; collateral can be liquidated.</p>
            <p className="still-note">Still total debt limit: {facts.policyLimitAssets == null ? 'Not read' : usdc(facts.policyLimitAssets)}.</p>
            <p className="still-note">Protocol total debt limit: {facts.protocolLimitAssets == null ? 'Not read' : usdc(facts.protocolLimitAssets)}.</p>
            <p className="still-note">Terms version: {facts.termsVersion ?? 'Not read'}.</p>
          </>}
          {facts.warnings.map((warning, index) => <p className="still-warn" key={`${index}:${warning}`}>{warning}</p>)}
          <p className="still-note">Simulated at Base block {body.measured.blockNumber.toLocaleString('en-US')}. The position and exact calls are checked again before your wallet opens.</p>
          <details className="still-disclosure">
            <summary>Calls checked for this review</summary>
            {body.steps.map(step => <div key={step.index}>
              <p className="still-note mono" style={{ overflowWrap: 'anywhere' }}>{step.to}</p><p className="still-note">{step.reading}</p>
            </div>)}
          </details>
        </> : <p className="still-note">No executable calls are available for this refusal.</p>}
      </> : null}
      {knownState ? <p className={knownState === 'confirmed' ? 'still-sub' : 'still-note'} role="status">{lendingExecutionCopyV1(knownState)}</p> : null}
      {model.batchId && !model.execution ? <p className="still-note" role="status">Submitted from your wallet. A batch ID is a submission handle; it is not a confirmed blockchain result.</p> : null}
      {model.execution?.transactionHash ? <p className="still-note mono" style={{ overflowWrap: 'anywhere' }}>Transaction: {model.execution.transactionHash}</p> : null}
      {model.submissionLock && knownState !== 'confirmed' ? <p className="still-note" role="status">{model.submissionLock}</p> : null}
      {body.state === 'ready' && model.onOpen && !blocked ? <button type="button" className="still-btn" disabled={model.walletBusy} onClick={model.onOpen}>
        {model.walletBusy ? 'Waiting for your wallet…' : 'Open in your wallet'}
      </button> : null}
      {model.onCheck ? <button type="button" className="still-btn sec" disabled={model.checking || model.walletBusy} onClick={model.onCheck}>
        {model.checking ? 'Checking the onchain result…' : 'Check onchain result'}
      </button> : null}
      {model.onFindTransaction ? <details className="still-lending-details">
        <summary>Wallet sent it, but the result is still unknown?</summary>
        <p className="still-note">Paste the transaction hash from your wallet activity. Still will check that transaction against this exact action; it will not send anything.</p>
        <label className="still-borrow-label">Transaction hash
          <input className="still-borrow-stock-select mono" type="text" autoComplete="off" spellCheck={false} value={model.transactionHint ?? ''}
            onChange={event => model.onTransactionHint?.(event.target.value)} disabled={model.checking || model.walletBusy} />
        </label>
        <button type="button" className="still-btn sec" onClick={model.onFindTransaction} disabled={model.checking || model.walletBusy}>Find this transaction</button>
      </details> : null}
      {model.walletError && !(body.state === 'refused' && body.detail === model.walletError) ? <p className="still-warn" role="alert">{model.walletError}</p> : null}
      <p className="still-note">Still prepares unsigned calls and verifies evidence. Only your wallet can approve and submit them. This page does not automatically open your wallet.</p>
    </div>
  );
}
