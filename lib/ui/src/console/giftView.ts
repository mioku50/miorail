// ---------------------------------------------------------------------------
// Growth plan step 4: what a gift looks like on the console.
//
// Two rules the screens below keep:
//
//   * WHO receives a gift is never read from the address bar. The stocks card
//     puts it in history state after the person typed it and the server
//     resolved it; a link somebody else wrote can carry a purchase, never a
//     recipient for the reader to pay.
//   * Every call the wallet will sign is named for what it does. The review
//     used to call anything that was not an approval "Swap through the
//     selected route — Recipient is your own wallet", which for the transfer a
//     gift appends would have been precisely backwards.
// ---------------------------------------------------------------------------

import { stockTradeAmountV1 } from '@mioagent/rwa-market-reality/execution-handoff';
import type { VerificationHonestyViewV1, VerifiedFactV1 } from './verificationHonesty';

/** A gift from what the wallet already holds: which stock, and how much of
 * it. Nothing is bought, so there is no route to compare. */
export interface GiftSendStateV1 {
  tokenAddress: `0x${string}`;
  amountAtomic: string;
  symbol: string;
  decimals: number;
}

export interface GiftStateV1 {
  recipient: `0x${string}`;
  /** The Basename the person typed, when they typed one. */
  recipientName: string | null;
  /** Present for a gift from holdings; absent for a gift that is bought. */
  send?: GiftSendStateV1 | null;
}

const ADDRESS_V1 = /^0x[0-9a-f]{40}$/;

/** The gift the stocks card handed over, or null when there is none — or
 * when what is there is not the shape the card writes. A malformed send is no
 * gift at all, never a purchase in its place. */
export function giftFromHistoryStateV1(state: unknown): GiftStateV1 | null {
  const gift = (state as { gift?: unknown } | null | undefined)?.gift as
    | { recipient?: unknown; recipientName?: unknown; send?: unknown }
    | undefined;
  if (!gift || typeof gift.recipient !== 'string') return null;
  const recipient = gift.recipient.toLowerCase();
  if (!ADDRESS_V1.test(recipient)) return null;
  const name =
    typeof gift.recipientName === 'string' && /^[^\s]{1,255}\.base\.eth$/i.test(gift.recipientName)
      ? gift.recipientName
      : null;
  if (gift.send === undefined || gift.send === null) {
    return { recipient: recipient as `0x${string}`, recipientName: name };
  }
  const send = gift.send as { tokenAddress?: unknown; amountAtomic?: unknown; symbol?: unknown; decimals?: unknown };
  const token = typeof send.tokenAddress === 'string' ? send.tokenAddress.toLowerCase() : '';
  if (
    !ADDRESS_V1.test(token) ||
    typeof send.amountAtomic !== 'string' ||
    !/^[1-9][0-9]{0,77}$/.test(send.amountAtomic) ||
    typeof send.symbol !== 'string' ||
    send.symbol.trim().length === 0 ||
    send.symbol.length > 40 ||
    typeof send.decimals !== 'number' ||
    !Number.isInteger(send.decimals) ||
    send.decimals < 0 ||
    send.decimals > 36
  ) {
    return null;
  }
  return {
    recipient: recipient as `0x${string}`,
    recipientName: name,
    send: { tokenAddress: token as `0x${string}`, amountAtomic: send.amountAtomic, symbol: send.symbol, decimals: send.decimals },
  };
}

/** 0x4de2…0d70 — the form the gift page's server-written preview uses too. */
function shortAddressV1(address: string): string {
  return address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}

/** How a recipient is named on screen: the Basename they were typed as, or
 * the address itself. */
export function giftRecipientLabelV1(gift: { recipient: string; recipientName: string | null }): string {
  return gift.recipientName ?? shortAddressV1(gift.recipient);
}

