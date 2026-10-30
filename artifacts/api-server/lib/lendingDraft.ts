import crypto from 'node:crypto';
import { ADDRESSES, STOCKS, CRYPTO } from '@mioagent/still-engine/registry';

export const LENDING_DRAFT_PREFIX_V1 = 'miorail-lending-v1';
export const LENDING_NATIVE_DRAFT_PREFIX_V2 = 'miorail-lending-v2';
export type LendingQuestionV1 =
  | { operation: 'borrow'; collateralTokenAddress: string; borrowAssets: string; collateralSupplyAssets: string; nativeFundingAssets?: string }
  | { operation: 'repay'; collateralTokenAddress: string; amountMode: 'assets' | 'all'; repayAssets: string | null; maximumAssets: string };
export interface LendingDraftClaimsV1 {
  version: 1 | 2; chainId: 8453; tenantId: string; walletAddress: string; draftId: string;
  venue: 'aave-v4' | 'morpho'; marketId: string; question: LendingQuestionV1; issuedAt: string; expiresAt: string;
}
export function lendingMarketV1(token: string): { venue: 'aave-v4' | 'morpho'; marketId: string } | null {
  if (STOCKS.some(stock => stock.token.toLowerCase() === token)) return { venue: 'aave-v4', marketId: ADDRESSES.aaveSpoke.toLowerCase() };
  const cryptoAsset = CRYPTO.find(asset => asset.token.toLowerCase() === token);
  return cryptoAsset ? { venue: 'morpho', marketId: cryptoAsset.morphoMarket } : null;
}
const atom = (value: unknown, zero = false): value is string => typeof value === 'string' && /^(0|[1-9][0-9]{0,38})$/.test(value)
  && BigInt(value) < (1n << 128n) && (zero || BigInt(value) > 0n);
const exact = (value: object, keys: string[]) => Object.keys(value).sort().join(',') === [...keys].sort().join(',');
function questionV1(value: unknown): value is LendingQuestionV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const q = value as LendingQuestionV1;
  if (typeof q.collateralTokenAddress !== 'string' || !/^0x[0-9a-f]{40}$/.test(q.collateralTokenAddress)) return false;
  const market = lendingMarketV1(q.collateralTokenAddress);
  if (!market) return false;
  if (q.operation === 'borrow') {
    const native = 'nativeFundingAssets' in q;
    return exact(q, ['operation','collateralTokenAddress','borrowAssets','collateralSupplyAssets', ...(native ? ['nativeFundingAssets'] : [])])
      && atom(q.borrowAssets) && atom(q.collateralSupplyAssets, !native)
      && (!native || q.collateralTokenAddress === ADDRESSES.weth.toLowerCase() && atom(q.nativeFundingAssets) && q.nativeFundingAssets === q.collateralSupplyAssets);
  }
  return q.operation === 'repay' && exact(q, ['operation','collateralTokenAddress','amountMode','repayAssets','maximumAssets'])
    && atom(q.maximumAssets) && ((q.amountMode === 'all' && q.repayAssets === null)
      || (q.amountMode === 'assets' && atom(q.repayAssets) && BigInt(q.repayAssets) <= BigInt(q.maximumAssets)));
}
const signature = (secret: string, body: string, prefix: string = LENDING_DRAFT_PREFIX_V1) => crypto.createHmac('sha256', crypto.createHmac('sha256', secret)
  .update('miorail-lending-question/v1').digest()).update(`${prefix}.${body}`).digest('base64url');

/** A signed, owned question. No price, permission, simulation result or calls
 * can be supplied by the browser or remembered in this link. */
