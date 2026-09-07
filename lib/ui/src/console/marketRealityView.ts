import { REPRESENTATION_STRUCTURE_ADAPTERS_V1 } from '@mioagent/rwa-issuer/structureAdapters';
import {
  representationUtilityMapV1,
  type RepresentationUtilityEdgeV1,
  type UtilityEvidenceStateV1,
} from '@mioagent/rwa-issuer/utilityMap';
import {
  establishedDefiUsesV1,
  type DefiUseKindV1,
  type RepresentationUseAccessV1,
} from '@mioagent/rwa-issuer/useAccess';
import {
  venueAnnouncementReadingsV1,
  type VenueAnnouncementReadingV1,
} from '@mioagent/rwa-issuer/venueAnnouncements';

import { stockSizeNoteV1 } from '@mioagent/rwa-market-reality/execution-handoff';

import { formatAtomicAmount } from '../formatAtomicAmount';
// One vocabulary across the RWA surfaces. A second FactViewV1 with the same
// four fields would let the two views drift into different meanings for the
// same word, which is exactly what the shared section table exists to stop.
import {
  ROUND_TRIP_ACCEPTABLE_MAX_BPS_V1,
  ROUND_TRIP_SEVERE_MIN_BPS_V1,
  rwaBpsLabelV1,
} from './rwaDiscoverView';
import type { FactViewV1, ToneV1 } from './rwaDiscoverView';

export type { FactViewV1, ToneV1 };

// ---------------------------------------------------------------------------
// Phase 10B — one security, every reviewed way to hold it on Base.
//
// This is the surface the whole RWA vertical was built toward: a reader picks
// a company and a size, and sees what each issuer's representation actually
// does at that size — not a price feed, not a marketing page, not a ranking.
//
// THE THING THIS SCREEN MUST NEVER DO
//
// Show a winner. Phase 10B.8 withholds ranking even when numeric coverage is
// complete; categorical coverage and numeric comparability are both visible,
// but neither emits BEST in this phase.
//
// THE SPLIT THE BACKEND CANNOT MAKE AND THIS FILE CAN
//
// A router quote is good for about twenty seconds. The measurement worker runs
// on a timer measured in tens of minutes. So by the time anybody opens this
// page, a quote that was taken perfectly is expired, and the engine — correctly
// — reports `not_measured` for it.
//
// `not_measured` is then doing two jobs that mean opposite things to a reader:
//
//   "we had a price for this and it aged out"     -> come back / re-measure
//   "this size was never asked about this token"  -> nothing exists yet
//
// The evidence to tell them apart is already in the payload: a lapsed row
// carries `quoteEvidence` with an `expiresAt` in the past. So this module
// splits them, and the screen says which one it is. That is the difference
// between a page that looks broken and a page that is honest.
//
// ROUTE OUTCOMES, AND WHOSE FACT EACH ONE IS
//
//   priced          a live quote at the exact size          the market
//   lapsed          we had one; router quotes live ~20s     time
//   no_route        no route under the reviewed policy      the market, scoped
//   provider_failed our router call did not complete        us
//   never_measured  this size was never asked               us
//
// Supply adds two separate onchain-read states before these route outcomes:
// zero supply and supply unknown. Collapsing any of them into "no data" would
// let a reader conclude the token is untradeable when the truth may only be
// that our timer has not come round or the RPC read failed.
// ---------------------------------------------------------------------------

export const MARKET_REALITY_SCOPE_V1 =
  'Measured on Base only. Quotes are router quotes at an exact size — never a promise of execution.';

export const MARKET_REALITY_DIRECTIONS_V1 = ['sell', 'buy'] as const;
export type MarketRealityDirectionV1 = (typeof MARKET_REALITY_DIRECTIONS_V1)[number];

/**
 * The sizes the ladder is actually measured at.
 *
 * Not a free text field: the engine answers an EXACT size and refuses anything
 * else, so a size nobody measures returns an empty answer that reads as a
 * broken product. These four are the public ladder's rungs.
 */
export const MARKET_REALITY_SIZES_V1 = [
  { label: '$100', requestedCashAtomic: '100000000' },
  { label: '$1k', requestedCashAtomic: '1000000000' },
  { label: '$10k', requestedCashAtomic: '10000000000' },
  { label: '$100k', requestedCashAtomic: '100000000000' },
] as const;

// ---------------------------------------------------------------------------
// Wire shapes.
//
// Declared structurally rather than imported, for the same reason the Discover
// view declares its own: this package compiles into the Base App bundle at a
// target where the schema package's dependencies do not belong. The host passes
// the parsed response straight in, so a field that changes shape fails to
// compile at the call site rather than rendering blank.
// ---------------------------------------------------------------------------

export type IssuerIdV1 = 'coinbase' | 'dinari' | 'backed';
export type RepresentationKindV1 =
  | 'b20_asset'
  | 'rebasing_erc20'
  | 'non_rebasing_erc4626_wrapper'
  | 'dinari_dshare';

export interface MarketRealityIndexEntryWireV1 {
  underlyingKey: string;
  canonicalName: string;
  displaySymbol: string | null;
  assetClass: 'equity' | 'fund_share' | 'other' | 'unknown';
  identifierScheme: string | null;
  identifierValue: string | null;
  representationCount: number;
  liveRepresentationCount: number;
  issuerIds: readonly IssuerIdV1[];
  multiIssuer: boolean;
}

export interface MarketRealityIndexWireV1 {
  scope?: 'coinbase_b20' | 'all_representations';
  entries: readonly MarketRealityIndexEntryWireV1[];
  totals: {
    underlyings: number;
    boundRepresentations: number;
    multiIssuerUnderlyings: number;
    coinbaseUnderlyings?: number;
    allUnderlyings?: number;
  };
  observedAt: string;
}

export interface MarketRealityQuoteWireV1 {
  source: string;
  direction: MarketRealityDirectionV1;
  inputAtomic: string;
  outputAtomic: string;
  observedAt: string;
  expiresAt: string;
  evidenceHash: string;
  blockNumber: string | null;
  /** `eip155:8453/<protocol>:<pool address>`, as the router named the route.
   * Optional because payloads assembled before Phase 17.3 carry none. */
  liquiditySources?: readonly string[];
}

export interface MarketRealitySourceWireV1 {
  source: string;
  status: 'quoted' | 'no_route' | 'unsized' | 'measurement_failed' | 'not_measured';
  errorCode: string | null;
  quoteEvidence: MarketRealityQuoteWireV1 | null;
}

export interface MarketRealityRepresentationWireV1 {
  tokenAddress: string;
  issuerId: IssuerIdV1;
  issuerInstrumentKey: string;
  representationKind: RepresentationKindV1;
  supply: {
    state: 'positive_supply' | 'zero_supply' | 'supply_unknown';
    totalSupplyAtomic: string | null;
    decimals: number | null;
    blockNumber: string | null;
    blockHash: string | null;
    observedAt: string | null;
    evidenceHash: string | null;
    readOutcome: 'success' | 'rpc_failure' | 'decode_failure' | 'not_observed';
    fresh: boolean;
    reason: string | null;
  };
  status: 'full' | 'unavailable' | 'not_measured' | 'measurement_failed';
  routePolicyKey: string | null;
  exactTestedTokenAtomic: string | null;
  normalizedExposureAtomic: string | null;
  normalizedExposureDecimals: number | null;
  normalization: 'fresh_ratio_applied' | 'reviewed_token_already_applied' | 'not_established';
  /** The multiplier's own clock. Declared here because the screen ages four
   * independent things and could previously only age two of them. */
  normalizationCheckedAt?: string | null;
  normalizationExpiresAt?: string | null;
  returnedCashAtomic: string | null;
  effectivePriceAtomic: string | null;
  effectivePriceDecimals: number | null;
  premiumDiscountBps: string | null;
  reference: {
    status: 'fresh' | 'stale' | 'paused' | 'unavailable' | 'unknown';
    session:
      | 'regular_hours'
      | 'after_hours'
      | 'weekend'
      | 'reference_holding_last_close'
      | 'corporate_action_hold'
      | 'stale'
      | 'unknown';
    marketSession: 'regular_hours' | 'after_hours' | 'weekend' | 'unknown';
    publicationMode:
      | 'live_reference'
      | 'holding_last_close'
      | 'corporate_action_hold'
      | 'stale'
      | 'unknown';
    valueAtomic: string | null;
    decimals: number | null;
    comparable: boolean;
    reason: string | null;
    /** When the feed itself last published, and when WE last looked. Both have
     * always been on the wire and neither was declared, so the card could say
     * what the reference session was and never when that was true. They are two
     * different clocks and are never merged: a feed that stopped publishing an
     * hour ago is still read every minute. */
    referenceUpdatedAt?: string | null;
    observedAt?: string | null;
  };
  basis: {
    status: 'comparable' | 'withheld';
    kind: 'current_reference' | 'last_close_reference' | 'withheld';
    premiumDiscountBps: string | null;
    reason: string;
  };
  sources: readonly MarketRealitySourceWireV1[];
  observedAt: string | null;
  expiresAt: string | null;
  liveness: 'live' | 'history_only' | 'never_measured';
  /** History, never a current price. The engine keeps it in its own field so a
   * surface cannot render it as one by forgetting to check a freshness flag. */
  lastObservation: {
    source: string;
    status: 'quoted' | 'no_route' | 'unsized' | 'measurement_failed';
    errorCode: string | null;
    observedAt: string;
    expiresAt: string;
    returnedCashAtomic: string | null;
    open: boolean;
  } | null;
}

export interface MarketRealityWireV1 {
  question: {
    underlyingKey: string;
    direction: MarketRealityDirectionV1;
    requestedCashAtomic: string;
    cashDecimals: number;
    destination: 'USDC' | 'ETH';
  };
  universe: {
    reviewedRepresentationCount: number;
    positiveSupplyRepresentationCount: number;
    zeroSupplyRepresentationCount: number;
    unresolvedSupplyRepresentationCount: number;
  };
  marketOutcomeCoverage: {
    eligibleRepresentationCount: number;
    establishedOutcomeCount: number;
    status: 'complete' | 'incomplete';
    reason: string | null;
  };
  numericComparisonCoverage: {
    eligibleRepresentationCount: number;
    pricedRepresentationCount: number;
    status: 'complete' | 'incomplete';
    reason: string | null;
  };
  ranking: {
    status: 'withheld';
    orderedTokenAddresses: readonly string[];
    reason: string | null;
  };
  representations: readonly MarketRealityRepresentationWireV1[];
  assembledAt: string;
}

// ---------------------------------------------------------------------------
// View shapes.
// ---------------------------------------------------------------------------

export const MARKET_REALITY_OUTCOMES_V1 = [
  'zero_supply',
  'supply_unknown',
  'priced',
  'lapsed',
  'stale_finding',
  'no_route',
  'unsupported_token',
  // A route source that covers this token and declined to quote it, on its
  // own trading rules. Its own outcome because the three it would otherwise
  // fall into each name the wrong party: the market, our coverage, our
  // transport. See `PROVIDER_POLICY_REFUSED_CODE_V1` in swap-adapters.
  'policy_refused',
  'unsized',
  'provider_failed',
  'never_measured',
] as const;
export type MarketRealityOutcomeV1 = (typeof MARKET_REALITY_OUTCOMES_V1)[number];

export interface UnderlyingChoiceViewV1 {
  underlyingKey: string;
  /** What a reader calls it. Never the key. */
  title: string;
  /** The stable identifier, spelled out — `ISIN US67066G1040`. */
  identifier: string | null;
  /** "Coinbase · Backed" or "Backed only". */
  issuerLine: string;
  issuerIds: readonly IssuerIdV1[];
  representationCount: number;
  multiIssuer: boolean;
  /**
   * Said out loud when nothing behind this security has any tokens outstanding.
   *
   * Null when at least one representation is live. Ordering already puts these
   * rows last; the line is what stops a reader opening one and concluding the
   * product is broken when the honest answer is that the contract is empty.
   */
  emptyNote: string | null;
}

export interface UtilitySourceViewV1 {
  label: string;
  href: string | null;
  checkedAt: string;
}

export interface UtilityEdgeViewV1 {
  edgeId:
    | RepresentationUtilityEdgeV1['edgeId']
    | 'defi_reviewed_integrations'
    | 'issuer_primary_market'
    | 'issuer_value_lifecycle';
  label: string;
  state: UtilityEvidenceStateV1;
  stateLabel: string;
  /** The exact instant, kept for the tooltip and for evidence. */
  checkedAt: string;
  /** The same instant as an age. A reader works out nothing from an ISO string
   * in a timezone they have to convert, and every other surface in the product
   * already says "9m ago". */
  checkedAgo: string | null;
  providerLabel: string | null;
  note: string;
  eligibilityNote: string;
  sources: UtilitySourceViewV1[];
}

export interface UtilityGroupViewV1 {
  label: string;
  edges: UtilityEdgeViewV1[];
}

export interface RepresentationViewV1 {
  /** The four independent clocks on this card, shortest-lived first. Always
   * four: a clock that has never run is a state, not an absent caption. */
  clocks: ClockCaptionV1[];
  /** The issuer's own restrictions, on the card rather than behind Terms.
   * Never a statement about this wallet. */
  accessNotices: AccessNoticeViewV1[];
  /**
   * What size the prepare step will be working with, said before it is pressed.
   *
   * A BUY spends an exact number of USDC atoms and there is no surprise to
   * warn about; only the SELL side gets a line, because a sale is sized in
   * TOKENS and the reader is looking at dollars. Null when the board is not
   * asking a sell question — the note belongs to the action, not the card.
   */
  prepareSellSizeNote: string | null;
  /** History, labelled as history. Null when nobody has ever measured. */
  lastSeen: { label: string; value: string; note: string } | null;
  tokenAddress: string;
  /** The issuer id, kept beside the name because issuer-scoped evidence — a
   * reviewed structure adapter, an announcement about one issuer's tokens —
   * must never be shown on another issuer's card. */
  issuerId: IssuerIdV1;
  /** The issuer, as a person says it. */
  issuerName: string;
  /** What kind of instrument this is, in one phrase. */
  structureLabel: string;
  /** The reviewed structure note — the issuer's own claim model. */
  structureNote: string;
  outcome: MarketRealityOutcomeV1;
  /** The headline chip: two or three words. */
  outcomeChip: string;
  /** One sentence a reader can act on. */
  outcomeBody: string;
  outcomeTone: ToneV1;
  /** Whose fact the outcome is. Rendered as a small label so a reader can tell
   * a fact about the asset from a fact about us at a glance. */
  attribution: 'the market' | 'the clock' | 'Miorail' | 'onchain read' | 'the venue';
  /** Phase 12.2. A watch is one exact reviewed market question. These fields
   * are projected from the server response, never reconstructed from labels. */
  watchable: boolean;
  watchUnavailableReason: string | null;
  routePolicyKey: string | null;
  approvedSources: readonly string[];
  /**
   * The narrow strip: what is true ONLY while a router quote is open.
   *
   * A quote lives about twenty seconds and the background sampler runs about
   * every forty-five minutes, so for almost every reader this is empty — which
   * is why it is a strip and not the card. Giving the body to fields that can
   * only be filled in a twenty-second window is how a card measured minutes
   * ago rendered as four dashes.
   *
   * The strip states NOW and nothing else. Why a quote expires is said once for
   * the whole board, not repeated on every card — three cards each explaining
   * the twenty-second window taught a reader the window three times and the
   * state zero times.
   */
  /**
   * Null when there is nothing outstanding to quote. "No live quote" over a
   * contract whose entire subject is that its supply is zero is not a finding —
   * it invites the reader to conclude the market refused, when there is no
   * position for a market to refuse.
   */
  openQuote: OpenQuoteViewV1 | null;
  /**
   * When the last completed measurement happened, in one phrase.
   *
   * The other half of the split: the strip above says what is true now, this
   * says what was true and when. A reader deciding whether to press Measure
   * needs both, apart, in that order.
   */
  lastMeasuredLabel: string | null;
  /**
   * Whether the money comes back — the one fact a quote alone never carried.
   *
   * Null when nothing has measured a round trip here, which is most
   * representations: a round trip needs both legs, and a size whose buy found
   * no route never had a sell to price.
   */
  exit: FactViewV1 | null;
  /**
   * Which measurement `exit` came from — the open quote, or the stored run.
   *
   * The card must be able to say LAST MEASURED over a durable answer, because
   * the whole point of keeping it is that it is still there twenty seconds
   * after the live quote is gone.
   */
  exitBasis: 'open' | 'last_measured' | null;
  /**
   * What the round trip COST, graded — the second axis of the card.
   *
   * `outcomeChip` says whether an answer exists; this says whether the answer
   * is worth anything. They were one chip, and the one chip was green whenever
   * a router answered, so a representation that returns $0.94 on $1,000 wore
   * the same colour as one that returns $999.72.
   *
   * Null when no round trip was measured. An absence is never graded.
   */
  exitCost: ExitCostViewV1 | null;
  /**
   * Where the priced answer went through — the venue, not the aggregator.
   *
   * Null when nothing priced this representation or the router named no pool.
   */
  routedThrough: RoutedThroughViewV1 | null;
  /**
   * Whether this representation belongs in the primary comparison.
   *
   * False for zero-supply: the card stays visible with its one fact, out of the
   * area where representations are read against each other. Not a ranking --
   * there is no order here, only membership.
   */
  inComparison: boolean;
  /**
   * The body: the newest measurement, with its age said out loud.
   *
   * History, and never disguised as a live price — every row that came from a
   * closed observation carries its age in the note, which is the same contract
   * Discover renders under.
   */
  numbers: FactViewV1[];
  /**
   * The same grid's rows that have no value, WITHOUT the dash.
   *
   * A row reading `Effective price  —  the share ratio isn't confirmed` spends
   * a full line of the card on a character that means nothing, and four of them
   * stacked read as a broken card rather than as four different absences. The
   * reasons are kept — they are the honest part — but they leave the value grid
   * and become one compact block, and every one of them is still stated in full
   * under Technical evidence.
   */
  withheld: WithheldFactViewV1[];
  /**
   * The ONE thing that was not established, when nothing in the grid was.
   *
   * Four withheld rows are four CONSEQUENCES of a single cause: a cash-worth
   * sell is sized by first pricing the buy, so when the buy finds no route
   * there is no token amount, and with no token amount there is no cash back,
   * no per-share price, no basis. The card printed all four, in the order the
   * engine computes them, and the cause — the only sentence a reader can act
   * on — was not among them.
   *
   * Non-null only when the grid is entirely absent. One value established means
   * the rows are genuinely different absences and are shown as they are.
   */
  withheldCause: WithheldCauseViewV1 | null;
  /** Round-trip cost at each reviewed size, from the same stored run. Empty
   * when nothing measured it — never a row of zeros. */
  ladder: FactViewV1[];
  ladderNote: string | null;
  /** Holding, redeeming and distributions — from the reviewed adapters. */
  terms: FactViewV1[];
  technical: { label: string; value: string }[];
  /** Phase 11. Exact-address utility evidence. No edge implies personal
   * eligibility and no router quote is promoted to execution. */
  utility: {
    caip10: string;
    /**
     * The question the panel exists to answer, answered before the evidence.
     *
     * The edges already carry every state; what they did not carry was a place
     * for a reader to look first. This is a regrouping of the same edges by the
     * same states — nothing is computed here that was not already decided.
     */
    answer: UtilityAnswerViewV1;
    groups: UtilityGroupViewV1[];
  };
}

