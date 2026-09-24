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

export interface GiftStateV1 {
  recipient: `0x${string}`;
  /** The Basename the person typed, when they typed one. */
  recipientName: string | null;
}

const ADDRESS_V1 = /^0x[0-9a-f]{40}$/;

/** The gift the stocks card handed over, or null when there is none — or
 * when what is there is not the shape the card writes. */
export function giftFromHistoryStateV1(state: unknown): GiftStateV1 | null {
  const gift = (state as { gift?: unknown } | null | undefined)?.gift as
    | { recipient?: unknown; recipientName?: unknown }
    | undefined;
  if (!gift || typeof gift.recipient !== 'string') return null;
  const recipient = gift.recipient.toLowerCase();
  if (!ADDRESS_V1.test(recipient)) return null;
  const name =
    typeof gift.recipientName === 'string' && /^[^\s]{1,255}\.base\.eth$/i.test(gift.recipientName)
      ? gift.recipientName
      : null;
  return { recipient: recipient as `0x${string}`, recipientName: name };
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
      return {
        index: index + 1,
        title: `Send exactly ${amount ?? call.amountAtomic ?? 'the guaranteed amount'} ${call.asset?.symbol ?? 'tokens'} to ${who}`,
        detail: `${call.recipient ?? call.to} · the gift. The swap above pays your own wallet first; this is the only call that sends anything to anyone else.`,
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
    note: gift.delivered
      ? `${recipient.value} received exactly the swap's guaranteed minimum, in the same transaction that bought it. Whatever the swap returned above that stayed with ${giver.value}.`
      : 'The transfer to the recipient was not confirmed by the receipt, so this page claims nothing arrived.',
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