/** What the console says above every step of a gift. */
export function giftBannerV1(input: {
  gift: GiftStateV1 | null;
  /** The page was opened as a gift, and no recipient came with it. */
  missing: boolean;
}): { tone: 'gift' | 'warn'; title: string; detail: string } | null {
  if (input.gift?.send) {
    const send = input.gift.send;
    return {
      tone: 'gift',
      title: `Gift to ${giftRecipientLabelV1(input.gift)}`,
      detail: `${input.gift.recipient} receives exactly ${unitsV1(send.amountAtomic, send.decimals) ?? send.amountAtomic} ${send.symbol} from what your wallet already holds — one transfer, approved in your wallet. Nothing is bought or swapped.`,
    };
  }
  if (input.gift) {
    return {
      tone: 'gift',
      title: `Gift to ${giftRecipientLabelV1(input.gift)}`,
      detail: `${input.gift.recipient} receives exactly the swap's guaranteed minimum of this stock, in the same batch your wallet approves. Anything the swap returns above that stays in your wallet.`,
    };
  }
  if (input.missing) {
    return {
      tone: 'warn',
      title: 'This gift has no recipient on this page',
      detail:
        'A link cannot carry a gift recipient, on purpose. Start the gift again from the stock’s page; nothing here will be prepared as a gift.',
    };
  }
  return null;
}

function unitsV1(atomic: string | null | undefined, decimals: number | null | undefined): string | null {
  if (!atomic || !/^[0-9]+$/.test(atomic) || typeof decimals !== 'number' || decimals < 0 || decimals > 36) return null;
  if (decimals === 0) return atomic;
  const padded = atomic.padStart(decimals + 1, '0');
  const whole = padded.slice(0, -decimals).replace(/^0+(?=\d)/, '');
  const fraction = padded.slice(-decimals).replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole;
}

export interface ReviewCallRowV1 {
  index: number;
  title: string;
  detail: string;
  mono: boolean;
}

/** The review's list of calls to sign, each named for what it does. */
export function reviewCallRowsV1(input: {
  calls: readonly {
    callType: string;
    to: string;
    spender: string | null;
    recipient: string | null;
    amountAtomic: string | null;
    asset?: { symbol: string; decimals: number } | null;
  }[];
  quoteExpiry: string;
  /** The name the gift recipient was typed as, when there is a gift. */
  recipientName?: string | null;
}): ReviewCallRowV1[] {
  return input.calls.map((call, index) => {
    if (call.callType === 'approval') {
      return {
        index: index + 1,
        title: `Allow ${call.spender ?? 'the router'} to spend exactly ${call.amountAtomic ?? 'the quoted amount'}`,
        detail: `${call.to} · exact amount, no unlimited approval`,
        mono: true,
      };
    }
    if (call.callType === 'swap') {
      return {
        index: index + 1,
        title: 'Swap through the selected route',
        detail: `Recipient is your own wallet · expires ${input.quoteExpiry}`,
        mono: true,
      };
    }
    if (call.callType === 'transfer') {
      const amount = unitsV1(call.amountAtomic, call.asset?.decimals);
      const who = call.recipient
        ? giftRecipientLabelV1({ recipient: call.recipient, recipientName: input.recipientName ?? null })
        : 'someone else';
      // Alone, it is a gift from holdings; after a swap, the bought gift.
      const bought = input.calls.some((other) => other.callType === 'swap');
      return {
        index: index + 1,
        title: `Send exactly ${amount ?? call.amountAtomic ?? 'the guaranteed amount'} ${call.asset?.symbol ?? 'tokens'} to ${who}`,
        detail: bought
          ? `${call.recipient ?? call.to} · the gift. The swap above pays your own wallet first; this is the only call that sends anything to anyone else.`
          : `${call.recipient ?? call.to} · the gift, from what your wallet already holds. It is the only call: nothing is bought or swapped.`,
        mono: true,
      };
    }
    return {
      index: index + 1,
      title: 'An unrecognised call',
      detail: `${call.to} · the Safety Kernel refuses a batch containing one`,
      mono: true,
    };
  });
}

/** What the proof says about a gift, once the chain has been read. */
export function giftProofLineV1(input: {
  gift: { recipient: string; amountAtomic: string } | null | undefined;
  asset: { symbol: string; decimals: number } | null;
  finalStatus: string;
  recipientName?: string | null;
}): { title: string; detail: string; delivered: boolean } | null {
  if (!input.gift) return null;
  const amount = unitsV1(input.gift.amountAtomic, input.asset?.decimals) ?? input.gift.amountAtomic;
  const who = giftRecipientLabelV1({ recipient: input.gift.recipient, recipientName: input.recipientName ?? null });
  const delivered = input.finalStatus === 'completed';
  return {
    title: delivered ? `Gift delivered to ${who}` : `Gift to ${who}`,
    detail: delivered
      ? `${amount} ${input.asset?.symbol ?? ''} went to ${input.gift.recipient}, read from the receipt.`.replace(/\s+,/, ',')
      : `${amount} ${input.asset?.symbol ?? ''} to ${input.gift.recipient} — not confirmed until the receipt shows the transfer.`,
    delivered,
  };
}

