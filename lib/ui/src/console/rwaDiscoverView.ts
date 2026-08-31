import { formatAtomicAmount } from '../formatAtomicAmount';

// ---------------------------------------------------------------------------
// Phase 6 — turning the three Discover reads into something a person reads.
//
// The mapping lives here, once, and every number leaves it as a formatted
// STRING or null. That is the whole design rule: a component that receives
// `roundTripCostBps: null` can render it as `0.00%` by accident, and a
// component that receives `null` where a string was expected renders nothing
// at all. This file is the only place a null can become words.
//
// The words themselves are the second rule. Three sentences that this surface
// must never merge, because each pair means opposite things:
//
//   "no route at the measured sizes"   a fact about the asset
//   "not measured"                     a fact about Miorail
//   "measurement did not finish"       a fact about our router call
//
// The counts at the top of the page sum to the issuance for the same reason:
// three numbers that do not add up invite a reader to subtract them and arrive
// at a fourth that nobody measured.
// ---------------------------------------------------------------------------

export const RWA_DISCOVER_TABS_V1 = ['official', 'signals', 'lookalikes'] as const;
export type RwaDiscoverTabV1 = (typeof RWA_DISCOVER_TABS_V1)[number];

export const RWA_DISCOVER_TAB_LABEL_V1: Readonly<Record<RwaDiscoverTabV1, string>> = {
  official: 'Official assets',
  signals: 'Signals',
  lookalikes: 'Lookalikes',
};

export type LookalikeAliasV1 = 'published_ticker' | 'underlying' | 'display_name';
export type LookalikeAliasFilterV1 = 'all' | LookalikeAliasV1;

/** Tone words the console stylesheet already knows. Never a severity. */
export type ToneV1 = 'good' | 'warn' | 'off' | 'neutral';

// ---------------------------------------------------------------------------
// Wire shapes.
//
// Declared structurally rather than imported: this package compiles into the
// Base App bundle at a target where the schema package's dependencies do not
// belong. The host passes the parsed response straight in, so any field that
// changes shape fails to compile at the call site rather than rendering blank.
// ---------------------------------------------------------------------------

export interface OfficialLadderRungWireV1 {
  requestedCashAtomic: string;
  destination: 'USDC' | 'ETH';
  status: 'full' | 'partial' | 'buy_only' | 'unavailable' | 'not_measured' | 'measurement_failed';
  roundTripCostBps: string | null;
  derivedFromExactRung: boolean;
  lowerBoundRequestedCashAtomic: string | null;
  entryRouteRefused: boolean;
}

export interface OfficialAssetWireV1 {
  tokenAddress: string;
  ticker: string;
  displayName: string | null;
  issuer: string;
  listedIn: readonly ('base_docs_technical' | 'base_product_list' | 'backed_assets_api')[];
  sourceDiscrepancy: boolean;
  referenceValue: {
    status: 'fresh' | 'stale' | 'paused' | 'unavailable' | 'invalid';
    valueAtomic: string | null;
    decimals: number | null;
    ageSeconds: number | null;
    feedAddress: string | null;
  };
  executableValue: {
    status: 'full' | 'partial' | 'buy_only' | 'unavailable' | 'not_measured' | 'measurement_failed';
    valueAtomic: string | null;
    decimals: number | null;
    requestedSizeAtomic: string | null;
    destination: 'USDC' | 'ETH' | null;
    observedAt: string | null;
  };
  comparison: {
    status: 'comparable' | 'withheld';
    differenceBps: string | null;
    reason: string | null;
  };
  market: {
    routeStatus:
      | 'cash_route_established'
      | 'no_route_at_measured_sizes'
      | 'no_entry_route_at_measured_sizes'
      | 'measurement_failed'
      | 'not_measured';
    measuredAt: string | null;
    approvedSources: readonly string[];
    ladder: readonly OfficialLadderRungWireV1[];
    observation: {
      status: 'movements_observed' | 'no_movements_observed' | 'not_observed';
      pairedPoolCount: number | null;
      movementCount: number | null;
    };
  };
  lookalikeCount: number;
}

export interface OfficialAssetsOverviewWireV1 {
  observedAt: string;
  counts: {
    officialIssuance: number;
    cashRouteEstablished: number;
    noRouteAtMeasuredSizes: number;
    noEntryRouteAtMeasuredSizes: number;
    measurementFailed: number;
    notMeasured: number;
  };
  sources: readonly {
    sourceKind: 'base_docs_technical' | 'base_product_list' | 'backed_assets_api';
    sourceUrl: string;
    checkedAt: string | null;
    status: 'ok' | 'unreachable' | 'unparsable' | null;
    assetCount: number | null;
    lastSuccessfulAt: string | null;
  }[];
  marketObservation: {
    status: 'observed' | 'never_run';
    checkedThroughBlock: number | null;
    checkedAt: string | null;
    identifiedVenueCount: number | null;
    candidatesPendingIdentification: number | null;
  };
  assets: readonly OfficialAssetWireV1[];
}

