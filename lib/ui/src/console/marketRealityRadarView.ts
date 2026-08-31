import { formatAtomicAmount } from '../formatAtomicAmount';
import { quoteAgeLabelV1, type UnderlyingChoiceViewV1 } from './marketRealityView';

export type RadarIssuerV1 = 'coinbase' | 'dinari' | 'backed';
export type RadarRepresentationKindV1 =
  | 'b20_asset'
  | 'rebasing_erc20'
  | 'non_rebasing_erc4626_wrapper';

export interface MarketRealityRadarWatchWireV1 {
  watchId: string;
  chainId: 8453;
  underlyingKey: string;
  tokenAddress: string;
  issuerId: RadarIssuerV1;
  representationKind: RadarRepresentationKindV1;
  direction: 'buy' | 'sell';
  requestedCashAtomic: string;
  destination: 'USDC' | 'ETH';
  routePolicyKey: string;
  approvedSources: readonly string[];
  createdAt: string;
  lastEvaluatedAt: string | null;
  lastComparableAt: string | null;
  lastEvaluationOutcome:
    | 'baseline'
    | 'compared'
    | 'measurement_failed'
    | 'unsized'
    | 'policy_changed'
    | null;
}

export interface MarketRealityRadarEventWireV1 {
  eventId: string;
  watchId: string;
  chainId: 8453;
  tokenAddress: string;
  kind:
    | 'sell_exit_cost_changed'
    | 'buy_effective_price_changed'
    | 'route_became_unavailable'
    | 'route_became_available'
    | 'market_session_changed'
    | 'reference_became_stale'
    | 'representation_ratio_changed';
  previousSnapshotHash: string;
  snapshotHash: string;
  previousObservedAt: string;
  occurredAt: string;
  approvedSources: readonly string[];
  facts: Record<string, unknown>;
}

export interface MarketRealityRadarWireV1 {
  watches: readonly MarketRealityRadarWatchWireV1[];
  events: readonly MarketRealityRadarEventWireV1[];
  assembledAt: string;
}

export interface MarketRealityRadarWatchViewV1 {
  watchId: string;
  title: string;
  issuerName: string;
  structureLabel: string;
  tokenAddress: string;
  question: string;
  statusLabel: string;
  statusNote: string;
  lastComparableAge: string | null;
  technicalOutcome: string | null;
  lastEvaluationOutcome: MarketRealityRadarWatchWireV1['lastEvaluationOutcome'];
  routePolicyKey: string;
  approvedSources: string;
}

export interface MarketRealityRadarEventViewV1 {
  eventId: string;
  watchId: string;
  title: string;
  issuerName: string;
  question: string;
  headline: string;
  primary: string;
  secondary: string | null;
  delta: string | null;
  occurredAge: string;
  occurredAt: string;
  tokenAddress: string;
  previousSnapshotHash: string;
  snapshotHash: string;
  approvedSources: string;
  technicalKind: MarketRealityRadarEventWireV1['kind'];
  technicalFacts: string;
}

export interface MarketRealityRadarViewV1 {
  watches: MarketRealityRadarWatchViewV1[];
  events: MarketRealityRadarEventViewV1[];
  assembledAge: string;
  scope: string;
}

const ISSUER_V1: Readonly<Record<RadarIssuerV1, string>> = {
  coinbase: 'Coinbase',
  dinari: 'Dinari',
  backed: 'Backed',
};

const STRUCTURE_V1: Readonly<Record<RadarRepresentationKindV1, string>> = {
  b20_asset: 'B20 asset',
  rebasing_erc20: 'Rebasing ERC-20',
  non_rebasing_erc4626_wrapper: 'ERC-4626 wrapper',
};

const SESSION_V1: Readonly<Record<string, string>> = {
  regular_hours: 'US market open',
  after_hours: 'US market closed / after hours',
  weekend: 'Weekend',
};

const PUBLICATION_V1: Readonly<Record<string, string>> = {
  live_reference: 'Live reference publication',
  holding_last_close: 'Reference holding last published value',
  corporate_action_hold: 'Corporate-action hold',
  stale: 'Stale reference',
};

function usdV1(atomic: unknown, decimals = 6): string {
  if (typeof atomic !== 'string' || !/^(0|[1-9][0-9]*)$/.test(atomic)) return '—';
  const value = formatAtomicAmount(atomic, decimals);
  const [whole, fraction] = value.split('.');
  return `$${(whole ?? '0').replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${(fraction ?? '').slice(0, 2).padEnd(2, '0')}`;
}