// ---------------------------------------------------------------------------
// Sharing a gift — on X and Farcaster first (the operator's call, 2026-09-23).
//
// A gift link IS a public proof link, published by the giver's own click. The
// warning says what it makes readable, before anything is published.
// ---------------------------------------------------------------------------

export const GIFT_SHARE_WARNING_V1 =
  'The gift link shows your wallet address, the recipient’s address and the transaction to anyone who has it. All three are already public on Base; the link puts them on one page. You can revoke it from Activity.';

/** The post that goes with a gift link. Every figure in it is the proof's. */
export function giftShareTextV1(input: {
  recipientLabel: string;
  amount: string;
  symbol: string;
  /** "NVIDIA", or null when only the token symbol is known. */
  company: string | null;
}): string {
  const what = input.company ? `tokenized ${input.company} stock` : 'a tokenized stock';
  return `I gave ${input.recipientLabel} ${input.amount} ${input.symbol}: ${what}, delivered on Base in one transaction.`;
}

/** Composer links: X takes the link as `url`, Farcaster as an embed, so the
 * text never carries it twice. */
export function giftShareLinksV1(input: { url: string; text: string }): { x: string; farcaster: string } {
  const text = encodeURIComponent(input.text);
  const url = encodeURIComponent(input.url);
  return {
    x: `https://x.com/intent/tweet?text=${text}&url=${url}`,
    // warpcast.com/~/compose now answers 301 to exactly this path, query intact.
    farcaster: `https://farcaster.xyz/~/compose?text=${text}&embeds[]=${url}`,
  };
}

/** The absolute gift link for a public proof id. */
export function giftUrlV1(origin: string, publicId: string): string {
  return `${origin.replace(/\/+$/, '')}/gift/${encodeURIComponent(publicId)}`;
}

// ---------------------------------------------------------------------------
// The public gift page.
// ---------------------------------------------------------------------------

/** What `giftOfPublicBundleV1` reads out of a bundle, structurally. */
export interface PublicGiftLikeV1 {
  giver: string;
  recipient: string;
  amountAtomic: string;
  token: { address: string; symbol: string; decimals: number };
  finalStatus: string;
  delivered: boolean;
  transactionHash: string | null;
  /** `held`: given from what the giver already held — nothing was bought. */
  source?: 'bought' | 'held';
  paid: { amountAtomic: string; symbol: string; decimals: number } | null;
  issuedAt: string;
}

export interface PublicGiftLabelsV1 {
  names: { giver: string | null; recipient: string | null };
  stock: { ticker: string | null; companyName: string | null } | null;
}

export interface PublicGiftRowV1 {
  label: string;
  value: string;
  detail: string | null;
  href: string | null;
}

export interface PublicGiftPageViewV1 {
  headline: string;
  amount: string;
  unit: string;
  what: string;
  status: { label: string; tone: 'g' | 'a' | 'n' };
  rows: PublicGiftRowV1[];
  note: string;
  stockHref: string | null;
  stockLabel: string;
  identityHref: string;
  proofHref: string;
  giveBack: string;
  share: { url: string; x: string; farcaster: string } | null;
}

const BASESCAN_V1 = 'https://basescan.org';

/** A person as the page names them: the Basename that resolves back to them,
 * or their address. */
function personV1(address: string, name: string | null): { value: string; detail: string | null } {
  return name ? { value: name, detail: address } : { value: shortAddressV1(address), detail: address };
}

