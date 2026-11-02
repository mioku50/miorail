import { Router, type Request } from 'express';
import { z } from 'zod';
import { STOCKS } from '@mioagent/still-engine/registry';
import { issueLendingDraftV1, lendingMarketV1, verifyLendingDraftV1, type LendingDraftClaimsV1 } from '../lib/lendingDraft.js';
import { verifyBorrowDraftV1 } from '../lib/borrowDraft.js';
import { lendingWireV1, type LendingRunV1 } from '../lib/lendingReview.js';
import { runMorphoRepayV1 } from '../lib/morphoRepayRunner.js';
import { runNativeMorphoBorrowV1 } from '../lib/nativeMorphoBorrowRunner.js';
import { runMorphoBorrowV1 } from '../lib/morphoBorrowRunner.js';
import { readRepayStandingV1 } from '../lib/stillRepayStanding.js';
import { readAaveStandingV1 } from '../lib/stillAaveStanding.js';
import { runAaveLendingV1 } from '../lib/aaveLendingRunner.js';
import { loanExecutionRuntimeV1, type LoanOwnerV1 } from '../lib/loanExecutionStore.js';
import { refreshLoanExecutionV1, loanExecutionWireV1 } from '../lib/loanExecutionStatus.js';
import { createViemBaseReceiptReader } from '../lib/baseReceiptReader.js';
import { readBaseWalletBatchHashesV1 } from '../lib/stockExecutionStatus.js';
import { verifyLendingEffectsAtReceiptV1 } from '../lib/lendingReceiptEffects.js';
import { stillLimitComparisonV1 } from '../lib/stillLimitComparison.js';
import { attachSpendPaymentV1 } from '../lib/stillSpendPayment.js';
import { STILL_SPEND_REVIEW_MARGIN_MS_V1, spendOrderStoreV1, stillSpendCheckoutV1, stillSpendPayEnabledV1 } from '../lib/stillSpendOrders.js';
import { bindLoanStepV1, recheckLoanStepsV1 } from '../lib/lendingSteps.js';
import { loanExecutionShareV1 } from '../lib/stillSpendShare.js';

export const rwaLendingRouter = Router();
export const rwaLendingRuntimeV1 = {
  readRepay: readRepayStandingV1, readAave: readAaveStandingV1, runRepay: runMorphoRepayV1, runAave: runAaveLendingV1, runBorrow: runMorphoBorrowV1, runNativeBorrow: runNativeMorphoBorrowV1,
  store: loanExecutionRuntimeV1.store, reader: createViemBaseReceiptReader,
  readBatchHashes: readBaseWalletBatchHashesV1, verifyEffectPosition: verifyLendingEffectsAtReceiptV1,
  secret: () => (process.env.SESSION_SECRET ?? '').trim(), now: () => new Date(),
  // Still Spend: the open invoices, Bitrefill's own reading of one, and the payment call.
  spendOrders: spendOrderStoreV1, spendEnabled: () => stillSpendPayEnabledV1(),
  spendCheckout: stillSpendCheckoutV1, attachPayment: attachSpendPaymentV1,
  // A loan in steps: how long to wait between reads of a step the read RPC has not seen yet.
  stepReadDelayMs: 1_500,
};
interface OwnerV1 { tenantId: string; walletAddress: string }
function ownerV1(req: Request): OwnerV1 | null {
  const user = (req as Request & { session?: { user?: { id?: string; address?: string; chainId?: number } } }).session?.user;
  if (!user || user.chainId !== 8453 || typeof user.address !== 'string' || !/^0x[0-9a-f]{40}$/.test(user.address) || user.id !== `eip155:8453:${user.address}`) return null;
  return { tenantId: user.id, walletAddress: user.address };
}
const atom = z.string().regex(/^(0|[1-9][0-9]{0,38})$/).refine(v => /^(0|[1-9][0-9]{0,38})$/.test(v) && BigInt(v) < (1n << 128n));
const positive = atom.refine(v => /^[1-9][0-9]{0,38}$/.test(v));
const token = z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform(v => v.toLowerCase());
const id = z.string().uuid();
const RepayIntentV1 = z.object({ collateralTokenAddress: token, amountMode: z.enum(['assets','all']), repayAmountAtomic: positive.nullable(), maximumUsdcAtomic: positive }).strict()
  .refine(v => v.amountMode === 'all' ? v.repayAmountAtomic === null : positive.safeParse(v.repayAmountAtomic).success &&
    positive.safeParse(v.maximumUsdcAtomic).success && BigInt(v.repayAmountAtomic!) <= BigInt(v.maximumUsdcAtomic));

