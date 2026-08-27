import {
  MarketRealityReferenceStateV1Schema,
  type MarketRealityReferenceStateV1,
} from './contracts.js';

const ADDRESS_V1 = /^0x[0-9a-f]{40}$/;

/**
 * Reviewed U.S. equity core-session semantics used by the current Coinbase
 * tokenized-equity reference adapter.
 *
 * The range is deliberately bounded. NYSE and Nasdaq currently publish the
 * same 2026 cash-equity holidays, 09:30–16:00 ET core session, and two 13:00
 * early closes. A date outside the reviewed corpus is `unknown`; this module
 * never grows a holiday calendar from weekday arithmetic.
 */
export const REVIEWED_US_EQUITIES_CALENDAR_2026_V1 = {
  key: 'us_equities_core_2026_v1',
  sourceUrls: [
    'https://www.nyse.com/trade/hours-calendars',
    'https://www.nasdaq.com/market-activity/stock-market-holiday-schedule',
  ],
  timeZone: 'America/New_York',
  validFrom: '2026-01-01',
  validThrough: '2026-12-31',
  regularOpenMinute: 9 * 60 + 30,
  regularCloseMinute: 16 * 60,
  closedDates: [
    '2026-01-01',
    '2026-01-19',
    '2026-02-16',
    '2026-04-03',
    '2026-05-25',
    '2026-06-19',
    '2026-07-03',
    '2026-09-07',
    '2026-11-26',
    '2026-12-25',
  ],
  earlyCloseMinutes: {
    '2026-11-27': 13 * 60,
    '2026-12-24': 13 * 60,
  } as Readonly<Record<string, number>>,
} as const;

export interface ReviewedReferenceCalendarV1 {
  key: string;
  sourceUrls: readonly string[];
  timeZone: 'America/New_York';
  validFrom: string;
  validThrough: string;
  regularOpenMinute: number;
  regularCloseMinute: number;
  closedDates: readonly string[];
  earlyCloseMinutes: Readonly<Record<string, number>>;
}

export interface ReviewedReferenceConfigurationV1 {
  chainId: 8453;
  tokenAddress: string;
  issuerId: 'coinbase' | 'dinari' | 'backed';
  referenceAddress: string;
  referenceSource: string;
  calendar: ReviewedReferenceCalendarV1 | null;
  outsideRegularHours: 'publishes' | 'holds_last_close' | 'unknown';
}

export interface ReviewedReferenceObservationV1 {
  chainId: 8453;
  tokenAddress: string;
  issuerId: 'coinbase' | 'dinari' | 'backed';
  referenceAddress: string;
  status: 'fresh' | 'stale' | 'corporate_action_hold';
  valueAtomic: string;
  decimals: number;
  observedAt: string;
  referenceUpdatedAt: string;
  evidence: {
    kind: 'chainlink_feed';
    source: string;
    blockNumber: string;
    blockHash: string;
    targetAddress: string;
    evidenceHash: string;
  };
}

type CalendarClassificationV1 = {
  kind: 'regular_hours' | 'after_hours' | 'weekend';
  localDate: string;
  regularOpenMinute: number;
  regularCloseMinute: number;
};

function localPartsV1(now: Date, timeZone: 'America/New_York') {
  if (!Number.isFinite(now.getTime())) return null;
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(now);
    const value = (type: Intl.DateTimeFormatPartTypes) =>
      parts.find((part) => part.type === type)?.value ?? null;
    const year = value('year');
    const month = value('month');
    const day = value('day');
    const weekday = value('weekday');
    const hour = Number(value('hour'));
    const minute = Number(value('minute'));
    if (
      !year ||
      !month ||
      !day ||
      !weekday ||
      !Number.isInteger(hour) ||
      !Number.isInteger(minute)
    ) {
      return null;
    }
    return {
      localDate: `${year}-${month}-${day}`,
      weekday,
      minuteOfDay: hour * 60 + minute,
    };
  } catch {
    return null;
  }
}