export function publicGiftPageViewV1(input: {
  publicId: string;
  origin: string;
  gift: PublicGiftLikeV1;
  labels: PublicGiftLabelsV1 | null;
  /** The verifier's answer for the bundle this gift was read from. */
  verified: boolean | null;
}): PublicGiftPageViewV1 {
  const { gift } = input;
  const names = input.labels?.names ?? { giver: null, recipient: null };
  const stock = input.labels?.stock ?? null;
  const giver = personV1(gift.giver, names.giver);
  const recipient = personV1(gift.recipient, names.recipient);
  const amount = unitsV1(gift.amountAtomic, gift.token.decimals) ?? gift.amountAtomic;
  const company = stock?.companyName ?? stock?.ticker ?? null;
  const ticker = stock?.ticker ?? null;
  const paid = gift.paid ? `${unitsV1(gift.paid.amountAtomic, gift.paid.decimals) ?? gift.paid.amountAtomic} ${gift.paid.symbol}` : null;
  const url = giftUrlV1(input.origin, input.publicId);

  const rows: PublicGiftRowV1[] = [
    { label: 'From', value: giver.value, detail: giver.detail, href: `${BASESCAN_V1}/address/${gift.giver}` },
    { label: 'To', value: recipient.value, detail: recipient.detail, href: `${BASESCAN_V1}/address/${gift.recipient}` },
    {
      label: 'Stock contract',
      value: `${gift.token.symbol} · ${shortAddressV1(gift.token.address)}`,
      detail: gift.token.address,
      href: `${BASESCAN_V1}/token/${gift.token.address}`,
    },
    gift.transactionHash
      ? {
          label: 'Transaction',
          value: shortAddressV1(gift.transactionHash),
          detail: gift.transactionHash,
          href: `${BASESCAN_V1}/tx/${gift.transactionHash}`,
        }
      : { label: 'Transaction', value: 'none recorded', detail: null, href: null },
    ...(paid ? [{ label: 'Paid for the purchase', value: paid, detail: null, href: null }] : []),
    {
      label: 'This record',
      value:
        input.verified === true
          ? 'Checked in your browser: every hash matches'
          : input.verified === false
            ? 'Did NOT check out in your browser'
            : 'Not checked',
      detail: null,
      href: null,
    },
  ];

  return {
    headline: gift.delivered
      ? `${giver.value} gave ${recipient.value} ${company ?? gift.token.symbol} stock`
      : `A gift from ${giver.value} to ${recipient.value} did not arrive`,
    amount,
    unit: gift.token.symbol,
    what: company ? `Tokenized ${company} stock on Base` : 'A tokenized stock on Base',
    status: gift.delivered
      ? { label: 'Delivered · read from the receipt', tone: 'g' }
      : { label: `Not delivered · ${gift.finalStatus.replace(/_/g, ' ')}`, tone: 'a' },
    rows,
    note: !gift.delivered
      ? 'The transfer to the recipient was not confirmed by the receipt, so this page claims nothing arrived.'
      : gift.source === 'held'
        ? `${recipient.value} received exactly ${amount} ${gift.token.symbol}, sent from ${giver.value}’s own holdings in one transfer. Nothing was bought for it.`
        : `${recipient.value} received exactly the swap's guaranteed minimum, in the same transaction that bought it. Whatever the swap returned above that stayed with ${giver.value}.`,
    stockHref: ticker ? `/stocks/${encodeURIComponent(ticker.toLowerCase())}` : null,
    stockLabel: ticker ? `Open ${ticker} on Miorail` : 'Open Miorail',
    identityHref: `/is-it-real/${gift.token.address}`,
    proofHref: `/proof/${encodeURIComponent(input.publicId)}`,
    giveBack: `To give one back, open the stock, choose Gift and enter ${names.giver ?? gift.giver}.`,
    share: gift.delivered
      ? {
          url,
          ...giftShareLinksV1({
            url,
            text: `${giver.value} gave ${recipient.value} ${amount} ${gift.token.symbol}${company ? `, tokenized ${company} stock` : ''}, on Base.`,
          }),
        }
      : null,
  };
}

/** The post and composer links for a gift on the giver's own proof screen. */
export function giftShareForProofV1(input: {
  gift: { recipient: string; amountAtomic: string };
  asset: { symbol: string; decimals: number } | null;
  recipientName: string | null;
  url: string;
}): { text: string; x: string; farcaster: string } {
  const amount = unitsV1(input.gift.amountAtomic, input.asset?.decimals) ?? input.gift.amountAtomic;
  const text = giftShareTextV1({
    recipientLabel: giftRecipientLabelV1({ recipient: input.gift.recipient, recipientName: input.recipientName }),
    amount,
    symbol: input.asset?.symbol ?? 'tokens',
    company: null,
  });
  return { text, ...giftShareLinksV1({ url: input.url, text }) };
}

// ---------------------------------------------------------------------------
// A gift from what the wallet already holds — the form's side.
//
// The form reads the holding first. When there is one, the gift is sent from
// it: one transfer, typed in the stock's own units, never in dollars — a
// dollar figure is a quote, and a quote converted into tokens asks for more
// than a position holds whenever the price has dipped. The dollar value is
// shown beside it as "about", and the range is checked by the server again,
// on a fresh quote, before anything is prepared.
// ---------------------------------------------------------------------------

