import { decodeEventLog, parseAbi, type Hex } from 'viem';
import type { BaseReceiptReader, VerifiedReceiptSourceV1 } from '@mioagent/route-proof';
import type { HashV1 } from '@mioagent/route-domain';
import {
  createDatabaseFoundShareRepositoryV1,
  type FoundShareProtocolV1,
  type FoundShareRepositoryV1,
  type FoundShareV1,
} from '@mioagent/route-storage';

import { client } from '@mioagent/db';
import { AERODROME_AERO_V1, type AerodromeClaimPlanV1 } from './aerodromeClaimReader.js';
import { aerodromeRewardsRuntimeV1, amountDigitsV1, byValueV1, usdcAtomicToCentsV1, valueRewardAmountV1, type AerodromeRewardAmountV1 } from './aerodromeRewards.js';
import { PostgresBaseMcpActionReceiptRepositoryV1, type BaseMcpActionReceiptRepositoryV1, type StoredBaseMcpActionReceiptV1 } from './baseMcpActionReceipts.js';
import { createViemBaseReceiptReader } from './baseReceiptReader.js';
import type { UniswapCollectPlanV1 } from './baseMcpUniswapCollect.js';
import { foundWalletChainReceiptV1 } from './foundWalletClaim.js';
import { cardHeightV1, cardYV1, type CardShapeV1 } from './cardShape.js';
import { UNISWAP_V3_POSITION_MANAGER_V1 } from './uniswapFeesReader.js';

// ---------------------------------------------------------------------------
// Found's share card: a claim or a collect that completed, as a picture to post
// on X or Farcaster.
//
// The amounts are what ARRIVED, read from the transaction's own events (the
// same events that completed the receipt), never the plan's estimate. They
// are valued once, when the owner asks for the card, by the sell quotes every
// Found answer uses, and the card says "when shared". It names no wallet and
// no transaction: the person posting chooses to say how much, not who.
// ---------------------------------------------------------------------------

const EVENTS_V1 = parseAbi([
  'event Claim(address indexed sender,address indexed recipient,uint256 amount0,uint256 amount1)',
  'event Collect(uint256 indexed tokenId,address recipient,uint256 amount0,uint256 amount1)',
  'event ClaimRewards(address indexed from,uint256 amount)',
]);

export interface FoundArrivedV1 { token: string; amountAtomic: bigint }

function add(into: Map<string, bigint>, token: string, amount: bigint): void {
  if (amount > 0n) into.set(token.toLowerCase(), (into.get(token.toLowerCase()) ?? 0n) + amount);
}

function decoded(log: VerifiedReceiptSourceV1['logs'][number]) {
  try {
    return decodeEventLog({ abi: EVENTS_V1, topics: log.topics as [Hex, ...Hex[]], data: log.data as Hex });
  } catch {
    return null;
  }
}

/** What a completed Uniswap collect paid the wallet, per token: each prepared
 * position's Collect event from the manager, once. */
export function uniswapArrivedV1(plan: UniswapCollectPlanV1, wallet: string, receipt: VerifiedReceiptSourceV1): FoundArrivedV1[] {
  const totals = new Map<string, bigint>();
  const used = new Set<number>();
  for (const item of plan.calls) {
    const index = receipt.logs.findIndex((log, at) => {
      if (used.has(at) || log.address.toLowerCase() !== UNISWAP_V3_POSITION_MANAGER_V1) return false;
      const event = decoded(log);
      return event?.eventName === 'Collect' && String(event.args.tokenId) === item.tokenId
        && event.args.recipient.toLowerCase() === wallet.toLowerCase();
    });
    if (index < 0) continue;
    used.add(index);
    const event = decoded(receipt.logs[index]!)!;
    if (event.eventName !== 'Collect') continue;
    add(totals, item.token0, event.args.amount0);
    add(totals, item.token1, event.args.amount1);
  }
  return [...totals].map(([token, amountAtomic]) => ({ token, amountAtomic }));
}

