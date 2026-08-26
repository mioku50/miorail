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
// Show a winner. `ranking.status` is `withheld` until the coverage gate proves
// every representation was measured through the same approved router set, at
// the same exact size, to the same destination. Measured 2026-08-26 it is
// withheld for every underlying in the corpus, and a BEST badge drawn anyway
// would be an ordering over rows that were not asked the same question.
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
// FIVE OUTCOMES, AND WHOSE FACT EACH ONE IS
//
//   priced          a live quote at the exact size          the market
//   lapsed          we had one; router quotes live ~20s     time
//   no_route        no venue would trade this size          the asset
//   provider_failed our router call did not complete        us
//   never_measured  this size was never asked               us
//
// Three of those five are about Miorail or the clock, and only one is about
// the asset. Collapsing them into "no data" would let a reader conclude the
// token is untradeable when the truth is that our timer has not come round.
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
  | 'non_rebasing_erc4626_wrapper';

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
  status: 'quoted' | 'no_route' | 'measurement_failed' | 'not_measured';
  errorCode: string | null;
  quoteEvidence: MarketRealityQuoteWireV1 | null;
}

export interface MarketRealityRepresentationWireV1 {
  tokenAddress: string;
  issuerId: IssuerIdV1;
  issuerInstrumentKey: string;
  representationKind: RepresentationKindV1;
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
    session: 'regular' | 'after_hours' | 'weekend' | 'held' | 'unknown';
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
    status: 'quoted' | 'no_route' | 'measurement_failed';
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
  coverage: {
    reviewedRepresentations: number;
    comparableRepresentations: number;
    status: 'complete' | 'incomplete';
    reason: string | null;
  };
  ranking: {
    status: 'available' | 'withheld';
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
  'priced',
  'lapsed',
  'stale_finding',
  'no_route',
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
  attribution: 'the market' | 'the clock' | 'Miorail';
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
 * The one derived fact this module owns: which of five outcomes a row is in.
 *
 * Reads the SOURCES rather than the row status, because the row status folds
 * "expired" and "never asked" into one word and the sources keep them apart.
 */
export function representationOutcomeV1(
  representation: MarketRealityRepresentationWireV1,
  nowIso: string,
): MarketRealityOutcomeV1 {
  void nowIso;
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
    switch (representation.lastObservation?.status) {
      case 'quoted':
        return 'lapsed';
      case 'no_route':
        return 'stale_finding';
      default:
        return 'provider_failed';
    }
  }
  if (representation.status === 'unavailable') return 'no_route';
  if (representation.sources.some((source) => source.errorCode === 'cash_size_anchor_no_route')) {
    return 'no_route';
  }
  if (representation.status === 'measurement_failed') return 'provider_failed';
  if (representation.sources.some((source) => source.errorCode !== null)) return 'provider_failed';
  return 'never_measured';
}

const OUTCOME_CHIP_V1: Readonly<Record<MarketRealityOutcomeV1, string>> = {
  priced: 'Priced now',
  lapsed: 'Price expired',
  stale_finding: 'Finding expired',
  no_route: 'No route',
  provider_failed: 'Our read failed',
  never_measured: 'Not measured',
};

const OUTCOME_TONE_V1: Readonly<Record<MarketRealityOutcomeV1, ToneV1>> = {
  priced: 'good',
  lapsed: 'warn',
  stale_finding: 'off',
  no_route: 'off',
  provider_failed: 'warn',
  never_measured: 'neutral',
};

const OUTCOME_ATTRIBUTION_V1: Readonly<
  Record<MarketRealityOutcomeV1, RepresentationViewV1['attribution']>
> = {
  priced: 'the market',
  lapsed: 'the clock',
  stale_finding: 'the clock',
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
      return `The last look at ${sizeLabel}${age ? ` ${age}` : ''} found no usable route, and that finding has since expired. Measure now to ask again.`;
    case 'no_route':
      return `No approved venue would trade ${sizeLabel} of this representation. That is a fact about the market for this contract, not about the issuer.`;
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
      note: observation.open ? `measured ${age}, still open` : `measured ${age} — history, not a price now`,
    };
  }
  return {
    label: 'Last seen',
    value: observation.status === 'no_route' ? 'No route' : 'Read failed',
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
  ];
  if (representation.routePolicyKey) {
    rows.push({ label: 'Route policy', value: representation.routePolicyKey });
  }
  if (representation.exactTestedTokenAtomic) {
    rows.push({ label: 'Tested token amount (atomic)', value: representation.exactTestedTokenAtomic });
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
  rows.push({ label: 'Reference', value: `${representation.reference.status} · session ${representation.reference.session}` });
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
  comparable: number;
  reviewed: number;
  subject: string;
}): string {
  const ways = input.reviewed === 1 ? 'one way' : `${input.reviewed} ways`;
  if (input.status === 'complete' && input.reviewed > 0) {
    return `${input.subject} is held ${ways} on Base, and all of them were measured the same way — so the numbers below can be read against each other.`;
  }
  if (input.reviewed === 0) {
    return `No reviewed source has bound a Base contract to ${input.subject}.`;
  }
  if (input.comparable === 0) {
    return `${input.subject} is held ${ways} on Base, and none of them has evidence that can be compared right now. Each card below says which of them it is.`;
  }
  const plural = input.comparable === 1 ? 'one' : String(input.comparable);
  return `${input.subject} is held ${ways} on Base, and ${plural} of them has evidence that can be compared. The rest say why they do not.`;
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

  const comparable = wire.coverage.comparableRepresentations;
  const reviewed = wire.coverage.reviewedRepresentations;

  return {
    title: input.choice?.title ?? wire.question.underlyingKey,
    identifier: input.choice?.identifier ?? null,
    questionLine,
    coverageChip: `${comparable} of ${reviewed} comparable`,
    coverageTone: comparable === reviewed && reviewed > 0 ? 'good' : 'warn',
    coverageDetail: wire.coverage.reason,
    // The one sentence a reader gets in five seconds. Deliberately NOT the
    // engine's `coverage.reason`, which is written for an operator — "fresh
    // exact-size evidence, normalized exposure and the same approved-router
    // policy" is true and tells a person nothing about what to do next. The
    // operator sentence stays reachable, under Technical evidence on the cards.
    coverageBody: coverageBodyV1({
      status: wire.coverage.status,
      comparable,
      reviewed,
      subject: input.choice?.title ?? 'This security',
    }),
    // Never hidden behind a control. A reader who does not see this line will
    // read the leftmost column as the winner.
    rankingNote:
      wire.ranking.status === 'withheld'
        ? (wire.ranking.reason ??
          'No representation is marked best: the coverage gate has not passed.')
        : null,
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
              representation.normalization === 'not_established' ? 'Not established' : 'Applied once',
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