/**
 * NOW: the short-lived half of the card.
 *
 * `live` and `none` are exclusive and neither of them is the durable answer.
 * When a quote lapses this becomes `none` and NOTHING else on the card changes
 * — the stored measurement below it was never sourced from the quote.
 */
export interface OpenQuoteViewV1 {
  state: 'live' | 'none';
  value: string;
  note: string | null;
  /** Counts down while the quote is open; null the moment it is not. */
  expiresInLabel: string | null;
}

/** A named absence: a label and the reason, and structurally no value. */
export interface WithheldFactViewV1 {
  label: string;
  note: string;
  tone: ToneV1;
}

/** What can be done with this exact address, before any document is opened. */
export interface UtilityAnswerViewV1 {
  headline: string;
  buckets: { label: string; note: string; items: string[] }[];
}

export interface MarketRealityViewV1 {
  /** The subject line: what security this whole page is about. */
  title: string;
  identifier: string | null;
  /** "$1,000 · selling into USDC" — the question, restated. */
  questionLine: string;
  /** The verdict strip. */
  coverageChip: string;
  coverageTone: ToneV1;
  coverageBody: string;
  /** The engine's own wording, kept reachable rather than discarded. A reader
   * gets `coverageBody`; an operator checking why gets this. */
  coverageDetail: string | null;
  /** The four denominators Phase 10B.8 keeps structurally separate. */
  comparisonSummary: FactViewV1[];
  /** Why no representation is marked best. Always shown while withheld. */
  rankingNote: string | null;
  representations: RepresentationViewV1[];
  /** Scope, verbatim and unconditional. */
  scope: string;
  /** When the answer was assembled, as an age. */
  assembledAge: string;
}

// ---------------------------------------------------------------------------
// Formatting.
// ---------------------------------------------------------------------------

const ISSUER_NAME_V1: Readonly<Record<IssuerIdV1, string>> = {
  coinbase: 'Coinbase',
  dinari: 'Dinari',
  backed: 'Backed',
};

const STRUCTURE_LABEL_V1: Readonly<Record<RepresentationKindV1, string>> = {
  b20_asset: 'B20 asset',
  rebasing_erc20: 'Rebasing ERC-20',
  non_rebasing_erc4626_wrapper: 'ERC-4626 wrapper',
  dinari_dshare: 'Dinari dShare',
};

/**
 * The ratio convention, said in words a holder can check their own balance
 * against. This is the single most expensive thing on the page to get wrong:
 * applying a rebasing token's ratio a second time overstates a Netflix holding
 * tenfold, and five Dinari dShares are already away from 1.0.
 */
const NORMALIZATION_NOTE_V1: Readonly<
  Record<MarketRealityRepresentationWireV1['normalization'], string>
> = {
  fresh_ratio_applied: 'Balance is raw; the current multiplier was read and applied once.',
  reviewed_token_already_applied: 'The token rebases — its own balance already carries the ratio.',
  not_established:
    "The share ratio behind this size isn't confirmed yet, so the holding shown is not adjusted for it.",
};

function usdV1(atomic: string | null | undefined, decimals = 6): string | null {
  // Guards the SHAPE, not just null. These atomics arrive from a wire, and an
  // absent field is `undefined` rather than `null` — a `=== null` check let
  // one through and threw inside the formatter, taking the whole card with it.
  if (typeof atomic !== 'string' || atomic.length === 0) return null;
  const plain = formatAtomicAmount(atomic, decimals);
  const [whole, fraction] = plain.split('.');
  const grouped = (whole ?? '0').replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  // Cents are padded, never truncated to whatever the atomic happened to have:
  // `$342.8` is not how money is written, and this figure is now the headline
  // of the exit line rather than a footnote.
  return fraction ? `$${grouped}.${fraction.slice(0, 2).padEnd(2, '0')}` : `$${grouped}`;
}

/**
 * `39 min ago` from an ISO instant.
 *
 * Named apart from `consoleState.ageLabelV1`, which takes a duration in
 * seconds and renders `12m 30s`. Two functions, two inputs, two jobs: this one
 * answers "how long ago was this true", and a reader compares that to now
 * without doing arithmetic. A timestamp in a foreign zone reads as noise.
 */
export function quoteAgeLabelV1(iso: string | null, nowIso: string): string | null {
  if (!iso) return null;
  const then = Date.parse(iso);
  const now = Date.parse(nowIso);
  if (!Number.isFinite(then) || !Number.isFinite(now)) return null;
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  // "0s ago" is not a time a reader can act on, and it appeared on the same
  // card as "measured 1h ago" — two ages, one of them apparently instantaneous,
  // sitting next to each other and reading as a contradiction. Under five
  // seconds the honest word is "just now".
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/**
 * Premium or discount against the reference — PERCENT first.
 *
 * It read `+11 bps`, which is a unit a reader has to convert before it means
 * anything, and it was the primary value of the Basis row rather than a
 * footnote. Basis points stay, second, because they are how this number is
 * quoted between systems and how two sizes are compared; the percentage is
 * what a person reads.
 *
 * The sign is carried on BOTH halves. It is the whole content of this figure —
 * trading above or below the reference — and dropping it from either half
 * leaves a number that looks like a cost.
 */
function bpsLabelV1(bps: string | null): string | null {
  if (bps === null) return null;
  if (!/^-?(0|[1-9][0-9]*)$/.test(bps)) return null;
  const value = BigInt(bps);
  const sign = value > 0n ? '+' : '';
  const percent = rwaBpsLabelV1(bps);
  if (percent === null) return `${sign}${value.toString()} bps`;
  return `${sign}${percent} · ${sign}${value.toString()} bps`;
}

const MARKET_SESSION_LABEL_V1: Readonly<
  Record<MarketRealityRepresentationWireV1['reference']['marketSession'], string>
> = {
  regular_hours: 'US market open',
  after_hours: 'US market closed / after hours',
  weekend: 'Weekend',
  unknown: 'Market session not confirmed',
};

const PUBLICATION_MODE_LABEL_V1: Readonly<
  Record<MarketRealityRepresentationWireV1['reference']['publicationMode'], string>
> = {
  live_reference: 'Reference price is live',
  holding_last_close: 'Reference price is holding its last published value',
  corporate_action_hold: 'Reference price is held for a corporate action',
  // "Stale" is a system word for a fact a reader can act on: the number on
  // screen is not the current one.
  stale: 'Reference price has not updated recently',
  unknown: 'How the reference price publishes is not confirmed',
};

/**
 * A publication mode that names an EVENT, rather than restating freshness.
 *
 * The Reference clock already says whether the feed is publishing and when it
 * last did, so `live_reference` and `stale` add a second sentence about the
 * same fact. `holding_last_close` and `corporate_action_hold` do not: they say
 * WHY it stopped, and a corporate-action hold in particular is a thing the
 * reader has to know before acting. Those stay on the card; the restating ones
 * move to Technical evidence, where the mode is still printed verbatim.
 */
const PUBLICATION_MODE_IS_AN_EVENT_V1: Readonly<
  Record<MarketRealityRepresentationWireV1['reference']['publicationMode'], boolean>
> = {
  live_reference: false,
  holding_last_close: true,
  corporate_action_hold: true,
  stale: false,
  unknown: false,
};

function referenceNoteV1(
  reference: MarketRealityRepresentationWireV1['reference'],
): string {
  const parts = [MARKET_SESSION_LABEL_V1[reference.marketSession]];
  if (PUBLICATION_MODE_IS_AN_EVENT_V1[reference.publicationMode]) {
    parts.push(PUBLICATION_MODE_LABEL_V1[reference.publicationMode]);
  }
  if (reference.reason) parts.push(reference.reason);
  return parts.join(' · ');
}

/**
 * The one derived fact this module owns: which evidence outcome a row is in.
 *
 * Reads the SOURCES rather than the row status, because the row status folds
 * "expired" and "never asked" into one word and the sources keep them apart.
 */
export function representationOutcomeV1(
  representation: MarketRealityRepresentationWireV1,
  nowIso: string,
): MarketRealityOutcomeV1 {
  if (representation.supply.state === 'zero_supply') return 'zero_supply';
  if (representation.supply.state === 'supply_unknown') return 'supply_unknown';
  // ONE authority for whether a quote is open, and it is the clock.
  //
  // `status: 'full'` is stamped when the server assembles the response; the
  // strip below already refuses to claim a live quote once the expiry has
  // passed. Reading the status here and the clock there is how one card came to
  // render `Priced now` in the header, `No live quote` in the strip and "the
  // quote is still open" in the body — three statements, two of them false,
  // about a quote that had lapsed nineteen seconds after assembly.
  //
  // A quote that has expired is exactly `lapsed`: we did have a price, and the
  // window closed. Nothing is lost — the durable measurement below is not
  // sourced from the quote and does not move.
  if (representation.status === 'full') {
    return openQuoteExpiryV1(representation, nowIso) === null ? 'lapsed' : 'priced';
  }
  // `liveness` is the engine's own answer and it is authoritative: it was
  // computed from the same rows that produced the status, at the same instant.
  // Re-deriving it here from timestamps was how this module and the engine
  // could disagree about whether a representation had ever been measured.
  if (representation.liveness === 'never_measured') return 'never_measured';
  if (representation.liveness === 'history_only') {
    // The evidence exists and its window closed. Which KIND of evidence it was
    // still matters, and all three read differently to a person:
    //
    //   quoted             we had a price and it aged out       the clock
    //   no_route           we had a finding and it aged out     the clock
    //   measurement_failed our call failed, and that is all     Miorail
    //
    // Telling a reader their price expired when we never had one is a small
    // lie; telling them a FINDING expired when what actually happened is that
    // our router call failed hands our failure to the market.
    if (representation.lastObservation?.status === 'quoted') return 'lapsed';
    // The stored status folds every non-quote into `measurement_failed`, so the
    // ERROR CODE is what still separates "the router does not cover this",
    // "the market gave us no size" and "our call failed". Reading the status
    // alone put all three under our name once the evidence expired.
    const aged = outcomeFromCodesV1(
      representation.lastObservation?.status === 'no_route' ? 'unavailable' : 'measurement_failed',
      [representation.lastObservation?.errorCode ?? null],
    );
    return aged === 'no_route' ? 'stale_finding' : aged;
  }
  return outcomeFromCodesV1(
    representation.status,
    representation.sources.map((source) => source.errorCode),
  );
}

/**
 * The ways route evidence can fail to be a price, kept apart.
 *
 * Phase 10B.7 measured all three NVIDIA representations through the same router
 * at the same size and got three different router-policy answers, of which
 * the product was reporting two:
 *
 *   Coinbase NVDAc  200                       -> priced
 *   Backed  bNVDA   400 4008 route not found  -> no route in this router policy
 *   Backed  wbNVDA  400 4011 token not found  -> our router does not index it
 *
 * The third was arriving as `provider_http_error` — our infrastructure taking
 * the blame for the router's token list, on 25 consecutive passes.
 */
function outcomeFromCodesV1(
  status: MarketRealityRepresentationWireV1['status'],
  errorCodes: readonly (string | null)[],
): MarketRealityOutcomeV1 {
  const codes = errorCodes.filter((code): code is string => code !== null);
  if (codes.some((code) => code === 'provider_unsupported_token')) return 'unsupported_token';
  // BEFORE the status, and deliberately. Storage folds a refusal into
  // `measurement_failed` (its `unavailable` state is reserved for an explicit
  // `provider_no_route`), so reading the status first would file a venue's own
  // decision as our call failing — the exact collapse this outcome exists to
  // prevent, in the direction that blames Miorail.
  if (codes.some((code) => code === 'provider_policy_refused')) return 'policy_refused';
  if (status === 'unavailable') return 'no_route';
  if (codes.some((code) => code === 'provider_no_route')) return 'no_route';
  // A cash rung is sized by pricing the BUY first. When that buy has no route
  // the sell was never sized — which is the market answering, not our call
  // failing, even though it lands in storage as `measurement_failed`.
  if (codes.some((code) => code === 'cash_size_anchor_no_route')) return 'unsized';
  if (status === 'measurement_failed') return 'provider_failed';
  if (codes.length > 0) return 'provider_failed';
  return 'never_measured';
}

const OUTCOME_CHIP_V1: Readonly<Record<MarketRealityOutcomeV1, string>> = {
  zero_supply: 'No tokens outstanding',
  supply_unknown: 'Supply unknown',
  priced: 'Priced now',
  lapsed: 'Price expired',
  stale_finding: 'Earlier check expired',
  unsupported_token: 'Not covered',
  // "Could not size" reads as our failure. The BUY anchor found no route, so
  // there was no token amount to sell — the market gave us no size, and the
  // sentence should say which of the two it is.
  unsized: 'Sell size not established',
  // "No route" is a claim about the whole of Base that this product cannot
  // make and has never measured. The scope still has to be stated — but as a
  // quiet second line under the card, not inside the chip. A reader is asking
  // "can I get cash out of this", and "No route under reviewed policy" answers
  // in Miorail's vocabulary instead of theirs. The same words the `lastSeen`
  // line uses, so the headline and the history below cannot read as two
  // separate findings.
  no_route: 'No cash route found',
  policy_refused: 'Venue declined to quote',
  provider_failed: 'Our read failed',
  never_measured: 'Not measured',
};

/**
 * Availability, coloured as availability.
 *
 * `priced` is NOT `good`. It says a router answered at this exact size and the
 * quote is still open — nothing at all about whether the answer is any use. A
 * COIN card carrying `$1,000 in → $0.94 back` wore the same success green as
 * one carrying `$999.72 back`, and a reader scanning for two seconds reads
 * green as "this market is fine".
 *
 * So the two axes are separated: this chip reports whether an answer EXISTS,
 * in the neutral tone every other availability state uses, and `exitCost`
 * below carries the economics with its own graded colour. One card, two
 * questions, two chips.
 */
const OUTCOME_TONE_V1: Readonly<Record<MarketRealityOutcomeV1, ToneV1>> = {
  zero_supply: 'neutral',
  supply_unknown: 'warn',
  priced: 'neutral',
  lapsed: 'warn',
  stale_finding: 'off',
  unsupported_token: 'warn',
  unsized: 'off',
  no_route: 'off',
  // Not `off`: nothing was found wrong with the token or the market. One
  // venue applied its own rule, and the others were still asked.
  policy_refused: 'warn',
  provider_failed: 'warn',
  never_measured: 'neutral',
};

const OUTCOME_ATTRIBUTION_V1: Readonly<
  Record<MarketRealityOutcomeV1, RepresentationViewV1['attribution']>
> = {
  zero_supply: 'onchain read',
  supply_unknown: 'Miorail',
  priced: 'the market',
  lapsed: 'the clock',
  stale_finding: 'the clock',
  // Our router set does not index the token. Another router might; the token
  // may trade perfectly well somewhere this set does not reach.
  unsupported_token: 'Miorail',
  // A cash-denominated size needs a buy quote to become a token amount. The
  // buy found no route, so the sell was never sized — the market's answer,
  // arriving as a non-measurement.
  unsized: 'the market',
  no_route: 'the market',
  // Neither the market nor us. A venue that could quote and chose not to is a
  // third party with its own rules, and there was no word for it until now.
  policy_refused: 'the venue',
  provider_failed: 'Miorail',
  never_measured: 'Miorail',
};

function outcomeBodyV1(
  outcome: MarketRealityOutcomeV1,
  representation: MarketRealityRepresentationWireV1,
  sizeLabel: string,
  nowIso: string,
): string {
  // The stored observation first: a failed or refused look carries no quote
  // evidence at all, and without this the sentence for those two lost its "39
  // minutes ago" and read as though nothing had ever been tried.
  const age = quoteAgeLabelV1(
    representation.lastObservation?.observedAt ??
      representation.sources.find((source) => source.quoteEvidence)?.quoteEvidence?.observedAt ??
      null,
    nowIso,
  );
  switch (outcome) {
    case 'zero_supply':
      // Was written in the engine's vocabulary — "the latest fresh successful
      // totalSupply read", "the market-comparison denominator". Both are true
      // and neither tells a reader that there is simply nothing here.
      return `No tokens of this contract are outstanding right now, so there is nothing to buy or sell at this address. It stays on the page: an exact address does not disappear because its supply is zero.`;
    case 'supply_unknown':
      return `${representation.supply.reason ?? 'How many tokens are outstanding could not be read.'} The contract stays on the page rather than quietly leaving it — not knowing is not the same as nothing being there.`;
    case 'priced':
      return `A router quoted this exact size and the quote is still open.`;
    case 'lapsed':
      // The state a reader is most likely to misread as a broken product. It
      // says what happened, says the number was real, and points at the one
      // control that fixes it.
      // The twenty-second window is said once for the board, above the cards.
      // Repeating it here put it back on every card it had just left.
      return `A router did quote ${sizeLabel}${age ? ` ${age}` : ''}, and that quote has since expired. Measure now to get an open one.`;
    case 'stale_finding':
      // Not a lapsed price: we never had a price here. What expired was a
      // finding about the market, and saying "price expired" would invent one.
      return `The last look at ${sizeLabel}${age ? ` ${age}` : ''} found no way to turn this into cash, and that finding has since expired. Measure now to ask again.`;
    case 'no_route':
      // The scope still has to be here — it is the difference between a fact
      // and an overclaim — but said as where we looked, not as the name of an
      // internal rule set. "Under Miorail's current reviewed router policy"
      // made a reader parse our vocabulary to learn we had not checked Base.
      return `No cash route was found for ${sizeLabel}. Checked across Miorail's reviewed route sources — this is about this exact contract at this exact size, not about the issuer or every market on Base.`;
    case 'policy_refused':
      // Says what the venue did and stops. No inference about the reader,
      // about the token, or about whether the refusal is lawful or permanent —
      // none of which was measured, and none of which is ours to conclude.
      return `A route source that covers this token declined to quote it${age ? ` — last asked ${age}` : ''}. That is that venue's own trading rule. It is not a finding about the token, and the other sources were still asked.`;
    case 'unsupported_token':
      // Never "no route": the router did not index the token, so it never
      // reached the question. Claiming a market verdict here would be us
      // speaking for a router that stayed silent.
      return `Our approved router does not cover this contract, so it never looked for a route${age ? ` — last asked ${age}` : ''}. That is our coverage, not the market's answer, and it says nothing about whether the token trades.`;
    case 'unsized':
      return `A cash size is set by first pricing a buy of ${sizeLabel}, and that buy found no route${age ? ` ${age}` : ''} — so this sell was never sized. The market gave us no size to test, which is not the same as refusing to trade a position already held.`;
    case 'provider_failed':
      return representation.liveness === 'history_only'
        ? `Our last router call for ${sizeLabel}${age ? ` ${age}` : ''} did not complete, and that is all we hold. Our failure, not the contract's — measure now to try again.`
        : `Our router call did not complete, so this size was not measured. That is our failure, and it says nothing about the contract.`;
    case 'never_measured':
    default:
      return `${sizeLabel} has not been measured against this representation yet.`;
  }
}

/**
 * NOW, in one line.
 *
 * Separated from the body so the body can hold a measurement. It says whether
 * anything is open at this instant and nothing else — the WHY of a twenty-
 * second window is a property of router quotes, not of this representation, so
 * the board says it once above the cards.
 */
/**
 * Is a router quote open on this representation RIGHT NOW — and for how long.
 *
 * The single authority. Liveness is decided by the CLOCK, not by the status the
 * server stamped when it assembled: `full` means the quote was open at assembly
 * time, and a reader holding that answer twenty-one seconds later holds a
 * lapsed one.
 *
 * Extracted because the header chip and the NOW strip each used to decide this
 * for themselves, from different inputs, and disagreed on screen: `Priced now`
 * beside `No live quote`, over the same quote. There is one question here and
 * it has one answer.
 */
function openQuoteExpiryV1(
  representation: MarketRealityRepresentationWireV1,
  nowIso: string,
): string | null {
  if (representation.status !== 'full') return null;
  // The response carries an expiry in three places — the representation's own
  // field, the stored observation, and the source quote — and any of them can
  // be absent on its own. The LATEST one wins, rather than a priority order:
  // an open quote does not become closed because an older observation is also
  // on the record, and a rule that picked by position had to justify why one
  // field outranks another when they simply describe different measurements.
  //
  // `lastObservation.open` is deliberately not consulted. It is a boolean
  // stamped at assembly, and a boolean cannot expire: one production
  // representation carried `open: true` beside a window that had closed
  // thirty-nine minutes earlier. An instant can be checked against the clock;
  // a flag can only be believed.
  const expiries = [
    representation.expiresAt,
    representation.lastObservation?.expiresAt ?? null,
    latestQuoteV1(representation)?.expiresAt ?? null,
  ].filter((value): value is string => typeof value === 'string' && value.length > 0);
  if (expiries.length === 0) return null;
  return expiresInLabelV1(
    expiries.reduce((latest, one) => (Date.parse(one) > Date.parse(latest) ? one : latest)),
    nowIso,
  );
}

function openQuoteStripV1(
  representation: MarketRealityRepresentationWireV1,
  requestedCashAtomic: string,
  nowIso: string,
): OpenQuoteViewV1 {
  const expiresInLabel = openQuoteExpiryV1(representation, nowIso);
  if (expiresInLabel) {
    const paidIn = usdV1(requestedCashAtomic);
    const cameBack = usdV1(representation.returnedCashAtomic ?? null);
    return {
      state: 'live',
      // Money first, in the same words the durable answer below uses, so a
      // reader sees the live number and the last measured number as the same
      // measurement taken twice — not as two different kinds of thing.
      value:
        paidIn !== null && cameBack !== null
          ? `${paidIn} in \u2192 ${cameBack} back`
          : (cameBack ?? '\u2014'),
      note: 'open right now, at this exact size',
      expiresInLabel,
    };
  }
  return { state: 'none', value: 'No live quote', note: null, expiresInLabel: null };
}

/**
 * "Expires in 17s" — the only number on this card that is worth watching move.
 *
 * A router quote is good for about twenty seconds and nothing else on the page
 * changes inside that window, so a static "open right now" leaves a reader with
 * no way to tell a quote that has eighteen seconds left from one that has one.
 * Under a second, and at expiry, the strip stops claiming anything is open.
 */
export function expiresInLabelV1(expiresAt: string | null, nowIso: string): string | null {
  if (!expiresAt) return null;
  const remainingMs = Date.parse(expiresAt) - Date.parse(nowIso);
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) return null;
  return `Expires in ${Math.max(1, Math.ceil(remainingMs / 1000))}s`;
}

