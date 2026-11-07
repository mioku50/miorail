import crypto from 'node:crypto';
import { CRYPTO, STOCKS } from '@mioagent/still-engine/registry';

import type { LoanExecutionV1 } from './loanExecutionStore.js';

// ---------------------------------------------------------------------------
// A Still Spend purchase as a link anyone can open: /spend/p/<token>. A plain
// loan gets one too, since 2026-11-03 (the operator: «нет карточки после
// успешного взятия займа для шаринга»): how much, against what, through which
// protocol. Spending without selling is what a loan is for, so it shares the
// address; its token has its own prefix and signing context.
//
// The token is the claim itself, signed by this server once the loan that
// paid the invoice was confirmed onchain: what was bought, at what price,
// against which collateral and through which protocol. It names no wallet,
// transaction, block, email or phone number. With the price, any one of them
// leads to the wallet and to everything in it, and a shared card is posted
// beside the person's own name. So the link needs no table, nobody can forge
// one, and it reads the same for as long as the secret does.
// ---------------------------------------------------------------------------

const PREFIX_V1 = 'ss1';
const CONTEXT_V1 = 'still-spend-share/v1';

export interface StillSpendShareV1 {
  productName: string;
  /** As the paid note shows it: "10 UC", "500 INR". */
  packageLabel: string;
  /** USDC base units: what the loan borrowed and paid to the invoice. */
  priceAtomic: string;
  /** Still's registry id of the collateral: a stock (NVDAc), cbBTC, WETH, ETH or PAXG. */
  collateral: string;
  venue: 'aave-v4' | 'morpho';
}

const COLLATERAL_V1 = new Set<string>([...STOCKS.map((stock) => stock.id), 'cbBTC', 'WETH', 'ETH', 'PAXG']);
const label = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= max &&
  !Array.from(value).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
const signature = (secret: string, body: string) =>
  crypto.createHmac('sha256', crypto.createHmac('sha256', secret).update(CONTEXT_V1).digest()).update(`${PREFIX_V1}.${body}`).digest('base64url');

function shareV1(value: Record<string, unknown>): value is StillSpendShareV1 & Record<string, unknown> {
  return label(value.productName, 120) && label(value.packageLabel, 84) &&
    typeof value.priceAtomic === 'string' && /^[1-9]\d{0,11}$/.test(value.priceAtomic) &&
    typeof value.collateral === 'string' && COLLATERAL_V1.has(value.collateral) &&
    (value.venue === 'aave-v4' || value.venue === 'morpho');
}

/** The collateral a loan pledged, by Still's registry: ETH when it was wrapped from native ETH. */
function collateralOfV1(token: string, native: boolean): string | null {
  const address = token.toLowerCase();
  const stock = STOCKS.find((row) => row.token.toLowerCase() === address);
  if (stock) return stock.id;
  const coin = CRYPTO.find((row) => row.token.toLowerCase() === address);
  if (!coin) return null;
  return coin.id === 'ETH' ? (native ? 'ETH' : 'WETH') : coin.id;
}

/** What a loan that paid a Bitrefill invoice may say in public once it is
 * confirmed onchain; null for any other loan, and before it is confirmed. */
export function stillSpendShareOfV1(execution: LoanExecutionV1): StillSpendShareV1 | null {
  const facts = execution.run.facts;
  const payment = facts.payment;
  if (execution.state !== 'confirmed' || facts.operation !== 'borrow' || !payment) return null;
  const face = payment.faceCurrency && /^\d+(?:\.\d+)?$/.test(payment.packageValue.trim()) ? ` ${payment.faceCurrency}` : '';
  const share = {
    productName: payment.productName.trim(),
    packageLabel: `${payment.packageValue.trim()}${face}`,
    priceAtomic: payment.assets,
    collateral: collateralOfV1(facts.collateralTokenAddress, Boolean(facts.nativeFunding)),
    venue: facts.venue,
  };
  return shareV1(share) ? share : null;
}

export function issueStillSpendShareV1(share: StillSpendShareV1, secret: string): string {
  if (secret.length < 16 || !shareV1({ ...share })) throw new Error('still_spend_share_invalid');
  const body = Buffer.from(JSON.stringify({
    v: 1, n: share.productName, p: share.packageLabel, a: share.priceAtomic, c: share.collateral, m: share.venue,
  })).toString('base64url');
  return `${PREFIX_V1}.${body}.${signature(secret, body)}`;
}

const LOAN_PREFIX_V1 = 'sl1';
const LOAN_CONTEXT_V1 = 'still-loan-share/v1';

export interface StillLoanShareV1 {
  /** USDC base units the loan paid out to the wallet. */
  borrowedAtomic: string;
  /** Still's registry id of the collateral: a stock (NVDAc), cbBTC, WETH, ETH or PAXG. */
  collateral: string;
  venue: 'aave-v4' | 'morpho';
}

const loanSignature = (secret: string, body: string) =>
  crypto.createHmac('sha256', crypto.createHmac('sha256', secret).update(LOAN_CONTEXT_V1).digest()).update(`${LOAN_PREFIX_V1}.${body}`).digest('base64url');

function loanShareV1(value: Record<string, unknown>): value is StillLoanShareV1 & Record<string, unknown> {
  return typeof value.borrowedAtomic === 'string' && /^[1-9]\d{0,11}$/.test(value.borrowedAtomic) &&
    typeof value.collateral === 'string' && COLLATERAL_V1.has(value.collateral) &&
    (value.venue === 'aave-v4' || value.venue === 'morpho');
}