export interface OfficialLookalikeCardWireV1 {
  tokenAddress: string;
  officialAddress: string;
  officialTicker: string;
  officialDisplayName: string | null;
  matchKind: 'symbol_exact' | 'symbol_normalized' | 'name_normalized';
  matchedAlias: LookalikeAliasV1;
  matchedValue: string;
  declaredSymbol: string;
  declaredName: string;
  launchedAt: string | null;
  firstFlaggedAt: string;
  lastSeenAt: string;
}

export interface OfficialLookalikeFeedWireV1 {
  observedAt: string;
  disclaimer: string;
  counts: { total: number; publishedTicker: number; underlying: number; displayName: number };
  filteredBy: LookalikeAliasV1 | null;
  lastScanAt: string | null;
  cards: readonly OfficialLookalikeCardWireV1[];
}

export interface RwaSignalCardWireV1 {
  signalId: string;
  kind: string;
  subjectAddress: string;
  subjectTicker: string | null;
  officialAddress: string | null;
  officialTicker: string | null;
  occurredAt: string;
  recordedAt: string;
  facts: Record<string, unknown>;
}

export interface RwaSignalFeedWireV1 {
  observedAt: string;
  watching: readonly { kind: string; watchingSince: string }[];
  notReported: readonly string[];
  cards: readonly RwaSignalCardWireV1[];
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/** Both ends of an address. Every B20 token begins `0xb2000000…`, so a leading
 * fragment is identical across the whole universe and the tail is what
 * separates one contract from another. */
function shortAddressV1(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function groupedV1(value: string): string {
  const [whole, fraction] = value.split('.');
  const grouped = (whole ?? '0').replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return fraction ? `${grouped}.${fraction}` : grouped;
}

/** A cash size, as money. Sizes here are exact decade steps in USDC atoms. */
export function cashSizeLabelV1(atomic: string, decimals = 6): string {
  return `$${groupedV1(formatAtomicAmount(atomic, decimals))}`;
}

/**
 * The same size, in the compact words the size chips already use.
 *
 * A LABEL has to stay short enough to read as a unit rather than as a figure:
 * "$100,000 cash-out $99,743.82" puts two long numbers side by side and invites
 * exactly the confusion the label exists to prevent. The four values are the
 * public ladder's own rungs, so this is a lookup, not arithmetic.
 */
const COMPACT_CASH_SIZE_V1: Readonly<Record<string, string>> = {
  '100000000': '$100',
  '1000000000': '$1k',
  '10000000000': '$10k',
  '100000000000': '$100k',
};

export function compactCashSizeLabelV1(atomic: string, decimals = 6): string {
  return COMPACT_CASH_SIZE_V1[atomic] ?? cashSizeLabelV1(atomic, decimals);
}

/** Basis points as a percentage, two places. Null stays null. */
export function rwaBpsLabelV1(bps: string | null): string | null {
  if (bps === null || !/^-?(0|[1-9][0-9]*)$/.test(bps)) return null;
  const negative = bps.startsWith('-');
  const digits = negative ? bps.slice(1) : bps;
  const padded = digits.padStart(3, '0');
  const whole = padded.slice(0, -2);
  const fraction = padded.slice(-2);
  return `${negative ? '-' : ''}${whole}.${fraction}%`;
}

/** A money value at its own decimals. Null stays null — never a zero. */
export function moneyLabelV1(atomic: string | null, decimals: number | null): string | null {
  if (atomic === null || decimals === null) return null;
  const decimal = formatAtomicAmount(atomic, decimals);
  const [whole, fraction = ''] = decimal.split('.');
  const cents = (fraction + '00').slice(0, 2);
  return `$${groupedV1(whole ?? '0')}.${cents}`;
}

/**
 * An age, in the coarsest unit that is still true.
 *
 * Ages rather than timestamps: a reader deciding whether a price is usable
 * needs "38 seconds ago", and works out nothing at all from an ISO string in
 * a timezone they have to convert.
 */
export function rwaAgeLabelV1(iso: string | null, now: Date): string | null {
  if (iso === null) return null;
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return null;
  const seconds = Math.max(0, Math.round((now.getTime() - then) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}

// ---------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------

const SOURCE_LABEL_V1: Readonly<
  Record<'base_docs_technical' | 'base_product_list' | 'backed_assets_api', string>
> = {
  base_docs_technical: 'Base docs',
  base_product_list: 'Base product page',
  backed_assets_api: 'Backed bTokens API',
};

const ROUTE_STATUS_V1: Readonly<
  Record<OfficialAssetWireV1['market']['routeStatus'], { chip: string; tone: ToneV1; body: string }>
> = {
  cash_route_established: {
    // NOT "active market". A completed round trip is an OBSERVATION, and the
    // one it is built from was 22 minutes old on the screen that carried this
    // chip — beside a reference feed marked stale. "Active" reads as a claim
    // about right now, which is the one thing a stored measurement cannot
    // support. `routeChipV1` below still downgrades it further when the
    // observation has aged out of its own window.
    chip: 'ROUTE OBSERVED',
    tone: 'good',
    body: 'An approved router returned a completed round trip at a measured size.',
  },
  no_route_at_measured_sizes: {
    chip: 'NO EXIT AT MEASURED SIZES',
    tone: 'warn',
    // The distinction the whole tab exists for. Officially issued is not the
    // same as tradeable, and this sentence is the product.
    body: 'The asset is officially issued and no approved router would sell it back to cash at any measured size. That is a reading about the market, not about the issuance.',
  },
  no_entry_route_at_measured_sizes: {
    chip: 'NO CASH ENTRY AT MEASURED SIZES',
    tone: 'warn',
    // Carefully bounded. The ladder is sized in cash, so it buys first to
    // learn an exact token amount; with no buy route the sell was never
    // attempted. Saying "cannot be exited" here would be a claim about a
    // position nobody tested.
    body: 'The asset is officially issued and no approved router would sell it to you for cash at any measured size, so a round trip could not be started. Selling a position already held was never tested and is not claimed either way.',
  },
  measurement_failed: {
    chip: 'MEASUREMENT DID NOT FINISH',
    tone: 'off',
    body: 'Our own router call did not complete, so nothing here is a statement about this asset.',
  },
  not_measured: {
    chip: 'NOT MEASURED',
    tone: 'off',
    body: 'Nothing has measured a cash route for this asset yet. That is a gap in Miorail, not a finding about the token.',
  },
};

/**
 * One rung of a cash-exit ladder, in the shape both readers of it carry.
 *
 * Discover reads it off its own list wire; Stocks reads it off the stored
 * dossier. The field names agree because both are projections of the same run,
 * and the subset below is what a ladder actually needs to be rendered.
 */
export interface CashExitRungInputV1 {
  requestedCashAtomic: string | null;
  destination: 'USDC' | 'ETH';
  status: OfficialLadderRungWireV1['status'];
  roundTripCostBps: string | null;
  derivedFromExactRung: boolean;
  lowerBoundRequestedCashAtomic: string | null;
  /** Discover's list wire carries this; the dossier's does not. */
  entryRouteRefused?: boolean;
  /**
   * What the last completed run found at this rung, whether or not its quote is
   * still open. The dossier carries it; Discover's list preview does not need
   * it, because that projection never applied a freshness filter in the first
   * place.
   */
  lastMeasured?: {
    status: OfficialLadderRungWireV1['status'];
    errorCode: string | null;
    observedAt: string;
    roundTripCostBps: string | null;
  } | null;
}

/**
 * The ladder, as rows.
 *
 * Extracted so the product has ONE projection of a round-trip ladder. Stocks
 * spent a phase rendering four dashes over a run whose ladder Discover was
 * already showing in full, and the cheapest way to grow a second, disagreeing
 * ladder would have been to write this logic again over there.
 *
 * USDC first, and only the rungs a run actually reached: a ladder of "not
 * measured" rows is four ways of saying nothing.
 *
 * A rung whose quote has expired is NOT one of those rows. The dossier's
 * projection carries open evidence in `status` and the completed measurement in
 * `lastMeasured`, and a router quote is good for about a minute -- so reading
 * `status` alone emptied every ladder on the Stocks page for every reader who
 * arrived later than that. The open figure wins when there is one; otherwise
 * the rung says what the run found, and when.
 */
export function cashExitLadderRungsV1(
  rungs: readonly CashExitRungInputV1[],
  now?: Date,
  /**
   * How to say an age. Defaults to Discover's own wording.
   *
   * Stocks renders this ladder beside its own rows, and the two spellings —
   * "46m ago" here, "46 min ago" three lines below — read as two different
   * measurements on one card. Each surface passes the words it uses everywhere
   * else rather than one of them being made to speak the other's.
   */
  ageLabel: (iso: string, at: Date) => string | null = rwaAgeLabelV1,
): FactViewV1[] {
  return rungs
    .filter(
      (rung): rung is CashExitRungInputV1 & { requestedCashAtomic: string } =>
        rung.destination === 'USDC' &&
        (rung.status !== 'not_measured' || (rung.lastMeasured ?? null) !== null) &&
        // A rung sized by an actual position carries no cash size, so it is
        // not a rung of the CASH ladder. The dossier holds both kinds.
        rung.requestedCashAtomic !== null,
    )
    .map((rung) => {
      const history = rung.status === 'not_measured' ? (rung.lastMeasured ?? null) : null;
      const cost = rwaBpsLabelV1(history ? history.roundTripCostBps : rung.roundTripCostBps);
      const coded = history?.errorCode ? (RUNG_ERROR_LABEL_V1[history.errorCode] ?? null) : null;
      const refused = history ? false : rung.entryRouteRefused === true;
      const meta =
        coded ??
        (refused ? ENTRY_REFUSED_LABEL_V1 : RUNG_STATUS_V1[history ? history.status : rung.status]);
      const age = history && now ? ageLabel(history.observedAt, now) : null;
      return {
        label: cashSizeLabelV1(rung.requestedCashAtomic),
        value: cost ?? meta.label,
        // A cost carried forward from a smaller rung must say so. Reading it
        // as this size's cost is reading a measurement of something else.
        note: rung.derivedFromExactRung
          ? `carried from ${cashSizeLabelV1(rung.lowerBoundRequestedCashAtomic ?? '0')}`
          : // History is labelled as history. The tone stays the outcome's --
            // a rung nobody can exit is not less true for being ten minutes old.
            (age ? `measured ${age}` : null),
        tone: meta.tone,
      };
    });
}

const RUNG_STATUS_V1: Readonly<
  Record<OfficialLadderRungWireV1['status'], { label: string; tone: ToneV1 }>
> = {
  full: { label: 'round trip', tone: 'good' },
  partial: { label: 'partial', tone: 'warn' },
  buy_only: { label: 'buy only', tone: 'warn' },
  unavailable: { label: 'no exit route', tone: 'warn' },
  not_measured: { label: 'not measured', tone: 'off' },
  measurement_failed: { label: 'did not finish', tone: 'off' },
};

/** The one rung label that depends on WHY the measurement stopped: a refused
 * buy leg is the router's answer, not our failure.
 *
 * Was "no cash entry", which is a phrase nobody outside this codebase can
 * read. It pairs with `unavailable`'s "no exit route" — one side in, one side
 * out — so it now says the same thing in the same shape. */
const ENTRY_REFUSED_LABEL_V1 = { label: 'no buy route', tone: 'warn' as ToneV1 };

/**
 * Rung labels the measurement's own error code decides.
 *
 * Both of these are the ROUTER answering. `measurement_failed` alone renders as
 * "did not finish", which is our vocabulary for our outage, and putting it over
 * a router that said "I do not carry this token" files the router's answer
 * under our failure.
 */
const RUNG_ERROR_LABEL_V1: Readonly<Record<string, { label: string; tone: ToneV1 }>> = {
  cash_size_anchor_no_route: ENTRY_REFUSED_LABEL_V1,
  // Compact in the rung, because it repeats once per size. The full sentence --
  // "This route source does not cover this token" -- is said once on the card,
  // where a reader meets it before the ladder.
  provider_unsupported_token: { label: 'not covered', tone: 'warn' },
  // A venue that CAN route this and declined to, on its own trading rules.
  // `warn`, not `off`: nothing was found wrong with the token or the market.
  provider_policy_refused: { label: 'venue declined', tone: 'warn' },
  // Ours, not the market's: a market exists at a venue this build cannot read.
  provider_venue_not_covered: { label: 'venue not covered by us', tone: 'warn' },
};

const REFERENCE_NOTE_V1: Readonly<Record<OfficialAssetWireV1['referenceValue']['status'], string>> =
  {
    fresh: 'Chainlink total-return feed',
    stale: 'Chainlink feed has not updated inside its window',
    paused: 'Chainlink feed is paused',
    unavailable: 'Reference feed could not be read',
    invalid: 'Reference feed answered something this build will not accept',
  };

const COMPARISON_REASON_V1: Readonly<Record<string, string>> = {
  reference_stale: 'the reference feed is stale',
  reference_paused: 'the reference feed is paused',
  reference_unavailable: 'the reference feed could not be read',
  reference_invalid: 'the reference feed answered something unusable',
  registry_pause_state_unavailable: 'the registry pause state could not be read',
  executable_value_not_measured: 'no cash route has been measured',
  executable_value_unavailable: 'no approved router returned a route',
  executable_value_buy_only: 'only the buy leg completed',
  executable_value_measurement_failed: 'the measurement did not finish',
  executable_value_not_normalized:
    'the quote is cash back at one size, not a per-share price, and the feed is per share',
};

export const LOOKALIKE_ALIAS_LABEL_V1: Readonly<Record<LookalikeAliasFilterV1, string>> = {
  all: 'All',
  published_ticker: 'Published ticker',
  underlying: 'Underlying',
  display_name: 'Display name',
};

const LOOKALIKE_ALIAS_NOTE_V1: Readonly<Record<LookalikeAliasV1, string>> = {
  published_ticker:
    'This contract declares the ticker Coinbase publishes for the asset. Nobody types AAPLc by accident.',
  underlying:
    'This contract declares the underlying company’s symbol, which is also an ordinary word people name tokens after.',
  display_name: 'This contract declares the asset’s display name.',
};

const MATCH_KIND_LABEL_V1: Readonly<Record<OfficialLookalikeCardWireV1['matchKind'], string>> = {
  symbol_exact: 'symbol, exactly',
  symbol_normalized: 'symbol, ignoring case and punctuation',
  name_normalized: 'name, ignoring case and punctuation',
};

const SIGNAL_TITLE_V1: Readonly<Record<string, string>> = {
  official_source_added_asset: 'Official source added an asset',
  official_source_removed_asset: 'Official source removed an asset',
  official_asset_lookalike_created: 'A contract started wearing an official name',
  official_asset_market_became_active: 'A cash route appeared',
  official_asset_market_became_unreachable: 'The cash route is gone',
  official_asset_cash_exit_changed: 'Round-trip cost moved',
};

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

export interface CounterViewV1 {
  label: string;
  value: string;
  note: string | null;
  tone: ToneV1;
}

export interface FactViewV1 {
  label: string;
  value: string;
  note: string | null;
  tone: ToneV1;
}

export interface OfficialAssetCardViewV1 {
  tokenAddress: string;
  ticker: string;
  displayName: string | null;
  trustRoot: string;
  status: { chip: string; tone: ToneV1; body: string };
  listedIn: string;
  facts: FactViewV1[];
  /** The cash ladder, one entry per measured size. Empty when nothing
   * measured it — never a row of zeros. */
  ladder: FactViewV1[];
  ladderNote: string | null;
  market: FactViewV1[];
  notices: string[];
  lookalikeNote: string | null;
  technical: { label: string; value: string }[];
}

export interface OfficialAssetsViewV1 {
  counters: CounterViewV1[];
  sources: { label: string; value: string; note: string | null; tone: ToneV1 }[];
  marketObservation: string;
  assets: OfficialAssetCardViewV1[];
}

export function officialAssetsViewV1(
  wire: OfficialAssetsOverviewWireV1,
  now: Date,
): OfficialAssetsViewV1 {
  const counters: CounterViewV1[] = [
    {
      label: 'Official issuance',
      value: String(wire.counts.officialIssuance),
      // Named for the corpus, not for one issuer in it. The count reached 34
      // once Backed's bTokens API became a reviewed source — and the right rail
      // on the same screen listed all three sources beside a sentence that
      // credited only Coinbase.
      note: 'Currently listed by a reviewed issuer source',
      tone: 'neutral',
    },
    {
      label: 'Cash route established',
      value: String(wire.counts.cashRouteEstablished),
      note: 'A round trip completed at a measured size',
      tone: 'good',
    },
    {
      label: 'No exit at measured sizes',
      value: String(wire.counts.noRouteAtMeasuredSizes),
      note: 'Bought, and no router would sell it back',
      tone: 'warn',
    },
    {
      label: 'No cash entry at measured sizes',
      value: String(wire.counts.noEntryRouteAtMeasuredSizes),
      note: 'No router would sell it to you for cash',
      tone: 'warn',
    },
  ];
  // Shown only when it is not zero, and the four still sum: a reader who sees
  // three numbers that do not add up subtracts them and invents a fourth.
  if (wire.counts.notMeasured > 0) {
    counters.push({
      label: 'Not measured',
      value: String(wire.counts.notMeasured),
      note: 'Miorail has not measured these yet',
      tone: 'off',
    });
  }
  if (wire.counts.measurementFailed > 0) {
    counters.push({
      label: 'Measurement did not finish',
      value: String(wire.counts.measurementFailed),
      note: 'Our router call failed, not the market',
      tone: 'off',
    });
  }

  const sources = wire.sources.map((source) => {
    const age = rwaAgeLabelV1(source.checkedAt, now);
    return {
      label: SOURCE_LABEL_V1[source.sourceKind],
      value:
        source.checkedAt === null
          ? 'never checked'
          : source.status === 'ok'
            ? `${source.assetCount ?? 0} assets · ${age}`
            : `check failed · ${age}`,
      note:
        source.status === 'ok' || source.status === null
          ? null
          : // A failed check withdraws nothing. Saying so beside the failure is
            // what stops a reader reading an outage as a delisting.
            `Membership is unchanged; the last successful check was ${
              rwaAgeLabelV1(source.lastSuccessfulAt, now) ?? 'never'
            }.`,
      tone: (source.checkedAt === null
        ? 'off'
        : source.status === 'ok'
          ? 'good'
          : 'warn') as ToneV1,
    };
  });

  const observation = wire.marketObservation;
  const read =
    observation.status === 'never_run'
      ? null
      : `Ledger tail read through Base block ${(
          observation.checkedThroughBlock ?? 0
        ).toLocaleString('en-US')} · ${rwaAgeLabelV1(observation.checkedAt, now) ?? 'unknown'}.`;
  const marketObservation =
    read === null
      ? 'The ledger tail has not run on this deployment, so no movement has been observed for any asset. That is not a quiet market.'
      : (observation.identifiedVenueCount ?? 0) === 0
        ? // The tail can read ten thousand transfers and store nothing: a
          // movement is only attributed once its counterparty is known to be a
          // venue. Saying "no movements" here would be a finding about the
          // assets authored entirely by our own backlog.
          `${read} No counterparty has been identified as a venue yet${
            observation.candidatesPendingIdentification
              ? `, with ${observation.candidatesPendingIdentification.toLocaleString('en-US')} still to ask`
              : ''
          }, so no movement can be attributed to one. That is our backlog, not a quiet market.`
        : `${read} ${(observation.identifiedVenueCount ?? 0).toLocaleString('en-US')} venue${
            observation.identifiedVenueCount === 1 ? '' : 's'
          } identified${
            observation.candidatesPendingIdentification
              ? `, ${observation.candidatesPendingIdentification.toLocaleString('en-US')} counterparties still to ask`
              : ''
          }.`;

  return {
    counters,
    sources,
    marketObservation,
    assets: wire.assets.map((asset) => officialAssetCardViewV1(asset, now)),
  };
}

/**
 * How long a round-trip observation may still be spoken of in the present.
 *
 * A router quote is good for about twenty seconds; this is not that window. It
 * is the point past which calling a stored measurement anything but history
 * misleads a reader, and it is deliberately generous: the sampler runs on a
 * much longer timer than a quote lives, so a stricter bound would mark every
 * card historical and teach nobody anything.
 */
const ROUTE_OBSERVATION_RECENT_SECONDS_V1 = 15 * 60;

/**
 * The chip, with the age of the evidence behind it taken into account.
 *
 * Screenshot, 2026-08-30: `AAPLc` carried `ACTIVE MARKET` over an executable
 * observation 22 minutes old and a reference feed marked stale on the same
 * card. The verdict was right and the tense was wrong.
 */
function routeChipV1(
  asset: OfficialAssetWireV1,
  now: Date,
): { chip: string; tone: ToneV1; body: string } {
  const status = ROUTE_STATUS_V1[asset.market.routeStatus];
  if (asset.market.routeStatus !== 'cash_route_established') return status;
  const observedAt = asset.executableValue.observedAt;
  const ageSeconds =
    observedAt === null ? null : Math.max(0, (now.getTime() - Date.parse(observedAt)) / 1000);
  if (ageSeconds !== null && ageSeconds <= ROUTE_OBSERVATION_RECENT_SECONDS_V1) return status;
  return {
    chip: 'HISTORICAL ROUTE EVIDENCE',
    // Not `good`: the finding stands, but nothing here is current.
    tone: 'neutral',
    body: `${status.body} That measurement is history, not a current price — measure again for an answer about now.`,
  };
}

function officialAssetCardViewV1(asset: OfficialAssetWireV1, now: Date): OfficialAssetCardViewV1 {
  const status = routeChipV1(asset, now);
  const reference = moneyLabelV1(asset.referenceValue.valueAtomic, asset.referenceValue.decimals);
  const executable = moneyLabelV1(
    asset.executableValue.valueAtomic,
    asset.executableValue.decimals,
  );
  const referenceAge =
    asset.referenceValue.ageSeconds === null
      ? null
      : rwaAgeLabelV1(
          new Date(now.getTime() - asset.referenceValue.ageSeconds * 1000).toISOString(),
          now,
        );

  const facts: FactViewV1[] = [
    {
      label: 'Reference value',
      // Null renders the words. A missing price displayed as $0.00 is a lie
      // with a decimal point in it.
      value: reference ?? 'not available',
      note:
        reference === null
          ? REFERENCE_NOTE_V1[asset.referenceValue.status]
          : `${REFERENCE_NOTE_V1[asset.referenceValue.status]}${referenceAge ? ` · updated ${referenceAge}` : ''}`,
      tone: reference === null ? 'off' : asset.referenceValue.status === 'fresh' ? 'good' : 'warn',
    },
    {
      // The size is IN the label. "Executable value $99,743.82" beside a
      // "$320.30" reference is how a $99,663 cash total once got divided by a
      // per-share feed and rendered as 31,015%: two different units under two
      // labels that both read as "value".
      label: executable
        ? `${compactCashSizeLabelV1(asset.executableValue.requestedSizeAtomic ?? '0')} cash-out`
        : 'Cash-out at a measured size',
      value: executable ?? 'not measured',
      note:
        executable === null
          ? asset.market.routeStatus === 'no_route_at_measured_sizes'
            ? 'Bought, and no approved router would sell it back'
            : asset.market.routeStatus === 'no_entry_route_at_measured_sizes'
              ? 'No approved router would sell it to you for cash'
              : 'No completed round trip on file'
          : `Router quote · measured ${
              rwaAgeLabelV1(asset.executableValue.observedAt, now) ?? 'at an unknown time'
            }`,
      tone: executable === null ? 'off' : 'good',
    },
  ];

  const difference = rwaBpsLabelV1(asset.comparison.differenceBps);
  if (asset.comparison.status === 'comparable' && difference !== null) {
    facts.push({
      label: 'Reference vs executable',
      value: difference,
      // The feed's age travels with the comparison. A US equity feed holds the
      // last close overnight and at weekends, so a difference read without it
      // would be taken for a live spread.
      note: referenceAge
        ? `Against a feed that last published ${referenceAge}`
        : 'What a round trip costs against the feed',
      tone: 'neutral',
    });
  } else if (asset.comparison.reason !== null) {
    facts.push({
      label: 'Reference vs executable',
      value: 'withheld',
      note: `Not comparable: ${COMPARISON_REASON_V1[asset.comparison.reason] ?? asset.comparison.reason}`,
      tone: 'off',
    });
  }

  const ladderRungs = cashExitLadderRungsV1(asset.market.ladder, now);

  const observation = asset.market.observation;
  const market: FactViewV1[] = [
    {
      label: 'Observed venues',
      value:
        observation.status === 'not_observed'
          ? 'not observed'
          : String(observation.pairedPoolCount ?? 0),
      note:
        observation.status === 'not_observed'
          ? 'No venue has been identified to attribute a movement to'
          : 'Identified pools holding this token as one side',
      tone: observation.status === 'not_observed' ? 'off' : 'neutral',
    },
    {
      label: 'Recent movements',
      value:
        observation.status === 'not_observed'
          ? 'not observed'
          : String(observation.movementCount ?? 0),
      // Never "trades". 2 of 34 measured transactions through the v4 singleton
      // carried no swap at all, so the word would be wrong 6% of the time.
      note: 'Transfers through a venue, not confirmed swaps',
      tone: observation.status === 'not_observed' ? 'off' : 'neutral',
    },
  ];

  const notices: string[] = [];
  if (asset.sourceDiscrepancy) {
    notices.push(
      'The reviewed sources do not agree about this asset. Both readings are shown rather than reconciled.',
    );
  }

  return {
    tokenAddress: asset.tokenAddress,
    ticker: asset.ticker,
    displayName: asset.displayName,
    trustRoot: 'OFFICIAL',
    status,
    listedIn: asset.listedIn.map((kind) => SOURCE_LABEL_V1[kind]).join(' + '),
    facts,
    ladder: ladderRungs,
    ladderNote:
      ladderRungs.length === 0
        ? null
        : `Exact sizes only, quoted through ${asset.market.approvedSources.join(', ') || 'no approved router'} · measured ${
            rwaAgeLabelV1(asset.market.measuredAt, now) ?? 'at an unknown time'
          }. Nothing here was executed.`,
    market,
    notices,
    lookalikeNote:
      asset.lookalikeCount === 0
        ? null
        : `${asset.lookalikeCount} contract${asset.lookalikeCount === 1 ? '' : 's'} in the launch index declare this asset’s name. A resemblance is not a claim about intent.`,
    technical: [
      { label: 'Route status', value: asset.market.routeStatus },
      { label: 'Reference status', value: asset.referenceValue.status },
      { label: 'Executable status', value: asset.executableValue.status },
      { label: 'Observation', value: observation.status },
      {
        label: 'Reference feed',
        value: asset.referenceValue.feedAddress ?? 'none bound by the source',
      },
      { label: 'Issuer', value: asset.issuer },
    ],
  };
}

export interface LookalikeCardViewV1 {
  tokenAddress: string;
  declaredSymbol: string;
  declaredName: string;
  official: { ticker: string; displayName: string | null; address: string };
  matchedLabel: string;
  matchedNote: string;
  facts: FactViewV1[];
}

export interface LookalikeFeedViewV1 {
  headline: string;
  disclaimer: string;
  filters: { id: LookalikeAliasFilterV1; label: string; count: number }[];
  lastScan: string | null;
  cards: LookalikeCardViewV1[];
}

export function lookalikeFeedViewV1(
  wire: OfficialLookalikeFeedWireV1,
  now: Date,
): LookalikeFeedViewV1 {
  return {
    headline: `${wire.counts.total} contract${
      wire.counts.total === 1 ? '' : 's'
    } in the launch index resemble an official asset by declared metadata.`,
    disclaimer: wire.disclaimer,
    filters: [
      { id: 'all', label: LOOKALIKE_ALIAS_LABEL_V1.all, count: wire.counts.total },
      {
        id: 'published_ticker',
        label: LOOKALIKE_ALIAS_LABEL_V1.published_ticker,
        count: wire.counts.publishedTicker,
      },
      {
        id: 'underlying',
        label: LOOKALIKE_ALIAS_LABEL_V1.underlying,
        count: wire.counts.underlying,
      },
      {
        id: 'display_name',
        label: LOOKALIKE_ALIAS_LABEL_V1.display_name,
        count: wire.counts.displayName,
      },
    ],
    lastScan:
      wire.lastScanAt === null
        ? 'The launch index has never been scanned against the official corpus.'
        : `Index last compared with the official corpus ${rwaAgeLabelV1(wire.lastScanAt, now) ?? 'at an unknown time'}.`,
    cards: wire.cards.map((card) => ({
      tokenAddress: card.tokenAddress,
      declaredSymbol: card.declaredSymbol,
      declaredName: card.declaredName,
      official: {
        ticker: card.officialTicker,
        displayName: card.officialDisplayName,
        address: card.officialAddress,
      },
      matchedLabel: `${LOOKALIKE_ALIAS_LABEL_V1[card.matchedAlias]} · ${card.matchedValue}`,
      matchedNote: LOOKALIKE_ALIAS_NOTE_V1[card.matchedAlias],
      facts: [
        {
          label: 'Matched on',
          value: MATCH_KIND_LABEL_V1[card.matchKind],
          note: null,
          tone: 'neutral',
        },
        {
          label: 'Launched',
          // Null renders the words. The index not knowing when a contract
          // launched is different from it launching at the epoch.
          value:
            card.launchedAt === null
              ? 'not known to the index'
              : (rwaAgeLabelV1(card.launchedAt, now) ?? 'unknown'),
          note: null,
          tone: card.launchedAt === null ? 'off' : 'neutral',
        },
        {
          label: 'First flagged',
          value: rwaAgeLabelV1(card.firstFlaggedAt, now) ?? 'unknown',
          note: null,
          tone: 'neutral',
        },
      ],
    })),
  };
}

export interface SignalCardViewV1 {
  signalId: string;
  title: string;
  /** `label` is the ticker when the corpus knows one and the short address
   * otherwise — never nothing, and never a symbol on its own. */
  subject: { ticker: string | null; address: string; label: string };
  official: { ticker: string | null; address: string } | null;
  occurred: string;
  detail: string;
}

export interface SignalFeedViewV1 {
  watching: string | null;
  notReported: string[];
  cards: SignalCardViewV1[];
  /** What an empty feed means, in words. Never "nothing is happening". */
  emptyNote: string | null;
}

function signalDetailV1(card: RwaSignalCardWireV1): string {
  const facts = card.facts;
  const text = (key: string): string | null => {
    const value = facts[key];
    return typeof value === 'string' && value.length > 0 ? value : null;
  };
  switch (card.kind) {
    case 'official_source_added_asset':
    case 'official_source_removed_asset': {
      const ticker = text('ticker') ?? card.subjectTicker ?? 'an asset';
      const sourceKind = text('sourceKind');
      const source =
        sourceKind === 'base_product_list'
          ? 'the Base product page'
          : sourceKind === 'backed_assets_api'
            ? 'the Backed bTokens API'
            : 'the Base docs corpus';
      return card.kind === 'official_source_added_asset'
        ? `${ticker} is now listed by ${source}.`
        : `${ticker} is no longer listed by ${source}. Only this successfully read source changed; no other issuer is inferred.`;
    }
    case 'official_asset_lookalike_created': {
      const official = text('officialTicker') ?? card.officialTicker ?? 'an official asset';
      const declared = text('launchSymbol') || text('launchName') || 'no symbol';
      return `A launch declaring “${declared}” matches ${official} on ${
        text('matchedAlias') === 'published_ticker'
          ? 'its published ticker'
          : 'a name it also answers to'
      }. Addresses differ; this is a resemblance and nothing more.`;
    }
    case 'official_asset_market_became_active': {
      const ticker = text('ticker') ?? card.subjectTicker ?? 'an asset';
      const size = text('requestedCashAtomic');
      const cost = rwaBpsLabelV1(text('roundTripCostBps'));
      return `${ticker} completed a round trip${size ? ` at ${cashSizeLabelV1(size)}` : ''}${
        cost ? ` for ${cost}` : ''
      }, where the previous measurement found no route.`;
    }
    case 'official_asset_market_became_unreachable': {
      const ticker = text('ticker') ?? card.subjectTicker ?? 'an asset';
      const size = text('requestedCashAtomic');
      return `${ticker} no longer returns a route${size ? ` at ${cashSizeLabelV1(size)}` : ''}, where the previous measurement completed one. The measurement itself succeeded.`;
    }
    case 'official_asset_cash_exit_changed': {
      const ticker = text('ticker') ?? card.subjectTicker ?? 'an asset';
      const size = text('requestedCashAtomic');
      const before = rwaBpsLabelV1(text('previousRoundTripCostBps'));
      const after = rwaBpsLabelV1(text('roundTripCostBps'));
      return `${ticker} round trip${size ? ` at ${cashSizeLabelV1(size)}` : ''} moved from ${before ?? 'an earlier reading'} to ${
        after ?? 'a new reading'
      }.`;
    }
    default:
      return 'This build does not know how to describe this signal.';
  }
}

export function signalFeedViewV1(wire: RwaSignalFeedWireV1, now: Date): SignalFeedViewV1 {
  const oldest = wire.watching
    .map((row) => row.watchingSince)
    .sort()
    .at(0);
  const watching =
    wire.watching.length === 0
      ? null
      : `Watching ${wire.watching.length} kind${wire.watching.length === 1 ? '' : 's'} of change since ${
          rwaAgeLabelV1(oldest ?? null, now) ?? 'an unknown time'
        }. Nothing before that can appear here.`;

  return {
    watching,
    notReported: [...wire.notReported],
    cards: wire.cards.map((card) => ({
      signalId: card.signalId,
      title: SIGNAL_TITLE_V1[card.kind] ?? card.kind,
      subject: {
        ticker: card.subjectTicker,
        address: card.subjectAddress,
        label: card.subjectTicker ?? shortAddressV1(card.subjectAddress),
      },
      official:
        card.officialAddress === null
          ? null
          : { ticker: card.officialTicker, address: card.officialAddress },
      occurred: rwaAgeLabelV1(card.occurredAt, now) ?? 'unknown',
      detail: signalDetailV1(card),
    })),
    // The two empty states are different facts and must not share a sentence.
    emptyNote:
      wire.cards.length > 0
        ? null
        : wire.watching.length === 0
          ? 'No emitter has run yet, so nothing is being watched. An empty feed here says nothing about the market.'
          : 'Nothing has changed since these kinds started being watched.',
  };
}