/** LAST MEASURED, in one phrase. The other half of the split. */
function lastMeasuredLabelV1(
  representation: MarketRealityRepresentationWireV1,
  nowIso: string,
): string | null {
  const observedAt =
    representation.lastObservation?.observedAt ??
    representation.sources.find((source) => source.quoteEvidence)?.quoteEvidence?.observedAt ??
    null;
  const age = quoteAgeLabelV1(observedAt, nowIso);
  return age ? `Last measured ${age}` : null;
}

function numbersV1(
  representation: MarketRealityRepresentationWireV1,
  direction: MarketRealityDirectionV1,
  nowIso: string,
): FactViewV1[] {
  const cash = usdV1(representation.returnedCashAtomic);
  const price =
    representation.effectivePriceAtomic && representation.effectivePriceDecimals !== null
      ? usdV1(representation.effectivePriceAtomic, representation.effectivePriceDecimals)
      : null;
  const referencePrice =
    representation.reference.valueAtomic !== null && representation.reference.decimals !== null
      ? usdV1(representation.reference.valueAtomic, representation.reference.decimals)
      : null;
  const premium = bpsLabelV1(representation.premiumDiscountBps);

  // The measurement, when there is no open quote to state instead.
  //
  // This is the change that stopped the card rendering four dashes over a
  // stored run: the figure exists, Discover has always shown it, and the only
  // thing that made it unshowable here was that this list would not carry a
  // closed observation. It carries one now, with its age in the note and a
  // muted tone, which is the distinction that actually protects a reader —
  // not the absence of the number.
  const observation = representation.lastObservation;
  const historyAge = observation ? quoteAgeLabelV1(observation.observedAt, nowIso) : null;
  const historyCash =
    observation && observation.status === 'quoted' && observation.returnedCashAtomic
      ? usdV1(observation.returnedCashAtomic)
      : null;
  const cashLabel = direction === 'sell' ? 'Cash back' : 'Cash in';

  return [
    cash !== null
      ? {
          label: cashLabel,
          value: cash,
          note: 'on evidence still open',
          // A returned amount is a fact, not an assessment of whether the route
          // is attractive. Route state remains visible in the outcome chip.
          tone: 'neutral' as const,
        }
      : historyCash !== null
        ? {
            label: cashLabel,
            value: historyCash,
            // The age left this line for the Round trip clock above. What is
            // load-bearing here is the KIND of number, not its age: a reader
            // who mistakes it for a live price acts on it.
            note: 'history, not a price now',
            tone: 'off' as const,
          }
        : {
            label: cashLabel,
            value: '—',
            note: observationAbsenceNoteV1(observation, historyAge),
            tone: 'neutral' as const,
          },
    {
      label: 'Effective price',
      value: price ?? '—',
      // The trap the roadmap names by hand: a reference VALUE and a total cash
      // return are different units, and a dash with no reason invites a reader
      // to compare the one that is present against something it is not.
      note:
        price === null
          ? representation.normalization === 'not_established'
            ? "the share ratio isn't confirmed, so there is no per-share price"
            : 'needs an open quote'
          : 'per unit of normalized exposure',
      tone: 'neutral',
    },
    {
      label: 'Reference price',
      value: referencePrice ?? '—',
      note: referenceNoteV1(representation.reference),
      tone: 'neutral',
    },
    {
      label: premium === null ? 'Basis withheld' : 'Basis',
      value: premium ?? '—',
      note:
        premium === null
          ? representation.basis.reason
          : representation.basis.kind === 'last_close_reference'
            ? 'vs last published reference value'
            : 'vs current reviewed reference',
      // The sign describes direction relative to the named reference. It does
      // not describe investment quality and never selects a green/red tone.
      tone: 'neutral',
    },
  ];
}

/**
 * Why there is no cash figure, named by what the last look actually found.
 *
 * The measurement's own error code decides the sentence wherever it has one.
 * "Miorail's router call did not complete" was covering two different facts:
 * a router that answered and said it does not carry this token at all, and a
 * router that never answered. The first is a finding about the market and the
 * second is an outage of ours, and a reader who is told the second when the
 * first is true will keep pressing Measure now forever.
 */
function observationAbsenceNoteV1(
  observation: MarketRealityRepresentationWireV1['lastObservation'],
  age: string | null,
): string {
  if (!observation) return 'nothing has been measured at this size yet';
  const when = age ? ` ${age}` : '';
  const coded = MEASUREMENT_OUTCOME_V1[observation.errorCode ?? ''];
  if (coded) return `${coded.note}${when}`;
  switch (observation.status) {
    case 'no_route':
      return `no cash route was found${when}`;
    case 'unsized':
      return `the buy anchor found no route${when}, so the sell was never sized`;
    case 'measurement_failed':
      return `Miorail's router call did not complete${when}`;
    default:
      return `no cash figure was returned${when}`;
  }
}

/**
 * The measurement codes a reader is entitled to see spelled out.
 *
 * Both of these are the ROUTER's answer, not ours. Kept in one table so the
 * chip and the note cannot drift into describing the same code two ways.
 */
export const ROUTER_UNSUPPORTED_SENTENCE_V1 = 'This route source does not cover this token';

/**
 * The round-trip cost past which a size is not exitable under the reviewed
 * policy.
 *
 * DERIVED, NOT OBSERVED. Every cash-exit intent is planned with
 * `slippageConstraint.maxBps = 100`, and a round trip is two of those legs, so
 * two hundred basis points is the most the policy Miorail already measures
 * under is willing to tolerate. No market number is hard-coded here: change the
 * slippage policy and this bound moves with it, which is the point.
 *
 * It decides one thing only — which sentence a reader gets. The measured cost
 * is always shown next to it, so a reader who disagrees with the bound can see
 * the number the bound was applied to.
 */
export const MARKET_REALITY_ROUND_TRIP_BOUND_BPS_V1 = Number(
  ROUND_TRIP_ACCEPTABLE_MAX_BPS_V1,
);

/**
 * Can the position be CLOSED at this size — as its own fact, with its own age.
 *
 * Deliberately not folded into `outcome`. A router quote lives about twenty
 * seconds, so for almost every reader the outcome is `lapsed` rather than
 * `priced`; an exit verdict that only fired on `priced` would be invisible
 * exactly when it matters. Exitability is a property of the venue behind the
 * token, it changes on the timescale of liquidity rather than of a quote, and
 * it is worth stating from the last completed run — labelled as such.
 *
 * The bound is ours and the cost is measured, so both are shown. Saying only
 * "cannot be exited" would be a verdict a reader cannot check.
 */
/**
 * Four rungs saying one thing become one line saying it once.
 *
 * `not covered` at $100, at $1,000, at $10,000 and at $100,000 is a single
 * finding about coverage printed four times; it fills the tallest block on the
 * card with a repetition, and the repetition is what a reader remembers instead
 * of the finding. Collapse only on EXACT agreement — same value, same note,
 * same tone — so the moment any size differs, every size is shown again. The
 * label keeps both ends of the range, because "at every size we measure" and
 * "at $1,000" are different claims.
 */
export function collapseLadderRungsV1(rungs: readonly FactViewV1[]): FactViewV1[] {
  if (rungs.length < 2) return [...rungs];
  const [first, ...rest] = rungs;
  const uniform = rest.every(
    (rung) => rung.value === first!.value && rung.note === first!.note && rung.tone === first!.tone,
  );
  if (!uniform) return [...rungs];
  return [{ ...first!, label: `${first!.label} – ${rungs[rungs.length - 1]!.label}` }];
}

/**
 * The value grid, split into what has a value and what does not.
 *
 * Nothing is discarded: a row with no value keeps its reason and moves out of
 * the grid, where the dash it needed in order to occupy a value column was the
 * loudest thing on the line.
 */
export function splitEstablishedFactsV1(
  facts: readonly FactViewV1[],
): { established: FactViewV1[]; withheld: WithheldFactViewV1[] } {
  const established: FactViewV1[] = [];
  const withheld: WithheldFactViewV1[] = [];
  for (const fact of facts) {
    if (fact.value === '—') {
      // The reason is the whole content of a withheld row, so the type has no
      // value field at all: there is no shape in which one can be rendered.
      withheld.push({ label: fact.label, note: fact.note ?? 'not established', tone: fact.tone });
    } else {
      established.push(fact);
    }
  }
  return { established, withheld };
}

export interface WithheldCauseViewV1 {
  /** The answer, in the reader's units. One sentence, no vocabulary of ours. */
  headline: string;
  /** What it does and does not mean. The bound always travels with the claim. */
  detail: string;
}

/**
 * The one cause behind a wholly withheld grid.
 *
 * Fires only when NOTHING in the value grid was established. With even one
 * value present the withheld rows are independent absences and stay as they
 * are; with none, they are all downstream of a single measurement outcome, and
 * that outcome is what the reader came for.
 *
 * Every sentence is bounded the same way the route-absence copy is: it names
 * the reviewed sources and the one size, and never claims the token does not
 * trade. The withheld rows are not discarded — they move to Technical evidence,
 * where the mechanics belong.
 */
export function withheldCauseV1(input: {
  established: readonly FactViewV1[];
  withheld: readonly WithheldFactViewV1[];
  observation: MarketRealityRepresentationWireV1['lastObservation'];
  direction: MarketRealityDirectionV1;
  sizeLabel: string;
}): WithheldCauseViewV1 | null {
  if (input.established.length > 0 || input.withheld.length < 2) return null;
  const observation = input.observation;
  if (!observation) {
    return {
      headline: `Nothing has been measured at ${input.sizeLabel} yet.`,
      detail:
        'This representation has no completed reading at this size and direction. That is a gap in Miorail\u2019s coverage, not a finding about the token.',
    };
  }
  const code = observation.errorCode ?? '';
  if (code === 'cash_size_anchor_no_route' || observation.status === 'unsized') {
    return input.direction === 'sell'
      ? {
          headline: `${input.sizeLabel} cash exit could not be sized.`,
          detail:
            'A cash-worth sell has no token amount until a buy is priced, and no reviewed router would price that buy at this size. Selling a position already held was never tested and is not claimed either way.',
        }
      : {
          headline: `${input.sizeLabel} buy could not be priced.`,
          detail:
            'No reviewed router would sell this token for cash at this size, so nothing downstream of that price could be established.',
        };
  }
  if (code === 'provider_unsupported_token') {
    return {
      headline: 'This route source does not carry this token.',
      detail:
        'The router answered that it does not know this contract, so it never looked for a route. That is Miorail\u2019s coverage, not the market\u2019s answer, and it says nothing about whether the token trades.',
    };
  }
  if (code === 'provider_policy_refused') {
    return {
      headline: 'A route source that covers this token declined to quote it.',
      detail:
        'The venue can route this token and would not, at this size and moment. That is the venue\u2019s decision, not a property of the token and not a reading of the market.',
    };
  }
  if (code === 'provider_venue_not_covered') {
    return {
      headline: 'The market for this token sits at a venue this route source cannot read.',
      detail:
        'A market exists and no price was taken from it, because the reviewed sources do not reach that venue. That is Miorail\u2019s coverage, not an absence of liquidity.',
    };
  }
  if (observation.status === 'no_route') {
    return {
      headline: `No cash route was found at ${input.sizeLabel}.`,
      detail:
        'Measured through the reviewed route sources, at this one size and one moment. It is not proof that no route exists anywhere on Base.',
    };
  }
  if (observation.status === 'measurement_failed') {
    return {
      headline: 'The measurement did not complete.',
      detail:
        'Miorail\u2019s own router call failed, so nothing on this card is a statement about this token. Measuring again is the next step.',
    };
  }
  return null;
}

/**
 * Ten times the reviewed bound: past here, a fifth or more of the money is gone.
 *
 * The first threshold is DERIVED — `MARKET_REALITY_ROUND_TRIP_BOUND_BPS_V1` is
 * two legs of the 100 bps slippage policy every cash-exit intent is planned
 * under, so it moves when the policy moves. This second one is a stated
 * multiple of it rather than a market observation, and it exists for one
 * reason: `warn` was carrying both a 4% round trip and a 99.90% one. Those are
 * not the same finding, and on a board where a reader compares three
 * representations at a glance, painting them the same colour is the whole
 * mistake.
 *
 * Ten times the bound is 2,000 bps, which reads as a sentence a person can
 * check against the number printed beside it: a fifth or more of the position
 * does not come back.
 */
export const MARKET_REALITY_ROUND_TRIP_SEVERE_BPS_V1 = Number(ROUND_TRIP_SEVERE_MIN_BPS_V1);

/**
 * The second axis of a priced card: not whether there is an answer, but what
 * the answer costs.
 *
 * `within_policy` is the only one that is good news, and it is good news about
 * a MEASUREMENT, never a recommendation — the card still names no winner.
 */
export type ExitCostGradeV1 =
  | 'within_policy'
  | 'above_policy'
  | 'most_value_lost'
  /**
   * The round trip returned MORE than it took.
   *
   * Its own grade rather than a band of the scale, because it is not a point on
   * the scale: `bps <= 200` is true of every negative number, so a `-529` — a
   * claimed 5.29% gain on a two-leg round trip — wore the same success green as
   * a real 0.02%. Seen on the review page of a $0.10 draft.
   *
   * At that size the two legs are separate quotes taken moments apart and the
   * token's own decimals round; whatever produced the sign, it is not a cost a
   * reader can act on, and it must not be coloured as a good one.
   */
  | 'returned_more_than_taken';

export interface ExitCostViewV1 {
  grade: ExitCostGradeV1;
  /** Chip words: the cost itself, because the number is the finding. */
  chip: string;
  tone: ToneV1;
  /** One clause a reader can act on, in their units, never ours. */
  note: string;
}

export function exitCostGradeV1(bps: number): ExitCostGradeV1 {
  // Checked FIRST, because every comparison below it is true of a negative
  // number and each one of them means something good.
  if (bps < 0) return 'returned_more_than_taken';
  if (bps <= MARKET_REALITY_ROUND_TRIP_BOUND_BPS_V1) return 'within_policy';
  if (bps < MARKET_REALITY_ROUND_TRIP_SEVERE_BPS_V1) return 'above_policy';
  return 'most_value_lost';
}

const EXIT_COST_TONE_V1: Readonly<Record<ExitCostGradeV1, ToneV1>> = {
  within_policy: 'good',
  above_policy: 'warn',
  most_value_lost: 'bad',
  // No verdict colour: the figure is not a claim about the market. `off` is the
  // console's word for that, and it is deliberately not `bad` either — nothing
  // here says the market is worse than it is.
  returned_more_than_taken: 'off',
};

/**
 * The cost chip, beside the availability chip.
 *
 * Null when no round trip was measured — an unmeasured cost is an absence, and
 * an absence never gets a colour on this card. `off` is the console's word for
 * that and it belongs on the withheld rows, not on a chip that would read as a
 * verdict about the market.
 */
export function exitCostViewV1(
  exit: RepresentationExitEvidenceV1 | null | undefined,
): ExitCostViewV1 | null {
  if (!exit) return null;
  const label = rwaBpsLabelV1(exit.roundTripCostBps);
  if (label === null) return null;
  const bps = Number(exit.roundTripCostBps);
  if (!Number.isFinite(bps)) return null;
  const grade = exitCostGradeV1(bps);
  return {
    grade,
    // The number stays on screen — it was measured and hiding it would be the
    // other failure. What it must not do is read as a cost, so the chip says so
    // in its own words rather than leaving a grey minus sign to be interpreted.
    chip:
      grade === 'returned_more_than_taken'
        ? `Round trip ${label} · not a cost reading`
        : `Round trip ${label}`,
    tone: EXIT_COST_TONE_V1[grade],
    note:
      grade === 'within_policy'
        ? 'buying in and selling straight back costs this much, inside the reviewed slippage policy'
        : grade === 'above_policy'
          ? 'buying in and selling straight back costs this much, above the reviewed slippage policy'
          : grade === 'most_value_lost'
            ? 'buying in and selling straight back costs this much — most of the money does not come back'
            : 'the round trip returned more than it took, which is not a cost a reader can act on: the two legs are separate quotes taken moments apart, and at small sizes that gap and the token’s own rounding are larger than the market',
  };
}