export async function readAaveBorrowCapacityWireV1(input: { tokenAddress: string; walletAddress: string; collateralSupplyAssets: bigint }): Promise<Record<string, unknown>> {
  const answer = await rwaLendingRuntimeV1.readAave({ tokenAddress: input.tokenAddress, walletAddress: input.walletAddress,
    operation: 'borrow', collateralSupplyAssets: input.collateralSupplyAssets });
  if (answer.state === 'refused') return { ...answer, markets: [] };
  const s = answer.standing;
  if (!s.selectedStock || !s.collateralReserve || !s.capacity) return { state: 'refused', refusal: 'aave_capacity_unread', detail: 'The selected stock borrowing limit was not established.', markets: [] };
  return { state: 'read', marketScope: 'still_aave_spoke', readAt: s.readAt, markets: [{ marketId: lendingMarketV1(input.tokenAddress)!.marketId,
    collateralTokenAddress: input.tokenAddress, collateralDecimals: s.selectedStock.decimals, loanDecimals: 6,
    walletCollateralAtomic: s.walletCollateralAssets.toString(), collateralAtomic: s.existingSuppliedAssets.toString(),
    collateralSupplyAtomic: input.collateralSupplyAssets.toString(), blockNumber: s.blockNumber,
    still: { scope: input.collateralSupplyAssets > 0n ? 'selected_collateral' : 'existing_collateral',
      availableAtomic: s.capacity.availableAssets.toString(), limitAtomic: s.capacity.limitAssets.toString(), debtAtomic: s.debtAssets.toString(), termsVersion: s.termsVersion },
    // Still's limit beside Aave's own, for the whole account the loan would use.
    comparison: stillLimitComparisonV1({ protocol: 'Aave V4', protocolLimitAssets: s.capacity.protocolLimitAssets, stillLimitAssets: s.capacity.limitAssets,
      shareBps: s.capacity.shareBpsByStock[s.selectedStock.id], lowered: s.capacity.loweredByStock[s.selectedStock.id] ?? null }) }] };
}

rwaLendingRouter.use((_req, res, next) => { res.setHeader('Cache-Control', 'private, no-store'); next(); });
rwaLendingRouter.get('/rwa/repay/capacity', async (req, res) => {
  const owner = ownerV1(req); if (!owner) { res.status(401).json({ error: 'authentication_required' }); return; }
  const parsed = token.safeParse(req.query.token); if (!parsed.success) { res.status(400).json({ error: 'lending_request_invalid' }); return; }
  const collateralTokenAddress = parsed.data, market = lendingMarketV1(collateralTokenAddress);
  if (!market) { res.status(400).json({ error: 'lending_collateral_not_supported' }); return; }
  if (market.venue === 'morpho') {
    const answer = await rwaLendingRuntimeV1.readRepay({ collateralTokenAddress, walletAddress: owner.walletAddress, marketId: market.marketId });
    if (answer.state === 'refused') { res.json(answer); return; }
    const s = answer.standing;
    res.json({ state: 'read', read: { venue: market.venue, marketId: market.marketId, collateralTokenAddress,
      collateralSymbol: s.collateral.symbol, collateralDecimals: s.collateral.decimals, debtAtomic: s.debtAssets.toString(), walletUsdcAtomic: s.walletLoanAssets.toString(), blockNumber: Number(s.block.number) } });
  } else {
    const answer = await rwaLendingRuntimeV1.readAave({ tokenAddress: collateralTokenAddress, walletAddress: owner.walletAddress, operation: 'repay' });
    if (answer.state === 'refused') { res.json(answer); return; }
    const s = answer.standing, stock = STOCKS.find(row => row.token.toLowerCase() === collateralTokenAddress)!;
    res.json({ state: 'read', read: { venue: market.venue, marketId: market.marketId, collateralTokenAddress,
      collateralSymbol: stock.id, collateralDecimals: stock.decimals, debtAtomic: s.debtAssets.toString(), walletUsdcAtomic: s.walletUsdcAssets.toString(), blockNumber: s.blockNumber } });
  }
});

