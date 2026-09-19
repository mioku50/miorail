import { Router, type Request } from 'express';

import { readMorphoBorrowStandingV1 } from '@mioagent/rwa-issuer';

import { verifyBorrowDraftV1 } from '../lib/borrowDraft.js';
import { runMorphoBorrowV1, type MorphoBorrowRunV1 } from '../lib/morphoBorrowRunner.js';

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
  read: readMorphoBorrowStandingV1,
  run: runMorphoBorrowV1,
  secret: (): string => (process.env.SESSION_SECRET ?? '').trim(),
  now: () => new Date(),
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

/** The run, as JSON. Calls ride the ready branch and no other — the shape is
 * the gate, so a client cannot read them out of a refusal. */
function runBodyV1(run: MorphoBorrowRunV1): Record<string, unknown> {
  if (run.state === 'refused') {
    return {
      state: 'refused',
      stage: run.stage,
      refusal: run.refusal,
      detail: run.detail,
      marketId: run.marketId,
      review: run.review,
    };
  }
  return {
    state: 'ready',
    marketId: run.marketId,
    review: run.review,
    steps: run.plan.steps.map((step) => ({
      index: step.index,
      to: step.to,
      selector: step.selector,
      venueDescription: step.venueDescription,
      readByMiorail: step.decodedByMiorail,
      reading: step.reading,
    })),
    authorizations: run.plan.authorizations,
    targets: run.plan.targets,
    calls: run.calls.map((call) => ({ to: call.to, value: call.valueWei, data: call.data })),
    callsHash: run.callsHash,
    measured: {
      blockNumber: run.measured.blockNumber,
      arrivedAtomic: run.measured.arrivedAssets,
      provider: run.measured.providerId,
    },
  };
}

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

  const reading = await rwaBorrowRuntimeV1.read({ tokenAddress: token, walletAddress: user.address });
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

  res.json({
    state: 'read',
    readAt: reading.readAt,
    markets: reading.markets.map((entry) => ({
      marketId: entry.market.marketId,
      curated: entry.market.curated,
      lltvBps: entry.market.lltvBps,
      collateralSymbol: entry.market.collateral.symbol,
      loanSymbol: entry.market.loan.symbol,
      collateralDecimals: entry.market.collateral.decimals,
      loanDecimals: entry.market.loan.decimals,
      blockNumber: entry.market.state.blockNumber,
      availableToBorrowAtomic: entry.capacity?.assets.toString() ?? null,
      bound: entry.capacity?.bound ?? null,
      collateralHeadroomAtomic: entry.capacity?.collateralHeadroomAssets.toString() ?? null,
      marketLiquidityAtomic: entry.capacity?.marketLiquidityAssets.toString() ?? null,
      borrowedAtomic: entry.health?.borrowedAssets.toString() ?? null,
      collateralAtomic: entry.position?.collateral.toString() ?? null,
      healthFactorWad: entry.health?.healthFactorWad?.toString() ?? null,
    })),
  });
});

/** The gate, run for an amount the person typed on this screen. */
rwaBorrowRouter.post('/rwa/borrow/review', async (req, res) => {
  const user = sessionUserV1(req);
  if (!user) return unauthenticated(res);

  const body = (req.body ?? {}) as Record<string, unknown>;
  const token = String(body.collateralTokenAddress ?? '').trim().toLowerCase();
  const amount = String(body.borrowAmountAtomic ?? '').trim();
  const marketId = body.marketId === undefined || body.marketId === null ? null : String(body.marketId).trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(token) || !/^[1-9][0-9]*$/.test(amount)) {
    res.status(400).json({ error: 'borrow_request_not_exact', code: 'borrow_request_not_exact' });
    return;
  }

  const run = await rwaBorrowRuntimeV1.run({
    collateralTokenAddress: token,
    walletAddress: user.address,
    borrowAssets: BigInt(amount),
    marketId,
  });
  res.json(runBodyV1(run));
});

/**
 * Opens a draft minted on the MCP surface, and measures everything again.
 *
 * The draft proves which wallet asked and what they asked for. It proves
 * nothing about the market, because it carries no number about the market — so
 * the figures on this screen are the ones from this request, not the ones from
 * the conversation that produced the link.
 */
rwaBorrowRouter.get('/rwa/borrow/review/:draft', async (req, res) => {
  const user = sessionUserV1(req);
  if (!user) return unauthenticated(res);

  const secret = rwaBorrowRuntimeV1.secret();
  if (!secret) {
    res.status(503).json({ error: 'borrow_secret_unavailable', code: 'borrow_secret_unavailable' });
    return;
  }

  const verified = verifyBorrowDraftV1({
    draft: String(req.params.draft ?? ''),
    secret,
    now: rwaBorrowRuntimeV1.now(),
    walletAddress: user.address,
  });
  if (!verified.ok) {
    // 403 rather than 404: the link exists and this session may not open it.
    const status = verified.reason === 'borrow_draft_wrong_wallet' ? 403 : 400;
    res.status(status).json({ error: verified.reason, code: verified.reason });
    return;
  }

  const run = await rwaBorrowRuntimeV1.run({
    collateralTokenAddress: verified.claims.collateralTokenAddress,
    walletAddress: verified.claims.walletAddress,
    borrowAssets: BigInt(verified.claims.borrowAssets),
    marketId: verified.claims.marketId,
  });
  res.json({ ...runBodyV1(run), borrowDraftId: verified.claims.borrowDraftId });
});