function exitViewV1(
  exit: RepresentationExitEvidenceV1 | null | undefined,
  nowIso: string,
): FactViewV1 | null {
  if (!exit) return null;
  const cost = rwaBpsLabelV1(exit.roundTripCostBps);
  if (cost === null) return null;
  const bps = Number(exit.roundTripCostBps);
  if (!Number.isFinite(bps)) return null;
  const age = quoteAgeLabelV1(exit.observedAt, nowIso);
  const when = exit.basis === 'open' ? 'on the open quote' : `measured ${age ?? 'earlier'}`;
  const grade = exitCostGradeV1(bps);
  const withinBound = grade === 'within_policy';
  const tone = EXIT_COST_TONE_V1[grade];

  // Money first, whenever both sides of the trip were measured.
  //
  // "Round trip: 65.72%" is arithmetic a reader has to do something with before
  // it means anything. "$1,000 in → $342.80 back" is the same measurement and
  // needs no DeFi vocabulary at all — it is read, not computed. The percentage
  // stays, one line down, because it is what makes two sizes comparable.
  const paidIn = usdV1(exit.requestedCashAtomic);
  const cameBack = usdV1(exit.returnedCashAtomic);
  if (paidIn !== null && cameBack !== null) {
    return {
      label: 'Buying in and selling back out',
      value: `${paidIn} in → ${cameBack} back`,
      note: withinBound
        ? `Total cost to buy and exit: ${cost} — ${when}.`
        : // Never "no route": a route exists and answered. What it answered is
          // that the money does not come back, which is a fact about how much
          // sits behind this contract and not about whether anyone would quote.
          `Total cost to buy and exit: ${cost} — ${when}. A price is available at this size; ${
            grade === 'most_value_lost' ? 'most of the money is not' : 'it costs more than the reviewed slippage policy allows'
          }.`,
      // Never `off`: this console's `off` means nothing was measured, and this
      // was measured. Three bands rather than two, because a 4% round trip and
      // a 99.90% one are not the same finding and shared one colour.
      tone,
    };
  }

  return {
    label: 'Cost to buy and exit',
    value: cost,
    note: withinBound
      ? `what buying in and selling straight back costs at this size — ${when}`
      : grade === 'most_value_lost'
        ? `a price is available at this size, and buying in then selling straight back costs this much — ${when}. Most of the money does not come back.`
        : `a price is available at this size, and buying in then selling straight back costs this much — ${when}. That is above the reviewed slippage policy.`,
    tone,
  };
}

const MEASUREMENT_OUTCOME_V1: Readonly<Record<string, { label: string | null; note: string }>> = {
  // The chip already reads "Sell not sized", which Phase 10B.7 chose on purpose
  // and is right; only the note was written in engineering vocabulary.
  cash_size_anchor_no_route: {
    label: null,
    note: 'no reviewed router would sell this token for cash at this size, so the sell was never sized',
  },
  provider_unsupported_token: {
    label: ROUTER_UNSUPPORTED_SENTENCE_V1,
    note: 'this route source answered that it does not carry this token',
  },
  // The venue could route it and would not. Stated as what happened, with no
  // inference about the reader, the token, or whether the rule is permanent.
  provider_policy_refused: {
    label: "This venue won't quote this token",
    note: 'a route source that covers this token declined to quote it',
  },
  // Ours, not the market's: a market exists here at a venue this build cannot
  // read. Saying "no route" would hand our gap to the token.
  provider_venue_not_covered: {
    label: "This market isn't covered by this route source",
    note: 'a market exists at a venue this route source cannot read, so no price was taken from it',
  },
};

/**
 * What the last look found, and when — as HISTORY.
 *
 * Deliberately separate from `numbers`, which only ever carries open evidence.
 * A background sample rendered beside a current price, in the same style, is
 * the exact confusion the engine grew a second field to prevent; a reader who
 * has to notice a timestamp to tell them apart will not notice the timestamp.
 */
function lastSeenV1(
  representation: MarketRealityRepresentationWireV1,
  nowIso: string,
): RepresentationViewV1['lastSeen'] {
  const observation = representation.lastObservation;
  if (!observation) return null;
  const age = quoteAgeLabelV1(observation.observedAt, nowIso) ?? 'recently';
  // Named for the read it reports. "Last seen · Read failed" sat under a
  // headline about a fresh successful totalSupply read and looked like a
  // contradiction; the two are different reads, and only the label said
  // otherwise. Supply is onchain, this is the cash-exit route measurement.
  // A quoted observation is no longer repeated here: the body carries that
  // figure now, with its age, which is where a reader looks first. Showing the
  // same number twice in two styles taught nobody anything and made the card
  // longer. What remains is the case the body has no figure FOR — a route that
  // was not found, a sell that was never sized, a call that did not complete.
  if (observation.status === 'quoted' && observation.returnedCashAtomic) return null;
  const coded = MEASUREMENT_OUTCOME_V1[observation.errorCode ?? ''];
  return {
    label: 'Last market check',
    value:
      coded?.label ||
      (observation.status === 'no_route'
        ? OUTCOME_CHIP_V1.no_route
        : observation.status === 'unsized'
          ? // The SAME words the chip uses. It said "Sell not sized" here and
            // "Sell size not established" three inches above, which reads as
            // two findings rather than one stated twice.
            OUTCOME_CHIP_V1.unsized
          : 'Read failed'),
    note: `measured ${age}`,
  };
}

/**
 * The four clocks, each with its own time.
 *
 * A card carries four facts that expire independently, and until now the screen
 * could age exactly two of them. The other two borrowed a neighbour's deadline:
 * the reference session printed its state with no instant at all, and the
 * multiplier — whose freshness window the engine has always enforced — printed
 * nothing. A reader watching a quote count down had no way to tell which of the
 * numbers around it were also about to stop being true, and no way to tell that
 * most of them were not.
 *
 * So they are stated apart, side by side, each naming what it times:
 *
 *   Live quote   the router's ~20 second window
 *   Round trip   the last completed measurement, whatever its age
 *   Reference    the issuer's feed and the session it publishes in
 *   Multiplier   the ratio read, and the window it counts for
 *
 * The order is deliberate: shortest-lived first, so the one that changes while
 * you read is where the eye starts. Reading them together is the point — an
 * expired quote beside "Round trip · measured 13 min ago" says exactly what
 * happened, where an expired quote alone reads as the whole card going dark.
 */
export interface ClockCaptionV1 {
  id: 'quote' | 'round_trip' | 'reference' | 'multiplier';
  /** What is being timed. Never the system's word for it. */
  label: string;
  /** The state, in one or two words. */
  state: string;
  /** The time itself — an age or a countdown. Null only when this clock has
   * genuinely never run, which is a state and not a missing value. */
  detail: string | null;
  tone: ToneV1;
}

export function clocksV1(
  representation: MarketRealityRepresentationWireV1,
  nowIso: string,
): ClockCaptionV1[] {
  const expiresInLabel = openQuoteExpiryV1(representation, nowIso);
  const quoteCaption: ClockCaptionV1 = expiresInLabel
    ? { id: 'quote', label: 'Live quote', state: 'Open', detail: expiresInLabel, tone: 'good' }
    : representation.lastObservation
      ? {
          // Deliberately timeless. A quote expires about twenty seconds after
          // the measurement that fetched it, so "lapsed 57s ago" beside
          // "measured 1 min ago" is one event written twice with two numbers
          // that do not quite agree. The age belongs to the round trip; this
          // column owns whether anything is open, and the answer is no.
          id: 'quote',
          label: 'Live quote',
          // Not "no quote": one WAS taken, which is why the round trip beside
          // it has a number at all.
          state: 'Expired',
          detail: null,
          tone: 'off',
        }
      : { id: 'quote', label: 'Live quote', state: 'None taken', detail: null, tone: 'off' };

  // Survives the quote by design. This is the caption the whole strip exists
  // for: the measurement stands after the price that fetched it is gone.
  const measuredAt =
    representation.lastObservation?.observedAt ??
    representation.sources.find((source) => source.quoteEvidence)?.quoteEvidence?.observedAt ??
    null;
  const measuredAge = quoteAgeLabelV1(measuredAt, nowIso);
  const roundTrip: ClockCaptionV1 = measuredAge
    ? {
        id: 'round_trip',
        label: 'Round trip',
        state: 'Measured',
        detail: measuredAge,
        // Neutral, never off: age is not a fault. A measurement forty minutes
        // old is the answer to this question, and greying it out taught a
        // reader to distrust the only number on the card that was real.
        tone: 'neutral',
      }
    : { id: 'round_trip', label: 'Round trip', state: 'Never measured', detail: null, tone: 'off' };

  const reference = representation.reference;
  // Two instants, never merged. The feed publishes on its own schedule; we look
  // on ours, and when the feed is not reviewed at all our look is the only
  // clock there is — which is a fact about our coverage, stated as one.
  const publishedAge = quoteAgeLabelV1(reference.referenceUpdatedAt ?? null, nowIso);
  const lookedAge = quoteAgeLabelV1(reference.observedAt ?? null, nowIso);
  const referenceCaption: ClockCaptionV1 = {
    id: 'reference',
    label: 'Reference',
    state: REFERENCE_CLOCK_STATE_V1[reference.status],
    detail: publishedAge
      ? `published ${publishedAge}`
      : lookedAge
        ? `we looked ${lookedAge}`
        : null,
    tone: reference.status === 'fresh' ? 'good' : 'off',
  };

  const multiplier = multiplierClockV1(representation, nowIso);
  return [quoteCaption, roundTrip, referenceCaption, multiplier];
}

const REFERENCE_CLOCK_STATE_V1: Readonly<
  Record<MarketRealityRepresentationWireV1['reference']['status'], string>
> = {
  fresh: 'Publishing',
  stale: 'Not updating',
  paused: 'Held',
  unavailable: 'No feed',
  // Ours, not the issuer's: nobody has reviewed a feed for this representation.
  unknown: 'Not reviewed',
};

function multiplierClockV1(
  representation: MarketRealityRepresentationWireV1,
  nowIso: string,
): ClockCaptionV1 {
  const label = 'Multiplier';
  if (representation.normalization === 'reviewed_token_already_applied') {
    // No second reading exists, so there is no clock. Saying so is better than
    // an empty column, which reads as a value we failed to fetch.
    return {
      id: 'multiplier',
      label,
      state: 'In the token',
      detail: 'nothing separate to age',
      tone: 'neutral',
    };
  }
  const checkedAge = quoteAgeLabelV1(representation.normalizationCheckedAt ?? null, nowIso);
  if (!checkedAge) {
    return { id: 'multiplier', label, state: 'Not read', detail: null, tone: 'off' };
  }
  const expiresAt = representation.normalizationExpiresAt ?? null;
  const open = expiresAt !== null && Date.parse(expiresAt) > Date.parse(nowIso);
  if (representation.normalization === 'fresh_ratio_applied' && open) {
    return { id: 'multiplier', label, state: 'Applied', detail: `read ${checkedAge}`, tone: 'good' };
  }
  // Two different things were wearing one word. Caught on production: a card
  // read "Window closed · read 4h ago" against a seven-hour window. The window
  // was open; there was simply no quote, so nothing asked the ratio to
  // normalize anything. Saying the reading expired when it had not is the same
  // class of error as our own failure wearing the token's name.
  return open
    ? {
        id: 'multiplier',
        label,
        state: 'Read, not applied',
        detail: `read ${checkedAge}`,
        tone: 'neutral',
      }
    : {
        // The case this caption was written for. `not_established` reads as
        // "we never knew"; what actually happened is that we knew, and the
        // window closed. The reading and its age are still stated.
        id: 'multiplier',
        label,
        state: 'Window closed',
        detail: `read ${checkedAge}`,
        tone: 'off',
      };
}

/**
 * What stands between a reader and holding this, on the card, unexpanded.
 *
 * The terms list below grades OUR EVIDENCE — every Coinbase field reads
 * "Reviewed", including the one whose reviewed content is that the product is
 * not offered to US persons. Those are two different axes folded into one word,
 * and the word that won is the one about us. A reader who cannot legally hold
 * the token saw "Reviewed" and a collapsed section.
 *
 * So the restriction is read from the reviewed KIND, which is machine-readable,
 * and stated in the reader's own terms. Anything whose kind is not in this map
 * contributes nothing: an unmapped kind is not a licence to invent a blocker,
 * and the full terms list is one press away either way.
 *
 * These are the ISSUER's terms. They are not a check on this wallet — that
 * measurement is the transfer gate, it lives on the review screen, and merging
 * the two would let a reviewed document answer a question only the registry can.
 */
export interface AccessNoticeViewV1 {
  label: string;
  note: string;
}

const ACCESS_NOTICE_BY_KIND_V1: Readonly<Record<string, string>> = {
  // Who may hold it.
  outside_us_secondary_permissionless_primary_kyc:
    'Not offered to US persons. Eligible jurisdictions only.',
  issuer_account_and_jurisdiction:
    'Needs an approved account with the issuer, and some jurisdictions are excluded.',
  restricted_jurisdictions_primary_kyc:
    'Some jurisdictions are excluded, and issuing needs an approved account.',
  // Whether a transfer can be stopped.
  policy_screened_permissionless_secondary:
    'Anyone may hold and trade it, but issuer policy can still block a specific address.',
  blacklist_restrictor: 'The issuer can block a specific address from transferring.',
  no_technical_restrictions: 'The contract itself stops no transfer.',
  // Getting out through the issuer, as opposed to through the market.
  authorized_participant_primary_market:
    'You cannot redeem with the issuer. The only way out is the market.',
  issuer_account_kyc: 'Redeeming needs an approved account with the issuer.',
  existing_holders_supported_new_issuance_closed:
    'New issuance is closed. Existing holders are still supported.',
};

export function accessNoticesV1(issuerId: IssuerIdV1): AccessNoticeViewV1[] {
  const adapter = REPRESENTATION_STRUCTURE_ADAPTERS_V1[issuerId];
  const rows: AccessNoticeViewV1[] = [];
  const add = (label: string, entry: { status: string; value: string | null }) => {
    // Only a REVIEWED value speaks here. `unknown` is the absence of evidence,
    // and an absence rendered as a restriction is a claim nobody made.
    if (entry.status !== 'reviewed' || entry.value === null) return;
    const note = ACCESS_NOTICE_BY_KIND_V1[entry.value];
    if (note) rows.push({ label, note });
  };
  add('Who may hold it', adapter.eligibility);
  add('Transfers', adapter.transferRestrictions);
  add('Getting out', adapter.redemption);
  return rows;
}

function termsV1(representation: MarketRealityRepresentationWireV1): FactViewV1[] {
  const adapter = REPRESENTATION_STRUCTURE_ADAPTERS_V1[representation.issuerId];
  const field = (
    label: string,
    entry: { status: 'reviewed' | 'unknown'; note: string },
  ): FactViewV1 => ({
    label,
    value: entry.status === 'reviewed' ? 'Reviewed' : 'Not confirmed yet',
    note: entry.note,
    // `unknown` is the absence of evidence, not a warning about the issuer.
    tone: entry.status === 'reviewed' ? 'neutral' : 'off',
  });
  return [
    field('Holding', adapter.transferRestrictions),
    field('Getting out through the issuer', adapter.redemption),
    field('Distributions', adapter.distributions),
    field('Who may hold it', adapter.eligibility),
    // The two questions a reader asks about a tokenized share before any of
    // the above — who is holding the actual share, and who watches them —
    // which this card recorded the claim model for and never answered.
    field('Who holds the shares', adapter.custody),
    field('Who supervises the structure', adapter.supervision),
  ];
}

function technicalV1(
  representation: MarketRealityRepresentationWireV1,
  nowIso: string,
  withheldFacts: readonly WithheldFactViewV1[] = [],
): { label: string; value: string }[] {
  const rows: { label: string; value: string }[] = [
    { label: 'Contract', value: representation.tokenAddress },
    { label: 'Instrument key', value: representation.issuerInstrumentKey },
    { label: 'Representation', value: representation.representationKind },
    { label: 'Engine status', value: representation.status },
    { label: 'Normalization', value: representation.normalization },
    { label: 'Supply state', value: representation.supply.state },
    {
      label: 'Total supply (atomic)',
      value: representation.supply.totalSupplyAtomic ?? 'not established',
    },
    {
      label: 'Supply evidence',
      value: representation.supply.observedAt
        ? `${representation.supply.readOutcome} · ${quoteAgeLabelV1(representation.supply.observedAt, nowIso) ?? representation.supply.observedAt}`
        : representation.supply.readOutcome,
    },
  ];
  if (representation.routePolicyKey) {
    rows.push({ label: 'Route policy', value: representation.routePolicyKey });
  }
  // The withheld rows, in full. When the card replaces them with their single
  // cause, this is where the four field-level absences still have to be
  // readable — the collapse is a change of emphasis, never a loss of evidence.
  for (const fact of withheldFacts) {
    rows.push({ label: `Not established · ${fact.label}`, value: fact.note });
  }
  if (representation.exactTestedTokenAtomic) {
    rows.push({
      label: 'Tested token amount (atomic)',
      value: representation.exactTestedTokenAtomic,
    });
  }
  for (const source of representation.sources) {
    rows.push({
      label: `Source · ${source.source}`,
      value: source.errorCode ? `${source.status} (${source.errorCode})` : source.status,
    });
    if (source.quoteEvidence) {
      const age = quoteAgeLabelV1(source.quoteEvidence.observedAt, nowIso);
      rows.push({
        label: `Quote · ${source.source}`,
        value: `in ${source.quoteEvidence.inputAtomic} → out ${source.quoteEvidence.outputAtomic}${age ? ` · ${age}` : ''}`,
      });
      rows.push({ label: `Evidence · ${source.source}`, value: source.quoteEvidence.evidenceHash });
    }
  }
  rows.push({
    label: 'Reference',
    value: `${representation.reference.status} · ${representation.reference.marketSession} · ${representation.reference.publicationMode}`,
  });
  return rows;
}

const UTILITY_STATE_LABEL_V1: Readonly<Record<UtilityEvidenceStateV1, string>> = {
  available: 'Available',
  observed: 'Observed',
  documented: 'Documented',
  not_established: 'Not established',
  stale: 'Stale',
};

const UTILITY_SOURCE_LABEL_V1: Readonly<
  Record<RepresentationUtilityEdgeV1['evidence'][number]['kind'], string>
> = {
  reviewed_document: 'Reviewed documentation',
  reviewed_machine_api: 'Reviewed machine source',
  reviewed_source_code: 'Reviewed source code',
  base_chain_call: 'Base contract read',
  router_quote: 'Exact router quote',
  reviewed_registry_check: 'Reviewed registry check',
};

/**
 * Who published a cited document, by host.
 *
 * The label used to be the source's KIND, so an edge citing both the Base
 * standard and Coinbase's product page rendered
 * "Reviewed documentation  Reviewed documentation" — two links, one word, and
 * no way to tell which was which. It read as a duplication bug rather than as
 * two independent documents, which is the opposite of what citing two of them
 * is for.
 *
 * A CODE-OWNED registry, keyed on the exact host, never a prettified domain:
 * this is the same rule provider links follow everywhere else in the console.
 * An unknown host falls back to the kind label rather than inventing a
 * publisher out of a string we have not reviewed.
 */
const SOURCE_PUBLISHER_BY_HOST_V1: Readonly<Record<string, string>> = {
  'docs.base.org': 'Base standard',
  'www.coinbase.com': 'Coinbase product terms',
  'coinbase.com': 'Coinbase product terms',
  'docs.dinari.com': 'Dinari documentation',
  'assets.backed.fi': 'Backed legal documentation',
  'docs.xstocks.fi': 'Backed machine source',
  'github.com': 'Published source code',
  'docs.chain.link': 'Chainlink documentation',
};

