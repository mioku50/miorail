import { z } from 'zod';

import {
  MarketRealityResponseV2Schema,
  type MarketRealityResponseV2,
} from './contracts.js';

// ---------------------------------------------------------------------------
// Phase 13.1 — the boundary between Stocks and advanced execution.
//
// Stocks answers "what does the market do at my size". Execution is a separate,
// optional capability, and this module is the ONLY thing that may carry one
// exact reviewed representation across that line.
//
// Three properties it exists to hold:
//
//   * The selector is an exact Base address. A ticker names a security, and a
//     security has several representations on Base with different structures
//     and different markets. `NVDA` cannot choose between the Coinbase B20
//     asset, the Backed rebasing token and the Backed wrapper, so it must never
//     be handed to anything that resolves assets. Nothing here accepts one.
//
//   * A handoff is an intent to LOOK. It carries no calldata, no approval, no
//     transaction and no signer request, and it says so in literals the schema
//     enforces rather than in a comment.
//
//   * A router quote is not executable state. Market Reality evidence expires
//     in about twenty seconds; the advanced path re-plans through the reviewed
//     route stack and the freshness carried here exists to say what the reader
//     is looking at, never to be spent as a route.
// ---------------------------------------------------------------------------

const Address = z.string().regex(/^0x[0-9a-f]{40}$/);
const Hash = z.string().regex(/^0x[0-9a-f]{64}$/);
const Digits = z.string().regex(/^[1-9][0-9]*$/);
const Timestamp = z.string().datetime();

/** Base USDC. The cash side of every reviewed Market Reality question. */
export const HANDOFF_CASH_ADDRESS_V1 = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' as const;

export const STOCK_EXECUTION_HANDOFF_REFUSALS_V1 = [
  'representation_not_reviewed',
  'zero_supply_representation',
  'supply_not_established',
  'route_policy_not_established',
  'destination_not_supported',
] as const;
export type StockExecutionHandoffRefusalV1 =
  (typeof STOCK_EXECUTION_HANDOFF_REFUSALS_V1)[number];

/**
 * Everything advanced execution is allowed to know about a Stocks card.
 *
 * `evidenceState` describes the Market Reality quote the reader was looking at
 * — nothing more. `stale` and `absent` are perfectly valid states to hand off
 * in: the advanced path plans fresh either way, and hiding the button until a
 * quote happens to be open would make freshness look like permission.
 */
export const StockExecutionHandoffV1Schema = z
  .object({
    schemaVersion: z.literal('stock-execution-handoff/v1'),
    /** An intent to inspect a route. Never an intent to execute one. */
    intent: z.literal('inspect_route'),
    chainId: z.literal(8453),
    tokenAddress: Address,
    caip10: z.string().regex(/^eip155:8453:0x[0-9a-f]{40}$/),
    underlyingKey: z
      .string()
      .regex(/^[a-z0-9_]+:[a-z0-9_]+:.+$/)
      .max(200),
    issuerId: z.enum(['coinbase', 'dinari', 'backed']),
    issuerInstrumentKey: z.string().min(1).max(200),
    representationKind: z.enum(['b20_asset', 'rebasing_erc20', 'non_rebasing_erc4626_wrapper', 'dinari_dshare']),
    direction: z.enum(['buy', 'sell']),
    requestedCashAtomic: Digits,
    cashAddress: z.literal(HANDOFF_CASH_ADDRESS_V1),
    destination: z.literal('USDC'),
    routePolicyKey: Hash,
    approvedSources: z.array(z.string().min(1).max(100)).min(1).max(16),
    /** What the reader was looking at, said plainly. Never a permission. */
    evidenceState: z.enum(['fresh_quote', 'expired_quote', 'no_quote']),
    quoteExpiresAt: Timestamp.nullable(),
    /**
     * Whether the advanced path can size this question without pricing it.
     *
     * A BUY spends an exact number of USDC atoms, so the size is exact before
     * anything is quoted. A SELL is "$1,000 worth", which is a token amount
     * only once something prices it — and the thing that priced it here has
     * expired. Carrying the tested amount forward would be spending an expired
     * quote as executable state, so it is not carried at all.
     */
    sizeBasis: z.enum(['exact_cash_in', 'cash_equivalent_requires_replan']),
    /** Literals, so a reader of the payload can check them rather than trust
     * a description of them. */
    createsApproval: z.literal(false),
    createsCalldata: z.literal(false),
    createsTransaction: z.literal(false),
    quoteIsExecutionEvidence: z.literal(false),
  })
  .strict()
  .superRefine((row, ctx) => {
    if (!row.caip10.endsWith(row.tokenAddress)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['caip10'],
        message: 'CAIP-10 must name this exact Base address',
      });
    }
    if ((row.evidenceState === 'no_quote') !== (row.quoteExpiresAt === null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['quoteExpiresAt'],
        message: 'a quote state travels with its expiry, and no quote has none',
      });
    }
    if (row.direction === 'buy' && row.sizeBasis !== 'exact_cash_in') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['sizeBasis'],
        message: 'a BUY spends an exact cash amount',
      });
    }
    if (row.direction === 'sell' && row.sizeBasis !== 'cash_equivalent_requires_replan') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['sizeBasis'],
        message: 'a SELL of "cash worth" has no exact token amount until something prices it',
      });
    }
  });