function signedUsdV1(atomic: unknown): string {
  if (typeof atomic !== 'string' || !/^-?(0|[1-9][0-9]*)$/.test(atomic)) return '—';
  const value = BigInt(atomic);
  const sign = value > 0n ? '+' : value < 0n ? '−' : '';
  return `${sign}${usdV1((value < 0n ? -value : value).toString())}`;
}

function bpsPercentV1(value: unknown): string {
  if (typeof value !== 'string' || !/^-?(0|[1-9][0-9]*)$/.test(value)) return '—';
  const bps = BigInt(value);
  const sign = bps < 0n ? '−' : '';
  const magnitude = bps < 0n ? -bps : bps;
  return `${sign}${magnitude / 100n}.${(magnitude % 100n).toString().padStart(2, '0')}%`;
}

function signedPercentFromBpsV1(value: unknown): string {
  if (typeof value !== 'string' || !/^-?(0|[1-9][0-9]*)$/.test(value)) return '—';
  return `${BigInt(value) > 0n ? '+' : ''}${bpsPercentV1(value)}`;
}

function signedBpsV1(value: unknown): string {
  if (typeof value !== 'string' || !/^-?(0|[1-9][0-9]*)$/.test(value)) return '—';
  const bps = BigInt(value);
  return `${bps > 0n ? '+' : bps < 0n ? '−' : ''}${(bps < 0n ? -bps : bps).toString()} bps`;
}

function questionV1(watch: MarketRealityRadarWatchWireV1): string {
  const cash = usdV1(watch.requestedCashAtomic);
  return watch.direction === 'sell'
    ? `${cash} SELL → ${watch.destination}`
    : `${cash} BUY with ${watch.destination}`;
}

function watchStatusV1(watch: MarketRealityRadarWatchWireV1): {
  label: string;
  note: string;
  technical: string | null;
} {
  if (watch.lastComparableAt === null) {
    if (watch.lastEvaluationOutcome === 'policy_changed') {
      return {
        label: 'Needs review',
        note: 'The reviewed route policy changed before a baseline was established. Re-open Market Reality before replacing this watch.',
        technical: 'route policy changed',
      };
    }
    if (watch.lastEvaluationOutcome === 'measurement_failed') {
      return {
        label: 'Waiting for baseline',
        note: 'The latest scheduled read failed. No market event was created.',
        technical: 'our latest read failed',
      };
    }
    if (watch.lastEvaluationOutcome === 'unsized') {
      return {
        label: 'Waiting for baseline',
        note: 'The latest scheduled pass could not size this exact question. No market event was created.',
        technical: 'exact question was not sized',
      };
    }
    return {
      label: 'Waiting for baseline',
      note: 'The first successful scheduled observation starts the watch and reports nothing as a change.',
      technical: null,
    };
  }
  if (watch.lastEvaluationOutcome === 'policy_changed') {
    return {
      label: 'Needs review',
      note: 'New observations use a different reviewed route policy and are not compared with this watch.',
      technical: 'route policy changed',
    };
  }
  return {
    label: 'Watching',
    note:
      watch.lastEvaluationOutcome === 'measurement_failed'
        ? 'The last scheduled read failed, so the previous successful baseline remains in place and no event was created.'
        : watch.lastEvaluationOutcome === 'unsized'
          ? 'The last scheduled pass could not size this exact question; the successful baseline remains in place.'
          : 'Only a later successful comparable observation can create an event.',
    technical:
      watch.lastEvaluationOutcome === 'measurement_failed'
        ? 'our latest read failed'
        : watch.lastEvaluationOutcome === 'unsized'
          ? 'exact question was not sized'
          : null,
  };
}