rwaLendingRouter.post('/rwa/repay/intent', (req, res) => {
  const owner = ownerV1(req); if (!owner) { res.status(401).json({ error: 'authentication_required' }); return; }
  const parsed = RepayIntentV1.safeParse(req.body); if (!parsed.success || !lendingMarketV1(parsed.data.collateralTokenAddress)) { res.status(400).json({ error: 'lending_request_invalid' }); return; }
  if (rwaLendingRuntimeV1.secret().length < 16) { res.status(503).json({ error: 'lending_unavailable' }); return; }
  const q = parsed.data;
  const issued = issueLendingDraftV1({ ...owner, question: { operation: 'repay', collateralTokenAddress: q.collateralTokenAddress,
    amountMode: q.amountMode, repayAssets: q.repayAmountAtomic, maximumAssets: q.maximumUsdcAtomic }, secret: rwaLendingRuntimeV1.secret(), now: rwaLendingRuntimeV1.now() });
  res.json({ draftId: issued.draftId, reviewUrl: `/lending/${issued.draft}`, expiresAt: issued.expiresAt });
});

rwaLendingRouter.get('/rwa/lending/review/:draft', async (req, res) => {
  const owner = ownerV1(req); if (!owner) { res.status(401).json({ error: 'authentication_required' }); return; }
  const signed = String(req.params.draft), secret = rwaLendingRuntimeV1.secret(), now = rwaLendingRuntimeV1.now();
  if (signed.length > 6000) { res.status(400).json({ error: 'lending_draft_invalid' }); return; }
  if (secret.length < 16) { res.status(503).json({ error: 'lending_unavailable' }); return; }
  let verified: { ok: true; claims: LendingDraftClaimsV1 } | { ok: false; refusal: string };
  if (signed.startsWith('miorail-borrow-v1.')) {
    const legacy = verifyBorrowDraftV1({ draft: signed, secret, walletAddress: owner.walletAddress, now, allowExpiredForStatus: true });
    if (!legacy.ok) verified = { ok: false, refusal: legacy.reason };
    else {
      const c = legacy.claims, market = typeof c.collateralTokenAddress === 'string' ? lendingMarketV1(c.collateralTokenAddress) : null;
      verified = c.tenantId !== owner.tenantId || market?.venue !== 'morpho' || market.marketId !== c.marketId
        ? { ok: false, refusal: 'legacy_borrow_market_outside_still' }
        : { ok: true, claims: { version: 1, chainId: 8453, ...owner, draftId: c.borrowDraftId,
            venue: 'morpho', marketId: market.marketId, issuedAt: c.issuedAt, expiresAt: c.expiresAt,
            question: { operation: 'borrow', collateralTokenAddress: c.collateralTokenAddress,
              borrowAssets: c.borrowAssets, collateralSupplyAssets: c.collateralSupplyAssets ?? '0' } } };
    }
  } else verified = verifyLendingDraftV1({ ...owner, draft: signed, secret, now, allowExpiredForStatus: true });
  if (!verified.ok) { res.status(verified.refusal.endsWith('wrong_wallet') ? 403 : 400).json({ error: verified.refusal }); return; }
  const claims = verified.claims, q = claims.question;
  // A wallet that cannot send a batch asks for steps. They are granted only
  // for an Aave V4 loan or repayment, a Spend payment included (it goes last);
  // native ETH and Morpho need one transaction.
  const sequential = req.query.delivery === 'sequential';
  if (sequential && (claims.venue !== 'aave-v4' || (q.operation === 'borrow' && q.nativeFundingAssets !== undefined))) {
    res.json({ state: 'refused', refusal: 'lending_steps_unavailable', detail: q.operation === 'borrow' && q.payment !== undefined
      ? 'Paying Bitrefill from a loan against cbBTC, WETH or ETH goes only as one transaction, and this wallet sends one at a time. Nothing was sent. Choose a stock, or use Base Account, Coinbase Wallet (Base App) or MetaMask.'
      : 'A loan against cbBTC, WETH or ETH goes only as one transaction for now, and this wallet sends one at a time. Nothing was sent. Use Base Account, Coinbase Wallet (Base App) or MetaMask.' });
    return;
  }
  const store = await rwaLendingRuntimeV1.store();
  const prior = await store.getByDraft({ owner, draftId: claims.draftId });
  if (prior && prior.state !== 'ready') {
    const expired = Date.parse(claims.expiresAt) <= now.getTime();
    res.json({ state: 'refused', refusal: expired ? 'lending_preparation_expired' : 'lending_submission_pending',
      detail: expired ? 'The preparation expired. Your existing submission can still be checked; nothing can be sent from this link.'
        : 'This review has an existing wallet attempt. Check its recorded result before preparing another.',
      executionId: prior.executionId, executionState: prior.state, facts: prior.run.facts }); return;
  }
  // Expiration ends preparation, not the owner's access to an already armed
  // submission. This branch can return status/facts, never executable calls.
  if (Date.parse(claims.expiresAt) <= now.getTime()) {
    res.status(400).json({ error: 'lending_draft_expired' }); return;
  }
  // Still Spend: before any loan is measured, the invoice must still be this
  // wallet's, priced as the draft says, waiting for payment at Bitrefill, and
  // not already sent by another review of it.
  const payment = q.operation === 'borrow' ? q.payment ?? null : null;
  if (payment) {
    const refuse = (refusal: string, detail: string) => { res.json({ state: 'refused', refusal, detail }); };
    if (!rwaLendingRuntimeV1.spendEnabled()) { refuse('spend_pay_off', 'Paying from Still is turned off on this server. Nothing can be signed.'); return; }
    const order = rwaLendingRuntimeV1.spendOrders.get(owner, payment.orderId);
    if (!order || order.payTo !== payment.payTo || order.priceAtomic !== payment.assets || order.expiresAt !== payment.expiresAt) {
      refuse('spend_order_unread', 'Still no longer holds this Bitrefill invoice: it expired, or the server restarted. Open a new one from Spend. Nothing was sent.'); return;
    }
    if (Date.parse(payment.expiresAt) - now.getTime() < STILL_SPEND_REVIEW_MARGIN_MS_V1) {
      refuse('spend_invoice_expiring', 'Bitrefill holds this price for less than two more minutes. Open a new invoice from Spend.'); return;
    }
    const attempts = await store.listByPaymentOrder({ owner, orderId: payment.orderId });
    if (attempts.some(row => row.draftId !== claims.draftId && row.state !== 'ready')) {
      refuse('spend_invoice_has_attempt', 'Another review already sent, or tried to send, this invoice’s payment. Check it in Activity before paying again.'); return;
    }
    const status = await rwaLendingRuntimeV1.spendCheckout().readInvoice({ invoiceId: order.orderId, accessToken: order.accessToken });
    if (!status.ok) { refuse('spend_invoice_unread', 'Bitrefill’s invoice could not be read just now, so nothing can be paid. Try again in a minute.'); return; }
    if (status.value.status !== 'unpaid') {
      refuse('spend_invoice_not_unpaid', `Bitrefill reports this invoice as ${status.value.status.replace(/_/g, ' ')}, not waiting for payment. Nothing can be paid to it.`); return;
    }
  }
  let run: LendingRunV1;
  if (claims.venue === 'morpho' && q.operation === 'repay') {
    run = await rwaLendingRuntimeV1.runRepay({ collateralTokenAddress: q.collateralTokenAddress, marketId: claims.marketId,
      walletAddress: owner.walletAddress, amount: q.amountMode === 'all' ? { mode: 'all' } : { mode: 'assets', assets: BigInt(q.repayAssets!) }, maximumAssets: BigInt(q.maximumAssets) });
  } else if (claims.venue === 'morpho' && q.operation === 'borrow' && q.nativeFundingAssets !== undefined) {
    run = await rwaLendingRuntimeV1.runNativeBorrow({walletAddress:owner.walletAddress,supplyAssets:BigInt(q.nativeFundingAssets),borrowAssets:BigInt(q.borrowAssets)});
  } else if (claims.venue === 'morpho' && q.operation === 'borrow') {
    const answer = await rwaLendingRuntimeV1.runBorrow({ collateralTokenAddress: q.collateralTokenAddress,
      walletAddress: owner.walletAddress, marketId: claims.marketId, borrowAssets: BigInt(q.borrowAssets), collateralSupplyAssets: BigInt(q.collateralSupplyAssets) });
    run = answer.state === 'refused' ? { state: 'refused', refusal: answer.refusal, detail: answer.detail ?? 'The borrow was refused.' }
      : !answer.lendingFacts ? { state: 'refused', refusal: 'lending_position_unread', detail: 'The exact measured borrowing position was not established.' }
        : { state: 'ready', facts: answer.lendingFacts, calls: answer.calls, callsHash: answer.callsHash, signingTermsHash: answer.signingTermsHash,
            expiresAt: answer.expiresAt, atomicRequired: true, steps: answer.plan.steps.map(step => ({ index: step.index, to: step.to, reading: step.reading })),
            measured: { provider: answer.measured.providerId, blockNumber: answer.measured.blockNumber, loanDeltaAssets: answer.measured.arrivedAssets } };
  } else {
    run = await rwaLendingRuntimeV1.runAave({ walletAddress: owner.walletAddress, question: q, ...(sequential ? { delivery: 'sequential' as const } : {}) });
  }
  if (payment) run = await rwaLendingRuntimeV1.attachPayment({ walletAddress: owner.walletAddress, run, payment, now });
  if (run.state === 'refused') { res.json(lendingWireV1(run)); return; }
  const record = await store.putReady({ owner, draftId: claims.draftId, run, now: rwaLendingRuntimeV1.now() });
  if (record.state !== 'ready') { res.json({ state: 'refused', refusal: 'lending_submission_pending', detail: 'This review has an existing wallet attempt. Check its recorded result before preparing another.', executionId: record.executionId, executionState: record.state, facts: record.run.facts }); return; }
  res.json({ ...lendingWireV1(record.run), executionId: record.executionId });
});