export type StockExecutionHandoffV1 = z.infer<typeof StockExecutionHandoffV1Schema>;

export type StockExecutionHandoffResultV1 =
  | { status: 'ready'; handoff: StockExecutionHandoffV1 }
  | { status: 'refused'; reason: StockExecutionHandoffRefusalV1; detail: string };

const REFUSAL_DETAIL_V1: Readonly<Record<StockExecutionHandoffRefusalV1, string>> = {
  representation_not_reviewed:
    'That exact address is not one of the reviewed representations in this answer. Miorail did not substitute another one.',
  zero_supply_representation:
    'No outstanding supply was observed for this exact representation. Advanced execution stays on the address you chose, so it will not be pointed at a different one.',
  supply_not_established:
    'Supply for this exact representation could not be established, so Miorail cannot say there is anything to route.',
  route_policy_not_established:
    'No reviewed router policy has been recorded for this exact representation, so there is nothing to carry into a route.',
  destination_not_supported:
    'Advanced execution is carried for the reviewed USDC cash question only.',
};

function refuseV1(reason: StockExecutionHandoffRefusalV1): StockExecutionHandoffResultV1 {
  return { status: 'refused', reason, detail: REFUSAL_DETAIL_V1[reason] };
}

/**
 * Build the handoff for ONE exact address out of a Market Reality answer.
 *
 * The address is the only selector. It is matched against the reviewed
 * representations already in the response, so a caller cannot hand across an
 * address the reader was never shown, and a zero-supply representation refuses
 * rather than resolving to whatever it wraps.
 */
