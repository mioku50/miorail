import { REPRESENTATION_STRUCTURE_ADAPTERS_V1 } from '@mioagent/rwa-issuer/structureAdapters';

import { formatAtomicAmount } from '../formatAtomicAmount';
// One vocabulary across the RWA surfaces. A second FactViewV1 with the same
// four fields would let the two views drift into different meanings for the
// same word, which is exactly what the shared section table exists to stop.
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
    comparable: boolean;
    reason: string | null;
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
  representationCount: number;
  multiIssuer: boolean;
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
  attribution: 'the market' | 'the clock' | 'Miorail' | 'onchain read';
  /** The three comparison numbers, always present, dashed when absent. */
  numbers: FactViewV1[];
  /** Holding, redeeming and distributions — from the reviewed adapters. */
  terms: FactViewV1[];
  technical: { label: string; value: string }[];
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
  not_established: 'The ratio behind this size is not established, so exposure is not normalized.',
};

function usdV1(atomic: string | null, decimals = 6): string | null {
  if (atomic === null) return null;
  const plain = formatAtomicAmount(atomic, decimals);
  const [whole, fraction] = plain.split('.');
  const grouped = (whole ?? '0').replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return fraction ? `$${grouped}.${fraction.slice(0, 2)}` : `$${grouped}`;
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

function bpsLabelV1(bps: string | null): string | null {
  if (bps === null) return null;
  const value = Number.parseInt(bps, 10);
  if (!Number.isFinite(value)) return null;
  const sign = value > 0 ? '+' : '';
  return `${sign}${(value / 100).toFixed(2)}%`;
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
  zero_supply: 'Zero supply',
  supply_unknown: 'Supply unknown',
  priced: 'Priced now',
  lapsed: 'Price expired',
  stale_finding: 'Finding expired',
  unsupported_token: 'Not covered',
  unsized: 'Could not size',
  no_route: 'No route',
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
      return `No outstanding supply was observed at the latest fresh successful totalSupply read. This reviewed representation stays visible but is outside the current market-comparison denominator.`;
    case 'supply_unknown':
      return `${representation.supply.reason ?? 'Current outstanding supply could not be established.'} This reviewed representation remains unresolved and cannot be silently removed from coverage.`;
    case 'priced':
      return `A router quoted this exact size and the quote is still open.`;
    case 'lapsed':
      // The state a reader is most likely to misread as a broken product. It
      // says what happened, says the number was real, and points at the one
      // control that fixes it.
      return `A router did quote ${sizeLabel}${age ? ` ${age}` : ''}, and that quote has since expired — router quotes are good for about twenty seconds. Measure now to get an open one.`;
    case 'stale_finding':
      // Not a lapsed price: we never had a price here. What expired was a
      // finding about the market, and saying "price expired" would invent one.
      return `The last look at ${sizeLabel}${age ? ` ${age}` : ''} found no route under Miorail's reviewed router policy, and that finding has since expired. Measure now to ask again.`;
    case 'no_route':
      return `No route was found for ${sizeLabel} under Miorail's current reviewed router policy. That scoped finding is about this exact contract and question, not the issuer or every market on Base.`;
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

function numbersV1(
  representation: MarketRealityRepresentationWireV1,
  direction: MarketRealityDirectionV1,
): FactViewV1[] {
  const cash = usdV1(representation.returnedCashAtomic);
  const price =
    representation.effectivePriceAtomic && representation.effectivePriceDecimals !== null
      ? usdV1(representation.effectivePriceAtomic, representation.effectivePriceDecimals)
      : null;
  const premium = bpsLabelV1(representation.premiumDiscountBps);
  const reference = representation.reference;

  return [
    {
      label: direction === 'sell' ? 'Cash back' : 'Cash in',
      value: cash ?? '—',
      note: cash === null ? 'no open quote at this size' : null,
      tone: cash === null ? 'neutral' : 'good',
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
            ? 'exposure not normalized, so no per-share price'
            : 'needs an open quote'
          : 'per unit of normalized exposure',
      tone: price === null ? 'neutral' : 'good',
    },
    {
      label: 'vs reference',
      value: premium ?? '—',
      note:
        premium === null
          ? reference.comparable
            ? 'needs an effective price'
            : (reference.reason ?? 'no comparable reference')
          : null,
      tone: premium === null ? 'neutral' : 'good',
    },
  ];
}

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
  if (observation.status === 'quoted' && observation.returnedCashAtomic) {
    return {
      label: 'Last seen',
      value: usdV1(observation.returnedCashAtomic) ?? '—',
      note: observation.open
        ? `measured ${age}, still open`
        : `measured ${age} — history, not a price now`,
    };
  }
  return {
    label: 'Last seen',
    value:
      observation.status === 'no_route'
        ? 'No route under policy'
        : observation.status === 'unsized'
          ? 'Sell not sized'
          : 'Read failed',
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
    value: entry.status === 'reviewed' ? 'Reviewed' : 'Not established',
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
    value: `${representation.reference.status} · session ${representation.reference.session}`,
  });
  return rows;
}