/** What a completed Aerodrome claim paid the wallet, per token, by the same
 * rules that matched its events: pool fees from Claim or Collect, AERO from
 * ClaimRewards, each event once and only from the call's own target. */
export function aerodromeArrivedV1(plan: AerodromeClaimPlanV1, wallet: string, receipt: VerifiedReceiptSourceV1): FoundArrivedV1[] {
  const totals = new Map<string, bigint>();
  const used = new Set<number>();
  const me = wallet.toLowerCase();
  for (const item of plan.calls) {
    const index = receipt.logs.findIndex((log, at) => {
      if (used.has(at) || log.address.toLowerCase() !== item.call.to.toLowerCase()) return false;
      const event = decoded(log);
      if (!event) return false;
      if (item.kind === 'basic_fees') return event.eventName === 'Claim' && event.args.recipient.toLowerCase() === me && event.args.sender.toLowerCase() === me;
      if (item.kind === 'cl_fees') return event.eventName === 'Collect' && event.args.recipient.toLowerCase() === me && String(event.args.tokenId) === item.tokenId;
      return event.eventName === 'ClaimRewards' && event.args.from.toLowerCase() === me;
    });
    if (index < 0) continue;
    used.add(index);
    const event = decoded(receipt.logs[index]!)!;
    if (event.eventName === 'ClaimRewards') add(totals, AERODROME_AERO_V1, event.args.amount);
    else {
      add(totals, item.token0, event.args.amount0);
      add(totals, item.token1, event.args.amount1);
    }
  }
  return [...totals].map(([token, amountAtomic]) => ({ token, amountAtomic }));
}

export const foundShareRuntimeV1 = {
  receipts: new PostgresBaseMcpActionReceiptRepositoryV1() as BaseMcpActionReceiptRepositoryV1,
  shares: (): FoundShareRepositoryV1 => createDatabaseFoundShareRepositoryV1(client as never),
  receiptReader: createViemBaseReceiptReader as () => BaseReceiptReader,
  value: (token: string, amount: bigint, wallet: string): Promise<AerodromeRewardAmountV1> => valueRewardAmountV1(token, amount, {
    tokenMeta: aerodromeRewardsRuntimeV1.tokenMeta,
    value: (asset, amountAtomic) => aerodromeRewardsRuntimeV1.value(asset, amountAtomic, wallet),
  }),
  origin: (): string => (process.env.MIORAIL_PUBLIC_ORIGIN ?? 'https://miorail.xyz').trim().replace(/\/+$/, ''),
  now: () => new Date(),
};

export type FoundShareOutcomeV1 =
  | { ok: true; share: FoundShareV1; url: string; text: string }
  | { ok: false; status: 404 | 409 | 503; errorCode: string };