function classifyReviewedCalendarV1(
  now: Date,
  calendar: ReviewedReferenceCalendarV1,
): CalendarClassificationV1 | 'outside_reviewed_range' | null {
  const local = localPartsV1(now, calendar.timeZone);
  if (!local) return null;
  if (local.localDate < calendar.validFrom || local.localDate > calendar.validThrough) {
    return 'outside_reviewed_range';
  }
  const close = calendar.earlyCloseMinutes[local.localDate] ?? calendar.regularCloseMinute;
  const weekend = local.weekday === 'Sat' || local.weekday === 'Sun';
  if (weekend) {
    return {
      kind: 'weekend',
      localDate: local.localDate,
      regularOpenMinute: calendar.regularOpenMinute,
      regularCloseMinute: close,
    };
  }
  const closed = calendar.closedDates.includes(local.localDate);
  const regular =
    !closed && local.minuteOfDay >= calendar.regularOpenMinute && local.minuteOfDay < close;
  return {
    kind: regular ? 'regular_hours' : 'after_hours',
    localDate: local.localDate,
    regularOpenMinute: calendar.regularOpenMinute,
    regularCloseMinute: close,
  };
}

export function unknownMarketRealityReferenceV1(input: {
  reasonCode:
    | 'reference_adapter_not_configured'
    | 'issuer_reference_not_reviewed'
    | 'exact_representation_not_reviewed'
    | 'reference_configuration_missing'
    | 'reference_identity_mismatch'
    | 'reference_read_failed'
    | 'reference_response_invalid';
  reason: string;
  observedAt?: string | null;
  referenceSource?: string | null;
  referenceAddress?: string | null;
}): MarketRealityReferenceStateV1 {
  return MarketRealityReferenceStateV1Schema.parse({
    status: 'unknown',
    session: 'unknown',
    valueAtomic: null,
    decimals: null,
    observedAt: input.observedAt ?? null,
    referenceUpdatedAt: null,
    freshness: 'unknown',
    referenceSource: input.referenceSource ?? null,
    referenceAddress: input.referenceAddress ?? null,
    calendar: null,
    evidence: null,
    comparable: false,
    reasonCode: input.reasonCode,
    reason: input.reason,
  });
}

function observedStateV1(input: {
  configuration: ReviewedReferenceConfigurationV1;
  observation: ReviewedReferenceObservationV1;
  calendar: CalendarClassificationV1 | null;
  session: MarketRealityReferenceStateV1['session'];
  status: MarketRealityReferenceStateV1['status'];
  freshness: MarketRealityReferenceStateV1['freshness'];
  reasonCode: MarketRealityReferenceStateV1['reasonCode'];
  reason: string;
}): MarketRealityReferenceStateV1 {
  const { configuration, observation, calendar } = input;
  return MarketRealityReferenceStateV1Schema.parse({
    status: input.status,
    session: input.session,
    valueAtomic: observation.valueAtomic,
    decimals: observation.decimals,
    observedAt: observation.observedAt,
    referenceUpdatedAt: observation.referenceUpdatedAt,
    freshness: input.freshness,
    referenceSource: configuration.referenceSource,
    referenceAddress: configuration.referenceAddress,
    calendar: calendar
      ? {
          key: configuration.calendar!.key,
          sourceUrls: [...configuration.calendar!.sourceUrls],
          timeZone: configuration.calendar!.timeZone,
          localDate: calendar.localDate,
          regularOpenMinute: calendar.regularOpenMinute,
          regularCloseMinute: calendar.regularCloseMinute,
        }
      : null,
    evidence: observation.evidence,
    // Phase 10C.1 establishes state only. It intentionally does not activate
    // the existing premium/discount calculation; that is the next bounded task.
    comparable: false,
    reasonCode: input.reasonCode,
    reason: input.reason,
  });
}

/**
 * Classify one observation only after all three identities agree: chain,
 * representation address, and reviewed reference address. Calendar state and
 * feed health remain separate inputs; neither is inferred from the other.
 */