/** What a gift from holdings may be worth, in USDC atoms: the server's range. */
export const GIFT_SEND_MIN_VALUE_USDC_ATOMIC_V1 = '50000';
export const GIFT_SEND_MAX_VALUE_USDC_ATOMIC_V1 = '100000000';

export type GiftHoldingV1 =
  | {
      status: 'held';
      symbol: string;
      decimals: number;
      balanceAtomic: string;
      /** What the whole balance fetches in USDC now; null when unpriced. */
      valueUsdcAtomic: string | null;
    }
  | { status: 'none'; symbol: string; decimals: number }
  | { status: 'unavailable'; message: string };

/** Cents, rounded down: the page never flatters a gift. */
export function usdcCentsLabelV1(atomic: string): string {
  const cents = BigInt(atomic) / 10_000n;
  return `$${(cents / 100n).toString()}.${(cents % 100n).toString().padStart(2, '0')}`;
}

/** What `amountAtomic` of a holding fetches, pro rata of the whole balance. */
export function giftSendValueV1(input: { amountAtomic: string; balanceAtomic: string; valueUsdcAtomic: string | null }): string | null {
  if (!input.valueUsdcAtomic || !/^[1-9][0-9]*$/.test(input.balanceAtomic)) return null;
  return ((BigInt(input.valueUsdcAtomic) * BigInt(input.amountAtomic)) / BigInt(input.balanceAtomic)).toString();
}

export type GiftSendAmountV1 =
  | { status: 'ready'; atomic: string; label: string; valueLabel: string | null }
  | { status: 'empty' | 'malformed' | 'too_precise' | 'zero' | 'over_balance' | 'below_minimum' | 'above_maximum'; message: string };

/** One typed amount of a held stock, exactly — or why it cannot be given. */
export function giftSendAmountV1(input: {
  text: string;
  holding: Extract<GiftHoldingV1, { status: 'held' }>;
}): GiftSendAmountV1 {
  const { holding } = input;
  const amount = stockTradeAmountV1({ direction: 'sell', text: input.text, tokenDecimals: holding.decimals });
  if (amount.status === 'empty') return { status: 'empty', message: `Enter how much ${holding.symbol} to give.` };
  if (amount.status === 'decimals_unread') return { status: 'malformed', message: amount.message };
  if (amount.status !== 'ready') {
    return { status: amount.status === 'below_minimum' || amount.status === 'above_maximum' ? 'malformed' : amount.status, message: amount.message };
  }
  if (BigInt(amount.atomic) > BigInt(holding.balanceAtomic)) {
    return {
      status: 'over_balance',
      message: `Your wallet holds ${unitsV1(holding.balanceAtomic, holding.decimals)} ${holding.symbol}. Give less, or buy the gift with USDC.`,
    };
  }
  const value = giftSendValueV1({
    amountAtomic: amount.atomic,
    balanceAtomic: holding.balanceAtomic,
    valueUsdcAtomic: holding.valueUsdcAtomic,
  });
  if (value !== null && BigInt(value) < BigInt(GIFT_SEND_MIN_VALUE_USDC_ATOMIC_V1)) {
    return {
      status: 'below_minimum',
      message: `A gift from what you hold is worth at least $0.05; ${amount.label} ${holding.symbol} fetches about ${usdcCentsLabelV1(value)}.`,
    };
  }
  if (value !== null && BigInt(value) > BigInt(GIFT_SEND_MAX_VALUE_USDC_ATOMIC_V1)) {
    return {
      status: 'above_maximum',
      message: `The largest gift is worth $100; ${amount.label} ${holding.symbol} fetches about ${usdcCentsLabelV1(value)}.`,
    };
  }
  return { status: 'ready', atomic: amount.atomic, label: amount.label, valueLabel: value === null ? null : usdcCentsLabelV1(value) };
}

/** Which way the form gives by default: from the holding when there is one
 * that can be given at all, otherwise by buying. */
export function giftDefaultModeV1(holding: GiftHoldingV1 | null): 'send' | 'buy' {
  if (holding?.status !== 'held') return 'buy';
  if (holding.valueUsdcAtomic === null) return 'send';
  return BigInt(holding.valueUsdcAtomic) >= BigInt(GIFT_SEND_MIN_VALUE_USDC_ATOMIC_V1) ? 'send' : 'buy';
}