export function sourceLabelV1(href: string | null, fallback: string): string {
  if (href === null) return fallback;
  try {
    return SOURCE_PUBLISHER_BY_HOST_V1[new URL(href).host] ?? fallback;
  } catch {
    return fallback;
  }
}

function latestQuoteV1(
  representation: MarketRealityRepresentationWireV1,
): MarketRealityQuoteWireV1 | null {
  let latest: MarketRealityQuoteWireV1 | null = null;
  for (const source of representation.sources) {
    const quote = source.quoteEvidence;
    if (!quote) continue;
    if (!latest || Date.parse(quote.observedAt) > Date.parse(latest.observedAt)) latest = quote;
  }
  return latest;
}

// ---------------------------------------------------------------------------
// Use & access — what can actually be done with this exact address.
//
// The tab used to open on a wall of citations. Every fact in it was true and
// almost none of it answered the question a reader arrived with, because three
// of its rows said "Not established" for things nobody had ever measured and
// the rest described a legal structure.
//
// Four measured sections first, in the order a person would ask: can I trade
// it, can I move it, can I bridge it, can anything lend against it. Then the
// issuer's own processes, then the documents. Nothing is hidden — the structure
// simply stops being the first screen.
// ---------------------------------------------------------------------------

export type UseSectionIdV1 =
  | 'trade'
  | 'transfer'
  | 'bridge'
  | 'pooled'
  | 'defi'
  | 'issuer'
  | 'how_it_works';

export interface UseSectionViewV1 {
  id: UseSectionIdV1;
  label: string;
  /** The answer, in one sentence, before any evidence. */
  headline: string;
  /** A short verdict chip. Never a number and never an id. */
  chip: string;
  tone: ToneV1;
  /** Consumer-facing lines. No selector, policy id, block tag or CAIP-10. */
  facts: FactViewV1[];
  /** Everything an operator needs and a reader does not: ids and raw reads. */
  evidence: { label: string; value: string }[];
  /** Issuer documentation, unchanged, for the two sections that carry it. */
  edges: UtilityEdgeViewV1[];
  /**
   * Whether this section opens closed.
   *
   * The four measured sections answer the question a reader arrived with — can
   * I trade it, move it, bridge it, does anything lend against it — in four
   * short blocks. Underneath them sat the issuer's authenticated processes and
   * the structure documents: several screens of prose about eligibility,
   * authorized participants and multiplier mechanics, none of which is a thing
   * the reader can do, all of which is true and worth keeping.
   *
   * So they keep their place and lose the space. Collapsed is not hidden: the
   * heading and its chip are still on the page, and the chip is the section's
   * whole verdict.
   */
  collapsed: boolean;
}

/** The LayerZero endpoint ids Miorail names, so a destination has a word. */
const BRIDGE_NETWORK_NAMES_V1: Readonly<Record<number, string>> = {
  30101: 'Ethereum',
  30102: 'BNB Chain',
  30106: 'Avalanche',
  30109: 'Polygon',
  30110: 'Arbitrum',
  30111: 'Optimism',
  30184: 'Base',
};

const SCOPE_SENTENCE_V1: Readonly<Record<'sender' | 'receiver' | 'executor', string>> = {
  sender: 'Your wallet can send',
  receiver: 'Your wallet can receive',
  executor: 'Route executor checked',
};

function tradeSectionV1(input: {
  exit: FactViewV1 | null;
  exitBasis: 'open' | 'last_measured' | null;
  openQuote: OpenQuoteViewV1 | null;
  lastMeasuredLabel: string | null;
  outcomeBody: string;
}): UseSectionViewV1 {
  // The bug this section replaces: the trade edge read only the twenty-second
  // quote, so a round trip measured half an hour ago and rendered in full on
  // Market Reality read here as "Stale". A live quote and a stored measurement
  // are different things, and an expired quote does not un-measure a trade.
  const live = input.openQuote?.state === 'live';
  const measured = input.exit !== null;
  const facts: FactViewV1[] = [];
  if (live && input.openQuote) {
    facts.push({
      label: 'Open right now',
      value: input.openQuote.value,
      note: input.openQuote.expiresInLabel,
      tone: 'good',
    });
  }
  if (input.exit) facts.push(input.exit);
  return {
    collapsed: false,
    id: 'trade',
    label: 'Trade',
    headline: live
      ? 'A router reaches this exact address at this size, and the quote is open now.'
      : measured
        ? `A router reached this exact address at this size when it was last measured${input.lastMeasuredLabel ? ` — ${input.lastMeasuredLabel.toLowerCase()}` : ''}. That measurement stands; only the live quote expired.`
        : input.outcomeBody,
    chip: live ? 'Tradable now' : measured ? 'Tradable when measured' : 'Not established',
    tone: live ? 'good' : measured ? 'neutral' : 'off',
    facts,
    evidence: [],
    edges: [],
  };
}

function transferSectionV1(
  use: RepresentationUseAccessV1 | null,
): UseSectionViewV1 {
  const facts: FactViewV1[] = [];
  const evidence: { label: string; value: string }[] = [];
  let chip = 'Not confirmed';
  let tone: ToneV1 = 'off';
  let headline =
    'Miorail has not read this contract’s transfer state. That is a gap in our reading, not a restriction on the token.';

  if (use?.transfers.state === 'read') {
    const paused = use.transfers.transfersPaused;
    chip = paused ? 'Transfers paused' : 'Transfers active';
    tone = paused ? 'warn' : 'good';
    headline = paused
      ? 'Transfers of this token are paused on chain right now. Nothing can be moved between wallets until that is lifted.'
      : 'Transfers of this token are active on chain right now.';
    facts.push({
      label: 'Transfers',
      value: paused ? 'Paused' : 'Active',
      note: 'read on chain, at the block in Evidence',
      tone: paused ? 'warn' : 'good',
    });
  } else if (use?.transfers.state === 'unread') {
    evidence.push({ label: 'Transfer pause read', value: use.transfers.reason });
  }

  for (const binding of use?.transferPolicies ?? []) {
    evidence.push({
      label: `Policy · ${binding.scope}`,
      value:
        binding.state === 'unrestricted'
          ? 'unrestricted (ALWAYS_ALLOW)'
          : binding.state === 'bound'
            ? `policy ${binding.policyId}${binding.policyExists ? '' : ' (registry has no such policy)'}`
            : `unread — ${binding.reason}`,
    });
  }

  // The wallet's own answer, and only the scopes that really gate it. Every
  // sentence here is about an ONCHAIN ADDRESS POLICY and nothing else.
  for (const check of use?.wallet?.checks ?? []) {
    const label = SCOPE_SENTENCE_V1[check.scope as 'sender' | 'receiver' | 'executor'];
    if (check.state === 'allowed') {
      facts.push({ label, value: 'Yes', note: 'this address passes the bound transfer policy', tone: 'good' });
    } else if (check.state === 'blocked') {
      facts.push({ label, value: 'No', note: 'this address does not pass the bound transfer policy', tone: 'warn' });
    } else if (check.state === 'unrestricted') {
      facts.push({ label, value: 'Yes', note: 'no policy gates this scope, so no address can fail it', tone: 'good' });
    } else if (check.state === 'not_confirmed') {
      facts.push({ label, value: 'Not confirmed', note: check.reason, tone: 'off' });
    }
  }
  if (use?.blockTag) evidence.push({ label: 'Read at block', value: use.blockTag });
  // Base Docs states this separately and it is exactly the kind of true fact a
  // reader turns into a false one: an allowance is not permission.
  evidence.push({
    label: 'approve()',
    value: 'not policy gated — an approval is not permission to transfer',
  });
  return {
    collapsed: false,
    id: 'transfer',
    label: 'Transfer',
    headline,
    chip,
    tone,
    facts,
    evidence,
    edges: [],
  };
}

function bridgeSectionV1(use: RepresentationUseAccessV1 | null): UseSectionViewV1 {
  const bridge = use?.bridge;
  if (!bridge || bridge.state === 'unread') {
    return {
      collapsed: false,
      id: 'bridge',
      label: 'Bridge',
      headline:
        'Miorail has not read this contract for a bridge. That is a gap in our reading, not an absence of one.',
      chip: 'Not confirmed',
      tone: 'off',
      facts: [],
      evidence: bridge?.state === 'unread' ? [{ label: 'Bridge read', value: bridge.reason }] : [],
      edges: [],
    };
  }
  if (bridge.state === 'none_detected') {
    return {
      collapsed: false,
      id: 'bridge',
      label: 'Bridge',
      headline:
        'No bridge capability answers at this exact address. Another representation of the same company may bridge; this contract does not.',
      chip: 'No bridge here',
      tone: 'neutral',
      facts: [],
      evidence: [{ label: 'LayerZero endpoint()', value: 'did not answer at this address' }],
      edges: [],
    };
  }
  const networks = bridge.configuredPeers.map(
    (id: number) => BRIDGE_NETWORK_NAMES_V1[id] ?? `endpoint ${id}`,
  );
  return {
    collapsed: false,
    id: 'bridge',
    label: 'Bridge',
    headline:
      networks.length > 0
        ? `A bridge is configured at this exact address to ${networks.join(', ')}.`
        : 'Bridge capability is present at this exact address, but no destination Miorail checked is configured. A capability with no peer can send nothing anywhere.',
    chip: networks.length > 0 ? 'Bridge established' : 'Bridge capability detected',
    tone: networks.length > 0 ? 'good' : 'neutral',
    facts: networks.map((network: string) => ({
      label: 'Bridge to',
      value: network,
      note: 'a peer is configured for this destination',
      tone: 'good' as const,
    })),
    evidence: [
      { label: 'LayerZero endpoint', value: bridge.endpointAddress ?? 'not decoded' },
      {
        label: 'Destinations checked',
        value: Object.values(BRIDGE_NETWORK_NAMES_V1).join(', '),
      },
    ],
    edges: [],
  };
}

/**
 * A publication date, spelled out.
 *
 * Everything else on this card is an age — "measured 4 minutes ago" — because
 * everything else is a reading that goes stale. An announcement does not: it
 * was made on a day, by somebody, and stays made. Pinned month names rather
 * than a locale so the same input renders the same string everywhere.
 */
// prettier-ignore
const MONTH_V1 = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
] as const;

export function announcementDateLabelV1(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!match) return iso;
  const month = MONTH_V1[Number(match[2]) - 1];
  if (!month) return iso;
  return `${Number(match[3])} ${month} ${match[1]}`;
}

const DEFI_USE_PHRASE_V1: Readonly<Record<DefiUseKindV1, string>> = {
  lend: 'lending',
  borrow: 'borrowing',
  collateral: 'use as collateral',
};

/**
 * The announcement, beside the reading, in the reader's own words.
 *
 * One rule holds this whole function together: nothing here may make the
 * section sound more available than the measurement did. An announcement never
 * sets a use, never lifts the tone above neutral, and the one case where it
 * says nothing at all is the case where the venue already listed the address
 * and answered the announced use — there the measurement IS the answer, and
 * repeating it in a second voice teaches nobody anything.
 */
function venueAnnouncementFactsV1(readings: readonly VenueAnnouncementReadingV1[]): FactViewV1[] {
  const facts: FactViewV1[] = [];
  for (const reading of readings) {
    const { announcement } = reading;
    const when = announcementDateLabelV1(announcement.announcedAt);
    const uses = announcement.uses.map((use) => DEFI_USE_PHRASE_V1[use]).join(' and ');
    const said = `${announcement.announcedBy} announced ${uses} at ${announcement.venueName} on ${when}.`;
    const label = `Announced at ${announcement.venueName}`;
    if (reading.measured === 'not_listed') {
      facts.push({
        label,
        value: 'Not there yet',
        // The sentence the announcement layer exists for. A reader who
        // arrived from that post must not read our "none found" as staleness.
        note: `${said} Read just now, ${announcement.venueName} does not list this exact address. Announced is not the same as live.`,
        tone: 'off',
      });
      continue;
    }
    if (reading.measured === 'unread') {
      facts.push({
        label,
        value: 'Venue not read',
        note: `${said} ${announcement.venueName} could not be read just now${reading.reason ? ` — ${reading.reason}` : ''}, so this is a gap in our reading, not an answer about the token.`,
        tone: 'off',
      });
      continue;
    }
    if (reading.measured === 'unchecked') {
      facts.push({
        label,
        value: 'Not checked here',
        note: `${said} ${announcement.venueName} was not among the venues this reading checked, so nothing here confirms or denies it.`,
        tone: 'off',
      });
      continue;
    }
    if (reading.unstatedUses.length > 0) {
      const unstated = reading.unstatedUses.map((use) => DEFI_USE_PHRASE_V1[use]).join(' and ');
      facts.push({
        label,
        value: `Listed, ${unstated} not read`,
        note: `${said} ${announcement.venueName} lists this exact address; whether ${unstated} is enabled for it is venue configuration this reading does not cover.`,
        tone: 'neutral',
      });
    }
  }
  return facts;
}

function venueAnnouncementEvidenceV1(
  readings: readonly VenueAnnouncementReadingV1[],
): { label: string; value: string }[] {
  return readings.map((reading) => ({
    label: `${reading.announcement.announcedBy} announcement`,
    value: `${reading.announcement.sourceTitle} · ${announcementDateLabelV1(reading.announcement.announcedAt)} · ${reading.announcement.sourceRef}`,
  }));
}

/**
 * Which axis each venue row was read on, said once, in evidence.
 *
 * The block under Transfer governs the pinned reads and nothing here: two
 * venues answer from chain state at head and two from their own catalogues,
 * which publish no block at all. A reader who is not told that attributes the
 * block above to all four rows — which is exactly what a reviewer did.
 */
function venueReadProvenanceEvidenceV1(
  venues: readonly RepresentationUseAccessV1['defi']['venues'][number][],
): { label: string; value: string }[] {
  const named = (source: 'chain_head' | 'venue_catalogue') =>
    venues.filter((venue) => venue.observed?.source === source).map((venue) => venue.venueName);
  const chain = named('chain_head');
  const catalogue = named('venue_catalogue');
  if (chain.length === 0 && catalogue.length === 0) return [];
  const parts: string[] = [];
  if (chain.length > 0) parts.push(`${chain.join(', ')} — read on chain at head`);
  if (catalogue.length > 0) {
    parts.push(
      `${catalogue.join(', ')} — read from the venue’s own catalogue, which publishes no block`,
    );
  }
  return [
    {
      label: 'How these were read',
      value: `${parts.join('. ')}. Separate readings, each at its own moment; the block under Transfer covers none of them.`,
    },
  ];
}

/**
 * Lending, and named for lending.
 *
 * This section was called "DeFi" and checked four venues — Moonwell, Morpho,
 * Aave v3 and Compound v3 — every one of them a LENDING protocol. So on a
 * screen whose Trade section reads "Tradable now · a router reaches this exact
 * address and the quote is open", the section two below it read "DeFi · none
 * found here". Both sentences were about the same token, both were true of what
 * they measured, and the one with the broader word measured the narrower thing.
 *
 * Trading through an AMM is DeFi. The label is the fix: six sections that do
 * not overlap, each claiming exactly its own scope. The body already bounded
 * itself correctly — it named the four venues and said other venues were not
 * checked — and it keeps doing that.
 *
 * What this does NOT do is add an LP or vault reader. Aerodrome, Beefy, Euler
 * and the rest are real and unchecked, and `unchecked` is not `not_listed`.
 */
/**
 * The pools that hold this exact address, and what was measured in them.
 *
 * This is the section the screen was missing. "Lend and borrow" reads four
 * lending venues and says so honestly, and for these tokens the honest answer
 * there is almost always no — while an Aerodrome concentrated-liquidity pool
 * holds 3,740 NVDAc against $1.61m of USDC. Trading through an AMM is the
 * largest onchain use these tokens have, and until now the only place it
 * appeared was the Trade section's router quote, which answers a different
 * question.
 *
 * RANKED BY BALANCE, NEVER BY COUNT. Thirty-nine pools hold NVDAc and
 * twenty-four of them pair it against a memecoin — 71 NVDAc against 212
 * million KUMA. "39 pools" is true arithmetic about a market that does not
 * exist, so the section leads with the deepest and says how many are tiny.
 *
 * NOT DEPTH, and the copy has to keep saying so. A balance is what the contract
 * holds; what a trade of a given size would actually get is measured by a
 * router quote at that exact size, in Trade, and a reader who takes this for
 * that has been told the wrong thing by a true number.
 */
function pooledSectionV1(use: RepresentationUseAccessV1 | null): UseSectionViewV1 {
  const pools = use?.pools;
  if (!pools || pools.state !== 'measured' || pools.rows.length === 0) {
    return {
      collapsed: false,
      id: 'pooled',
      label: 'Pooled liquidity',
      // Both branches say it as OUR gap. "This deployment does not measure
      // pooled liquidity" is a fact about us stated as if it were a property of
      // the token, and a reader takes an empty section for an empty market —
      // which is the whole failure that put this section on the screen.
      headline:
        pools && pools.state === 'not_measured'
          ? 'Miorail did not check the pools holding this address. Not checked is not the same as none: pools may exist and hold real amounts.'
          : 'Miorail did not check the pools holding this address.',
      chip: 'Not checked',
      tone: 'off',
      facts: [],
      evidence: [],
      edges: [],
    };
  }

  const amount = (atomic: string, decimals: number): string => {
    // Decimal-string arithmetic. A balance parsed through a float loses its
    // last digits, and those digits are the difference between a pool holding
    // $1,614,910.95 and one holding $1,614,910.
    const negative = atomic.startsWith('-');
    const digits = negative ? atomic.slice(1) : atomic;
    const padded = digits.padStart(decimals + 1, '0');
    const whole = padded.slice(0, padded.length - decimals) || '0';
    const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    if (decimals === 0) return grouped;
    const fraction = padded.slice(padded.length - decimals).replace(/0+$/, '');
    return fraction ? `${grouped}.${fraction.slice(0, 2)}` : grouped;
  };

  const rows = pools.rows;
  const lead = rows[0]!;
  const named = rows.filter((row) => row.venueName !== null);
  const venues = [...new Set(named.map((row) => row.venueName as string))];
  // How concentrated the pooled amount is, as a MEASURED share rather than a
  // threshold somebody chose. A first draft called every pool below a
  // hundredth of the largest "noise", which is a judgement wearing a number: on
  // the real corpus the memecoin pairs sit at about a fiftieth and the line
  // silently stopped firing. A share of the total says the same thing — one
  // pool is the market — and says it from the measurements themselves.
  const leadBalance = BigInt(lead.tokenBalanceAtomic);
  const totalBalance = rows.reduce((sum, row) => sum + BigInt(row.tokenBalanceAtomic), 0n);
  const leadShare =
    totalBalance > 0n ? Number((leadBalance * 1000n) / totalBalance) / 10 : null;

  const facts: FactViewV1[] = rows.slice(0, 6).map((row) => ({
    label: row.venueName ?? 'Venue not identified',
    value: `${amount(row.tokenBalanceAtomic, row.tokenDecimals)} held`,
    note:
      row.pairedBalanceAtomic !== null && row.pairedDecimals !== null
        ? `against ${amount(row.pairedBalanceAtomic, row.pairedDecimals)} ${row.pairedSymbol ?? 'of the other side'} · ${row.poolAddress.slice(0, 8)}\u2026${row.poolAddress.slice(-4)}`
        : `the other side was not read · ${row.poolAddress.slice(0, 8)}\u2026${row.poolAddress.slice(-4)}`,
    // Neutral for every row. A balance is a size, not a quality, and colouring
    // the deepest pool green would make the section a recommendation about
    // where to trade — which is the one thing this board must never be.
    tone: 'neutral',
  }));

  return {
    collapsed: false,
    id: 'pooled',
    label: 'Pooled liquidity',
    headline:
      `${rows.length} pool${rows.length === 1 ? '' : 's'} on Base hold this exact address. ` +
      `The deepest holds ${amount(lead.tokenBalanceAtomic, lead.tokenDecimals)}` +
      (lead.pairedBalanceAtomic !== null && lead.pairedDecimals !== null
        ? ` against ${amount(lead.pairedBalanceAtomic, lead.pairedDecimals)} ${lead.pairedSymbol ?? 'of the other side'}`
        : '') +
      `${lead.venueName ? ` on ${lead.venueName}` : ''}. ` +
      // The count is bounded the moment it is said, because a count is the one
      // number here that flatters a market that does not exist: thirty-nine
      // pools hold NVDAc and one of them holds ninety-one per cent of it.
      (leadShare !== null && rows.length > 1
        ? `That one pool holds ${leadShare}% of everything measured in pools, so a pool is not a market. `
        : '') +
      'These are balances the contracts hold, not what a trade of a given size would get — that is measured under Trade.',
    chip: venues.length > 0 ? (venues[0] as string) : 'Measured',
    tone: 'neutral',
    facts,
    evidence: [
      { label: 'Pools measured', value: String(rows.length) },
      {
        label: 'Venues named',
        value: venues.length > 0 ? venues.join(', ') : 'none identified',
      },
      {
        label: 'Not identified',
        value: String(rows.length - named.length),
      },
      { label: 'Block', value: pools.blockNumber === null ? 'not stated' : String(pools.blockNumber) },
      { label: 'Read at', value: pools.readAt ?? 'not stated' },
      ...rows
        .slice(0, 10)
        .map((row) => ({
          label: row.poolAddress,
          value: `${row.venueId ?? 'unidentified'} · factory ${row.factoryAddress ?? 'none'}`,
        })),
    ],
    edges: [],
  };
}

