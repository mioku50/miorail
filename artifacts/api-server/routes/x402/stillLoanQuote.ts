import {
  ASSETS,
  stillLoanQuoteV1,
  type Asset,
  type MirrorInput,
  type StillLoanAtV1,
  type StillLoanQuoteAskV1,
  type StillLoanQuoteV1,
} from '@mioagent/still-engine';
import { healthFactorTextV1 } from '@mioagent/still-engine/scenario';
import type { X402StillLoanQuoteV1 } from '@mioagent/route-domain';

import { lendingStressScenariosV1 } from '../../lib/lendingStress.js';
import { packageEvidenceClaimsV1, type EvidenceClaimV1 } from '../mcp/evidencePackage.js';

// ---------------------------------------------------------------------------
// still_loan_quote: what Still would lend against an exact amount of one
// collateral, with no wallet, sold over x402 (2026-11-16).
//
// The free public tools answer for a wallet: still_check_wallet reads one,
// still_what_if edits one. An agent deciding whether to borrow before it holds
// anything has no wallet to name, and none of them says the rate, the venue's
// liquidity, the protocol's own limit, the liquidation price or a stress table
// in one answer. This one does, read live at one block with the engine the page
// and a loan review use. Nothing here is estimated, and nothing is offered.
// ---------------------------------------------------------------------------

const AMOUNT_V1 = /^\d{1,12}(?:\.\d{1,18})?$/;
const USDC_V1 = /^\d{1,9}(?:\.\d{1,6})?$/;
const ASSET_LIST_V1 = 'AAPLc, AMZNc, GOOGLc, METAc, MSFTc, NVDAc, SPCXc, TSLAc, cbBTC, ETH or PAXG';

export interface StillQuoteQuestionV1 {
  asset: Asset;
  ask: StillLoanQuoteAskV1;
  amount: string;
  borrowUsdc: string | null;
}

export type StillQuoteParseV1 = { ok: true; question: StillQuoteQuestionV1 } | { ok: false; code: string; message: string };

function unitsV1(text: string, decimals: number): bigint | null {
  const [whole = '0', fraction = ''] = text.split('.');
  if (fraction.length > decimals) return null;
  return BigInt(`${whole}${fraction.padEnd(decimals, '0')}`);
}

/** The asked question, or why it is not one. Decided before any read and before the price. */
export function parseStillQuoteQuestionV1(query: Record<string, unknown>): StillQuoteParseV1 {
  const named = String(query.asset ?? '').trim();
  const key = named.toLowerCase();
  // Still's own ids and exact token addresses only: a ticker such as NVDA names three issuers' contracts on Base,
  // and Still lends against one of them.
  const asset = ASSETS.find((entry) => entry.id.toLowerCase() === key || entry.token.toLowerCase() === key)
    ?? (key === 'weth' ? ASSETS.find((entry) => entry.id === 'ETH') : undefined);
  if (!asset) {
    return {
      ok: false,
      code: 'unsupported_collateral',
      message: `Still lends against ${ASSET_LIST_V1} on Base. Name one of them, or its exact Base token address. Nothing was charged.`,
    };
  }
  const amount = String(query.amount ?? '').trim();
  const raw = AMOUNT_V1.test(amount) ? unitsV1(amount, asset.decimals) : null;
  if (raw === null || raw === 0n) {
    return {
      ok: false,
      code: 'invalid_amount',
      message: `amount is the number of ${asset.id} tokens to pledge, above zero, with at most ${asset.decimals} decimals: 10 or 0.25. Nothing was charged.`,
    };
  }
  const borrowText = query.borrowUsdc === undefined ? '' : String(query.borrowUsdc).trim();
  let borrowAtomic: bigint | null = null;
  if (borrowText !== '') {
    borrowAtomic = USDC_V1.test(borrowText) ? unitsV1(borrowText, 6) : null;
    if (borrowAtomic === null || borrowAtomic === 0n) {
      return {
        ok: false,
        code: 'invalid_borrow',
        message: 'borrowUsdc is a USDC amount above zero with at most six decimals: 500 or 120.5. Nothing was charged.',
      };
    }
  }
  return {
    ok: true,
    question: { asset, ask: { asset: asset.id, raw, borrowAtomic }, amount, borrowUsdc: borrowText === '' ? null : borrowText },
  };
}

