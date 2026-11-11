import { Router, type Request, type Response } from 'express';
import { BORROW_REVIEW_REFUSALS_V1 } from '@mioagent/rwa-issuer/borrowReview';
import { morphoBorrowCapacityV1 } from '@mioagent/rwa-issuer/morphoBorrowMath';

import { issueBorrowDraftV1 } from '../lib/borrowDraft.js';
import { readBorrowStandingV1, stillBorrowAssetV1, stillBorrowCapacityWireV1, stillBorrowComparisonWireV1 } from '../lib/stillBorrowStanding.js';
import { runMorphoBorrowV1 } from '../lib/morphoBorrowRunner.js';
import { nativeMorphoFundingRefusalV1 } from '../lib/nativeMorphoBorrowPlan.js';
import { TERMS } from '@mioagent/still-engine/policy';
import { STOCKS, CRYPTO, ADDRESSES } from '@mioagent/still-engine/registry';
import { issueLendingDraftV1, type LendingPaymentV1 } from '../lib/lendingDraft.js';
import { spendDraftPaymentV1, spendOrderStoreV1, stillSpendPayEnabledV1 } from '../lib/stillSpendOrders.js';
import { readAaveBorrowCapacityWireV1 } from './rwaLending.js';
import { stillEntryGateV1 } from '../lib/stillRegion.js';

// ---------------------------------------------------------------------------
// Borrow, for the two consoles.
//
// THE ONE DIFFERENCE FROM THE MCP SURFACE, AND WHY IT IS PRINCIPLED
//
// These endpoints return the measured calls on a ready verdict; the MCP tools
// return none, ever. That is not an inconsistency. A request here carries the
// session of the wallet the borrow is for, and what comes back is rendered on a
// screen a person is looking at — the review IS the human step. An MCP response
// is read by a model, with nobody necessarily looking, so the only thing it may
// carry away is a link to this screen.
//
// EVERY OPEN IS A FRESH MEASUREMENT
//
// Opening a draft re-runs the whole gate: the market is re-read, the venue
// writes the calldata again and the batch is executed against current state.
// The draft carries the question, never the answer, so there is nothing stale
// in it to show. Base's own borrowing guidance is the spec: re-fetch and
// display health immediately before signing.
// ---------------------------------------------------------------------------

export const rwaBorrowRouter = Router();

/** Everything these endpoints reach outside themselves, in one place, so a test
 * substitutes the venue and the simulator without touching process state. */
export const rwaBorrowRuntimeV1 = {
  read: readBorrowStandingV1,
  run: runMorphoBorrowV1,
  secret: (): string => (process.env.SESSION_SECRET ?? '').trim(),
  now: () => new Date(),
  spendOrders: spendOrderStoreV1,
  spendEnabled: () => stillSpendPayEnabledV1(),
  // A new loan is not offered in the United States or to US persons (lib/stillRegion.ts).
  entryGate: stillEntryGateV1,
};

interface BorrowSessionUserV1 {
  id: string;
  address: string;
  chainId: number;
}

function sessionUserV1(req: Request): BorrowSessionUserV1 | null {
  const user = (req as { session?: { user?: BorrowSessionUserV1 } }).session?.user;
  if (
    !user ||
    user.chainId !== 8453 ||
    !/^0x[0-9a-f]{40}$/.test(user.address) ||
    user.id !== `eip155:8453:${user.address}`
  ) {
    return null;
  }
  return user;
}

function unauthenticated(res: Parameters<Parameters<typeof rwaBorrowRouter.get>[1]>[1]): void {
  res.status(401).json({ error: 'authentication_required', code: 'authentication_required' });
}

/** Wire amounts are canonical base-unit strings. Bound length before BigInt
 * so an oversized body/query cannot turn a capacity read into unbounded work. */
function atomicV1(value: unknown, allowZero: boolean): bigint | null {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,38})$/.test(value)) return null;
  const amount = BigInt(value);
  return amount < 1n << 128n && (allowZero || amount > 0n) ? amount : null;
}

const objectV1 = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * What this wallet could borrow against one exact token, market by market.
 *
 * A read. No preparation, no simulation, nothing executable, and every row
 * carries which of the two constraints set its figure rather than one merged
 * number that describes neither.
 */
