import { REPRESENTATION_STRUCTURE_ADAPTERS_V1 } from '@mioagent/rwa-issuer/structureAdapters';
import {
  representationUtilityMapV1,
  type RepresentationUtilityEdgeV1,
  type UtilityEvidenceStateV1,
} from '@mioagent/rwa-issuer/utilityMap';

import { formatAtomicAmount } from '../formatAtomicAmount';
// One vocabulary across the RWA surfaces. A second FactViewV1 with the same
// four fields would let the two views drift into different meanings for the
// same word, which is exactly what the shared section table exists to stop.
import { rwaBpsLabelV1 } from './rwaDiscoverView';
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
export type RepresentationKindV1 = 'b20_asset' | 'rebasing_erc20' | 'non_rebasing_erc4626_wrapper';

export interface MarketRealityIndexEntryWireV1 {
  underlyingKey: string;
  canonicalName: string;
  displaySymbol: string | null;
  assetClass: 'equity' | 'fund_share' | 'other' | 'unknown';
  identifierScheme: string | null;
  identifierValue: string | null;
  representationCount: number;
  issuerIds: readonly IssuerIdV1[];
  multiIssuer: boolean;
}

export interface MarketRealityIndexWireV1 {
  entries: readonly MarketRealityIndexEntryWireV1[];
  totals: {
    underlyings: number;
    boundRepresentations: number;
    multiIssuerUnderlyings: number;
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
  /** History, labelled as history. Null when nobody has ever measured. */
  lastSeen: { label: string; value: string; note: string } | null;
  tokenAddress: string;
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
  openQuote: { value: string; note: string | null };
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
    groups: UtilityGroupViewV1[];
  };
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

function referenceNoteV1(
  reference: MarketRealityRepresentationWireV1['reference'],
): string {
  const context = `${MARKET_SESSION_LABEL_V1[reference.marketSession]} · ${PUBLICATION_MODE_LABEL_V1[reference.publicationMode]}`;
  return reference.reason ? `${context} · ${reference.reason}` : context;
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
  void nowIso;
  if (representation.supply.state === 'zero_supply') return 'zero_supply';
  if (representation.supply.state === 'supply_unknown') return 'supply_unknown';
  if (representation.status === 'full') return 'priced';
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

const OUTCOME_TONE_V1: Readonly<Record<MarketRealityOutcomeV1, ToneV1>> = {
  zero_supply: 'neutral',
  supply_unknown: 'warn',
  priced: 'good',
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
function openQuoteStripV1(
  representation: MarketRealityRepresentationWireV1,
): { value: string; note: string | null } {
  if (representation.status === 'full' && representation.returnedCashAtomic) {
    return {
      value: usdV1(representation.returnedCashAtomic) ?? '—',
      note: 'open right now, at this exact size',
    };
  }
  return { value: 'No live quote', note: null };
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
            note: `measured ${historyAge ?? 'earlier'} — history, not a price now`,
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
export const MARKET_REALITY_ROUND_TRIP_BOUND_BPS_V1 = 200;

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
  const withinBound = bps <= MARKET_REALITY_ROUND_TRIP_BOUND_BPS_V1;

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
          `Total cost to buy and exit: ${cost} — ${when}. A price is available at this size; most of the money is not.`,
      tone: withinBound ? 'good' : 'off',
    };
  }

  return {
    label: 'Cost to buy and exit',
    value: cost,
    note: withinBound
      ? `what buying in and selling straight back costs at this size — ${when}`
      : `a price is available at this size, and buying in then selling straight back costs this much — ${when}. Most of the money does not come back.`,
    tone: withinBound ? 'good' : 'off',
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
  ];
}

function technicalV1(
  representation: MarketRealityRepresentationWireV1,
  nowIso: string,
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
    sources: edge.evidence.map((source) => ({
      label: UTILITY_SOURCE_LABEL_V1[source.kind],
      href: /^https:\/\//.test(source.ref) ? source.ref : null,
      checkedAt: source.checkedAt,
    })),
  };
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
  return {
    caip10: map.caip10,
    groups: [
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
    ],
  };
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
    // Enrichment does not always reach a company name: some reviewed rows
    // carry the ticker in both fields, and `NVDA (NVDA)` reads as a rendering
    // fault rather than as the one name Miorail actually holds.
    title:
      entry.displaySymbol && entry.displaySymbol !== entry.canonicalName
        ? `${entry.canonicalName} (${entry.displaySymbol})`
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
  }));
}

/** The headline counters. Corpus-wide — every one of these is a claim about the
 * whole graph, never about the page. */
export function underlyingCountersV1(wire: MarketRealityIndexWireV1 | null): FactViewV1[] {
  if (!wire) return [];
  return [
    {
      label: 'Securities',
      value: String(wire.totals.underlyings),
      note: 'bound to a Base contract by a reviewed source',
      tone: 'neutral',
    },
    {
      label: 'Representations',
      value: String(wire.totals.boundRepresentations),
      note: 'each identified by its own exact address',
      tone: 'neutral',
    },
    {
      label: 'Multi-issuer stocks',
      value: String(wire.totals.multiIssuerUnderlyings),
      // The only number on the page that says whether a COMPARISON exists at
      // all. Counted by distinct issuer, so one issuer's token plus its own
      // wrapper never inflates it.
      note: 'have reviewed representations from two or more issuers',
      tone: 'neutral',
    },
  ];
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
      return {
        tokenAddress: representation.tokenAddress,
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
        lastSeen: lastSeenV1(representation, input.now),
        openQuote: openQuoteStripV1(representation),
        lastMeasuredLabel: lastMeasuredLabelV1(representation, input.now),
        // Zero supply leaves the comparison, and a round trip through a
        // contract with nothing outstanding is not a fact about anything.
        exit:
          outcome === 'zero_supply'
            ? null
            : exitViewV1(
                input.ladders?.[representation.tokenAddress.toLowerCase()]?.exit ?? null,
                input.now,
              ),
        // Zero supply is the whole card. A representation with nothing
        // outstanding is not being compared against anything, so it leaves the
        // comparison area rather than sitting in it with five dashes.
        inComparison: outcome !== 'zero_supply',
        // The numbers grid answers "what did it cost". With no supply there is
        // no position to cost, and four dashes each explaining a different
        // absence buried the one fact that mattered.
        numbers: outcome === 'zero_supply' ? [] : numbersV1(representation, direction, input.now),
        // Same reasoning for the ladder: four rungs of "not supported" under a
        // card whose subject is that nothing is outstanding is four ways of
        // repeating a finding that is not about this size. What the last look
        // found still reaches the reader — as one line, in `lastSeen`.
        ladder:
          outcome === 'zero_supply'
            ? []
            : (input.ladders?.[representation.tokenAddress.toLowerCase()]?.rungs ?? []),
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
        technical: technicalV1(representation, input.now),
        utility: utilityViewV1(representation, input.now),
      };
    }),
    scope: MARKET_REALITY_SCOPE_V1,
    assembledAge: quoteAgeLabelV1(wire.assembledAt, input.now) ?? 'just now',
  };
}