function defiSectionV1(
  use: RepresentationUseAccessV1 | null,
  issuerId: IssuerIdV1 | null,
  /** Whether the Trade section established a live route at this size. The one
   * cross-reference this section makes, and only when it is true. */
  tradeEstablished = false,
): UseSectionViewV1 {
  const listing = use?.defi;
  const checked = listing?.checkedVenues ?? [];
  const uses: { kind: DefiUseKindV1; venues: string[] }[] = listing
    ? establishedDefiUsesV1(listing)
    : [];
  const unread = (listing?.venues ?? []).filter(
    (venue: RepresentationUseAccessV1['defi']['venues'][number]) => venue.state === 'unread',
  );
  // Read even when the whole listing is missing: an announcement about a venue
  // nobody checked is `unchecked`, which is a different sentence from silence.
  const announcements = venueAnnouncementReadingsV1({
    issuerId,
    venues: listing?.venues ?? [],
  });
  const announcementFacts = venueAnnouncementFactsV1(announcements);
  const evidence = [
    ...venueAnnouncementEvidenceV1(announcements),
    ...(listing?.venues ?? []).map(
      (venue: RepresentationUseAccessV1['defi']['venues'][number]) => ({
        label: venue.venueName,
        value:
          venue.state === 'listed'
            ? `listed${venue.curated === false ? ' · permissionless market' : ''}${venue.marketRef ? ` · ${venue.marketRef}` : ''}`
            : venue.state === 'unread'
              ? `unread — ${venue.reason ?? 'no reason given'}`
              : 'not listed',
      }),
    ),
    ...venueReadProvenanceEvidenceV1(listing?.venues ?? []),
  ];
  // Did the venue put this asset on its list, or did somebody deploy a market
  // against it?
  //
  // Both tokenized-stock markets that exist on Base — wbCOIN and METAc, both on
  // Morpho — come back `listed: false`. Morpho is permissionless: anyone can
  // create a market for any token, so an uncurated one proves a market EXISTS,
  // not that the venue accepted the asset. Rendering the two the same way is
  // the strongest sentence on this card resting on the weakest evidence.
  const uncurated = (listing?.venues ?? []).filter(
    (venue: RepresentationUseAccessV1['defi']['venues'][number]) =>
      venue.state === 'listed' && venue.curated === false,
  );
  const allUncurated = uses.length > 0 && uncurated.length === (listing?.venues ?? []).filter(
    (venue: RepresentationUseAccessV1['defi']['venues'][number]) => venue.state === 'listed',
  ).length;
  if (uses.length > 0) {
    return {
      collapsed: false,
      id: 'defi',
      label: 'Lend and borrow',
      headline: `This exact address is used in DeFi: ${uses
        .map((entry) => `${DEFI_USE_LABEL_V1[entry.kind]} at ${entry.venues.join(', ')}`)
        .join('; ')}.${
        allUncurated
          ? ' The market exists but is not on the venue’s curated list — anyone can create one.'
          : ''
      }`,
      chip: allUncurated ? 'Permissionless market' : 'Integration found',
      tone: allUncurated ? 'neutral' : 'good',
      facts: [
        ...uses.map((entry) => ({
          label: DEFI_USE_LABEL_V1[entry.kind],
          value: entry.venues.join(', '),
          note: allUncurated
            ? 'a market names this exact address; the venue has not listed it'
            : 'the venue names this exact address',
          tone: allUncurated ? ('neutral' as const) : ('good' as const),
        })),
        ...announcementFacts,
      ],
      evidence,
      edges: [],
    };
  }
  return {
    collapsed: false,
    id: 'defi',
    label: 'Lend and borrow',
    headline:
      checked.length > 0
        ? `No reviewed lending venue lists this exact address (${checked.join(', ')} were checked). Other venues exist and were not checked.${
            // Said only when we measured it ourselves, one section above. A
            // reader who takes "none found here" for a verdict about DeFi has
            // been told the opposite of what the same screen just proved.
            tradeEstablished
              ? ' Trading it on an AMM is DeFi too, and that is measured under Trade above.'
              : ''
          }`
        : 'Miorail did not check any lending venue for this address.',
    // Bounded to what was actually asked. "None found here" read as a verdict
    // on the token rather than an answer from four lending venues.
    chip: unread.length > 0 && unread.length === checked.length ? 'Not confirmed' : 'Not on these venues',
    tone: 'off',
    facts: announcementFacts,
    evidence,
    edges: [],
  };
}

const DEFI_USE_LABEL_V1: Readonly<Record<'lend' | 'borrow' | 'collateral', string>> = {
  lend: 'Lend',
  borrow: 'Borrow',
  collateral: 'Collateral',
};

export function useSectionsV1(input: {
  use: RepresentationUseAccessV1 | null;
  /** Whose token this is. Issuer-scoped evidence is filtered by it, and null
   * shows none of it rather than the wrong issuer's. */
  issuerId?: IssuerIdV1 | null;
  groups: readonly UtilityGroupViewV1[];
  exit: FactViewV1 | null;
  exitBasis: 'open' | 'last_measured' | null;
  openQuote: OpenQuoteViewV1 | null;
  lastMeasuredLabel: string | null;
  outcomeBody: string;
  caip10: string;
}): UseSectionViewV1[] {
  const issuerEdges = input.groups
    .filter((group) => group.label === 'Issuer lifecycle')
    .flatMap((group) => group.edges);
  const structureEdges = input.groups
    .filter((group) => group.label === 'Access, transfer and value model')
    .flatMap((group) => group.edges);
  return [
    tradeSectionV1(input),
    transferSectionV1(input.use),
    bridgeSectionV1(input.use),
    // Pooled liquidity sits ABOVE lending, because for these tokens it is the
    // larger answer by orders of magnitude and the screen read as if it did
    // not exist.
    pooledSectionV1(input.use),
    // The trade verdict travels into the lending section, because the two are
    // both DeFi and the screen used to say so in only one of them.
    defiSectionV1(input.use, input.issuerId ?? null, tradeSectionV1(input).tone === 'good'),
    {
      collapsed: true,
      id: 'issuer',
      label: 'Issuer services',
      headline:
        'What the issuer documents it will do. These are authenticated processes, not actions Miorail can carry out.',
      chip: 'Documented',
      tone: 'neutral',
      facts: [],
      evidence: [],
      edges: issuerEdges,
    },
    {
      collapsed: true,
      id: 'how_it_works',
      label: 'How it works',
      headline:
        'What this token represents and how its value is referenced. Structure, not availability.',
      chip: 'Reference',
      tone: 'neutral',
      facts: [],
      evidence: [{ label: 'Exact address', value: input.caip10 }],
      edges: structureEdges,
    },
  ];
}

function utilityEdgeViewV1(
  edge: RepresentationUtilityEdgeV1,
  nowIso: string,
): UtilityEdgeViewV1 {
  return {
    edgeId: edge.edgeId,
    label: edge.label,
    state: edge.state,
    stateLabel: UTILITY_STATE_LABEL_V1[edge.state],
    checkedAt: edge.checkedAt,
    checkedAgo: quoteAgeLabelV1(edge.checkedAt, nowIso),
    providerLabel: edge.providerId,
    note: edge.note,
    eligibilityNote: edge.eligibilityNote,
    sources: edge.evidence.map((source) => {
      const href = /^https:\/\//.test(source.ref) ? source.ref : null;
      return {
        label: sourceLabelV1(href, UTILITY_SOURCE_LABEL_V1[source.kind]),
        href,
        checkedAt: source.checkedAt,
      };
    }),
  };
}

/**
 * "What can I do with this exact representation?" — answered from the edges.
 *
 * The panel already held every fact; what it did not hold was an answer. Each
 * edge rendered at the same weight as every other, with its documents beneath
 * it, so the first thing a reader met was a wall of citations to prospectuses.
 * This buckets the SAME edges by the SAME states — nothing new is asserted, and
 * an edge that says "not established" still says exactly that.
 *
 * `available` and `observed` are the only states that answer the question in
 * the present tense, and they are kept apart from `documented`, which is a
 * process the issuer describes and Miorail cannot perform.
 */
export function utilityAnswerV1(groups: readonly UtilityGroupViewV1[]): UtilityAnswerViewV1 {
  const edges = groups.flatMap((group) => group.edges);
  const pick = (...states: readonly UtilityEvidenceStateV1[]): string[] =>
    edges.filter((edge) => states.includes(edge.state)).map((edge) => edge.label);
  const now = pick('available', 'observed');
  const documented = pick('documented');
  const stale = pick('stale');
  const gaps = pick('not_established');
  const buckets = [
    {
      label: 'Established right now',
      note: 'measured against this exact address, in this direction and size',
      items: now,
    },
    {
      label: 'Documented by the issuer',
      note: 'a process the issuer describes — not something Miorail can carry out',
      items: documented,
    },
    {
      label: 'Measured before, not open now',
      note: 'it answered once; that answer is history until it is measured again',
      items: stale,
    },
    {
      label: 'Not established',
      note: 'no reviewed exact-address evidence — an evidence gap, never a claim that it is impossible',
      items: gaps,
    },
  ].filter((bucket) => bucket.items.length > 0);
  const headline =
    now.length > 0
      ? `Established right now at this exact address: ${now.join(', ').toLowerCase()}. Everything else below is documentation or a gap.`
      : documented.length > 0
        ? 'Nothing here is established as doable right now at this exact address. What follows is what the issuer documents, and where the evidence stops.'
        : 'Nothing is established at this exact address yet. Every line below names a gap in evidence, not a property of the token.';
  return { headline, buckets };
}

function utilityViewV1(
  representation: MarketRealityRepresentationWireV1,
  nowIso: string,
): RepresentationViewV1['utility'] {
  const quote = latestQuoteV1(representation);
  const quoteOpen = quote !== null && Date.parse(quote.expiresAt) > Date.parse(nowIso);
  const last = representation.lastObservation;
  const source = quote?.source ?? last?.source ?? representation.sources[0]?.source ?? null;
  const outcome = representationOutcomeV1(representation, nowIso);
  const marketTrade = quote
    ? {
        state: quoteOpen ? ('observed' as const) : ('stale' as const),
        providerId: quote.source,
        checkedAt: quote.observedAt,
        evidenceRef: `router_quote:${quote.evidenceHash}`,
        note: quoteOpen
          ? 'A router reached this exact representation and size. The quote estimates economics; execution is not established.'
          : 'A router previously reached this exact representation and size, but that quote is now history.',
      }
    : {
        state: 'not_established' as const,
        providerId: source,
        checkedAt:
          last?.observedAt ?? representation.observedAt ?? representation.supply.observedAt ?? nowIso,
        evidenceRef: null,
        note:
          outcome === 'no_route' || outcome === 'stale_finding'
            ? 'No approved router route was established for this exact direction and size. This route-scoped result is not an asset-wide claim.'
            : outcome === 'provider_failed'
              ? 'Miorail did not obtain a successful router measurement. Provider failure is not a claim about the representation.'
              : outcome === 'unsized'
                ? 'The exact market question was not sized, so route reachability was not established.'
                : 'No reviewed exact-address router observation establishes trade reachability for this question.',
      };

  const map = representationUtilityMapV1({
    tokenAddress: representation.tokenAddress,
    issuerId: representation.issuerId,
    evaluatedAt: nowIso,
    marketTrade,
  });
  const [trade, ...defi] = map.marketDefi.map((edge) => utilityEdgeViewV1(edge, nowIso));
  const allDefiUnestablished =
    defi.length > 0 &&
    defi.every(
      (edge) =>
        edge.state === 'not_established' && edge.sources.length === 0 && edge.providerLabel === null,
    );
  const defiPresentation: UtilityEdgeViewV1[] = allDefiUnestablished
    ? [
        {
          ...defi[0]!,
          edgeId: 'defi_reviewed_integrations',
          label: 'Lending, borrowing, collateral, vaults and liquidity',
          note:
            'No reviewed exact-address integration is established in these DeFi categories. This is one evidence gap, not six unavailable-product claims.',
        },
      ]
    : defi;
  const issuerViews = map.issuer.map((edge) => utilityEdgeViewV1(edge, nowIso));
  const accessIds = new Set<UtilityEdgeViewV1['edgeId']>([
    'representation_claim_model',
    'representation_transfer',
    'representation_eligibility',
    'representation_reference_model',
  ]);
  const combineIssuerEdgesV1 = (
    edgeId: 'issuer_primary_market' | 'issuer_value_lifecycle',
    label: string,
    sourceIds: readonly UtilityEdgeViewV1['edgeId'][],
  ): UtilityEdgeViewV1 | null => {
    const selected = issuerViews.filter((edge) => sourceIds.includes(edge.edgeId));
    if (selected.length !== sourceIds.length || selected.length === 0) return null;
    const sources = new Map<string, UtilitySourceViewV1>();
    for (const edge of selected) {
      for (const source of edge.sources) {
        sources.set(`${source.label}:${source.href ?? ''}:${source.checkedAt}`, source);
      }
    }
    const latest = selected.reduce(
      (value, edge) =>
        Date.parse(edge.checkedAt) > Date.parse(value) ? edge.checkedAt : value,
      selected[0]!.checkedAt,
    );
    const allDocumented = selected.every((edge) => edge.state === 'documented');
    return {
      ...selected[0]!,
      edgeId,
      label,
      state: allDocumented ? 'documented' : 'not_established',
      stateLabel: allDocumented ? 'Documented terms' : 'Evidence gap',
      checkedAt: latest,
      checkedAgo: quoteAgeLabelV1(latest, nowIso),
      note: selected.map((edge) => edge.note).join(' '),
      sources: [...sources.values()],
    };
  };
  const primaryMarket = combineIssuerEdgesV1(
    'issuer_primary_market',
    'Primary issue and redemption',
    ['issuer_mint_issue', 'issuer_redeem_sell'],
  );
  const valueLifecycle = combineIssuerEdgesV1(
    'issuer_value_lifecycle',
    'Distributions and corporate actions',
    ['issuer_distributions', 'issuer_corporate_actions'],
  );
  const bridge = issuerViews.find((edge) => edge.edgeId === 'issuer_bridge');
  const groups: UtilityGroupViewV1[] = [
      {
        label: 'Market reachability',
        edges: trade ? [trade] : [],
      },
      { label: 'Access, transfer and value model', edges: issuerViews.filter((edge) => accessIds.has(edge.edgeId)) },
      {
        label: 'Issuer lifecycle',
        edges: [primaryMarket, valueLifecycle, bridge].filter(
          (edge): edge is UtilityEdgeViewV1 => edge !== null && edge !== undefined,
        ),
      },
      { label: 'Reviewed DeFi integrations', edges: defiPresentation },
  ];
  return { caip10: map.caip10, answer: utilityAnswerV1(groups), groups };
}

/**
 * The security's name when the chooser has not arrived yet.
 *
 * `security:isin:US67066G1040` is a storage key, and it was the page's heading
 * for as long as the index request was in flight or the selected key was not in
 * the chooser's list. A reader is owed the identifier, not the key that holds
 * it.
 */
function underlyingKeyPartsV1(key: string): { scheme: string; value: string } | null {
  const parts = key.split(':');
  if (parts.length !== 3 || parts[0] !== 'security') return null;
  const [, scheme, value] = parts;
  if (!scheme || !value) return null;
  return { scheme: scheme.toUpperCase(), value };
}

function underlyingKeyTitleV1(key: string): string {
  const parts = underlyingKeyPartsV1(key);
  return parts ? parts.value : key;
}

function underlyingKeyIdentifierV1(key: string): string | null {
  const parts = underlyingKeyPartsV1(key);
  return parts ? `${parts.scheme} ${parts.value}` : null;
}

export function underlyingChoicesV1(
  wire: MarketRealityIndexWireV1 | null,
): UnderlyingChoiceViewV1[] {
  if (!wire) return [];
  return wire.entries.map((entry) => ({
    underlyingKey: entry.underlyingKey,
    // Ticker first, company second.
    //
    // These rows are one line and they ellipsis, so `Microsoft Corporation
    // (MSFT)` rendered as `Microsoft Corporation (MS…` — cutting off exactly
    // the part a reader scans for. Leading with the ticker means the truncation
    // falls on the half that can afford it.
    //
    // Enrichment does not always reach a company name: some reviewed rows carry
    // the ticker in both fields, and `NVDA · NVDA` would read as a rendering
    // fault rather than as the one name Miorail actually holds.
    title:
      entry.displaySymbol && entry.displaySymbol !== entry.canonicalName
        ? `${entry.displaySymbol} · ${entry.canonicalName}`
        : entry.canonicalName,
    identifier:
      entry.identifierScheme && entry.identifierValue
        ? `${entry.identifierScheme.toUpperCase()} ${entry.identifierValue}`
        : null,
    issuerLine:
      entry.issuerIds.length === 0
        ? 'Issuer not attributed'
        : entry.issuerIds.map((id) => ISSUER_NAME_V1[id]).join(' · '),
    issuerIds: entry.issuerIds,
    representationCount: entry.representationCount,
    multiIssuer: entry.multiIssuer,
    emptyNote:
      entry.liveRepresentationCount === 0 && entry.representationCount > 0
        ? entry.representationCount === 1
          ? 'No tokens outstanding'
          : entry.representationCount === 2
            ? 'No tokens outstanding on either contract'
            : // "either" is two. MSTR has three.
              `No tokens outstanding on any of ${entry.representationCount} contracts`
        : null,
  }));
}

export interface StockFilterViewV1 {
  id: 'all' | 'multi' | IssuerIdV1;
  label: string;
  /** How many of the reviewed securities this chip would leave on screen. */
  count: number;
}