/** What reads a loan's result from the chain: the same for every route that asks. */
function lendingStatusDepsV1(store: Awaited<ReturnType<typeof rwaLendingRuntimeV1.store>>) {
  return { store, reader: rwaLendingRuntimeV1.reader(), readBatchHashes: rwaLendingRuntimeV1.readBatchHashes,
    verifyEffectPosition: rwaLendingRuntimeV1.verifyEffectPosition, now: rwaLendingRuntimeV1.now };
}
/** Reads a loan in steps that stopped on purpose, so what landed is its result now. A failed read leaves
 * it as it was, to be read again. */
async function settleStoppedStepsV1(store: Awaited<ReturnType<typeof rwaLendingRuntimeV1.store>>, owner: LoanOwnerV1, executionId: string) {
  return refreshLoanExecutionV1({ owner, executionId, refresh: true }, lendingStatusDepsV1(store)).catch(() => null);
}

rwaLendingRouter.post('/rwa/lending/executions/:id/arm', async (req, res) => {
  const owner = ownerV1(req); if (!owner) { res.status(401).json({ error: 'authentication_required' }); return; }
  const body = z.object({ callsHash: z.string().regex(/^0x[0-9a-f]{64}$/i), signingTermsHash: z.string().regex(/^0x[0-9a-f]{64}$/i) }).strict().safeParse(req.body);
  if (!id.safeParse(req.params.id).success || !body.success) { res.status(400).json({ error: 'lending_request_invalid' }); return; }
  const store = await rwaLendingRuntimeV1.store(), executionId = String(req.params.id);
  // One invoice is paid once: a second review of it cannot be armed after the first was.
  const execution = await store.get({ owner, executionId }), paying = execution?.run.facts.payment;
  if (paying && (await store.listByPaymentOrder({ owner, orderId: paying.orderId })).some(row => row.executionId !== executionId && row.state !== 'ready')) {
    res.status(409).json({ error: 'spend_invoice_has_attempt' }); return;
  }
  let result = await store.arm({ owner, executionId, ...body.data, now: rwaLendingRuntimeV1.now() });
  if (!result.ok && result.refusal === 'execution_active') {
    // A lock is only as current as its last reading: what holds this market is read from the chain once
    // (a stopped loan in steps, a batch that landed since), then the same question is asked again.
    for (const held of await store.listActiveInScope({ owner, executionId })) {
      await refreshLoanExecutionV1({ owner, executionId: held.executionId, refresh: true }, lendingStatusDepsV1(store)).catch(() => null);
    }
    result = await store.arm({ owner, executionId, ...body.data, now: rwaLendingRuntimeV1.now() });
  }
  if (!result.ok) { res.status(409).json({ error: result.refusal === 'invoice_has_attempt' ? 'spend_invoice_has_attempt' : result.refusal }); return; }
  res.json({ attemptId: result.attemptId });
});
rwaLendingRouter.post('/rwa/lending/executions/:id/submission', async (req, res) => {
  const owner = ownerV1(req); if (!owner) { res.status(401).json({ error: 'authentication_required' }); return; }
  const body = z.object({ attemptId: id, outcome: z.enum(['submitted','unknown','rejected','stopped']), batchId: z.string().min(1).max(2000).optional() }).strict().safeParse(req.body);
  if (!id.safeParse(req.params.id).success || !body.success || ((body.data.outcome === 'submitted' || body.data.outcome === 'stopped') && !body.data.batchId)) { res.status(400).json({ error: 'lending_request_invalid' }); return; }
  const store = await rwaLendingRuntimeV1.store(), executionId = String(req.params.id);
  // Only a loan in steps can stop part way; a batch is sent whole or not at all.
  if (body.data.outcome === 'stopped' && (await store.get({ owner, executionId }))?.run.delivery !== 'sequential') {
    res.status(409).json({ error: 'lending_attempt_changed' }); return;
  }
  const record = await store.recordSubmission({ owner, executionId, ...body.data, now: rwaLendingRuntimeV1.now() });
  if (!record) { res.status(409).json({ error: 'lending_attempt_changed' }); return; }
  // Stopped on purpose: what landed is read now, so the market is free as soon as the chain says what is in place.
  const settled = body.data.outcome === 'stopped' ? await settleStoppedStepsV1(store, owner, executionId) : null;
  res.json({ executionId: record.executionId, state: (settled ?? record).state });
});
rwaLendingRouter.post('/rwa/lending/executions/:id/transaction', async (req, res) => {
  const owner = ownerV1(req); if (!owner) { res.status(401).json({ error: 'authentication_required' }); return; }
  const body = z.object({ transactionHash: z.string().regex(/^0x[0-9a-f]{64}$/i) }).strict().safeParse(req.body);
  if (!id.safeParse(req.params.id).success || !body.success) { res.status(400).json({ error: 'lending_request_invalid' }); return; }
  const store = await rwaLendingRuntimeV1.store(), executionId = String(req.params.id);
  const record = await store.get({ owner, executionId });
  if (!record || !['awaiting_wallet','submitted','unknown'].includes(record.state)) { res.status(409).json({ error: 'lending_attempt_changed' }); return; }
  // A pasted hash is only a lookup hint. The ordinary exact-call, own-operation,
  // protocol-event and receipt-block position verifier is still mandatory.
  const saved = await store.recordVerification({ owner, executionId, expectedVersion: record.version, state: 'unknown',
    transactionHash: body.data.transactionHash.toLowerCase() as `0x${string}`, proof: null, errorCode: 'loan_transaction_hint_unverified', now: rwaLendingRuntimeV1.now() });
  if (!saved) { res.status(409).json({ error: 'lending_attempt_changed' }); return; }
  res.json({ ...loanExecutionWireV1(saved), facts: saved.run.facts });
});
/** A loan in steps: the step that just landed, read from the chain, and the
 * review run again before the next one. The answer says whether the wallet
 * may be asked for the next step; it never sends anything itself. */