export function stockExecutionHandoffV1(input: {
  response: MarketRealityResponseV2;
  tokenAddress: string;
  now: Date;
  /**
   * Which side to prepare, when the reader asked for one directly.
   *
   * Phase 17.4. The card used to carry a single `Advanced: inspect route`
   * button, and the direction came from the page's own Sell/Buy toggle — so a
   * reader who wanted to buy had to first change the QUESTION the whole board
   * was answering, which silently re-measured every other representation.
   *
   * `Prepare buy` and `Prepare sell` name a side without touching the board.
   * The size is unchanged: it is the cash amount already on screen, and the
   * refusals below are unchanged too — naming a side is not permission to
   * execute one.
   */
  direction?: 'buy' | 'sell';
}): StockExecutionHandoffResultV1 {
  const response = MarketRealityResponseV2Schema.parse(input.response);
  const tokenAddress = input.tokenAddress.trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(tokenAddress)) return refuseV1('representation_not_reviewed');

  const representation = response.representations.find((row) => row.tokenAddress === tokenAddress);
  if (!representation) return refuseV1('representation_not_reviewed');
  if (response.question.destination !== 'USDC') return refuseV1('destination_not_supported');
  if (representation.supply.state === 'zero_supply') return refuseV1('zero_supply_representation');
  if (representation.supply.state !== 'positive_supply') return refuseV1('supply_not_established');
  if (representation.routePolicyKey === null) return refuseV1('route_policy_not_established');

  const approvedSources = [
    ...new Set(representation.sources.map((row) => row.source)),
  ].sort();
  if (approvedSources.length === 0) return refuseV1('route_policy_not_established');

  const direction = input.direction ?? response.question.direction;
  const expiresAt = representation.expiresAt;
  const evidenceState =
    expiresAt === null
      ? ('no_quote' as const)
      : Date.parse(expiresAt) > input.now.getTime()
        ? ('fresh_quote' as const)
        : ('expired_quote' as const);

  return {
    status: 'ready',
    handoff: StockExecutionHandoffV1Schema.parse({
      schemaVersion: 'stock-execution-handoff/v1',
      intent: 'inspect_route',
      chainId: 8453,
      tokenAddress,
      caip10: `eip155:8453:${tokenAddress}`,
      underlyingKey: response.question.underlyingKey,
      issuerId: representation.issuerId,
      issuerInstrumentKey: representation.issuerInstrumentKey,
      representationKind: representation.representationKind,
      direction,
      requestedCashAtomic: response.question.requestedCashAtomic,
      cashAddress: HANDOFF_CASH_ADDRESS_V1,
      destination: 'USDC',
      routePolicyKey: representation.routePolicyKey,
      approvedSources,
      evidenceState,
      quoteExpiresAt: expiresAt,
      // Follows the direction actually being prepared, never the board's. A
      // BUY spends an exact number of USDC atoms and is sized before anything
      // quotes it; a SELL of "cash worth" has no token amount until something
      // prices it, and the thing that priced it here expires in seconds.
      sizeBasis: direction === 'buy' ? 'exact_cash_in' : 'cash_equivalent_requires_replan',
      createsApproval: false,
      createsCalldata: false,
      createsTransaction: false,
      quoteIsExecutionEvidence: false,
    }),
  };
}

function usdLabelV1(atomic: string): string {
  const whole = BigInt(atomic) / 1_000_000n;
  const fraction = BigInt(atomic) % 1_000_000n;
  return fraction === 0n
    ? whole.toString()
    : `${whole}.${fraction.toString().padStart(6, '0').replace(/0+$/, '')}`;
}

/**
 * The sentence the reviewed planner is given.
 *
 * Addresses only. No ticker, no symbol, no company name — the planner reads a
 * user's own words, and an address in them is the one way a token enters an
 * intent by name. Putting `NVDA` in this string would hand the resolver exactly
 * the ambiguity this phase exists to remove.
 *
 * A BUY carries its amount, because a BUY spends an exact number of USDC atoms
 * and that is true before anything is quoted.
 *
 * A SELL carries NO amount. "$1,000 worth" is a token quantity only once
 * something prices it, and the thing that priced it on the Stocks card has a
 * twenty-second life. Writing the tested amount into this sentence would spend
 * an expired quote as executable state. The planner asking how much to sell is
 * the correct outcome, not a gap to paper over.
 */
export function stockExecutionGoalSentenceV1(handoff: StockExecutionHandoffV1): string {
  const parsed = StockExecutionHandoffV1Schema.parse(handoff);
  if (parsed.direction === 'buy') {
    return `Swap ${usdLabelV1(parsed.requestedCashAtomic)} ${parsed.cashAddress} to ${parsed.tokenAddress} on Base`;
  }
  return `Swap ${parsed.tokenAddress} to ${parsed.cashAddress} on Base`;
}

/** What the reader is told about the size before they plan. Reader copy, so the
 * SELL case names the reason rather than leaving an amount silently missing. */
export function stockExecutionSizeNoteV1(handoff: StockExecutionHandoffV1): string {
  const parsed = StockExecutionHandoffV1Schema.parse(handoff);
  const usd = usdLabelV1(parsed.requestedCashAtomic);
  return parsed.direction === 'buy'
    ? `Spending exactly $${usd} of USDC. That amount is exact before anything is quoted.`
    : `You were looking at $${usd} worth. A sale needs a token amount, and the quote that converted one has expired — the route step establishes it fresh.`;
}