/** What a loan that paid no invoice may say in public once it is confirmed onchain: how much, against what, where. */
export function stillLoanShareOfV1(execution: LoanExecutionV1): StillLoanShareV1 | null {
  const facts = execution.run.facts;
  if (execution.state !== 'confirmed' || facts.operation !== 'borrow' || facts.payment || facts.requestedAssets == null) return null;
  const share = { borrowedAtomic: facts.requestedAssets, collateral: collateralOfV1(facts.collateralTokenAddress, Boolean(facts.nativeFunding)), venue: facts.venue };
  return loanShareV1(share) ? share : null;
}

export function issueStillLoanShareV1(share: StillLoanShareV1, secret: string): string {
  if (secret.length < 16 || !loanShareV1({ ...share })) throw new Error('still_loan_share_invalid');
  const body = Buffer.from(JSON.stringify({ v: 1, a: share.borrowedAtomic, c: share.collateral, m: share.venue })).toString('base64url');
  return `${LOAN_PREFIX_V1}.${body}.${loanSignature(secret, body)}`;
}

export function verifyStillLoanShareV1(token: unknown, secret: string): StillLoanShareV1 | null {
  if (secret.length < 16 || typeof token !== 'string' || token.length > 600) return null;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== LOAN_PREFIX_V1 || !/^[A-Za-z0-9_-]+$/.test(parts[1]!) || !/^[A-Za-z0-9_-]{43}$/.test(parts[2]!)) return null;
  const wanted = Buffer.from(loanSignature(secret, parts[1]!));
  const got = Buffer.from(parts[2]!);
  if (wanted.length !== got.length || !crypto.timingSafeEqual(wanted, got)) return null;
  try {
    const claim: unknown = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8'));
    if (!claim || typeof claim !== 'object' || Array.isArray(claim)) return null;
    const c = claim as Record<string, unknown>;
    if (Object.keys(c).sort().join(',') !== 'a,c,m,v' || c.v !== 1) return null;
    const share = { borrowedAtomic: c.a, collateral: c.c, venue: c.m };
    return loanShareV1(share) ? { borrowedAtomic: share.borrowedAtomic, collateral: share.collateral, venue: share.venue } : null;
  } catch {
    return null;
  }
}

/** The link a confirmed loan offers its owner: its purchase when it paid an invoice, the loan itself when not. */
export function loanExecutionShareV1(execution: LoanExecutionV1, secret: string): { path: string } | null {
  if (secret.length < 16) return null;
  const share = stillSpendShareOfV1(execution);
  if (share) return { path: `/spend/p/${issueStillSpendShareV1(share, secret)}` };
  const loan = stillLoanShareOfV1(execution);
  return loan ? { path: `/spend/p/${issueStillLoanShareV1(loan, secret)}` } : null;
}

/** The claim, when this server signed it; null for anything else. */
export function verifyStillSpendShareV1(token: unknown, secret: string): StillSpendShareV1 | null {
  if (secret.length < 16 || typeof token !== 'string' || token.length > 1200) return null;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== PREFIX_V1 || !/^[A-Za-z0-9_-]+$/.test(parts[1]!) || !/^[A-Za-z0-9_-]{43}$/.test(parts[2]!)) return null;
  const wanted = Buffer.from(signature(secret, parts[1]!));
  const got = Buffer.from(parts[2]!);
  if (wanted.length !== got.length || !crypto.timingSafeEqual(wanted, got)) return null;
  try {
    const claim: unknown = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8'));
    if (!claim || typeof claim !== 'object' || Array.isArray(claim)) return null;
    const c = claim as Record<string, unknown>;
    if (Object.keys(c).sort().join(',') !== 'a,c,m,n,p,v' || c.v !== 1) return null;
    const share = { productName: c.n, packageLabel: c.p, priceAtomic: c.a, collateral: c.c, venue: c.m };
    return shareV1(share) ? { productName: share.productName, packageLabel: share.packageLabel, priceAtomic: share.priceAtomic, collateral: share.collateral, venue: share.venue } : null;
  } catch {
    return null;
  }
}

/** The words a card and its page say, from the claim alone. */
export function stillSpendShareWordsV1(share: Pick<StillSpendShareV1, 'priceAtomic' | 'collateral' | 'venue'>): {
  priceUsdc: string; collateralLabel: string; collateralKind: 'stock' | 'crypto'; collateralName: string; venueName: string;
} {
  const atomic = BigInt(share.priceAtomic);
  const micro = (atomic % 1_000_000n).toString().padStart(6, '0');
  const trimmed = micro.replace(/0+$/, '');
  const stock = STOCKS.find((row) => row.id === share.collateral);
  return {
    priceUsdc: `${(atomic / 1_000_000n).toString()}.${trimmed.length <= 2 ? micro.slice(0, 2) : trimmed}`,
    collateralLabel: stock ? stock.ticker : share.collateral,
    collateralKind: stock ? 'stock' : 'crypto',
    collateralName: stock ? `${stock.name} stock` : share.collateral === 'cbBTC' ? 'bitcoin' : share.collateral === 'PAXG' ? 'gold' : 'ether',
    venueName: share.venue === 'aave-v4' ? 'Aave' : 'Morpho',
  };
}