// ---------------------------------------------------------------------------
// What was checked for a gift from holdings, and what was not.
//
// The swap version says "you pay / you receive" and lists what a PURCHASE
// leaves unchecked — pool depth, liquidity locks. None of that is this
// transaction. A send is judged on different facts and leaves different
// questions open, so it gets its own list, stated as flatly.
// ---------------------------------------------------------------------------

export const GIFT_SEND_NOT_VERIFIED_V1: readonly string[] = [
  'Who holds the keys to the recipient’s address. Miorail checked its shape and, for a Basename, that it still resolves there — not that the person you mean controls it.',
  'Whether the recipient can sell the stock later. Its issuer’s transfer rules applied to this transfer in the simulation; what they allow afterwards was not read.',
  'What the stock will be worth when it arrives, or later. The dollar figure was a quote, not a price anyone promised.',
  'Whether it can be undone. It cannot: once the receipt shows the transfer, the stock is theirs.',
];

export function giftSendHonestyViewV1(input: {
  token: { address: string | null; symbol: string; decimals: number };
  recipient: string;
  recipientName: string | null;
  safetyChecks: readonly { id: string; description: string; status: 'passed' | 'failed' | 'skipped'; detail: string | null }[];
  simulation: { state: string } | null;
}): VerificationHonestyViewV1 {
  const status = (id: string) => input.safetyChecks.find((check) => check.id === id) ?? null;
  const fact = (label: string, id: string, passed: string): VerifiedFactV1 => {
    const check = status(id);
    return check?.status === 'passed'
      ? { label, detail: passed, tone: 'good' }
      : { label, detail: check?.detail ?? `${check?.description ?? label} — not confirmed`, tone: 'warn' };
  };
  const address = input.token.address?.toLowerCase() ?? '';
  const verified: VerifiedFactV1[] = [
    fact(
      'You give',
      'send_reviewed_stock',
      `${address} — a Coinbase-issued stock in Miorail’s reviewed corpus; the contract answers "${input.token.symbol}" and ${input.token.decimals} decimals.`,
    ),
    {
      label: 'They receive',
      detail: input.recipientName
        ? `${input.recipient} — ${input.recipientName}, resolved again just before this review.`
        : `${input.recipient} — the address as you entered it.`,
      tone: 'none',
    },
    fact('Calldata', 'send_calldata_exact', 'One ERC-20 transfer of exactly the reviewed amount to the reviewed recipient, and nothing else — decoded from the bytes your wallet signs.'),
    fact('Balance', 'send_balance', 'Your wallet held at least this amount when it was read, and it is read again when you approve.'),
    {
      label: 'Token security',
      detail: 'Not asked: nothing is bought, so no token-risk provider was queried. The stock is one Miorail has already reviewed.',
      tone: 'none',
    },
  ];
  if (input.simulation) {
    const passed = input.simulation.state === 'passed';
    verified.push({
      label: 'Simulation',
      detail: passed
        ? 'The transfer was executed from your wallet against current Base state and did not revert.'
        : `Not simulated (${input.simulation.state}). Nothing here proves the transfer would succeed.`,
      tone: passed ? 'good' : 'warn',
    });
  }
  return {
    verified,
    notVerified: [...GIFT_SEND_NOT_VERIFIED_V1],
    note: 'Each line above is something that was read. Everything below it is something nobody looked at.',
  };
}

/** What a refused or expired gift from holdings says on the Review screen.
 * The words of a route ("compare again") do not fit a transfer. */
export function giftSendNoticeV1(
  data:
    | { outcome: 'prepared' }
    | { outcome: 'refresh_required'; detail: string }
    | { outcome: 'unsupported'; reason: string; detail: string }
    | { outcome: 'blocked'; safety: { blockedReason: string | null } }
    | null
    | undefined,
): { title: string; detail: string; canCompareAgain?: boolean } | null {
  if (!data || data.outcome === 'prepared') return null;
  if (data.outcome === 'refresh_required') {
    return { title: 'This gift’s review expired', detail: data.detail, canCompareAgain: true };
  }
  if (data.outcome === 'unsupported') return { title: 'Miorail cannot send this gift', detail: data.detail };
  return {
    title: 'The Safety Kernel refused this transfer',
    detail: data.safety.blockedReason ?? 'A safety check did not pass, so nothing was prepared for signing.',
  };
}
