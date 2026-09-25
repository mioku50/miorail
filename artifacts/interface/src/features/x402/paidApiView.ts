import type { PaidActionState } from '@mioagent/x402-actions';

// ---------------------------------------------------------------------------
// The paid API, for a person holding a wallet.
//
// Miorail sells five answers over x402 on Base. Until 2026-09-25 the only way
// to buy one was an agent with its own x402 client. CDP's discovery list (the
// Bazaar) indexes a resource only after a payment settles through its
// facilitator, and every resource here validated clean while none was listed:
// nobody had a way to pay.
//
// This page is that buyer, for a person. Their wallet signs one USDC
// authorization for exactly the price the server's 402 names, and the same
// request returns the answer. Miorail signs nothing: the wallet signs, and the
// facilitator submits the transfer.
// ---------------------------------------------------------------------------

export const X402_INTELLIGENCE_BASE_V1 = '/api/x402/intelligence/v1';

export type PaidResourceIdV1 =
  | 'address_identity_check'
  | 'stock_representation_choice'
  | 'b20_exit_analysis'
  | 'b20_liquidity_evidence'
  | 'enhanced_route_proof';

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

/** NVIDIA on Base (Coinbase), the one stock every resource here has evidence for. */
export const PAID_API_EXAMPLE_TOKEN_V1 = '0xb20000000000000000000078ee7ce2fe4908108c';

const ADDRESS_V1 = /^0x[0-9a-fA-F]{40}$/;
// The server's own rules, mirrored so a malformed ask is stopped before it
// reaches the wallet. The server checks them again either way.
const UNDERLYING_KEY_V1 = /^[a-z0-9_]+:[a-z0-9_]+:.+$/;
const USDC_DECIMAL_V1 = /^\d{1,7}(?:\.\d{1,6})?$/;
const PUBLIC_ID_V1 = /^[0-9a-f]{48,}$/;
const LADDER_USDC_V1 = new Set(['100', '1000', '10000', '100000']);

function addressField(name: string, label: string): PaidFieldV1 {
  return {
    name,
    label,
    required: true,
    example: PAID_API_EXAMPLE_TOKEN_V1,
    hint: 'An exact Base contract address. A ticker cannot select a contract.',
    accepts: (value) => ADDRESS_V1.test(value),
    refusal: `${label} must be a 0x address of 40 hex characters.`,
  };
}

export const PAID_RESOURCES_V1: readonly PaidResourceV1[] = [
  {
    id: 'address_identity_check',
    title: 'Is this the real one?',
    question:
      'What a Base contract address is against the reviewed corpus: official standing and issuer, any lookalike it resembles, and who put it on chain.',
    path: '/address/identity',
    fields: [addressField('tokenAddress', 'Contract address')],
  },
  {
    id: 'stock_representation_choice',
    title: 'Which token is the stock?',
    question:
      'Every reviewed Base representation of one security, with issuer, supply, and which of them the reviewed routers actually took at an exact size.',
    path: '/stocks/representations',
    fields: [
      {
        name: 'underlyingKey',
        label: 'Security key',
        required: true,
        example: 'security:isin:US67066G1040',
        hint: 'security:isin: followed by the ISIN. US67066G1040 is NVIDIA.',
        accepts: (value) => UNDERLYING_KEY_V1.test(value) && value.length <= 200,
        refusal: 'The security key reads like security:isin:US67066G1040.',
      },
      {
        name: 'direction',
        label: 'Direction',
        required: false,
        example: 'buy',
        hint: 'buy or sell.',
        accepts: (value) => value === 'buy' || value === 'sell',
        refusal: 'Direction is buy or sell.',
      },
      {
        name: 'sizeUsdc',
        label: 'Size, USDC',
        required: false,
        example: '100',
        hint: 'A size the ladder measures: 100, 1000, 10000 or 100000.',
        accepts: (value) => LADDER_USDC_V1.has(value),
        refusal: 'Size is one of the measured sizes: 100, 1000, 10000 or 100000.',
      },
    ],
  },
  {
    id: 'b20_exit_analysis',
    title: 'Can a holder get out, and at what cost?',
    question:
      'Exit coverage for one B20 token from the latest stored Miorail observation, with a typed refusal where the market said no.',
    path: '/b20/exit-analysis',
    fields: [
      addressField('tokenAddress', 'Token address'),
      {
        name: 'positionUsdc',
        label: 'Position, USDC',
        required: false,
        example: '',
        hint: 'Optional. Only the exact size Miorail measured is comparable.',
        accepts: (value) => USDC_DECIMAL_V1.test(value) && Number(value) > 0,
        refusal: 'Position is a USDC amount above zero, up to six decimals.',
      },
    ],
  },
  {
    id: 'b20_liquidity_evidence',
    title: 'Where is the liquidity?',
    question:
      'Route sources, the capacity ladder, controls, hook and launch-window provenance for one B20 token.',
    path: '/b20/liquidity-evidence',
    fields: [addressField('tokenAddress', 'Token address')],
  },
  {
    id: 'enhanced_route_proof',
    title: 'Check a published trade proof',
    question:
      'A published Route Proof bundle, with its hashes, event chain and proof verified again by the server.',
    path: '/route-proofs/enhanced',
    fields: [
      {
        name: 'publicId',
        label: 'Proof id',
        required: true,
        example: '',
        hint: 'The id at the end of a miorail.xyz/proof/… link somebody published.',
        accepts: (value) => PUBLIC_ID_V1.test(value),
        refusal: 'The proof id is the long hex id at the end of a /proof/ link.',
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
    const raw = (values[field.name] ?? '').trim();
    const value = field.name === 'publicId' ? raw.toLowerCase() : raw;
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