function eventCopyV1(event: MarketRealityRadarEventWireV1): {
  headline: string;
  primary: string;
  secondary: string | null;
  delta: string | null;
} {
  const facts = event.facts;
  switch (event.kind) {
    case 'sell_exit_cost_changed': {
      const delta = typeof facts.changeBps === 'string' ? BigInt(facts.changeBps) : 0n;
      return {
        headline: delta > 0n ? 'Exit cost widened' : delta < 0n ? 'Exit cost narrowed' : 'Exit cost changed',
        primary: `${usdV1(facts.previousCashBackAtomic)} → ${usdV1(facts.cashBackAtomic)} cash back`,
        secondary: `${bpsPercentV1(facts.previousExitCostBps)} → ${bpsPercentV1(facts.exitCostBps)} exit cost`,
        delta: `${signedUsdV1(facts.cashBackChangeAtomic)} · ${signedBpsV1(facts.changeBps)}`,
      };
    }
    case 'buy_effective_price_changed':
      return {
        headline: 'Effective execution price changed',
        primary: `${usdV1(facts.previousEffectivePriceAtomic, Number(facts.effectivePriceDecimals))} → ${usdV1(facts.effectivePriceAtomic, Number(facts.effectivePriceDecimals))}`,
        secondary: null,
        // Was a bare basis-point delta — the only relative figure on this
        // event, in the one unit a reader has to convert.
        delta: `${signedPercentFromBpsV1(facts.changeBps)} · ${signedBpsV1(facts.changeBps)}`,
      };
    case 'route_became_unavailable':
      return {
        headline: 'Route became unavailable',
        primary: 'Route priced → no reviewed route',
        secondary: 'Both outcomes were established by successful full-policy measurements.',
        delta: null,
      };
    case 'route_became_available':
      return {
        headline: 'Route became available',
        primary: 'No reviewed route → route priced',
        secondary: 'Both outcomes were established by successful full-policy measurements.',
        delta: null,
      };
    case 'market_session_changed':
      return {
        headline: 'Reference session changed',
        primary: `${SESSION_V1[String(facts.previousMarketSession)] ?? facts.previousMarketSession} → ${SESSION_V1[String(facts.marketSession)] ?? facts.marketSession}`,
        secondary: `${PUBLICATION_V1[String(facts.previousPublicationMode)] ?? facts.previousPublicationMode} → ${PUBLICATION_V1[String(facts.publicationMode)] ?? facts.publicationMode}`,
        delta: null,
      };
    case 'reference_became_stale':
      return {
        headline: 'Reference became stale',
        primary: 'Fresh reviewed reference → stale reviewed reference',
        secondary: 'Executable market evidence remains separate from reference health.',
        delta: null,
      };
    case 'representation_ratio_changed':
      return {
        headline: 'Representation ratio changed',
        primary: `${facts.previousRawValue}/${facts.previousScale} → ${facts.rawValue}/${facts.scale}`,
        secondary: String(facts.ratioKind ?? 'reviewed representation ratio'),
        delta: null,
      };
  }
}

export function marketRealityRadarViewV1(input: {
  wire: MarketRealityRadarWireV1 | null;
  choices: readonly UnderlyingChoiceViewV1[];
  now: string;
}): MarketRealityRadarViewV1 | null {
  if (!input.wire) return null;
  const titleByKey = new Map(input.choices.map((choice) => [choice.underlyingKey, choice.title]));
  const watches = input.wire.watches.map((watch) => {
    const status = watchStatusV1(watch);
    return {
      watchId: watch.watchId,
      title: titleByKey.get(watch.underlyingKey) ?? watch.underlyingKey,
      issuerName: ISSUER_V1[watch.issuerId],
      structureLabel: STRUCTURE_V1[watch.representationKind],
      tokenAddress: watch.tokenAddress,
      question: questionV1(watch),
      statusLabel: status.label,
      statusNote: status.note,
      lastComparableAge: watch.lastComparableAt
        ? quoteAgeLabelV1(watch.lastComparableAt, input.now)
        : null,
      technicalOutcome: status.technical,
      lastEvaluationOutcome: watch.lastEvaluationOutcome,
      routePolicyKey: watch.routePolicyKey,
      approvedSources: [...watch.approvedSources].sort().join(' · '),
    };
  });
  const watchById = new Map(input.wire.watches.map((watch) => [watch.watchId, watch]));
  const events = input.wire.events.flatMap((event) => {
    const watch = watchById.get(event.watchId);
    if (!watch) return [];
    return [
      {
        eventId: event.eventId,
        watchId: event.watchId,
        title: titleByKey.get(watch.underlyingKey) ?? watch.underlyingKey,
        issuerName: ISSUER_V1[watch.issuerId],
        question: questionV1(watch),
        ...eventCopyV1(event),
        occurredAge: quoteAgeLabelV1(event.occurredAt, input.now) ?? event.occurredAt,
        occurredAt: event.occurredAt,
        tokenAddress: event.tokenAddress,
        previousSnapshotHash: event.previousSnapshotHash,
        snapshotHash: event.snapshotHash,
        approvedSources: [...event.approvedSources].sort().join(' · '),
        technicalKind: event.kind,
        technicalFacts: JSON.stringify(event.facts),
      },
    ];
  });
  return {
    watches,
    events,
    assembledAge: quoteAgeLabelV1(input.wire.assembledAt, input.now) ?? input.wire.assembledAt,
    scope:
      'Each watch is one exact Base representation, cash size, direction, destination and reviewed route policy. Events require two successful comparable observations. Provider and RPC failures remain technical gaps and never become asset changes.',
  };
}