export function underlyingChoicesV1(
  wire: MarketRealityIndexWireV1 | null,
): UnderlyingChoiceViewV1[] {
  if (!wire) return [];
  return wire.entries.map((entry) => ({
    underlyingKey: entry.underlyingKey,
    title: entry.displaySymbol
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
      label: 'Carried by two issuers',
      value: String(wire.totals.multiIssuerUnderlyings),
      // The only number on the page that says whether a COMPARISON exists at
      // all. Counted by distinct issuer, so one issuer's token plus its own
      // wrapper never inflates it.
      note: 'the only securities this page can compare',
      tone: wire.totals.multiIssuerUnderlyings > 0 ? 'good' : 'off',
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
    return `Miorail obtained a legitimate answer to this exact market question for all ${input.eligible} positive-supply representations. This is categorical coverage, not permission to rank them.`;
  }
  return `Miorail answered this exact market question for ${input.answered} of ${input.eligible} positive-supply representations. Every unanswered card says whether the missing fact belongs to coverage, sizing or infrastructure.`;
}

export function marketRealityViewV1(input: {
  wire: MarketRealityWireV1 | null;
  choice: UnderlyingChoiceViewV1 | null;
  now: string;
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
  const priced = wire.numericComparisonCoverage.pricedRepresentationCount;

  return {
    title: input.choice?.title ?? wire.question.underlyingKey,
    identifier: input.choice?.identifier ?? null,
    questionLine,
    coverageChip: `${answered} of ${eligible} market outcomes`,
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
        label: 'Outstanding supply',
        value: String(wire.universe.positiveSupplyRepresentationCount),
        note:
          wire.universe.unresolvedSupplyRepresentationCount > 0
            ? `${wire.universe.unresolvedSupplyRepresentationCount} unresolved`
            : `${wire.universe.zeroSupplyRepresentationCount} zero-supply`,
        tone: wire.universe.unresolvedSupplyRepresentationCount > 0 ? 'warn' : 'neutral',
      },
      {
        label: 'Market question answered',
        value: `${answered} / ${eligible}`,
        note: 'categorical outcomes for this exact direction and size',
        tone: wire.marketOutcomeCoverage.status === 'complete' ? 'good' : 'warn',
      },
      {
        label: 'Priced',
        value: `${priced} / ${wire.numericComparisonCoverage.eligibleRepresentationCount}`,
        note: 'fresh normalized numeric quotes',
        tone: wire.numericComparisonCoverage.status === 'complete' ? 'good' : 'warn',
      },
      {
        label: 'Ranking',
        value: 'WITHHELD',
        note: 'Phase 10B.8 never emits BEST',
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
      wire.ranking.reason ?? 'No representation is marked best: Phase 10B.8 withholds ranking.',
    representations: wire.representations.map((representation) => {
      const outcome = representationOutcomeV1(representation, input.now);
      const adapter = REPRESENTATION_STRUCTURE_ADAPTERS_V1[representation.issuerId];
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
        lastSeen: lastSeenV1(representation, input.now),
        numbers: numbersV1(representation, direction),
        terms: [
          {
            label: 'Ratio',
            value:
              representation.normalization === 'not_established'
                ? 'Not established'
                : 'Applied once',
            note: NORMALIZATION_NOTE_V1[representation.normalization],
            tone: representation.normalization === 'not_established' ? 'off' : 'neutral',
          },
          ...termsV1(representation),
        ],
        technical: technicalV1(representation, input.now),
      };
    }),
    scope: MARKET_REALITY_SCOPE_V1,
    assembledAge: quoteAgeLabelV1(wire.assembledAt, input.now) ?? 'just now',
  };
}