export function issueLendingDraftV1(input: { tenantId: string; walletAddress: string; question: LendingQuestionV1; secret: string; now: Date }): {
  draft: string; draftId: string; expiresAt: string;
} {
  if (input.secret.length < 16 || !/^0x[0-9a-f]{40}$/.test(input.walletAddress) || input.tenantId !== `eip155:8453:${input.walletAddress}`
    || !questionV1(input.question) || !Number.isFinite(input.now.getTime())) throw new Error('lending_question_invalid');
  const market = lendingMarketV1(input.question.collateralTokenAddress)!;
  const native = input.question.operation === 'borrow' && input.question.nativeFundingAssets !== undefined;
  const prefix = native ? LENDING_NATIVE_DRAFT_PREFIX_V2 : LENDING_DRAFT_PREFIX_V1;
  const claims: LendingDraftClaimsV1 = { version: native ? 2 : 1, chainId: 8453, tenantId: input.tenantId, walletAddress: input.walletAddress,
    draftId: crypto.randomUUID(), ...market, question: input.question, issuedAt: input.now.toISOString(), expiresAt: new Date(input.now.getTime() + 300_000).toISOString() };
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return { draft: `${prefix}.${body}.${signature(input.secret, body, prefix)}`, draftId: claims.draftId, expiresAt: claims.expiresAt };
}

export function verifyLendingDraftV1(input: { draft: string; tenantId: string; walletAddress: string; secret: string; now: Date; allowExpiredForStatus?: boolean }):
  { ok: true; claims: LendingDraftClaimsV1 } | { ok: false; refusal: 'lending_draft_invalid' | 'lending_draft_expired' | 'lending_draft_wrong_wallet' } {
  const fail = (refusal: 'lending_draft_invalid' | 'lending_draft_expired' | 'lending_draft_wrong_wallet') => ({ ok: false as const, refusal });
  if (input.secret.length < 16 || typeof input.draft !== 'string' || input.draft.length > 6000) return fail('lending_draft_invalid');
  const parts = input.draft.split('.');
  if (parts.length !== 3 || ![LENDING_DRAFT_PREFIX_V1, LENDING_NATIVE_DRAFT_PREFIX_V2].includes(parts[0]!) || !/^[A-Za-z0-9_-]+$/.test(parts[1]!) || !/^[A-Za-z0-9_-]{43}$/.test(parts[2]!)) return fail('lending_draft_invalid');
  const wanted = Buffer.from(signature(input.secret, parts[1]!, parts[0]!)), got = Buffer.from(parts[2]!);
  if (wanted.length !== got.length || !crypto.timingSafeEqual(wanted, got)) return fail('lending_draft_invalid');
  try {
    const c: LendingDraftClaimsV1 = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8'));
    if (!c || !exact(c, ['version','chainId','tenantId','walletAddress','draftId','venue','marketId','question','issuedAt','expiresAt']) || (c.version !== 1 && c.version !== 2) || c.chainId !== 8453
      || !/^0x[0-9a-f]{40}$/.test(c.walletAddress) || c.tenantId !== `eip155:8453:${c.walletAddress}` || !/^[0-9a-f-]{36}$/.test(c.draftId) || !questionV1(c.question)) return fail('lending_draft_invalid');
    const native = c.question.operation === 'borrow' && c.question.nativeFundingAssets !== undefined;
    if (c.version !== (native ? 2 : 1) || parts[0] !== (native ? LENDING_NATIVE_DRAFT_PREFIX_V2 : LENDING_DRAFT_PREFIX_V1)) return fail('lending_draft_invalid');
    const market = lendingMarketV1(c.question.collateralTokenAddress)!;
    if (market.marketId !== c.marketId || market.venue !== c.venue) return fail('lending_draft_invalid');
    if (c.walletAddress !== input.walletAddress || c.tenantId !== input.tenantId) return fail('lending_draft_wrong_wallet');
    const issued = Date.parse(c.issuedAt), expiry = Date.parse(c.expiresAt), now = input.now.getTime();
    if (!Number.isFinite(issued) || !Number.isFinite(expiry) || !Number.isFinite(now) || expiry <= issued || expiry - issued !== 300_000 || issued > now + 1000) return fail('lending_draft_invalid');
    return expiry <= now && !input.allowExpiredForStatus ? fail('lending_draft_expired') : { ok: true, claims: c };
  } catch { return fail('lending_draft_invalid'); }
}