function loanV1(at: StillLoanAtV1) {
  if (at.outcome === 'refused') return { outcome: 'refused' as const, reason: at.reason };
  const health = BigInt(at.figures.healthFactor);
  return {
    outcome: 'computed' as const,
    figures: {
      borrowAtomic: at.figures.borrowAtomic,
      healthFactor: at.figures.healthFactor,
      healthFactorText: healthFactorTextV1(health),
      marginBps: at.figures.marginBps,
      state: at.figures.state,
      liquidationPriceCents: at.figures.liquidationPriceCents,
      liquidationUnreachable: at.figures.liquidationUnreachable,
      borrowRateBps: at.figures.borrowRateBps,
      stress: lendingStressScenariosV1(health).map((row) => ({
        fallBps: row.fallBps,
        healthFactor: row.healthWad,
        liquidationCanStart: row.liquidatable,
      })),
    },
  };
}

function caveatsV1(asset: Asset): string[] {
  const pause = asset.kind === 'stock'
    ? 'If a Coinbase stock token pauses its transfers, repaying on Aave V4 still works and taking the stock back waits, and a liquidation can still proceed inside the spoke (verified on the contracts on 2026-11-13).'
    : asset.id === 'ETH'
      ? 'WETH cannot pause its transfers, so neither repaying, taking it back nor a liquidation waits on one.'
      : `If ${asset.symbol} pauses its transfers, repaying on Morpho still works, and both taking it back and a liquidation wait until transfers resume (measured on 2026-11-13).`;
  return [
    'This is a quote read at one Base block, not an offer, a recommendation or a commitment to lend. A Still loan is prepared through Still’s own review and checked again onchain before anything is signed. Still is not offered to US persons.',
    'A loan creates debt and the collateral can be liquidated. The margin and the liquidation price hold while the debt stays as quoted: interest grows it, and a fall larger than the margin can start a liquidation.',
    'Still lends at most half of what the protocol would, and 40% of it while Wall Street is closed, around a stock’s earnings report, or once a stock’s reference price has gone more than 25 open-market hours without an update. The figures apply the rule in force at this block.',
    'Stress rows are falls at once, with no moment between to repay. Prices are the venue’s own oracle, per whole token, rounded down; a liquidation price is rounded up.',
    pause,
  ];
}

function claimsV1(payload: Omit<X402StillLoanQuoteV1, 'dataHash' | 'evidencePackage'>): EvidenceClaimV1[] {
  const block = payload.reading.block;
  const at = payload.reading.blockTime;
  const scope = {
    tokenAddress: payload.question.token,
    tokenAmountAtomic: payload.question.amountRaw,
    ...(payload.requested ? { requestedCashAtomic: payload.requested.borrowAtomic } : {}),
  };
  const stock = payload.collateral.kind === 'stock';
  const read = (paths: string[], kind: EvidenceClaimV1['kind'], id: string, observedAt: string | null = at): EvidenceClaimV1 => ({
    paths, kind, block, observedAt, source: { kind: 'rpc', id }, hash: null, hashKind: null, scope, basisPaths: [],
    missing: ['hash', ...(observedAt === null ? ['observedAt' as const] : [])],
  });
  const derived = (paths: string[], id: string, basisPaths: string[]): EvidenceClaimV1 => ({
    paths, kind: 'derived', block, observedAt: at, source: { kind: 'miorail_derived', id }, hash: null, hashKind: null,
    scope, basisPaths, missing: ['hash'],
  });
  const claims: EvidenceClaimV1[] = [
    read(['/collateral/priceCents', '/collateral/valueCents'], 'reference', stock ? 'aave_v4_oracle' : 'morpho_market_oracle',
      payload.collateral.priceUpdatedAt ?? at),
    read(['/collateral/protocolFactorBps', '/collateral/pledgeableRaw', '/collateral/limits'], 'controls',
      stock ? 'aave_v4_coinbase_stocks_spoke' : 'morpho_blue_market'),
    read(['/venue/liquidityCents', '/venue/borrowRateBps'], 'venue', stock ? 'aave_v4_hub' : 'morpho_blue_market'),
    {
      paths: ['/terms', '/collateral/stillFactorBps'], kind: 'declaration', block: null, observedAt: null,
      source: { kind: 'miorail_derived', id: 'still_terms' }, hash: null, hashKind: null, scope, basisPaths: [],
      missing: ['block', 'observedAt', 'hash'],
    },
    derived(['/limit'], 'still_engine_limit', ['/collateral', '/venue', '/terms']),
  ];
  if (payload.collateral.earnings) {
    const readAt = payload.terms.earnings.calendarReadAt;
    claims.push({
      paths: ['/collateral/earnings'], kind: 'announcement', block: null, observedAt: readAt,
      source: { kind: 'public_source', id: 'aave_earnings_calendar' }, hash: null, hashKind: null, scope, basisPaths: [],
      missing: ['block', ...(readAt === null ? ['observedAt' as const] : []), 'hash'],
    });
  }
  if (payload.atStillLimit) claims.push(derived(['/atStillLimit'], 'still_engine_scenario', ['/limit', '/collateral', '/venue']));
  if (payload.requested) claims.push(derived(['/requested'], 'still_engine_scenario', ['/collateral', '/venue', '/terms']));
  return claims;
}