export function classifyMarketRealityReferenceV1(input: {
  now: Date;
  configuration: ReviewedReferenceConfigurationV1;
  observation: ReviewedReferenceObservationV1;
}): MarketRealityReferenceStateV1 {
  const { configuration, observation } = input;
  const exactIdentity =
    configuration.chainId === observation.chainId &&
    configuration.tokenAddress === observation.tokenAddress &&
    configuration.issuerId === observation.issuerId &&
    configuration.referenceAddress === observation.referenceAddress &&
    observation.evidence.targetAddress === observation.referenceAddress &&
    ADDRESS_V1.test(configuration.tokenAddress) &&
    ADDRESS_V1.test(configuration.referenceAddress);
  if (!exactIdentity) {
    return unknownMarketRealityReferenceV1({
      reasonCode: 'reference_identity_mismatch',
      reason:
        'The observation does not match the exact reviewed representation, issuer, and reference address.',
      observedAt: input.now.toISOString(),
      referenceSource: configuration.referenceSource,
      referenceAddress: ADDRESS_V1.test(configuration.referenceAddress)
        ? configuration.referenceAddress
        : null,
    });
  }

  if (!configuration.calendar) {
    return observedStateV1({
      configuration,
      observation,
      calendar: null,
      session: 'unknown',
      status:
        observation.status === 'fresh'
          ? 'fresh'
          : observation.status === 'stale'
            ? 'stale'
            : 'paused',
      freshness: observation.status === 'fresh' ? 'fresh' : 'stale',
      reasonCode: 'calendar_semantics_missing',
      reason: 'No reviewed market calendar is configured for this exact reference.',
    });
  }
  const calendar = classifyReviewedCalendarV1(input.now, configuration.calendar);
  if (calendar === 'outside_reviewed_range') {
    return observedStateV1({
      configuration,
      observation,
      calendar: null,
      session: 'unknown',
      status:
        observation.status === 'fresh'
          ? 'fresh'
          : observation.status === 'stale'
            ? 'stale'
            : 'paused',
      freshness: observation.status === 'fresh' ? 'fresh' : 'stale',
      reasonCode: 'calendar_outside_reviewed_range',
      reason: 'The observation falls outside the explicitly reviewed market-calendar range.',
    });
  }
  if (!calendar) {
    return observedStateV1({
      configuration,
      observation,
      calendar: null,
      session: 'unknown',
      status:
        observation.status === 'fresh'
          ? 'fresh'
          : observation.status === 'stale'
            ? 'stale'
            : 'paused',
      freshness: observation.status === 'fresh' ? 'fresh' : 'stale',
      reasonCode: 'calendar_classification_failed',
      reason: 'The reviewed calendar could not classify the explicit observation timestamp.',
    });
  }

  if (observation.status === 'corporate_action_hold') {
    return observedStateV1({
      configuration,
      observation,
      calendar,
      session: 'corporate_action_hold',
      status: 'paused',
      freshness: 'stale',
      reasonCode: 'reviewed_registry_corporate_action_hold',
      reason: 'The reviewed issuer registry explicitly established a corporate-action hold.',
    });
  }
  if (observation.status === 'stale') {
    return observedStateV1({
      configuration,
      observation,
      calendar,
      session: 'stale',
      status: 'stale',
      freshness: 'stale',
      reasonCode: 'reviewed_reference_stale',
      reason: 'The reviewed reference observation is outside its explicit freshness policy.',
    });
  }
  if (calendar.kind === 'weekend') {
    return observedStateV1({
      configuration,
      observation,
      calendar,
      session: 'weekend',
      status: 'fresh',
      freshness: 'fresh',
      reasonCode: 'reviewed_calendar_weekend',
      reason: 'The explicit observation time falls on a weekend in the reviewed market calendar.',
    });
  }
  if (calendar.kind === 'after_hours' && configuration.outsideRegularHours === 'holds_last_close') {
    return observedStateV1({
      configuration,
      observation,
      calendar,
      session: 'reference_holding_last_close',
      status: 'fresh',
      freshness: 'fresh',
      reasonCode: 'reviewed_feed_holding_last_close',
      reason:
        'The reviewed feed holds its last published value outside the reference core session.',
    });
  }
  if (calendar.kind === 'after_hours' && configuration.outsideRegularHours === 'unknown') {
    return observedStateV1({
      configuration,
      observation,
      calendar,
      session: 'unknown',
      status: 'fresh',
      freshness: 'fresh',
      reasonCode: 'calendar_semantics_missing',
      reason:
        'The calendar is reviewed, but this reference’s outside-session publication behavior is not.',
    });
  }
  return observedStateV1({
    configuration,
    observation,
    calendar,
    session: calendar.kind,
    status: 'fresh',
    freshness: 'fresh',
    reasonCode:
      calendar.kind === 'regular_hours'
        ? 'reviewed_calendar_regular_hours'
        : 'reviewed_calendar_after_hours',
    reason:
      calendar.kind === 'regular_hours'
        ? 'The explicit observation time falls inside the reviewed core trading session.'
        : 'The explicit observation time falls outside the reviewed core trading session.',
  });
}