/**
 * The filter chips, derived from the corpus rather than typed out.
 *
 * They used to be a literal list of five, and one of them was Dinari. Dinari
 * has a hundred contracts proven to be dShares and NOT ONE bound to a security
 * — a root proves who deployed an address, never which share it is — so
 * pressing it emptied the page. A filter that can only return nothing is worse
 * than an absent one: it reads as a broken product rather than as a gap in
 * coverage, and it is the first thing a demo finds.
 *
 * `multi` appears only when something is actually held by two issuers, for the
 * same reason.
 */
/**
 * Markets first, reviewed-but-empty second.
 *
 * Nine of the thirteen Coinbase tokenized stocks hold exactly zero, and a
 * chooser that interleaves them makes a product with four working markets look
 * like a product that mostly does not work. Neither set is hidden and neither is
 * ranked: this is the denominator separation the comparison already publishes
 * ("3 reviewed · 0 with tokens outstanding"), applied to the list a reader picks
 * from. An empty representation keeps its exact address and all of its evidence
 * — it simply stops occupying the first screen.
 */
export function partitionChoicesBySupplyV1(
  choices: readonly UnderlyingChoiceViewV1[],
): { live: UnderlyingChoiceViewV1[]; empty: UnderlyingChoiceViewV1[] } {
  const live: UnderlyingChoiceViewV1[] = [];
  const empty: UnderlyingChoiceViewV1[] = [];
  // `emptyNote` is set only when supply was READ and came back zero on every
  // contract. A representation nobody has read is not empty, and stays above.
  for (const choice of choices) (choice.emptyNote === null ? live : empty).push(choice);
  return { live, empty };
}

/**
 * The canonical representation first, the alternatives after it.
 *
 * Base documents one tokenized-stock standard on this chain — B20, issued by
 * Coinbase — and the measurements agree that it is also the one that answers:
 * on 2026-09-04 at $1,000 SELL, 10 of 13 Coinbase representations held a cash
 * route against 2 of 21 Backed and 0 of 96 Dinari. A board that presented all
 * three as peers put the reader's first card on a contract that mostly cannot
 * be priced.
 *
 * This is an ORDER and a heading, never a filter and never a ranking. Every
 * representation the comparison holds is still on the page with its own exact
 * address, because the thing this product knows that nothing else does is that
 * one security has several representations and they are not economically the
 * same. That claim needs the alternatives visible; it does not need them first.
 */
export function partitionByIssuerRoleV1(
  representations: readonly RepresentationViewV1[],
): { primary: RepresentationViewV1[]; others: RepresentationViewV1[] } {
  const primary: RepresentationViewV1[] = [];
  const others: RepresentationViewV1[] = [];
  for (const representation of representations) {
    (representation.issuerName === ISSUER_NAME_V1.coinbase ? primary : others).push(representation);
  }
  // With no Coinbase representation there is no primary and nothing to demote:
  // the alternatives ARE the page, and heading them "other" would be measuring
  // them against a card that is not there.
  if (primary.length === 0) return { primary: [], others: [] };
  return { primary, others };
}

/**
 * The answer, hoisted above everything that explains it.
 *
 * The page used to open on a title, three counters, a search field, five
 * filter chips, thirteen tiles, a collapsed section, two tabs, two rails, a
 * question console and a history rail -- and only then on the number a reader
 * came for. A whole viewport spent before the answer, every time, on a screen
 * whose entire job is to answer one question about one security.
 *
 * This is that answer, and it is a PROJECTION of the same view the board
 * renders. It computes nothing: the chip, the tone, the measured result and
 * its age all come from the representation card that is still below, so the
 * summary and the evidence cannot disagree. Nothing here is a ranking -- the
 * primary representation is the one Base documents as the standard, chosen by
 * issuer role and never by which number looks better.
 */
export interface StocksHeadlineViewV1 {
  title: string;
  identifier: string | null;
  /** The question, restated: "Selling $1,000 worth into USDC". */
  questionLine: string;
  /** Absent when this security has no Coinbase representation: then there is
   * no primary to lead with, and the board itself is the answer. */
  representation: {
    tokenAddress: string;
    shortAddress: string;
    issuerName: string;
    structureLabel: string;
    chip: string;
    tone: ToneV1;
    /** One sentence a reader can act on, from the card below. */
    body: string;
    /** Whose fact that sentence is. */
    attribution: RepresentationViewV1['attribution'];
    /** The measured round trip and its age. Null when nobody has measured. */
    lastSeen: { label: string; value: string; note: string } | null;
  } | null;
  /** How many representations the board holds, so the card never reads as the
   * whole page. */
  alternativeCount: number;
  /**
   * Why there is no primary card, when there is none. Null when there is one.
   *
   * Two different facts used to share one sentence. "No Coinbase
   * representation is on this board" is true when Coinbase never issued this
   * security, and it is ALSO what a reader saw for COIN, where Coinbase issued
   * a contract that holds no tokens. On the same screen the tile grid counts
   * COIN among "13 companies with a Coinbase B20 contract", so the page said
   * the contract exists and then said there is no representation. Both
   * sentences were true and the pair reads as a contradiction, with the reason
   * -- zero supply -- folded away inside a collapsed disclosure that does not
   * name which representation it means.
   */
  primaryAbsence: {
    kind: 'no_primary_representation' | 'primary_has_no_tokens_outstanding';
    /** The contract the reader was told about, when there is one. */
    shortAddress: string | null;
    sentence: string;
  } | null;
}

export function stocksHeadlineV1(
  view: MarketRealityViewV1 | null,
): StocksHeadlineViewV1 | null {
  if (!view) return null;
  const compared = view.representations.filter((row) => row.inComparison);
  const { primary } = partitionByIssuerRoleV1(compared);
  const lead = primary[0] ?? null;
  // The board excludes a representation for exactly one reason -- zero supply,
  // see `inComparison` -- so a primary that is reviewed but not compared is a
  // contract with no tokens outstanding, and the page can say which fact it is
  // instead of reporting the absence of the card as the absence of the issuer.
  const reviewedPrimary = lead
    ? null
    : (partitionByIssuerRoleV1(view.representations).primary[0] ?? null);
  return {
    title: view.title,
    identifier: view.identifier,
    questionLine: view.questionLine,
    representation: lead
      ? {
          tokenAddress: lead.tokenAddress,
          shortAddress: `${lead.tokenAddress.slice(0, 8)}\u2026${lead.tokenAddress.slice(-4)}`,
          issuerName: lead.issuerName,
          structureLabel: lead.structureLabel,
          chip: lead.outcomeChip,
          tone: lead.outcomeTone,
          body: lead.outcomeBody,
          attribution: lead.attribution,
          lastSeen: lead.lastSeen,
        }
      : null,
    // Every compared representation, the lead included: "3 representations"
    // is the board's size, not a count of what was left out.
    alternativeCount: compared.length,
    primaryAbsence: lead
      ? null
      : reviewedPrimary
        ? {
            kind: 'primary_has_no_tokens_outstanding',
            shortAddress: `${reviewedPrimary.tokenAddress.slice(0, 8)}\u2026${reviewedPrimary.tokenAddress.slice(-4)}`,
            sentence:
              `${reviewedPrimary.issuerName} has a contract for this security, but no tokens are ` +
              'outstanding, so there is nothing to price and nothing to lead with. Every reviewed ' +
              'representation is below, each on its own terms.',
          }
        : {
            kind: 'no_primary_representation',
            shortAddress: null,
            sentence:
              `No ${ISSUER_NAME_V1.coinbase} representation is on this board, so there is no ` +
              'primary contract to lead with. Every reviewed representation is below, each on ' +
              'its own terms.',
          },
  };
}

export function stockFiltersV1(
  choices: readonly UnderlyingChoiceViewV1[],
): StockFilterViewV1[] {
  const perIssuer = new Map<IssuerIdV1, number>();
  let multi = 0;
  for (const choice of choices) {
    if (choice.multiIssuer) multi += 1;
    for (const issuer of new Set(choice.issuerIds)) {
      perIssuer.set(issuer, (perIssuer.get(issuer) ?? 0) + 1);
    }
  }
  const filters: StockFilterViewV1[] = [{ id: 'all', label: 'All', count: choices.length }];
  if (multi > 0) filters.push({ id: 'multi', label: 'Multi-issuer', count: multi });
  // ISSUER_NAME_V1's own order, so the chips do not reshuffle when the corpus
  // grows and a reader does not have to re-find the one they use.
  for (const issuer of Object.keys(ISSUER_NAME_V1) as IssuerIdV1[]) {
    const count = perIssuer.get(issuer) ?? 0;
    if (count > 0) filters.push({ id: issuer, label: ISSUER_NAME_V1[issuer], count });
  }
  return filters;
}

/**
 * The headline counters, in units a reader can tell apart.
 *
 * Three numbers sat on one band under three labels that never named what they
 * counted: `Securities 13`, `Representations 39`, and a button reading `All
 * representations · 35`. Thirteen companies, thirty-nine contracts and
 * thirty-five companies — two units, three headings, and the only way to work
 * out which was which was to read the engine.
 *
 * Two changes, and neither of them hides anything. Every label now names its
 * own unit — a company or an exact address — and the totals are scoped, so in
 * the Coinbase scope the contract count is Coinbase contracts rather than every
 * contract bound to a Coinbase-covered company.
 */
export function underlyingCountersV1(wire: MarketRealityIndexWireV1 | null): FactViewV1[] {
  if (!wire) return [];
  const coinbaseScope = (wire.scope ?? 'all_representations') === 'coinbase_b20';
  return [
    {
      label: coinbaseScope ? 'Coinbase stocks' : 'Stocks',
      value: String(wire.totals.underlyings),
      note: coinbaseScope
        ? 'companies with a Coinbase B20 contract'
        : 'companies bound to a Base contract by a reviewed source',
      tone: 'neutral',
    },
    {
      label: coinbaseScope ? 'B20 contracts' : 'Contracts',
      value: String(wire.totals.boundRepresentations),
      note: coinbaseScope
        ? 'exact addresses on this page, one company each'
        : 'exact addresses across Coinbase, Backed and Dinari',
      tone: 'neutral',
    },
    {
      label: coinbaseScope ? 'Also represented elsewhere' : 'Multi-issuer stocks',
      value: String(wire.totals.multiIssuerUnderlyings),
      // The only number on the page that says whether a COMPARISON exists at
      // all. Counted by distinct issuer, so one issuer's token plus its own
      // wrapper never inflates it.
      note: coinbaseScope
        ? 'companies here that also have a Backed or Dinari contract to compare against'
        : 'companies represented by two or more issuers',
      tone: 'neutral',
    },
  ];
}

/**
 * What this page is a slice of, said above the grid.
 *
 * A scoped list whose counters move with the scope is honest about the page and
 * silent about the corpus: a reader has no way to tell whether thirteen is the
 * whole world or a thirteen-of-thirty-five view. Both numbers are on the wire,
 * so both are said, and the wider scope is named as a place to go rather than
 * as something withheld.
 */
export interface StockScopeViewV1 {
  title: string;
  body: string;
  /** The corpus this page is a slice of, said in the same unit the band counts
   * in. Null when this scope is the whole corpus. */
  aside: string | null;
  /** The scope this page is NOT showing, and how big it is. Null when there is
   * nothing else to show. */
  other: { scope: 'coinbase_b20' | 'all_representations'; label: string } | null;
  /**
   * Both corpora, as a switch rather than a one-way button.
   *
   * A reader standing in one corpus could not see the other was a corpus at
   * all: the only control was "View all issuers", which looks like a link to
   * somewhere else rather than the other half of a choice. Meanwhile the
   * issuer chips under the search field -- All, Multi-issuer, Coinbase,
   * Dinari, Backed -- filter WITHIN whichever corpus is loaded. Two scoping
   * ideas, drawn identically, meaning different things.
   */
  options: readonly {
    scope: 'coinbase_b20' | 'all_representations';
    label: string;
    /** Companies, the same unit the band above counts in. */
    count: number;
  }[];
  selected: 'coinbase_b20' | 'all_representations';
}

export function stockScopeViewV1(wire: MarketRealityIndexWireV1 | null): StockScopeViewV1 | null {
  if (!wire) return null;
  const scope = wire.scope ?? 'all_representations';
  const coinbase = wire.totals.coinbaseUnderlyings;
  const all = wire.totals.allUnderlyings;
  if (coinbase === undefined || all === undefined) return null;
  const others = all - coinbase;
  if (scope === 'coinbase_b20') {
    return {
      title: 'Coinbase Tokenized Stocks',
      // The B20 standard named once, because it is what every other Base
      // surface calls these and a reader arriving from one of them should not
      // have to work out that this is the same thing.
      body: 'The standard Base documents for tokenized stocks on this chain.',
      // The wider corpus, named in the SAME unit as the number above it. The
      // button used to read `All representations · 35` while the band above it
      // counted securities — so the one number a reader could compare it
      // against was in the other unit. It says what pressing it changes: the
      // set of issuers, not the set of companies.
      aside:
        others > 0
          ? `Miorail also tracks ${all} companies in total, across Coinbase, Backed and Dinari.`
          : null,
      other: others > 0 ? { scope: 'all_representations', label: 'View all issuers' } : null,
      // Both corpora, always both visible, so a reader can see which one they
      // are standing in. As a single "View all issuers" button it was a
      // one-way door with no lit state: the counters said "Coinbase stocks 13"
      // while the chips below offered All / Multi-issuer / Coinbase / Dinari /
      // Backed, and the two scoping ideas -- which corpus, and which issuer
      // within it -- looked identical and meant different things.
      options: [
        { scope: 'coinbase_b20', label: 'Coinbase B20', count: coinbase },
        ...(others > 0
          ? [{ scope: 'all_representations' as const, label: 'All reviewed', count: all }]
          : []),
      ],
      selected: 'coinbase_b20',
    };
  }
  return {
    title: 'Every reviewed representation on Base',
    body: `${all} companies across Coinbase, Backed and Dinari. The same company can be represented by several contracts, and they are not economically identical.`,
    aside: null,
    other: { scope: 'coinbase_b20', label: `Coinbase only · ${coinbase}` },
    options: [
      { scope: 'coinbase_b20', label: 'Coinbase B20', count: coinbase },
      { scope: 'all_representations', label: 'All reviewed', count: all },
    ],
    selected: 'all_representations',
  };
}

/**
 * The verdict, in a reader's words.
 *
 * Three shapes, because "all of them", "some of them" and "none of them" are
 * three different situations and a single sentence with a fraction in it reads
 * as none of them. The `none` case is the live product's state for every
 * security in the corpus, so it is the one that had to be written first.
 */
function coverageBodyV1(input: {
  status: 'complete' | 'incomplete';
  answered: number;
  eligible: number;
  reviewed: number;
  unresolvedSupply: number;
  subject: string;
}): string {
  const ways = input.reviewed === 1 ? 'one way' : `${input.reviewed} ways`;
  if (input.reviewed === 0) {
    return `No reviewed source has bound a Base contract to ${input.subject}.`;
  }
  if (input.unresolvedSupply > 0) {
    return `${input.subject} has ${ways} on Base, but current outstanding supply is unresolved for ${input.unresolvedSupply}. It stays visible and keeps market-outcome coverage incomplete.`;
  }
  if (input.eligible === 0) {
    return `${input.subject} has ${ways} on Base, but no representation currently has fresh evidence of outstanding supply. Reviewed zero-supply contracts remain visible below.`;
  }
  if (input.status === 'complete') {
    return `Miorail has a current market answer for all ${input.eligible} outstanding representations at this exact direction and size.`;
  }
  return `Miorail has a current market answer for ${input.answered} of ${input.eligible} outstanding representations at this exact direction and size. Each remaining card says what is missing.`;
}

/**
 * Round-trip cost per reviewed size, keyed by exact token address.
 *
 * Supplied by the caller rather than derived here: it comes from the stored
 * cash-exit run — the same read Discover has always rendered — and this view
 * builds from the market-reality answer. Passing it in keeps one projection of
 * the ladder in the product instead of a second one that can disagree with the
 * first.
 */
export interface RepresentationLadderInputV1 {
  rungs: FactViewV1[];
  note: string | null;
  /**
   * Whether the position can be CLOSED at the size being asked — not merely
   * whether a router answered.
   *
   * The Market Route Coverage Audit is why this field exists. Six reviewed
   * representations were quoting; two of them round-tripped to roughly nothing,
   * because the only pool behind them held a fraction of a token. Both facts
   * were already in the stored run — the buy leg, the sell leg, and the cost
   * between them — and neither reached the reader, because every surface asked
   * the ladder whether a quote existed and none asked what came back.
   *
   * Supplied by the caller for the same reason the rungs are: the cash-exit run
   * is read once, by the console, and projected once.
   */
  exit?: RepresentationExitEvidenceV1 | null;
}

/**
 * The measured cost of a full round trip at one exact size.
 *
 * `basis` is not decoration. A round trip computed from an open quote is a
 * statement about now; one computed from the last completed run is history,
 * and the card has to say which it is holding — the same split `openQuote` and
 * `lastMeasuredLabel` already keep.
 */
export interface RepresentationExitEvidenceV1 {
  /** Signed integer bps. Positive is cost, so larger is worse. */
  roundTripCostBps: string;
  /**
   * The two sides of the round trip, as MEASURED atomic USDC — the cash the
   * question put in, and the cash that came back out.
   *
   * Carried rather than reconstructed from the cost. The percentage is the
   * derived figure here (it is computed FROM these two), so rebuilding the
   * money from the percentage would print a number that never existed and
   * present it as a measurement. Null where the run did not complete both legs.
   */
  requestedCashAtomic: string | null;
  returnedCashAtomic: string | null;
  basis: 'open' | 'last_measured';
  /** When the measurement behind it completed. */
  observedAt: string;
}

