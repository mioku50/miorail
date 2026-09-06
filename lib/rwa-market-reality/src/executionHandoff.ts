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
  'size_not_measured',
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
     * anything is quoted.
     *
     * A SELL is "$1,000 worth", which is a token amount only once something
     * prices it. When this board HAS priced it, that token amount travels as
     * `observed_token_amount` — see `exactTokenAtomic` for why that is a size
     * and not a price. When nothing has priced it, nothing is carried and the
     * planner asks.
     */
    sizeBasis: z.enum([
      'exact_cash_in',
      'observed_token_amount',
      'cash_equivalent_requires_replan',
    ]),
    /**
     * The token quantity a SELL is for, when this board established one.
     *
     * This is the number the card was already showing: the exact amount tested
     * against the routers for the cash size on screen. It is carried BECAUSE
     * it is a size and not a price. Two different things were being conflated
     * before, and only one of them is unsafe to carry:
     *
     *   * The quote's OUTPUT — what those tokens fetch — is a price with a
     *     twenty-second life. It is never carried, and the advanced path
     *     re-establishes it against fresh routes.
     *   * The quote's INPUT — how many tokens the reader pointed at — is the
     *     question's size. A price that moves changes what the sale returns,
     *     which the re-plan shows before anything is signed; it does not
     *     change how many tokens the reader meant.
     *
     * Refusing to carry it made the planner ask "what exact amount should be
     * swapped?" — a question this screen had already answered, put to a reader
     * who has no way to convert dollars into tokens by hand. Null when nothing
     * priced this representation, and then the question is the honest outcome.
     */
    exactTokenAtomic: Digits.nullable().default(null),
    /** Decimals for `exactTokenAtomic`. Travels with it: an atomic amount with
     * no scale is not an amount. */
    tokenDecimals: z.number().int().min(0).max(36).nullable().default(null),
    /** When that amount was established. A size does not expire the way a
     * price does, but the reader is still owed its age. */
    sizeObservedAt: Timestamp.nullable().default(null),
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
    if (row.direction === 'buy' && row.exactTokenAtomic !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['exactTokenAtomic'],
        message: 'a BUY is sized in cash, so it carries no token amount',
      });
    }
    if (
      row.direction === 'sell' &&
      row.sizeBasis !== (row.exactTokenAtomic === null ? 'cash_equivalent_requires_replan' : 'observed_token_amount')
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['sizeBasis'],
        message:
          'a SELL is sized by the token amount this board established, or by nothing at all — the basis must say which',
      });
    }
    // An amount, its scale and its age are one fact. Any one of them alone
    // would let a surface print a number with no scale, or a scale with no
    // number, or an amount whose age nobody can state.
    const sizeParts = [row.exactTokenAtomic, row.tokenDecimals, row.sizeObservedAt];
    if (sizeParts.some((part) => part === null) && sizeParts.some((part) => part !== null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['exactTokenAtomic'],
        message: 'a carried token amount travels with its decimals and the instant it was established',
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
  size_not_measured:
    'A reviewed router policy exists for this representation, but nobody has measured this exact size yet, so there are no approved sources to carry. The ladder measures four fixed sizes ($100, $1k, $10k, $100k) on a schedule; any other size is measured on demand. Measure this exact size and direction, then ask again.',
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

  // Two different situations used to answer with ONE word, and the word named
  // the thing that was fine. A policy IS established here — the hash is right
  // there on the row — and what is missing is a measurement AT THIS SIZE.
  //
  // 2026-09-06: an assistant asked to sell a holding worth about $0.09, got
  // `route_policy_not_established`, and reported to its user that Miorail has
  // no reviewed route policy for selling tokenized stocks. It read the word
  // and drew the only conclusion the word supports. The refusal is
  // direction-blind — a BUY at the same size refuses identically — and the
  // remedy it never mentioned is one call away: measure this exact size.
  const approvedSources = [
    ...new Set(representation.sources.map((row) => row.source)),
  ].sort();
  if (approvedSources.length === 0) return refuseV1('size_not_measured');

  const direction = input.direction ?? response.question.direction;
  // The token quantity this board established for the cash size on screen.
  // Whichever side the board measured, the number means the same thing: how
  // many tokens the reader's dollar figure comes to. On a BUY board it is what
  // the cash buys; on a SELL board it is what was tested to return the cash.
  // Only a SELL needs it — a BUY already knows its size in USDC atoms.
  const tokenDecimals = representation.supply.decimals;
  const carriedTokenAtomic =
    direction === 'sell' &&
    representation.exactTestedTokenAtomic !== null &&
    tokenDecimals !== null &&
    representation.observedAt !== null &&
    BigInt(representation.exactTestedTokenAtomic) > 0n
      ? representation.exactTestedTokenAtomic
      : null;
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
      // quotes it. A SELL is sized by the token amount this board established,
      // when it established one — the price it fetches is re-established by
      // the advanced path and is never carried from here.
      sizeBasis:
        direction === 'buy'
          ? 'exact_cash_in'
          : carriedTokenAtomic === null
            ? 'cash_equivalent_requires_replan'
            : 'observed_token_amount',
      exactTokenAtomic: carriedTokenAtomic,
      tokenDecimals: carriedTokenAtomic === null ? null : tokenDecimals,
      sizeObservedAt: carriedTokenAtomic === null ? null : representation.observedAt,
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
 * A SELL carries the token amount this board established for the cash size on
 * screen, when it established one. That is the question's SIZE, not its price:
 * what those tokens fetch is re-established against fresh routes and never
 * taken from here. Leaving it out made the planner ask "what exact amount
 * should be swapped?" — a question this screen had already answered, put to a
 * reader with no way to convert dollars into tokens by hand.
 *
 * A SELL of a representation nothing has priced still carries no amount, and
 * the planner asking is then the honest outcome rather than a gap.
 */
export function stockExecutionGoalSentenceV1(handoff: StockExecutionHandoffV1): string {
  const parsed = StockExecutionHandoffV1Schema.parse(handoff);
  if (parsed.direction === 'buy') {
    return `Swap ${usdLabelV1(parsed.requestedCashAtomic)} ${parsed.cashAddress} to ${parsed.tokenAddress} on Base`;
  }
  const amount = tokenLabelV1(parsed.exactTokenAtomic, parsed.tokenDecimals);
  return amount === null
    ? `Swap ${parsed.tokenAddress} to ${parsed.cashAddress} on Base`
    : `Swap ${amount} ${parsed.tokenAddress} to ${parsed.cashAddress} on Base`;
}

/** What the reader is told about the size before they plan. Reader copy, so the
 * SELL case names where its number came from rather than presenting a carried
 * amount as something freshly true. */
export function stockExecutionSizeNoteV1(handoff: StockExecutionHandoffV1): string {
  const parsed = StockExecutionHandoffV1Schema.parse(handoff);
  return stockSizeNoteV1({
    direction: parsed.direction,
    requestedCashAtomic: parsed.requestedCashAtomic,
    exactTokenAtomic: parsed.exactTokenAtomic,
    tokenDecimals: parsed.tokenDecimals,
  });
}

/**
 * The same sentence, from the parts a screen already holds.
 *
 * The Stocks card says this BEFORE the button is pressed and the prepare step
 * says it after, and a sentence about what a sale is sized by is exactly the
 * kind that drifts when it is written out twice.
 */
export function stockSizeNoteV1(input: {
  direction: 'buy' | 'sell';
  requestedCashAtomic: string;
  exactTokenAtomic?: string | null;
  tokenDecimals?: number | null;
}): string {
  const usd = usdLabelV1(input.requestedCashAtomic);
  if (input.direction === 'buy') {
    return `Spending exactly $${usd} of USDC. That amount is exact before anything is quoted.`;
  }
  const amount = tokenLabelV1(input.exactTokenAtomic ?? null, input.tokenDecimals ?? null);
  return amount === null
    ? `Nothing has priced this representation at $${usd}, so there is no token amount to sell yet. The prepare step asks for one.`
    : `Selling ${amount} tokens — the amount $${usd} came to when this was last measured. What that fetches is priced again on fresh routes; the amount is what you chose.`;
}

/** An atomic amount as a decimal string, or null when either half is missing.
 * Exact — never rounded, because a rounded size is a different size. */
export function tokenLabelV1(atomic: string | null, decimals: number | null): string | null {
  if (atomic === null || decimals === null) return null;
  if (decimals === 0) return atomic;
  const scale = 10n ** BigInt(decimals);
  const value = BigInt(atomic);
  const whole = value / scale;
  const fraction = (value % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
  return fraction === '' ? whole.toString() : `${whole}.${fraction}`;
}

// ---------------------------------------------------------------------------
// Phase 17.5 — who issued this, said where the action starts.
//
// This constant lives beside the handoff rather than in the console because
// three surfaces now say it — the Stocks card, the review page, and the API's
// own review response — and a sentence about who issued a security is exactly
// the kind that drifts when it is written out three times.
//
// It states two facts and claims nothing beyond them. Base did not issue these
// and neither did Miorail; the issuer restricts who may hold them. Stating a
// restriction is NOT enforcing one, and the wording is careful not to let a
// reader infer that pressing a button means somebody checked their eligibility.
// What Miorail does enforce is narrower and is said in its own words: the
// token's own onchain policy for that exact wallet, one step later.
// ---------------------------------------------------------------------------
export const STOCK_ISSUER_NOTICE_V1 =
  'Tokenized stocks on Base are issued by Coinbase, not by Base and not by Miorail, and the issuer makes them available only to eligible users outside the United States. Miorail measures the market and states the token’s own rules; it does not decide eligibility, and nothing here is an offer or a recommendation.';
