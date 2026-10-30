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
import { loanExecutionRuntimeV1 } from '../lib/loanExecutionStore.js';
import { refreshLoanExecutionV1, loanExecutionWireV1 } from '../lib/loanExecutionStatus.js';
import { createViemBaseReceiptReader } from '../lib/baseReceiptReader.js';
import { readBaseWalletBatchHashesV1 } from '../lib/stockExecutionStatus.js';
import { verifyLendingEffectsAtReceiptV1 } from '../lib/lendingReceiptEffects.js';

export const rwaLendingRouter = Router();
export const rwaLendingRuntimeV1 = {
  readRepay: readRepayStandingV1, readAave: readAaveStandingV1, runRepay: runMorphoRepayV1, runAave: runAaveLendingV1, runBorrow: runMorphoBorrowV1, runNativeBorrow: runNativeMorphoBorrowV1,
  store: loanExecutionRuntimeV1.store, reader: createViemBaseReceiptReader,
  readBatchHashes: readBaseWalletBatchHashesV1, verifyEffectPosition: verifyLendingEffectsAtReceiptV1,
  secret: () => (process.env.SESSION_SECRET ?? '').trim(), now: () => new Date(),
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
      availableAtomic: s.capacity.availableAssets.toString(), limitAtomic: s.capacity.limitAssets.toString(), debtAtomic: s.debtAssets.toString(), termsVersion: s.termsVersion } }] };
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
    run = await rwaLendingRuntimeV1.runAave({ walletAddress: owner.walletAddress, question: q });
  }
  if (run.state === 'refused') { res.json(lendingWireV1(run)); return; }
  const record = await store.putReady({ owner, draftId: claims.draftId, run, now: rwaLendingRuntimeV1.now() });
  if (record.state !== 'ready') { res.json({ state: 'refused', refusal: 'lending_submission_pending', detail: 'This review has an existing wallet attempt. Check its recorded result before preparing another.', executionId: record.executionId, executionState: record.state, facts: record.run.facts }); return; }
  res.json({ ...lendingWireV1(record.run), executionId: record.executionId });
});

rwaLendingRouter.post('/rwa/lending/executions/:id/arm', async (req, res) => {
  const owner = ownerV1(req); if (!owner) { res.status(401).json({ error: 'authentication_required' }); return; }
  const body = z.object({ callsHash: z.string().regex(/^0x[0-9a-f]{64}$/i), signingTermsHash: z.string().regex(/^0x[0-9a-f]{64}$/i) }).strict().safeParse(req.body);
  if (!id.safeParse(req.params.id).success || !body.success) { res.status(400).json({ error: 'lending_request_invalid' }); return; }
  const result = await (await rwaLendingRuntimeV1.store()).arm({ owner, executionId: String(req.params.id), ...body.data, now: rwaLendingRuntimeV1.now() });
  if (!result.ok) { res.status(409).json({ error: result.refusal }); return; }
  res.json({ attemptId: result.attemptId });
});
rwaLendingRouter.post('/rwa/lending/executions/:id/submission', async (req, res) => {
  const owner = ownerV1(req); if (!owner) { res.status(401).json({ error: 'authentication_required' }); return; }
  const body = z.object({ attemptId: id, outcome: z.enum(['submitted','unknown','rejected']), batchId: z.string().min(1).max(2000).optional() }).strict().safeParse(req.body);
  if (!id.safeParse(req.params.id).success || !body.success || (body.data.outcome === 'submitted' && !body.data.batchId)) { res.status(400).json({ error: 'lending_request_invalid' }); return; }
  const record = await (await rwaLendingRuntimeV1.store()).recordSubmission({ owner, executionId: String(req.params.id), ...body.data, now: rwaLendingRuntimeV1.now() });
  if (!record) { res.status(409).json({ error: 'lending_attempt_changed' }); return; }
  res.json({ executionId: record.executionId, state: record.state });
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
rwaLendingRouter.get('/rwa/lending/executions/:id', async (req, res) => {
  const owner = ownerV1(req); if (!owner) { res.status(401).json({ error: 'authentication_required' }); return; }
  if (!id.safeParse(req.params.id).success) { res.status(400).json({ error: 'lending_request_invalid' }); return; }
  const record = await refreshLoanExecutionV1({ owner, executionId: String(req.params.id), refresh: true }, {
    store: await rwaLendingRuntimeV1.store(), reader: rwaLendingRuntimeV1.reader(), readBatchHashes: rwaLendingRuntimeV1.readBatchHashes,
    verifyEffectPosition: rwaLendingRuntimeV1.verifyEffectPosition, now: rwaLendingRuntimeV1.now,
  });
  if (!record) { res.status(404).json({ error: 'lending_execution_not_found' }); return; }
  res.json({ ...loanExecutionWireV1(record), facts: record.run.facts,
    transactionHash: record.transactionHash, verification: record.verification, errorCode: record.errorCode });
});