export function marketRealityViewV1(input: {
  wire: MarketRealityWireV1 | null;
  choice: UnderlyingChoiceViewV1 | null;
  now: string;
  /** Keyed by lowercase token address. */
  ladders?: Readonly<Record<string, RepresentationLadderInputV1>>;
}): MarketRealityViewV1 | null {
  const wire = input.wire;
  if (!wire) return null;
  const direction = wire.question.direction;
  const sizeLabel =
    usdV1(wire.question.requestedCashAtomic, wire.question.cashDecimals) ?? 'this size';
  const questionLine =
    direction === 'sell'
      ? `Selling ${sizeLabel} worth into ${wire.question.destination}`
      : `Buying ${sizeLabel} worth with ${wire.question.destination}`;

  const reviewed = wire.universe.reviewedRepresentationCount;
  const eligible = wire.marketOutcomeCoverage.eligibleRepresentationCount;
  const answered = wire.marketOutcomeCoverage.establishedOutcomeCount;

  return {
    title: input.choice?.title ?? underlyingKeyTitleV1(wire.question.underlyingKey),
    identifier: input.choice?.identifier ?? underlyingKeyIdentifierV1(wire.question.underlyingKey),
    questionLine,
    coverageChip: `${answered} / ${eligible} market answers`,
    coverageTone: wire.marketOutcomeCoverage.status === 'complete' ? 'good' : 'warn',
    coverageDetail: wire.marketOutcomeCoverage.reason,
    comparisonSummary: [
      {
        label: 'Reviewed representations',
        value: String(reviewed),
        note: 'exact addresses remain visible regardless of supply',
        tone: 'neutral',
      },
      {
        label: 'With tokens outstanding',
        value: String(wire.universe.positiveSupplyRepresentationCount),
        note:
          wire.universe.unresolvedSupplyRepresentationCount > 0
            ? `${wire.universe.unresolvedSupplyRepresentationCount} not confirmed`
            : `${wire.universe.zeroSupplyRepresentationCount} with none outstanding`,
        tone: wire.universe.unresolvedSupplyRepresentationCount > 0 ? 'warn' : 'neutral',
      },
      {
        // One coverage row, not two. "Market answers 0 / 2" and "Live prices
        // 0 / 2" sat one above the other saying the same thing to a reader in
        // two vocabularies, and neither said which one to act on.
        label: 'Live answers',
        value: `${answered} / ${eligible}`,
        note: 'open at this exact direction and size',
        tone: wire.marketOutcomeCoverage.status === 'complete' ? 'good' : 'warn',
      },
      {
        label: 'Comparison',
        value: 'Not ranked',
        note: 'Miorail does not choose a winner from these facts',
        tone: 'off',
      },
    ],
    // The one sentence a reader gets in five seconds. Deliberately NOT the
    // engine's `coverage.reason`, which is written for an operator — "fresh
    // exact-size evidence, normalized exposure and the same approved-router
    // policy" is true and tells a person nothing about what to do next. The
    // operator sentence stays reachable, under Technical evidence on the cards.
    coverageBody: coverageBodyV1({
      status: wire.marketOutcomeCoverage.status,
      answered,
      eligible,
      reviewed,
      unresolvedSupply: wire.universe.unresolvedSupplyRepresentationCount,
      subject: input.choice?.title ?? 'This security',
    }),
    // Never hidden behind a control. A reader who does not see this line will
    // read the leftmost column as the winner.
    rankingNote:
      'No winner is selected. Compare the exact market state and evidence for each representation.',
    representations: wire.representations.map((representation) => {
      const outcome = representationOutcomeV1(representation, input.now);
      const adapter = REPRESENTATION_STRUCTURE_ADAPTERS_V1[representation.issuerId];
      const approvedSources = [...new Set(representation.sources.map((source) => source.source))].sort();
      const watchUnavailableReason =
        representation.supply.state !== 'positive_supply'
          ? 'A watch starts only after fresh evidence establishes outstanding supply.'
          : representation.routePolicyKey === null || approvedSources.length === 0
            ? 'No reviewed route source is established for this representation, so there is nothing to watch.'
            : null;
      // Zero supply already says the whole thing in one sentence; naming four
      // fields it does not establish only repeats it in a longer form.
      const grid =
        outcome === 'zero_supply'
          ? { established: [], withheld: [] }
          : splitEstablishedFactsV1(numbersV1(representation, direction, input.now));
      return {
        tokenAddress: representation.tokenAddress,
        issuerId: representation.issuerId,
        issuerName: ISSUER_NAME_V1[representation.issuerId],
        structureLabel: STRUCTURE_LABEL_V1[representation.representationKind],
        structureNote: adapter.structure.note,
        outcome,
        outcomeChip: OUTCOME_CHIP_V1[outcome],
        outcomeBody: outcomeBodyV1(outcome, representation, sizeLabel, input.now),
        outcomeTone: OUTCOME_TONE_V1[outcome],
        attribution: OUTCOME_ATTRIBUTION_V1[outcome],
        watchable: watchUnavailableReason === null,
        watchUnavailableReason,
        routePolicyKey: representation.routePolicyKey,
        approvedSources,
        // The same reason the numbers grid and the ladder go: a route reading
        // taken against a contract with nothing outstanding measures our own
        // question, not this token.
        // Not gated on the outcome. A zero-supply wrapper has nothing to
        // measure, and saying WHEN we established that is still the answer.
        clocks: clocksV1(representation, input.now),
        accessNotices: accessNoticesV1(representation.issuerId),
        // Written from the SAME parts the handoff carries, so the sentence on
        // the card and the sentence in the prepare step cannot drift apart.
        prepareSellSizeNote: stockSizeNoteV1({
          direction: 'sell',
          requestedCashAtomic: wire.question.requestedCashAtomic,
          exactTokenAtomic: representation.exactTestedTokenAtomic,
          tokenDecimals: representation.supply.decimals,
        }),
        lastSeen: outcome === 'zero_supply' ? null : lastSeenV1(representation, input.now),
        openQuote:
          outcome === 'zero_supply'
            ? null
            : openQuoteStripV1(representation, wire.question.requestedCashAtomic, input.now),
        lastMeasuredLabel:
          outcome === 'zero_supply' ? null : lastMeasuredLabelV1(representation, input.now),
        // Zero supply leaves the comparison, and a round trip through a
        // contract with nothing outstanding is not a fact about anything.
        exitBasis:
          outcome === 'zero_supply'
            ? null
            : (input.ladders?.[representation.tokenAddress.toLowerCase()]?.exit?.basis ?? null),
        exit:
          outcome === 'zero_supply'
            ? null
            : exitViewV1(
                input.ladders?.[representation.tokenAddress.toLowerCase()]?.exit ?? null,
                input.now,
              ),
        // The economics, as its own chip beside the availability chip. Same
        // evidence as `exit` — one measurement, read twice — so the two can
        // never disagree about the number they are grading.
        exitCost:
          outcome === 'zero_supply'
            ? null
            : exitCostViewV1(
                input.ladders?.[representation.tokenAddress.toLowerCase()]?.exit ?? null,
              ),
        // The venue, from the same quote the number came from. Only over an
        // OPEN quote: a pool a route went through forty minutes ago is not
        // where a trade would go now, and this line sits beside a live figure.
        routedThrough:
          outcome === 'priced' ? routedThroughV1(latestQuoteV1(representation)) : null,
        // Zero supply is the whole card. A representation with nothing
        // outstanding is not being compared against anything, so it leaves the
        // comparison area rather than sitting in it with five dashes.
        inComparison: outcome !== 'zero_supply',
        // The numbers grid answers "what did it cost". With no supply there is
        // no position to cost, and four dashes each explaining a different
        // absence buried the one fact that mattered.
        numbers: grid.established,
        withheld: grid.withheld,
        withheldCause:
          outcome === 'zero_supply'
            ? null
            : withheldCauseV1({
                established: grid.established,
                withheld: grid.withheld,
                observation: representation.lastObservation,
                direction,
                sizeLabel,
              }),
        // Same reasoning for the ladder: four rungs of "not supported" under a
        // card whose subject is that nothing is outstanding is four ways of
        // repeating a finding that is not about this size. What the last look
        // found still reaches the reader — as one line, in `lastSeen`.
        ladder:
          outcome === 'zero_supply'
            ? []
            : collapseLadderRungsV1(
                input.ladders?.[representation.tokenAddress.toLowerCase()]?.rungs ?? [],
              ),
        ladderNote:
          outcome === 'zero_supply'
            ? null
            : (input.ladders?.[representation.tokenAddress.toLowerCase()]?.note ?? null),
        terms: [
          {
            label: 'Ratio',
            value:
              representation.normalization === 'not_established'
                ? 'Not confirmed yet'
                : 'Applied once',
            note: NORMALIZATION_NOTE_V1[representation.normalization],
            tone: representation.normalization === 'not_established' ? 'off' : 'neutral',
          },
          ...termsV1(representation),
        ],
        technical: technicalV1(representation, input.now, grid.withheld),
        utility: utilityViewV1(representation, input.now),
      };
    }),
    scope: MARKET_REALITY_SCOPE_V1,
    assembledAge: quoteAgeLabelV1(wire.assembledAt, input.now) ?? 'just now',
  };
}

// ---------------------------------------------------------------------------
// Which venue the money actually went through.
//
// Base's own product page says Coinbase tokenized stocks have deep liquidity on
// Aerodrome. Every priced card in this product was already routing through an
// Aerodrome concentrated-liquidity pool — the stored quote for NVDAc names
// `eip155:8453/aerodrome-cl-3:0x853f5f1b92b16714fe6cda67caad0856b83c7ab9` — and
// the card reported "kyberswap" and stopped, which names the aggregator that
// answered and hides the venue that held the money.
//
// The distinction is worth stating precisely, because a reader has to be able
// to check it:
//
//   PRICED BY   the aggregator that answered. Its number, its route, its
//               responsibility.
//   ROUTED VIA  the pools that number went through, by exact address. Each one
//               can be verified against the chain: read the pool's own
//               `factory()` and, for an Aerodrome pool, that factory's
//               `voter()`.
//
// Nothing here is a price and nothing here is derived. Miorail's own Aerodrome
// adapter still cannot quote a concentrated-liquidity pool — it walks the v2
// Router, which for these pairs holds dust, and it refuses rather than answer
// for a venue it cannot see. That refusal is unchanged and correct. This says
// where the aggregator's number came from, which is a different claim.
// ---------------------------------------------------------------------------

/** Venue names, keyed on the protocol slug the router publishes.
 *
 * A CODE-OWNED registry, like every other provider label in this console: a
 * prettified slug would let a router name a venue on our screen. An unknown
 * slug keeps its raw form rather than being guessed at. */
const VENUE_NAME_V1: Readonly<Record<string, string>> = {
  'aerodrome-cl': 'Aerodrome CL',
  'aerodrome-cl-1': 'Aerodrome CL',
  'aerodrome-cl-2': 'Aerodrome CL',
  'aerodrome-cl-3': 'Aerodrome CL',
  aerodrome: 'Aerodrome',
  'aerodrome-v1': 'Aerodrome',
  'uniswap-v3': 'Uniswap v3',
  'uniswap-v4': 'Uniswap v4',
  uniswapv3: 'Uniswap v3',
  slipstream: 'Aerodrome CL',
  'alien-base-cl': 'AlienBase CL',
  'pancake-v3': 'PancakeSwap v3',
  tessera: 'Tessera',
};

export interface VenueViewV1 {
  /** The venue as a person says it, or the raw slug when we do not know it. */
  label: string;
  /** The exact pool, or null when the router named a venue without one. */
  poolAddress: string | null;
  /** Whether this console has a reviewed name for the slug. An unknown venue is
   * shown as it arrived, never dressed up. */
  named: boolean;
}

/** One `eip155:8453/<protocol>:<pool>` reference, split. */
export function parseVenueRefV1(ref: string): VenueViewV1 | null {
  const match = /^eip155:(\d+)\/([^:]+):(.+)$/.exec(ref.trim());
  if (!match) return null;
  const protocol = (match[2] ?? '').toLowerCase();
  const pool = (match[3] ?? '').toLowerCase();
  const named = Object.prototype.hasOwnProperty.call(VENUE_NAME_V1, protocol);
  return {
    label: named ? VENUE_NAME_V1[protocol]! : protocol,
    poolAddress: /^0x[0-9a-f]{40}$/.test(pool) ? pool : null,
    named,
  };
}

export interface RoutedThroughViewV1 {
  /** "Priced by KyberSwap · routed through Aerodrome CL" */
  headline: string;
  /** One row per distinct venue, with the exact pool when the router gave one. */
  venues: VenueViewV1[];
  /** Said once, because the two claims are different and a reader must not read
   * the second as the first. */
  note: string;
}

/**
 * Where a priced answer actually came from.
 *
 * Null when there is no open quote or the router named no pool — an absence,
 * never an empty "routed through nothing" line. Deduplicated by pool, because
 * a route that crosses the same pool twice crossed one venue.
 */
export function routedThroughV1(
  quote: { source: string; liquiditySources?: readonly string[] } | null,
): RoutedThroughViewV1 | null {
  if (!quote) return null;
  const seen = new Map<string, VenueViewV1>();
  for (const ref of quote.liquiditySources ?? []) {
    const venue = parseVenueRefV1(ref);
    // A venue the router named without a pool address is not evidence of a
    // venue: `elfomofi:unknown` says only that the router used something it did
    // not identify, and printing it would put an unverifiable name on screen.
    if (!venue || venue.poolAddress === null) continue;
    if (!seen.has(venue.poolAddress)) seen.set(venue.poolAddress, venue);
  }
  const venues = [...seen.values()];
  if (venues.length === 0) return null;
  const source = VENUE_NAME_V1[quote.source.toLowerCase()] ?? quote.source;
  const names = [...new Set(venues.map((venue) => venue.label))];
  return {
    headline: `Priced by ${source} · routed through ${names.join(', ')}`,
    venues,
    note:
      names.length === 1
        ? `${source} produced the number; the exact pool below is where it went through. Read the pool’s own factory() to check the venue.`
        : `${source} produced the number; the exact pools below are where it was split. Read each pool’s own factory() to check the venue.`,
  };
}

// ---------------------------------------------------------------------------
// Phase 17.5 — who issued this, and who may hold it.
//
// A `Prepare buy` button changes what a page is. Everything before it was a
// measurement, and a measurement carries no implication that the reader may
// act on it; a primary button does. So the two facts a reader needs before
// pressing one are stated NEXT TO IT rather than in a document:
//
//   1. Base did not issue this. Coinbase did. A product that measures Base and
//      renders a Coinbase asset must not let the chain's name stand in for the
//      issuer's.
//
//   2. The issuer restricts who may hold it, and Miorail is not the party that
//      decides. Stating that is not the same as enforcing it, and this copy is
//      careful never to imply that pressing the button means somebody checked.
//      What IS enforced is the token's own onchain policy for the exact wallet,
//      one step later, and that is a narrower claim said in its own words.
//
// Deliberately NOT an IP geo-gate. An IP address is not a jurisdiction, a VPN
// defeats it, and a product that blocked on one would be claiming an
// eligibility ruling it has no basis to make. The honest pair is a plain notice
// plus the issuer's own per-address rule, enforced where the issuer publishes
// it.
// ---------------------------------------------------------------------------

/** Said wherever an action can start, and nowhere else. Re-exported rather
 * than restated: three surfaces show this sentence, and a sentence about who
 * issued a security must not be able to differ between them. */
export { STOCK_ISSUER_NOTICE_V1 } from '@mioagent/rwa-market-reality/execution-handoff';

export type TransferGateStateV1 = 'authorized' | 'denied' | 'not_established';

export interface TransferGateViewV1 {
  /** The chip, in the reader's words. */
  label: string;
  tone: ToneV1;
  /** The sentence under it. Always present: a gate with no explanation is a
   * verdict the reader cannot check. */
  detail: string;
  /** True only for a measured denial — the one state that stops anything. */
  blocking: boolean;
}

/**
 * The issuer's own answer about this wallet, as one line on an action surface.
 *
 * `not_established` renders as itself and never as reassurance. That is the
 * whole discipline: this gate FAILS OPEN, so a reader who is shown nothing
 * would reasonably conclude somebody checked and found nothing wrong — when in
 * fact nobody could reach the registry. Saying "not established" costs one line
 * and keeps the two states apart.
 */
export function transferGateViewV1(
  gate: { state?: string; detail?: string; direction?: string } | null | undefined,
): TransferGateViewV1 | null {
  if (!gate) return null;
  const detail = typeof gate.detail === 'string' && gate.detail.length > 0 ? gate.detail : null;
  if (!detail) return null;
  const side = gate.direction === 'sell' ? 'sell' : 'buy';
  if (gate.state === 'denied') {
    return {
      label: side === 'sell' ? 'The token refuses this sale' : 'The token refuses this purchase',
      tone: 'bad',
      detail,
      blocking: true,
    };
  }
  if (gate.state === 'authorized') {
    return { label: 'Issuer policy allows this wallet', tone: 'good', detail, blocking: false };
  }
  return { label: 'Issuer policy not established', tone: 'off', detail, blocking: false };
}

// ---------------------------------------------------------------------------
// Phase 17.5 — the second reading, rendered so it can never pass for the first.
//
// The card already says `Priced by KyberSwap · routed through Aerodrome CL`.
// That names the venue. This adds what the venue itself says the price is —
// computed by us from one onchain word — beside the number the aggregator
// reported.
//
// The single hazard: a price with no size attached, sitting next to prices that
// have one, reads as a quote. So the word "quote" never appears on it, the
// figure carries the word "marginal", and the sentence that says what it is not
// travels with it in every state. There is no compact variant.
// ---------------------------------------------------------------------------

export interface PoolSpotViewV1 {
  /** "Aerodrome pool says $231.878101 per NVDAc" — or the absence, in words. */
  headline: string;
  /** Present only when a price was actually read. */
  price: string | null;
  /** The raw word, so the arithmetic can be redone from the pool's own state. */
  sqrtPriceX96: string | null;
  blockTag: string | null;
  /** Always present. A figure with no size attached needs this every time. */
  note: string;
  tone: ToneV1;
}

/**
 * One pool's own marginal price, as a line under the venue it belongs to.
 *
 * `quoteTokenAddress` is the side the reader is thinking in — the token whose
 * price they want. The pool answers in both directions and this picks the one
 * the card is about, rather than making a reader work out which of `token0`
 * and `token1` is theirs.
 */
/**
 * The cash tokens a marginal price may be denominated in by name.
 *
 * Tiny and pinned, for the same reason `VENUE_NAME_V1` is: a symbol read off a
 * contract is a string that contract chose, and a card that prints it is
 * printing whatever a token wants it to. Anything not on this list is named by
 * its address, which is checkable.
 */
const SPOT_DENOMINATION_V1: Readonly<Record<string, string>> = {
  '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': 'USDC',
  '0x4200000000000000000000000000000000000006': 'WETH',
};

export function poolSpotViewV1(input: {
  wire:
    | {
        outcome?: string;
        reason?: string;
        detail?: string;
        note?: string;
        token0?: string;
        token1?: string;
        token0PerToken1?: string;
        token1PerToken0?: string;
        sqrtPriceX96?: string;
        blockTag?: string | null;
      }
    | null
    | undefined;
  /** The token being priced. Its price is expressed in the OTHER token. */
  tokenAddress: string;
}): PoolSpotViewV1 | null {
  const wire = input.wire ?? null;
  if (!wire) return null;
  if (wire.outcome !== 'read') {
    const detail = typeof wire.detail === 'string' && wire.detail.length > 0 ? wire.detail : null;
    if (!detail) return null;
    return {
      headline: 'No second reading from the pool',
      price: null,
      sqrtPriceX96: null,
      blockTag: null,
      note: detail,
      // Never `bad`: a reading we could not take is an absence, not a defect in
      // the market. The severity vocabulary belongs to what a trade costs.
      tone: 'off',
    };
  }
  const token = input.tokenAddress.toLowerCase();
  const token0 = wire.token0?.toLowerCase() ?? null;
  const token1 = wire.token1?.toLowerCase() ?? null;
  // The price OF this token is denominated in the other one, so the side is
  // chosen by which slot this token occupies — never by which figure looks
  // more like a dollar amount. A pool that does not hold this token at all
  // renders nothing: it is somebody else's pool, and printing either figure
  // would attach a price to the wrong asset.
  const price =
    token0 === token ? wire.token1PerToken0 : token1 === token ? wire.token0PerToken1 : null;
  const counterpart = token0 === token ? token1 : token1 === token ? token0 : null;
  if (!price || !counterpart) return null;
  const denomination = SPOT_DENOMINATION_V1[counterpart] ?? counterpart;
  return {
    headline: `Aerodrome pool’s own marginal price: ${price} ${denomination} per token`,
    price,
    sqrtPriceX96: wire.sqrtPriceX96 ?? null,
    blockTag: wire.blockTag ?? null,
    note:
      typeof wire.note === 'string' && wire.note.length > 0
        ? wire.note
        : 'The pool’s marginal price at its current tick. Not a quote: no size, no slippage, no route.',
    tone: 'neutral',
  };
}