rwaBorrowRouter.get('/rwa/borrow/capacity', async (req, res) => {
  const user = sessionUserV1(req);
  if (!user) return unauthenticated(res);

  const token = String(req.query.token ?? '').trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(token)) {
    res.status(400).json({ error: 'token_not_exact', code: 'token_not_exact' });
    return;
  }
  const native = req.query.funding === 'native';
  if (req.query.funding !== undefined && !native) { res.status(400).json({error:'borrow_funding_invalid'}); return; }
  if (native && token !== ADDRESSES.weth.toLowerCase()) { res.status(400).json({error:'borrow_funding_invalid'}); return; }
  const supply = req.query.collateralSupplyAtomic === undefined ? 0n : atomicV1(req.query.collateralSupplyAtomic, true);
  if (supply === null || native && supply === 0n) {
    res.status(400).json({ error: 'borrow_request_not_exact', code: 'borrow_request_not_exact' });
    return;
  }
  if (STOCKS.some(stock => stock.token.toLowerCase() === token)) {
    res.json(await readAaveBorrowCapacityWireV1({ tokenAddress: token, walletAddress: user.address, collateralSupplyAssets: supply }));
    return;
  }
  const asset = stillBorrowAssetV1(token);
  if (supply > 0n && !asset) {
    res.status(400).json({ error: 'borrow_collateral_not_supported', code: 'borrow_collateral_not_supported' });
    return;
  }

  const reading = await rwaBorrowRuntimeV1.read({ tokenAddress: token, walletAddress: user.address, ...(native ? {nativeFunding:true} : {}) });
  if (reading.state === 'refused') {
    res.json({
      state: 'refused',
      readAt: reading.readAt,
      refusal: reading.refusal,
      detail: reading.detail,
      markets: [],
    });
    return;
  }
  const nativeRefusal = native ? nativeMorphoFundingRefusalV1(reading.nativeFunding?.balance ?? null, supply) : null;
  if (nativeRefusal) {
    res.json({ state: 'refused', readAt: reading.readAt, ...nativeRefusal, markets: [] }); return;
  }
  if (supply > 0n && !native) {
    const unread = reading.markets.some(entry => entry.walletCollateralAssets === null || entry.walletCollateralAssets === undefined);
    const insufficient = reading.markets.some(entry => entry.walletCollateralAssets !== null && entry.walletCollateralAssets !== undefined && entry.walletCollateralAssets < supply);
    if (unread || insufficient) {
      const refusal = unread ? 'wallet_collateral_unread' : 'wallet_collateral_insufficient';
      res.json({ state: 'refused', readAt: reading.readAt, refusal, detail: BORROW_REVIEW_REFUSALS_V1[refusal], markets: [] });
      return;
    }
  }

  res.json({
    state: 'read',
    ...(asset ? { marketScope: 'still_registered_market' } : {}),
    readAt: reading.readAt,
    markets: reading.markets.map((entry) => {
      // Both maxima answer the same conditional question. The selected deposit
      // changes capacity, not the separately reported already-pledged balance.
      const capacity = supply > 0n
        ? entry.position === null ? null : morphoBorrowCapacityV1({ market: entry.market.state,
          position: { ...entry.position, collateral: entry.position.collateral + supply } })
        : entry.capacity;
      return {
        marketId: entry.market.marketId,
        curated: entry.market.curated,
        lltvBps: entry.market.lltvBps,
        collateralSymbol: entry.market.collateral.symbol,
        loanSymbol: entry.market.loan.symbol,
        collateralDecimals: entry.market.collateral.decimals,
        loanDecimals: entry.market.loan.decimals,
        blockNumber: entry.market.state.blockNumber,
        ...(asset ? {
          walletCollateralAtomic: native ? reading.nativeFunding?.balance.toString() ?? null : entry.walletCollateralAssets?.toString() ?? null,
          ...(native ? { funding:'native', nativeReserveAtomic:TERMS.ethGasReserveWei.toString(), feeQuoteState:'wallet_quote_required' } : {}),
          collateralSupplyAtomic: supply.toString(),
          still: stillBorrowCapacityWireV1(token, entry, supply),
          comparison: stillBorrowComparisonWireV1(token, entry, supply),
        } : {}),
        availableToBorrowAtomic: capacity?.assets.toString() ?? null,
        bound: capacity?.bound ?? null,
        collateralHeadroomAtomic: capacity?.collateralHeadroomAssets.toString() ?? null,
        marketLiquidityAtomic: capacity?.marketLiquidityAssets.toString() ?? null,
        borrowedAtomic: entry.health?.borrowedAssets.toString() ?? null,
        collateralAtomic: entry.position?.collateral.toString() ?? null,
        healthFactorWad: entry.health?.healthFactorWad?.toString() ?? null,
      };
    }),
  });
});

/** The region check before a borrow (lib/stillRegion.ts): true when the request was answered with a refusal. */
function refusedByRegionV1(req: Request, res: Response, confirmation: boolean): boolean {
  const gate = rwaBorrowRuntimeV1.entryGate(req, { kind: 'loan', confirmation });
  if (gate.ok) return false;
  res.status(403).json({ error: gate.refusal, code: gate.refusal, detail: gate.detail });
  return true;
}

/** A person selects the question, not calldata or a cached market answer.
 * This mints a wallet-bound link only. Opening it runs the existing fresh gate. */
