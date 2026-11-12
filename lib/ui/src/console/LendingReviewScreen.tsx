import React from 'react';
import { tokenDecimalV1 } from './stockSellAmount';
import { formatLendingHealthRatioV1, labelLendingTargetV1, lendingExecutionCopyV1 } from './lendingReviewView';
import type { LendingReviewConsoleModelV1 } from './useLendingReviewConsole';
import { spendConfirmByNoteV1 } from '../still/spendView';

void React;
export { formatLendingHealthRatioV1 };

/** While the wallet has a loan that pays an invoice: by when to confirm, counted in minutes (audit SPEND-6). */
function LendingInvoiceDeadlineV1({ expiresAt, orderId }: { expiresAt: string; orderId: string }) {
  const [now, setNow] = React.useState(() => new Date());
  React.useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 15_000);
    return () => clearInterval(timer);
  }, []);
  const note = spendConfirmByNoteV1({ expiresAt, orderId, now, withLoan: true });
  return note ? <p className="still-note" role="status">{note}</p> : null;
}

/** One review for both web and Base App. Values and verdicts belong to the
 * server; the screen formats exact decimals and never recalculates risk. */
export function LendingReviewScreen({ model }: { model: LendingReviewConsoleModelV1 }) {
  if (model.loading) return <p className="still-section still-note" role="status">Reading the position and simulating the exact calls…</p>;
  const backLink = model.back ? <a className="still-btn sec" href={model.back.href}>{model.back.label}</a> : null;
  if (model.error) return <div className="still-section"><p className="still-warn" role="alert">{model.error}</p>{backLink}</div>;
  if (!model.body) return <p className="still-section still-note">There is no lending review to display.</p>;
  const body = model.body, facts = body.facts;
  const repay = facts?.operation === 'repay';
  // Repay all and take the collateral back; with nothing owed, the collateral alone.
  const back = facts?.collateralReturnAssets ?? null, onlyBack = back !== null && facts?.maximumDebitAssets === '0';
  const title = facts ? repay ? back !== null ? `${onlyBack ? 'Take back' : 'Repay all and take back'} ${facts.collateralSymbol}` : 'Review repayment' : 'Review loan' : 'Lending review';
  const asset = (value: string) => facts ? `${tokenDecimalV1(value, facts.collateralDecimals)} ${facts.collateralSymbol}` : value;
  const usdc = (value: string) => `${tokenDecimalV1(value, 6)} USDC`;
  const health = (value: string | null | undefined, debtAssets: string) => formatLendingHealthRatioV1(value, debtAssets, facts?.operation ?? 'borrow');
  const debtIncrease = facts && !repay ? BigInt(facts.debtAfterAssets) - BigInt(facts.debtBeforeAssets) : BigInt(0);
  const shareRoundingExtra = facts && !repay && facts.requestedAssets !== null && debtIncrease > BigInt(facts.requestedAssets);
  const knownState = model.execution?.state ?? (body.state === 'refused' ? body.executionState : null);
  const inSteps = body.state === 'ready' && body.delivery === 'sequential';
  const blocked = Boolean(model.submissionLock || model.batchId || (knownState && knownState !== 'ready'));
  // A loan in steps that went part way: what landed, the step Still has not seen, and the step after a stop.
  const standing = model.execution?.steps ?? null;
  const inPlace = standing ? standing.landed === 1 ? `Step 1 of ${standing.total} is in place on Base` : `Steps 1–${standing.landed} of ${standing.total} are in place on Base` : '';
  const stoppedInSteps = standing !== null && knownState === 'failed' && model.execution?.errorCode === 'loan_steps_stopped' && standing.landed < standing.total;
  const releasedUnsent = knownState === 'failed' && model.execution?.errorCode === 'loan_wallet_sent_nothing';
  return (
    <div className="still-section still-lending-review">
      <div className="still-eyebrow">{facts ? facts.venue === 'aave-v4' ? 'Aave V4 · Base' : 'Morpho · Base' : 'Base lending'}</div>
      <h1>{title}</h1>
      <p className="still-sub">Read the measured terms before anything is signed.</p>
      {body.state === 'refused' ? <><p className="still-warn" role="alert">{body.detail}</p>{backLink}</> : null}
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
            <tr><th scope="row">Health ratio</th><td className="mono">{health(facts.healthBeforeWad, facts.debtBeforeAssets)}</td>{body.state === 'ready' ? <td className="mono">{health(facts.healthAfterWad, facts.debtAfterAssets)}</td> : null}</tr>
          </tbody>
        </table>
        <p className="still-note">
          {repay && facts.healthBeforeWad == null && facts.healthAfterWad == null
            ? back !== null ? `${facts.venue === 'morpho' ? 'Morpho' : 'Aave'} checks the account before the collateral leaves. With the whole debt repaid first, nothing is left for it to secure, so no health ratio applies.`
              : 'Health ratio is not checked during repayment: repaying USDC only reduces your debt and keeps collateral deposited, so execution does not depend on live oracle prices.'
            : 'Health ratio is calculated at the simulation block. It does not guarantee protection against liquidation after prices change.'}
        </p>
        {body.state === 'ready' ? <>
          {repay ? <>
            {onlyBack ? <p className="still-sub">No USDC debt is open. Take back <strong>{asset(back!)}</strong> to this wallet; no USDC moves.</p> : <>
              {/* 2026-11-07, the operator: the cap read as what is paid. What is paid comes first, measured; the cap after it. */}
              {facts.amountMode === 'all' ? <>
                <p className="still-sub">Repay all of the debt: <strong>{usdc((BigInt(facts.debtBeforeAssets) > BigInt(facts.debtAfterAssets) ? BigInt(facts.debtBeforeAssets) - BigInt(facts.debtAfterAssets) : BigInt(0)).toString())}</strong> in
                  the simulation at block {facts.blockNumber.toLocaleString('en-US')}, plus the interest until your transaction lands.</p>
                <p className="still-sub">The most it may take: {usdc(facts.maximumDebitAssets)}.</p>
                <p className="still-note">That is a cap, not the payment. Your wallet must hold it; only what is owed is taken, and the rest stays in your wallet.{back !== null ? '' : ' Your collateral stays deposited.'}</p>
              </> : <>
                <p className="still-sub">Repay exactly {usdc(facts.requestedAssets!)}.</p>
                <p className="still-note">Your wallet pays exactly that.{back !== null ? '' : ' Your collateral stays deposited.'}</p>
              </>}
              {back !== null ? <p className="still-sub">Then take back <strong>{asset(back)}</strong> to this wallet, {inSteps ? 'as the last step' : 'in the same transaction'}.</p> : null}
            </>}
            {facts.amountMode === 'assets' && BigInt(facts.debtAfterAssets) > BigInt(0) && BigInt(facts.debtAfterAssets) < BigInt(10_000) ? <p className="still-note">Remaining micro-debt ({usdc(facts.debtAfterAssets)}) comes from onchain share rounding and accrued interest when repaying exact {usdc(facts.requestedAssets!)}. To close the entire debt to 0 USDC, use Repay all debt with a small USDC buffer.</p> : null}
          </> : <>
            <p className="still-sub">Borrow {facts.requestedAssets === null ? 'the measured amount' : usdc(facts.requestedAssets)} to this wallet.</p>
            {facts.payment ? <div className="still-notice" role="note"><span>
              <strong>Then pay Bitrefill {usdc(facts.payment.assets)} for {facts.payment.productName} · {facts.payment.packageValue}{facts.payment.faceCurrency && /^\d+(?:\.\d+)?$/.test(facts.payment.packageValue) ? ` ${facts.payment.faceCurrency}` : ''}, {inSteps ? 'as the last step' : 'in the same transaction'}.</strong>{' '}
              {inSteps ? 'Still reads the invoice again before your wallet is asked for that step; if Bitrefill no longer waits for it, nothing is paid. ' : null}
              It goes to Bitrefill’s invoice address <span className="mono" style={{ overflowWrap: 'anywhere' }}>{facts.payment.payTo}</span>, which Still read from Bitrefill.
              {body.deliverTo ? <>{' '}Bitrefill sends what you buy to <strong style={{ overflowWrap: 'anywhere' }}>{body.deliverTo.email}</strong>{body.deliverTo.phone
                ? <>, and tops up <strong className="mono">{body.deliverTo.phone}</strong></> : null}. Check that {body.deliverTo.phone ? 'they are' : 'it is'} yours:
                the invoice was opened with {body.deliverTo.phone ? 'them' : 'it'}, and Still cannot change {body.deliverTo.phone ? 'them' : 'it'}.{' '}</> : null}
              Bitrefill holds this price until {new Date(facts.payment.expiresAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}. The loan stays yours to repay.
            </span></div> : null}
            <p className="still-note">New collateral selected: {asset(facts.collateralSupplyAssets)}. Borrowing creates debt; collateral can be liquidated.</p>
            {shareRoundingExtra ? <p className="still-note">Your wallet receives {usdc(facts.requestedAssets!)} ({facts.requestedAssets} atomic USDC). Onchain debt-share rounding records {usdc(debtIncrease.toString())} ({debtIncrease.toString()} atomic USDC) of new debt.</p> : null}
          </>}
          {facts.warnings.length > 0 ? <div className="still-warn" role="note">
            <p style={{ margin: 0, fontWeight: 600 }}>Key risks &amp; execution terms</p>
            <ul style={{ margin: '0.35rem 0 0', paddingLeft: '1.15rem' }}>
              {facts.warnings.map((warning, index) => <li key={`${index}:${warning}`}>{warning}</li>)}
            </ul>
          </div> : null}
          <p className="still-note">Simulated at Base block {body.measured.blockNumber.toLocaleString('en-US')}. The position and exact calls are checked again before your wallet opens.</p>
          <details className="still-disclosure" open>
            {inSteps ? <>
              <summary>Steps in your wallet ({body.steps.length} {body.steps.length === 1 ? 'transaction' : 'transactions'}) &amp; technical details</summary>
              <p className="still-note">Your wallet sends these one at a time. Still simulated all {body.steps.length} together at Base block {body.measured.blockNumber.toLocaleString('en-US')} and verified every asset movement, and it reviews each next step again, from the chain as it is then, before your wallet asks for it.</p>
            </> : <>
              <summary>Verified atomic batch ({body.steps.length} {body.steps.length === 1 ? 'call' : 'calls'}) &amp; technical details</summary>
              <p className="still-note">Some wallets (including Coinbase Wallet) may display &ldquo;Transaction preview unavailable&rdquo; for multi-call atomic batches. Still has already simulated all {body.steps.length} {body.steps.length === 1 ? 'call' : 'calls'} below at Base block {body.measured.blockNumber.toLocaleString('en-US')} and verified every asset movement.</p>
            </>}
            {!repay ? <>
              <p className="still-note">Still total debt limit: {facts.policyLimitAssets == null ? 'Not read' : usdc(facts.policyLimitAssets)}.</p>
              <p className="still-note">Protocol total debt limit: {facts.protocolLimitAssets == null ? 'Not read' : usdc(facts.protocolLimitAssets)}.</p>
              <p className="still-note">Terms version: {facts.termsVersion ?? 'Not read'}.</p>
            </> : null}
            <p className="still-note mono" style={{ overflowWrap: 'anywhere' }}>
              Atomic units — {repay
                ? `repay request: ${facts.requestedAssets ?? 'all'}, max USDC debit: ${facts.maximumDebitAssets}, wallet USDC delta: ${body.measured.loanDeltaAssets}${back !== null ? `, collateral returned: ${back}` : ''}`
                : `borrow request: ${facts.requestedAssets ?? '0'}, wallet USDC delta: ${body.measured.loanDeltaAssets}, collateral supply: ${facts.collateralSupplyAssets}`}; debt: {facts.debtBeforeAssets} → {facts.debtAfterAssets}{facts.debtBeforeShares !== null && facts.debtAfterShares !== null ? ` (shares: ${facts.debtBeforeShares} → ${facts.debtAfterShares})` : ''}; collateral: {facts.collateralBeforeAssets} → {facts.collateralAfterAssets}{facts.collateralBeforeShares != null && facts.collateralAfterShares != null ? ` (shares: ${facts.collateralBeforeShares} → ${facts.collateralAfterShares})` : ''}.
            </p>
            {body.steps.map(step => <div key={step.index} style={{ padding: '0.45rem 0', borderTop: '1px solid rgba(255,255,255,0.08)' }}>
              <p className="still-note" style={{ margin: 0 }}>
                <strong>Step {step.index + 1} of {body.steps.length} · {labelLendingTargetV1(step.to, facts)}</strong>{' '}
                <span className="mono" style={{ overflowWrap: 'anywhere' }}>{step.to}</span>
              </p>
              <p className="still-note" style={{ margin: '0.2rem 0 0' }}>{step.reading}</p>
            </div>)}
          </details>
        </> : <p className="still-note">No executable calls are available for this refusal.</p>}
      </> : null}
      {knownState ? <p className={knownState === 'confirmed' ? 'still-sub' : 'still-note'} role="status">{lendingExecutionCopyV1(knownState, model.execution?.errorCode ?? null, model.execution?.remainingDebtAtomic ?? null)}</p> : null}
      {model.batchId && !model.execution ? <p className="still-note" role="status">Submitted from your wallet. A batch ID is a submission handle; it is not a confirmed blockchain result.</p> : null}
      {model.execution?.transactionHash ? <p className="still-note mono" style={{ overflowWrap: 'anywhere' }}>Transaction: {model.execution.transactionHash}</p> : null}
      {model.submissionLock && knownState !== 'confirmed' ? <p className="still-note" role="status">{model.submissionLock}</p> : null}
      {model.step ? <p className="still-note" role="status">{model.step.phase === 'wallet' ? `Step ${model.step.index} of ${model.step.total}: confirm it in your wallet.`
        : model.step.phase === 'confirming' ? `Step ${model.step.index} of ${model.step.total} sent. Waiting for it to land on Base…`
          : `Step ${model.step.index} of ${model.step.total} landed. Still checks the next step against the chain…`}</p> : null}
      {body.state === 'ready' && model.onOpen && !blocked && !inSteps && model.feeNote ? <p className="still-note">{model.feeNote}</p> : null}
      {/* A Spend loan in the wallet: the transfer carries no deadline of its own, so the invoice's is said here (audit SPEND-6). */}
      {body.state === 'ready' && model.walletBusy && facts?.payment
        ? <LendingInvoiceDeadlineV1 expiresAt={facts.payment.expiresAt} orderId={facts.payment.orderId} /> : null}
      {/* The terms moved while the person read them. Nothing failed and nothing was sent: the page shows the
          new terms, and this says so beside the button that accepts them. */}
      {body.state === 'ready' && model.onOpen && !blocked && model.termsChanged && model.walletError
        ? <p className="still-note" role="status"><strong>Nothing was sent.</strong> {model.walletError}</p> : null}
      {body.state === 'ready' && model.onOpen && !blocked ? <button type="button" className="still-btn" disabled={model.walletBusy} onClick={model.onOpen}>
        {model.walletBusy ? 'Waiting for your wallet…'
          : model.termsChanged ? (inSteps ? `Accept these terms and open step 1 of ${body.steps.length}` : 'Accept these terms and open your wallet')
            : inSteps ? `Open step 1 of ${body.steps.length} in your wallet` : 'Open in your wallet'}
      </button> : null}
      {/* The result is read from Base by itself once something was sent: no press is needed while it is. */}
      {model.following ? <p className="still-note" role="status">Reading the result from Base…</p> : null}
      {model.followEnded && model.onCheck ? <p className="still-note" role="status">Base has not shown it yet. Your wallet may still be sending it; check again in a moment, and look at your wallet’s activity.</p> : null}
      {model.onCheck ? <button type="button" className="still-btn sec" disabled={model.checking || model.walletBusy} onClick={model.onCheck}>
        {model.checking ? 'Checking the onchain result…' : model.followEnded ? 'Check again' : 'Check onchain result'}
      </button> : null}
      {model.onStop && standing ? <>
        <p className="still-note" role="status">{inPlace}, and Still has not seen step {standing.landed + 1} land.</p>
        <p className="still-note">If you will not send step {standing.landed + 1}, stop here. Still first checks on Base that your wallet sent nothing after step {standing.landed} and has
          nothing waiting; only then is this {repay ? 'repayment' : 'loan'} recorded as stopped after step {standing.landed}, and Repay works again. Do not stop while your wallet
          still asks you to approve step {standing.landed + 1}.</p>
        <button type="button" className="still-btn sec" disabled={model.checking || model.walletBusy} onClick={model.onStop}>{model.checking ? 'Checking Base…' : 'Stop here'}</button>
      </> : null}
      {model.onRelease ? <>
        <p className="still-note" role="status">Still has found no transaction for this review on Base, and while it waits this market takes no other loan or repayment from your wallet.</p>
        <p className="still-note">If your wallet never sent it, release it. Still first checks on Base that your wallet has sent nothing since this review and has nothing
          waiting; only then is the review recorded as not sent, and the market works again. If your wallet still shows this request, or a transaction of it waiting,
          decline or cancel it there first.</p>
        <button type="button" className="still-btn sec" disabled={model.checking || model.walletBusy} onClick={model.onRelease}>{model.checking ? 'Checking Base…' : 'It was not sent: release it'}</button>
      </> : null}
      {model.onFindTransaction ? <details className="still-lending-details">
        <summary>{stoppedInSteps ? `Your wallet sent step ${standing.landed + 1} after all?` : releasedUnsent ? 'Your wallet sent it after all?' : 'Wallet sent it, but the result is still unknown?'}</summary>
        <p className="still-note">{stoppedInSteps
          ? `Paste its hash from your wallet activity. Still adds it to this ${repay ? 'repayment' : 'loan'} only if it is exactly step ${standing.landed + 1}, landed on Base; it will not send anything.`
          : releasedUnsent ? `Paste its hash from your wallet activity. Still takes this ${repay ? 'repayment' : 'loan'} back only if that transaction is exactly this review’s, landed on Base; it will not send anything.`
          : 'Paste the transaction hash from your wallet activity. Still will check that transaction against this exact action; it will not send anything.'}</p>
        <label className="still-borrow-label">Transaction hash
          <input className="still-borrow-stock-select mono" type="text" autoComplete="off" spellCheck={false} value={model.transactionHint ?? ''}
            onChange={event => model.onTransactionHint?.(event.target.value)} disabled={model.checking || model.walletBusy} />
        </label>
        <button type="button" className="still-btn sec" onClick={model.onFindTransaction} disabled={model.checking || model.walletBusy}>Find this transaction</button>
      </details> : null}
      {model.walletError && !model.termsChanged && !(body.state === 'refused' && body.detail === model.walletError) ? <p className="still-warn" role="alert">{model.walletError}</p> : null}
      {/* A Spend loan in steps that stopped before its payment only because Bitrefill could not be read: the invoice is still open. */}
      {model.walletPayPath ? <p className="still-note"><a href={model.walletPayPath}>Pay this invoice from your wallet</a></p> : null}
      <p className="still-note">Still prepares unsigned calls and verifies evidence. Only your wallet can approve and submit them. This page does not automatically open your wallet.</p>
    </div>
  );
}
