import type { PaidActionState } from '@mioagent/x402-actions';

// ---------------------------------------------------------------------------
// The paid API, for a person holding a wallet.
//
// Miorail sells one answer over x402 on Base since 2026-11-16: what Still would
// lend against an exact amount of a stock, bitcoin, ether or gold, read live,
// with no wallet. The five resources sold before it answered what the free MCP
// answers, or read a launch feed frozen in September, and were retired.
//
// This page is the buyer, for a person. Their wallet signs one USDC
// authorization for exactly the price the server's 402 names, and the same
// request returns the answer. Miorail signs nothing: the wallet signs, and the
// facilitator submits the transfer.
// ---------------------------------------------------------------------------

export const X402_INTELLIGENCE_BASE_V1 = '/api/x402/intelligence/v1';

export type PaidResourceIdV1 = 'still_loan_quote';

export interface PaidFieldV1 {
  name: string;
  label: string;
  required: boolean;
  /** Prefilled so the first payment returns an answer rather than a refusal. */
  example: string;
  hint: string;
  accepts: (value: string) => boolean;
  refusal: string;
}

export interface PaidResourceV1 {
  id: PaidResourceIdV1;
  title: string;
  question: string;
  path: string;
  fields: readonly PaidFieldV1[];
}

/** Still's collateral, as the server names it. */
export const PAID_API_ASSETS_V1 = ['AAPLc', 'AMZNc', 'GOOGLc', 'METAc', 'MSFTc', 'NVDAc', 'SPCXc', 'TSLAc', 'cbBTC', 'ETH', 'PAXG'] as const;

const ADDRESS_V1 = /^0x[0-9a-fA-F]{40}$/;
// The server's own rules, mirrored so a malformed ask is stopped before it
// reaches the wallet. The server checks them again either way.
const AMOUNT_V1 = /^\d{1,12}(?:\.\d{1,18})?$/;
const USDC_DECIMAL_V1 = /^\d{1,9}(?:\.\d{1,6})?$/;
const ASSET_KEYS_V1 = new Set<string>([...PAID_API_ASSETS_V1.map((id) => id.toLowerCase()), 'weth']);

export const PAID_RESOURCES_V1: readonly PaidResourceV1[] = [
  {
    id: 'still_loan_quote',
    title: 'What would Still lend?',
    question:
      'What Still would lend in USDC against an exact amount, read live from Aave V4 or Morpho on Base: Still’s limit beside the protocol’s own, the rate, what the venue can lend now, the liquidation price and what a 10, 20 or 30% fall at once would do. No wallet of yours is read, and nothing is offered.',
    path: '/still/loan-quote',
    fields: [
      {
        name: 'asset',
        label: 'Collateral',
        required: true,
        example: 'NVDAc',
        hint: `${PAID_API_ASSETS_V1.join(', ')}, or its exact Base token address.`,
        accepts: (value) => ASSET_KEYS_V1.has(value.toLowerCase()) || ADDRESS_V1.test(value),
        refusal: `Collateral is one of ${PAID_API_ASSETS_V1.join(', ')}, or its token address.`,
      },
      {
        name: 'amount',
        label: 'Amount',
        required: true,
        example: '10',
        hint: 'Tokens to pledge, such as 10 or 0.25.',
        accepts: (value) => AMOUNT_V1.test(value) && Number(value) > 0,
        refusal: 'Amount is a number of tokens above zero, such as 10 or 0.25.',
      },
      {
        name: 'borrowUsdc',
        label: 'Loan, USDC',
        required: false,
        example: '',
        hint: 'Optional. A loan to compute at that size.',
        accepts: (value) => USDC_DECIMAL_V1.test(value) && Number(value) > 0,
        refusal: 'Loan is a USDC amount above zero, up to six decimals.',
      },
    ],
  },
];

export type PaidRequestV1 = { ok: true; url: string } | { ok: false; refusal: string };

/** The request for one resource, or the reason it is not sent. An optional
 * field left empty is left out, so the server applies its own default. */
export function paidRequestUrlV1(resource: PaidResourceV1, values: Readonly<Record<string, string>>): PaidRequestV1 {
  const params = new URLSearchParams();
  for (const field of resource.fields) {
    const value = (values[field.name] ?? '').trim();
    if (!value) {
      if (field.required) return { ok: false, refusal: `${field.label} is required.` };
      continue;
    }
    if (!field.accepts(value)) return { ok: false, refusal: field.refusal };
    params.set(field.name, value);
  }
  return { ok: true, url: `${X402_INTELLIGENCE_BASE_V1}${resource.path}?${params.toString()}` };
}