/** The delivered answer before its hash: the engine's quote, in the published contract's shape. */
export function stillLoanQuoteDraftV1(input: {
  quote: StillLoanQuoteV1;
  question: StillQuoteQuestionV1;
  now: Date;
  payment: X402StillLoanQuoteV1['payment'];
  requestHash: X402StillLoanQuoteV1['requestHash'];
}): Omit<X402StillLoanQuoteV1, 'dataHash'> {
  const { quote, question } = input;
  const asset = question.asset;
  const line = quote.line;
  const body: Omit<X402StillLoanQuoteV1, 'dataHash' | 'evidencePackage'> = {
    schemaVersion: 'x402-still-loan-quote/v1',
    service: 'still_loan_quote',
    answerSource: 'live_chain_read',
    chainId: 8453,
    question: {
      asset: asset.id,
      token: asset.token.toLowerCase(),
      decimals: asset.decimals,
      amount: question.amount,
      amountRaw: question.ask.raw.toString(),
      borrowUsdc: question.borrowUsdc,
    },
    reading: { block: quote.reading.block, blockTime: quote.reading.blockTime },
    collateral: {
      name: asset.name,
      symbol: asset.kind === 'stock' ? asset.id : asset.symbol,
      kind: asset.kind,
      isin: asset.kind === 'stock' ? asset.isin : null,
      priceCents: line?.priceCents ?? null,
      priceUpdatedAt: line?.priceUpdatedAt ?? null,
      valueCents: line?.valueCents ?? null,
      pledgeableRaw: quote.pledgeableRaw === null ? null : quote.pledgeableRaw.toString(),
      protocolFactorBps: line?.protocolFactorBps ?? null,
      stillFactorBps: line?.stillFactorBps ?? null,
      limits: [...(line?.limits ?? [])],
      earnings: line?.earnings
        ? {
            source: line.earnings.source,
            reportDate: line.earnings.reportDate,
            window: line.earnings.window ? { startsAt: line.earnings.window.startsAt, endsAt: line.earnings.window.endsAt } : null,
            lowered: line.earnings.lowered,
          }
        : null,
    },
    venue: {
      venue: quote.venue.venue,
      market: quote.venue.market.toLowerCase(),
      label: quote.venue.label,
      liquidityCents: quote.venueLine?.liquidityCents ?? null,
      borrowRateBps: quote.venueLine?.borrowRateBps ?? null,
    },
    terms: {
      version: quote.terms.version,
      stockShareBps: quote.terms.stockShareBps,
      cryptoShareBps: quote.terms.cryptoShareBps,
      weekend: { ...quote.terms.weekend },
      earnings: { ...quote.terms.earnings },
    },
    limit: {
      stillLimitCents: quote.stillLimitCents,
      protocolLimitCents: quote.protocolLimitCents,
      availableNowCents: quote.availableNowCents,
      weekdayAvailableCents: quote.weekdayAvailableCents,
      newLoans: quote.newLoans,
      closedBecause: [...quote.closedBecause],
    },
    atStillLimit: quote.atStillLimit ? loanV1(quote.atStillLimit) : null,
    requested: quote.requested
      ? { borrowAtomic: quote.requested.borrowAtomic, withinStillLimit: quote.requested.withinStillLimit, loan: loanV1(quote.requested) }
      : null,
    contracts: [
      { label: `${asset.kind === 'stock' ? asset.id : asset.symbol === 'ETH' ? 'WETH' : asset.symbol} token`, address: asset.token.toLowerCase() },
      ...quote.evidence.map((entry) => ({ label: entry.label, address: entry.address.toLowerCase() })),
    ].slice(0, 16),
    missingEvidence: quote.failed.slice(0, 24).map((failure) =>
      failure.owner === 'us' ? `${failure.what}: not read at this block (our failure)` : `${failure.what}: not published by the protocol`,
    ).map((text) => text.slice(0, 200)),
    caveats: caveatsV1(asset),
    generatedAt: input.now.toISOString(),
    payment: input.payment,
    requestHash: input.requestHash,
  };
  return { ...body, evidencePackage: packageEvidenceClaimsV1(claimsV1(body), input.now) };
}

/** The quote for a question, from one market reading. */
export function stillLoanQuoteFromReadingV1(reading: MirrorInput, question: StillQuoteQuestionV1): StillLoanQuoteV1 {
  return stillLoanQuoteV1(reading, question.ask);
}