rwaBorrowRouter.post('/rwa/borrow/intent', (req, res) => {
  const user = sessionUserV1(req);
  if (!user) return unauthenticated(res);
  // Only where the request comes from: the link hands out nothing, and the review it opens asks the rest.
  if (refusedByRegionV1(req, res, false)) return;

  const body: unknown = req.body;
  const chosenToken = objectV1(body) && typeof body.collateralTokenAddress === 'string' ? body.collateralTokenAddress.toLowerCase() : null;
  if (objectV1(body) && chosenToken && [...STOCKS, ...CRYPTO].some(stock => stock.token.toLowerCase() === chosenToken)) {
    const native = 'nativeFundingAtomic' in body, paying = 'spendOrderId' in body;
    const keys = ['collateralTokenAddress','borrowAmountAtomic','collateralSupplyAtomic', ...(native ? ['nativeFundingAtomic'] : []), ...(paying ? ['spendOrderId'] : [])];
    const borrow = atomicV1(body.borrowAmountAtomic, false), supply = atomicV1(body.collateralSupplyAtomic, true);
    if (Object.keys(body).length !== keys.length || !keys.every(key => key in body) || borrow === null || supply === null || native && paying ||
        native && (chosenToken !== ADDRESSES.weth.toLowerCase() || supply === 0n || atomicV1(body.nativeFundingAtomic,false) !== supply)) {
      res.status(400).json({ error: 'borrow_request_not_exact' }); return;
    }
    const secret = rwaBorrowRuntimeV1.secret();
    if (secret.length < 16) { res.status(503).json({ error: 'borrow_secret_unavailable', code: 'borrow_secret_unavailable' }); return; }
    // Still Spend: the loan is exactly the price of an invoice this wallet
    // opened, and the draft carries that invoice as the server read it.
    let payment: LendingPaymentV1 | null = null;
    if (paying) {
      if (!rwaBorrowRuntimeV1.spendEnabled()) { res.status(503).json({ error: 'spend_pay_off' }); return; }
      const order = typeof body.spendOrderId === 'string' && /^[0-9a-f-]{36}$/.test(body.spendOrderId)
        ? rwaBorrowRuntimeV1.spendOrders.get({ tenantId: user.id, walletAddress: user.address }, body.spendOrderId) : null;
      if (!order) { res.status(409).json({ error: 'spend_order_not_found' }); return; }
      payment = spendDraftPaymentV1(order, rwaBorrowRuntimeV1.now());
      if (!payment) { res.status(409).json({ error: 'spend_order_expiring' }); return; }
      if (borrow !== BigInt(order.priceAtomic)) { res.status(400).json({ error: 'borrow_request_not_exact' }); return; }
    }
    const issued = issueLendingDraftV1({ tenantId: user.id, walletAddress: user.address,
      question: { operation: 'borrow', collateralTokenAddress: chosenToken, borrowAssets: borrow.toString(), collateralSupplyAssets: supply.toString(),
        ...(native ? {nativeFundingAssets:supply.toString()} : {}), ...(payment ? { payment } : {}) }, secret, now: rwaBorrowRuntimeV1.now() });
    res.json({ borrowDraftId: issued.draftId, draft: issued.draft, reviewUrl: `/lending/${issued.draft}`, expiresAt: issued.expiresAt }); return;
  }
  const keys = ['collateralTokenAddress', 'borrowAmountAtomic', 'collateralSupplyAtomic'];
  if (!objectV1(body) || Object.keys(body).length !== keys.length || !keys.every(key => Object.prototype.hasOwnProperty.call(body, key)) ||
      typeof body.collateralTokenAddress !== 'string') {
    res.status(400).json({ error: 'borrow_request_not_exact', code: 'borrow_request_not_exact' });
    return;
  }
  const token = body.collateralTokenAddress.toLowerCase();
  const borrow = atomicV1(body.borrowAmountAtomic, false), supply = atomicV1(body.collateralSupplyAtomic, true);
  if (!/^0x[0-9a-f]{40}$/.test(token) || borrow === null || supply === null) {
    res.status(400).json({ error: 'borrow_request_not_exact', code: 'borrow_request_not_exact' });
    return;
  }
  const asset = stillBorrowAssetV1(token);
  if (!asset) {
    res.status(400).json({ error: 'borrow_collateral_not_supported', code: 'borrow_collateral_not_supported' });
    return;
  }
  const secret = rwaBorrowRuntimeV1.secret();
  if (!secret) {
    res.status(503).json({ error: 'borrow_secret_unavailable', code: 'borrow_secret_unavailable' });
    return;
  }
  const issued = issueBorrowDraftV1({
    tenantId: user.id, walletAddress: user.address, collateralTokenAddress: asset.token,
    marketId: asset.morphoMarket, borrowAssets: borrow, collateralSupplyAssets: supply,
    secret, now: rwaBorrowRuntimeV1.now(),
  });
  res.json({ borrowDraftId: issued.borrowDraftId, draft: issued.draft,
    reviewUrl: `/borrow/${encodeURIComponent(issued.draft)}`, expiresAt: issued.expiresAt });
});

// The two routes that answered a borrow review with its calls ('/rwa/borrow/review', by an amount and by an
// assistant's draft) were removed on 2026-11-11 (audit LEND-6). They handed out executable calls with no
// record in lending_executions: no arm, no market held, no receipt read afterwards. Nothing on Still's site
// had called them since every review, an old assistant link among them, became the one owned lending review
// (routes/rwaLending.ts), which is where a draft from '/rwa/borrow/intent' opens.