export function examplesOfV1(resource: PaidResourceV1): Record<string, string> {
  return Object.fromEntries(resource.fields.map((field) => [field.name, field.example]));
}

/** What the server's own 402 names: who is paid, how much, in what. */
export interface PaymentTermsV1 {
  payTo: string;
  amountAtomic: string;
  asset: string;
  network: string;
}

/**
 * Reads the terms from a PAYMENT-REQUIRED header (x402 v2: base64 JSON).
 * Null when the header is absent or unreadable — the page then states no
 * price rather than one it assumed.
 */
export function paymentTermsFromHeaderV1(header: string | null): PaymentTermsV1 | null {
  if (!header) return null;
  try {
    const decoded = JSON.parse(atob(header)) as { accepts?: Array<Record<string, unknown>> };
    const offer = decoded.accepts?.find((entry) => entry.network === 'eip155:8453' && entry.scheme === 'exact');
    if (!offer) return null;
    const { payTo, amount, asset, network } = offer;
    if (typeof payTo !== 'string' || !ADDRESS_V1.test(payTo)) return null;
    if (typeof amount !== 'string' || !/^[1-9][0-9]*$/.test(amount)) return null;
    if (typeof asset !== 'string' || !ADDRESS_V1.test(asset)) return null;
    return { payTo, amountAtomic: amount, asset, network: String(network) };
  } catch {
    return null;
  }
}

/** 2000 atoms of USDC reads "0.002 USDC". */
export function usdcLabelV1(amountAtomic: string): string {
  const value = BigInt(amountAtomic);
  const whole = value / 1_000_000n;
  const fraction = (value % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return `${whole}${fraction ? `.${fraction}` : ''} USDC`;
}

/**
 * A wallet that IS the payTo would pay itself. The transfer proves nothing
 * about the resource, and a facilitator may refuse it, so the page says so
 * instead of asking for a signature.
 */
export function payerRefusalV1(payer: string | null | undefined, terms: PaymentTermsV1 | null): string | null {
  if (!payer || !terms) return null;
  return payer.toLowerCase() === terms.payTo.toLowerCase()
    ? 'This wallet is the one Miorail’s payments go to, so it would be paying itself. Connect another wallet to pay.'
    : null;
}

export function basescanTxUrlV1(hash: string | null | undefined): string | null {
  return hash && /^0x[0-9a-fA-F]{64}$/.test(hash) ? `https://basescan.org/tx/${hash}` : null;
}

const MAX_RENDERED_CHARS_V1 = 20_000;

/** The answer as the server sent it, bounded for the screen. A cut is said. */
export function renderedAnswerV1(body: unknown): string {
  const text = JSON.stringify(body, null, 2) ?? String(body);
  if (text.length <= MAX_RENDERED_CHARS_V1) return text;
  return `${text.slice(0, MAX_RENDERED_CHARS_V1)}\n… ${text.length - MAX_RENDERED_CHARS_V1} more characters not shown`;
}

/** One line per state, for a person rather than for a log. */
export function paidStateLineV1(state: PaidActionState | 'idle', price: string): string | null {
  switch (state) {
    case 'idle':
      return null;
    case 'preparing_payment':
      return 'Reading the price…';
    case 'awaiting_wallet_confirmation':
    case 'awaiting_wallet':
      return `Approve ${price} in your wallet.`;
    case 'submitted':
    case 'settling_payment':
    case 'settling':
      return 'Settling the payment through the x402 facilitator…';
    case 'running_action':
      return 'Paid. Reading the answer…';
    case 'succeeded':
    case 'settled':
      return 'Paid and answered.';
    case 'settled_degraded':
      return 'Answered. The facilitator did not report the settlement transaction.';
    case 'rejected':
    case 'cancelled':
      return 'Cancelled in the wallet. Nothing was paid.';
    case 'insufficient_funds':
      return `This wallet does not hold ${price} on Base.`;
    case 'unsupported_wallet':
      return 'Connect a wallet on Base first.';
    case 'settlement_failed':
      return 'The x402 facilitator did not confirm the payment.';
    case 'failed':
      return 'The request did not return an answer.';
  }
}