rwaLendingRouter.post('/rwa/lending/executions/:id/steps', async (req, res) => {
  const owner = ownerV1(req); if (!owner) { res.status(401).json({ error: 'authentication_required' }); return; }
  const body = z.object({ attemptId: id, index: z.number().int().min(0).max(15), transactionHash: z.string().regex(/^0x[0-9a-f]{64}$/i), stop: z.boolean().optional() }).strict().safeParse(req.body);
  if (!id.safeParse(req.params.id).success || !body.success) { res.status(400).json({ error: 'lending_request_invalid' }); return; }
  const store = await rwaLendingRuntimeV1.store(), executionId = String(req.params.id), hash = body.data.transactionHash.toLowerCase() as `0x${string}`;
  const record = await store.get({ owner, executionId });
  if (!record || record.run.delivery !== 'sequential' || record.state !== 'awaiting_wallet' || record.attemptId !== body.data.attemptId) {
    res.status(409).json({ error: 'lending_attempt_changed' }); return;
  }
  // The wallet saw the receipt; the read RPC may lag a block or two behind it.
  const reader = rwaLendingRuntimeV1.reader();
  let read: { receipt: Awaited<ReturnType<typeof reader.getTransactionReceipt>>; transaction: Awaited<ReturnType<typeof reader.getTransaction>> } | null = null;
  for (let attempt = 0; attempt < 6 && !read; attempt++) {
    if (attempt > 0) await new Promise(resolve => setTimeout(resolve, rwaLendingRuntimeV1.stepReadDelayMs));
    try {
      const [receipt, transaction] = await Promise.all([reader.getTransactionReceipt(hash), reader.getTransaction(hash)]);
      if (receipt && transaction && receipt.transactionHash.toLowerCase() === hash) read = { receipt, transaction };
    } catch { /* read again */ }
  }
  if (!read?.receipt || !read.transaction) { res.status(409).json({ error: 'lending_step_unread' }); return; }
  const bound = bindLoanStepV1({ execution: record, index: body.data.index, transaction: read.transaction, receipt: read.receipt });
  if (bound.state === 'unknown') { res.status(409).json({ error: bound.errorCode }); return; }
  const last = body.data.index === record.run.calls.length - 1;
  const saved = await store.recordStep({ owner, executionId, attemptId: body.data.attemptId, index: body.data.index, transactionHash: hash,
    stop: !last && (bound.state === 'failed' || body.data.stop === true), now: rwaLendingRuntimeV1.now() });
  if (!saved) { res.status(409).json({ error: 'lending_attempt_changed' }); return; }
  if (bound.state === 'failed') {
    res.json({ state: 'stopped', refusal: 'loan_step_reverted', detail: `Step ${body.data.index + 1} failed onchain, so the rest was not sent.`, batchId: saved.batchId }); return;
  }
  if (last) { res.json({ state: 'submitted', batchId: saved.batchId }); return; }
  if (body.data.stop) {
    await settleStoppedStepsV1(store, owner, executionId);
    res.json({ state: 'stopped', refusal: 'loan_steps_stopped', detail: 'The remaining steps were not sent.', batchId: saved.batchId }); return;
  }
  // A Spend loan is reviewed again with its payment attached, and before the
  // payment itself Bitrefill's invoice is read again (lendingSteps).
  const payment = saved.run.facts.payment ?? null;
  const check = await recheckLoanStepsV1({ record: saved, landed: body.data.index + 1, now: rwaLendingRuntimeV1.now(),
    review: async question => {
      const run = await rwaLendingRuntimeV1.runAave({ walletAddress: owner.walletAddress, question, delivery: 'sequential' });
      return payment ? rwaLendingRuntimeV1.attachPayment({ walletAddress: owner.walletAddress, run, payment, now: rwaLendingRuntimeV1.now() }) : run;
    },
    ...(payment ? { invoice: async () => {
      if (!rwaLendingRuntimeV1.spendEnabled()) return { ok: false as const, refusal: 'spend_pay_off' as const };
      const order = rwaLendingRuntimeV1.spendOrders.get(owner, payment.orderId);
      if (!order || order.payTo !== payment.payTo || order.priceAtomic !== payment.assets) return { ok: false as const, refusal: 'spend_order_unread' as const };
      const status = await rwaLendingRuntimeV1.spendCheckout().readInvoice({ invoiceId: order.orderId, accessToken: order.accessToken });
      return status.ok ? { ok: true as const, status: status.value.status } : { ok: false as const, refusal: 'spend_invoice_unread' as const };
    } } : {}) });
  if (!check.ok) {
    // What landed is submitted and the rest is never asked of the wallet, so it is final from the chain.
    const stopped = await store.recordSubmission({ owner, executionId, attemptId: body.data.attemptId, outcome: 'stopped', batchId: saved.batchId, now: rwaLendingRuntimeV1.now() });
    if (stopped) await settleStoppedStepsV1(store, owner, executionId);
    res.json({ state: 'stopped', refusal: check.refusal, detail: check.detail, batchId: stopped?.batchId ?? saved.batchId }); return;
  }
  res.json({ state: 'next', index: body.data.index + 1, batchId: saved.batchId });
});
rwaLendingRouter.get('/rwa/lending/executions/:id', async (req, res) => {
  const owner = ownerV1(req); if (!owner) { res.status(401).json({ error: 'authentication_required' }); return; }
  if (!id.safeParse(req.params.id).success) { res.status(400).json({ error: 'lending_request_invalid' }); return; }
  const record = await refreshLoanExecutionV1({ owner, executionId: String(req.params.id), refresh: true }, lendingStatusDepsV1(await rwaLendingRuntimeV1.store()));
  if (!record) { res.status(404).json({ error: 'lending_execution_not_found' }); return; }
  res.json({ ...loanExecutionWireV1(record), facts: record.run.facts,
    transactionHash: record.transactionHash, verification: record.verification, errorCode: record.errorCode,
    // Still Spend: once the loan that paid an invoice is confirmed, its owner gets a card to share.
    share: loanExecutionShareV1(record, rwaLendingRuntimeV1.secret()) });
});