/** The post that goes with a card. Every figure in it is the card's. */
export function foundShareTextV1(share: Pick<FoundShareV1, 'protocol' | 'usdCents'>): string {
  const dollars = `$${(share.usdCents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return share.protocol === 'uniswap'
    ? `Collected ${dollars} in Uniswap fees that were sitting in my wallet. Found with Miorail.`
    : `Claimed ${dollars} in Aerodrome fees and rewards that were sitting in my wallet. Found with Miorail.`;
}

export function foundShareUrlV1(origin: string, code: string): string {
  return `${origin}/found/${code}`;
}

/**
 * The card for one completed claim or collect, made by its owner. The receipt
 * must be this tenant's and this wallet's, completed by its matched events;
 * a second ask returns the first card.
 */
export async function makeFoundShareV1(input: { receiptId: string; tenantId: string; walletAddress?: string }): Promise<FoundShareOutcomeV1> {
  const runtime = foundShareRuntimeV1;
  const receipt = await runtime.receipts.get(input.receiptId, input.tenantId);
  if (!receipt || receipt.walletAddress !== input.walletAddress?.toLowerCase()) return { ok: false, status: 404, errorCode: 'found_share_receipt_not_found' };
  const protocol: FoundShareProtocolV1 | null = receipt.actionType === 'uniswap_collect' ? 'uniswap'
    : receipt.actionType === 'aerodrome_claim' ? 'aerodrome' : null;
  if (!protocol) return { ok: false, status: 409, errorCode: 'found_share_not_a_claim' };
  if (receipt.status !== 'completed' || receipt.reconciliationState !== 'matched' || !receipt.transactionHash) {
    return { ok: false, status: 409, errorCode: 'found_share_not_completed' };
  }
  const shares = runtime.shares();
  const existing = await shares.byReceipt(receipt.id, input.tenantId);
  if (existing) return { ok: true, share: existing, url: foundShareUrlV1(runtime.origin(), existing.code), text: foundShareTextV1(existing) };
  let arrived: FoundArrivedV1[];
  let blockNumber: string;
  try {
    // A claim the person's wallet sent may span several transactions (a
    // wallet without atomic batches sends them one by one): read them as one.
    const read = receipt.provider === 'wallet'
      ? await foundWalletChainReceiptV1(receipt, runtime.receiptReader())
      : await runtime.receiptReader().getTransactionReceipt(receipt.transactionHash as HashV1);
    const chain = read && read !== 'missing' && read !== 'reverted' ? read : null;
    if (!chain || chain.status !== 'success') return { ok: false, status: 503, errorCode: 'found_share_receipt_unavailable' };
    blockNumber = String(chain.blockNumber);
    arrived = arrivedV1(receipt, chain);
  } catch {
    return { ok: false, status: 503, errorCode: 'found_share_receipt_unavailable' };
  }
  if (arrived.length === 0) return { ok: false, status: 409, errorCode: 'found_share_nothing_arrived' };
  const valued = (await Promise.all(arrived.map((item) => runtime.value(item.token, item.amountAtomic, receipt.walletAddress)))).sort(byValueV1);
  const usdcAtomic = valued.reduce((sum, amount) => sum + BigInt(amount.usdcAtomic ?? '0'), 0n);
  const share = await shares.make({
    receiptId: receipt.id, tenantId: input.tenantId, protocol,
    usdCents: Math.min(usdcAtomicToCentsV1(usdcAtomic.toString()), 100_000_000),
    tokens: valued.slice(0, 4).map((amount) => ({ symbol: amount.symbol, amount: amountDigitsV1(amount) })),
    blockNumber, at: runtime.now(),
  });
  return { ok: true, share, url: foundShareUrlV1(runtime.origin(), share.code), text: foundShareTextV1(share) };
}

function arrivedV1(receipt: StoredBaseMcpActionReceiptV1, chain: VerifiedReceiptSourceV1): FoundArrivedV1[] {
  if (receipt.actionType === 'uniswap_collect') {
    const plan = receipt.durableProof?.collectPlan as UniswapCollectPlanV1 | undefined;
    return plan ? uniswapArrivedV1(plan, receipt.walletAddress, chain) : [];
  }
  const plan = receipt.durableProof?.claimPlan as AerodromeClaimPlanV1 | undefined;
  return plan ? aerodromeArrivedV1(plan, receipt.walletAddress, chain) : [];
}

// ---------------------------------------------------------------------------
// The picture.
// ---------------------------------------------------------------------------

export interface FoundCardV1 {
  amount: string;
  lede: string;
  tokens: { symbol: string; amount: string }[];
  footer: string;
  pageTitle: string;
  description: string;
  alt: string;
}

function blockTextV1(blockNumber: string): string {
  return BigInt(blockNumber).toLocaleString('en-US');
}

export function foundCardV1(share: FoundShareV1): FoundCardV1 {
  const amount = `$${(share.usdCents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const what = share.protocol === 'uniswap' ? 'collected in Uniswap fees' : 'claimed in Aerodrome fees and rewards';
  const tokens = share.tokens.map((token) => `${token.amount} ${token.symbol}`).join(', ');
  return {
    amount,
    lede: `${what}, worth that when shared`,
    tokens: share.tokens,
    footer: `verified on Base · block ${blockTextV1(share.blockNumber)} · found with miorail.xyz`,
    pageTitle: `${amount} ${share.protocol === 'uniswap' ? 'in Uniswap fees' : 'in Aerodrome rewards'}, found with Miorail`,
    description: `${amount} ${what} that were waiting in a wallet: ${tokens}. Miorail reads what your wallet can claim on Aerodrome and Uniswap, from Base itself, and your wallet approves the claim.`,
    alt: `${amount} ${what}: ${tokens}. Verified on Base in block ${blockTextV1(share.blockNumber)}.`,
  };
}

function escapeXmlV1(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const INK_V1 = { page: '#0b0b10', text: '#f3f4f6', soft: '#a4a7b5', faint: '#6f7285', rule: '#1f2130', brand: '#8fa2ff' };

function textV1(x: number, y: number, content: string, style: { font: string; size: number; fill: string; weight?: number; anchor?: 'end'; spacing?: number }): string {
  return `<text x="${x}" y="${y}" font-family="${style.font}" font-size="${style.size}"${style.weight ? ` font-weight="${style.weight}"` : ''}${style.anchor ? ` text-anchor="${style.anchor}"` : ''}${style.spacing ? ` letter-spacing="${style.spacing}"` : ''} fill="${style.fill}">${escapeXmlV1(content)}</text>`;
}

export function foundCardSvgV1(card: FoundCardV1, shape: CardShapeV1 = 'link'): string {
  const W = 1200;
  const H = cardHeightV1(shape);
  const at = (y: number) => cardYV1(y, H);
  const left = 72;
  const right = W - 72;
  const out: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`,
    '<defs>',
    '<radialGradient id="glow" cx="0.82" cy="0.08" r="0.62"><stop offset="0" stop-color="#262a48" stop-opacity="0.95"/><stop offset="1" stop-color="#0b0b10" stop-opacity="0"/></radialGradient>',
    '<linearGradient id="accent" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#6d8dff"/><stop offset="1" stop-color="#a77bff"/></linearGradient>',
    '</defs>',
    `<rect width="${W}" height="${H}" fill="${INK_V1.page}"/>`,
    `<rect width="${W}" height="${H}" fill="url(#glow)"/>`,
    textV1(left, at(88), 'MIORAIL', { font: 'JetBrains Mono', size: 20, fill: INK_V1.brand, spacing: 6 }),
    textV1(left + 150, at(88), 'Found · Wallet MCP', { font: 'JetBrains Mono', size: 20, fill: INK_V1.soft }),
    `<rect x="${right - 170}" y="${at(58)}" width="170" height="42" rx="21" fill="#14151f" stroke="#2c2f45" stroke-width="1.5"/>`,
    `<circle cx="${right - 146}" cy="${at(58) + 21}" r="5" fill="url(#accent)"/>`,
    textV1(right - 130, at(58) + 28, 'Collected', { font: 'Inter', size: 19, fill: '#c9cbe0', weight: 600 }),
    textV1(left, at(226), card.amount, { font: 'Inter', size: 112, weight: 600, fill: 'url(#accent)' }),
    textV1(left, at(280), card.lede, { font: 'Inter', size: 28, fill: INK_V1.soft }),
    `<rect x="${left}" y="${at(318)}" width="${right - left}" height="1" fill="${INK_V1.rule}"/>`,
  ];
  card.tokens.forEach((token, index) => {
    const y = at(370) + index * at(48);
    out.push(textV1(left, y, token.amount, { font: 'JetBrains Mono', size: 32, weight: 600, fill: INK_V1.text }));
    out.push(textV1(right, y, token.symbol, { font: 'JetBrains Mono', size: 28, fill: INK_V1.soft, anchor: 'end' }));
  });
  out.push(textV1(right, at(598), card.footer, { font: 'JetBrains Mono', size: 18, fill: INK_V1.faint, anchor: 'end' }));
  out.push('</svg>');
  return out.join('');
}
