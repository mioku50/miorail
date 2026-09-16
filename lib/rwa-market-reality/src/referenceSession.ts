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

type ReviewedSessionV1 = { localDate: string; open: number; close: number };

/** The placement as this module produces it: always one of the five, never
 * absent. Absence is reserved for evidence stored before the axis existed. */
export type ReferencePublicationPlacementV1 = NonNullable<
  MarketRealityReferenceStateV1['publicationPlacement']
>;

type CalendarClassificationV1 = {
  kind: 'regular_hours' | 'after_hours' | 'weekend';
  localDate: string;
  minuteOfDay: number;
  regularOpenMinute: number;
  regularCloseMinute: number;
  publicationSessionLocalDate: string;
  publicationSessionOpenMinute: number;
  publicationSessionCloseMinute: number;
  /** The session that is open at this instant, or null outside one. */
  openSession: ReviewedSessionV1 | null;
  /** The most recent session whose close is already in the past. Distinct from
   * the publication session above, which is the most recent session INCLUDING
   * one that is still open. */
  lastClosedSession: ReviewedSessionV1 | null;
};

function dateShiftV1(localDate: string, days: number): string {
  const [year, month, day] = localDate.split('-').map(Number);
  const value = new Date(Date.UTC(year!, month! - 1, day! + days));
  return value.toISOString().slice(0, 10);
}

function reviewedOpenSessionV1(
  localDate: string,
  calendar: ReviewedReferenceCalendarV1,
): ReviewedSessionV1 | null {
  if (localDate < calendar.validFrom || localDate > calendar.validThrough) return null;
  const day = new Date(`${localDate}T12:00:00.000Z`).getUTCDay();
  if (day === 0 || day === 6 || calendar.closedDates.includes(localDate)) return null;
  return {
    localDate,
    open: calendar.regularOpenMinute,
    close: calendar.earlyCloseMinutes[localDate] ?? calendar.regularCloseMinute,
  };
}

function publicationSessionV1(localDate: string, calendar: ReviewedReferenceCalendarV1) {
  for (let offset = 0; offset <= 10; offset += 1) {
    const session = reviewedOpenSessionV1(dateShiftV1(localDate, -offset), calendar);
    if (session) return session;
  }
  return null;
}

/**
 * The most recent session whose close has already happened.
 *
 * Today's own session counts only once its close is behind us; otherwise the
 * walk continues backwards. This is the boundary a publication is placed
 * against, and it is deliberately NOT `publicationSessionV1`: during a live
 * session that function returns the session we are inside, and everything
 * printed overnight would then read as older than a close that has not
 * happened yet.
 */
function lastClosedSessionV1(
  localDate: string,
  minuteOfDay: number,
  calendar: ReviewedReferenceCalendarV1,
): ReviewedSessionV1 | null {
  const today = reviewedOpenSessionV1(localDate, calendar);
  if (today && minuteOfDay >= today.close) return today;
  for (let offset = 1; offset <= 10; offset += 1) {
    const session = reviewedOpenSessionV1(dateShiftV1(localDate, -offset), calendar);
    if (session) return session;
  }
  return null;
}

/** Lexicographic on (local date, minute of day); both are ET wall-clock, so
 * this is a total order over instants the calendar can name. */
function isAfterV1(
  point: { localDate: string; minute: number },
  boundary: { localDate: string; minute: number },
): boolean {
  if (point.localDate !== boundary.localDate) return point.localDate > boundary.localDate;
  return point.minute > boundary.minute;
}

/**
 * Place the feed's own last publication against the reviewed sessions.
 *
 * This is the whole of the off-session basis: the value on screen is named by
 * WHEN THE FEED PUBLISHED IT, not by a configured belief about when this feed
 * publishes. Measured 2026-09-16 over sixty rounds, the Coinbase feeds print
 * overnight with a new value each time and go quiet only across the weekend,
 * so a policy that assumed "holds the last close after 16:00" was naming an
 * overnight print a close, and refusing the comparison precisely when the
 * reference was at its freshest.
 */
export function placeReferencePublicationV1(input: {
  referenceUpdatedAt: string;
  calendar: CalendarClassificationV1;
  timeZone: 'America/New_York';
}): ReferencePublicationPlacementV1 {
  const published = localPartsV1(new Date(input.referenceUpdatedAt), input.timeZone);
  if (!published) return 'not_classified';
  const point = { localDate: published.localDate, minute: published.minuteOfDay };
  const open = input.calendar.openSession;
  if (
    open &&
    point.localDate === open.localDate &&
    point.minute >= open.open &&
    point.minute <= input.calendar.minuteOfDay
  ) {
    return 'inside_open_session';
  }
  const closed = input.calendar.lastClosedSession;
  if (!closed) return 'not_classified';
  if (
    point.localDate === closed.localDate &&
    point.minute >= closed.open &&
    point.minute <= closed.close
  ) {
    return 'last_closed_session';
  }
  return isAfterV1(point, { localDate: closed.localDate, minute: closed.close })
    ? 'after_last_close'
    : 'before_last_close';
}

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
  const publicationSession = publicationSessionV1(local.localDate, calendar);
  if (!publicationSession) return null;
  const lastClosedSession = lastClosedSessionV1(local.localDate, local.minuteOfDay, calendar);
  const weekend = local.weekday === 'Sat' || local.weekday === 'Sun';
  if (weekend) {
    return {
      kind: 'weekend',
      localDate: local.localDate,
      minuteOfDay: local.minuteOfDay,
      regularOpenMinute: calendar.regularOpenMinute,
      regularCloseMinute: close,
      publicationSessionLocalDate: publicationSession.localDate,
      publicationSessionOpenMinute: publicationSession.open,
      publicationSessionCloseMinute: publicationSession.close,
      openSession: null,
      lastClosedSession,
    };
  }
  const closed = calendar.closedDates.includes(local.localDate);
  const regular =
    !closed && local.minuteOfDay >= calendar.regularOpenMinute && local.minuteOfDay < close;
  return {
    kind: regular ? 'regular_hours' : 'after_hours',
    localDate: local.localDate,
    minuteOfDay: local.minuteOfDay,
    regularOpenMinute: calendar.regularOpenMinute,
    regularCloseMinute: close,
    publicationSessionLocalDate: publicationSession.localDate,
    publicationSessionOpenMinute: publicationSession.open,
    publicationSessionCloseMinute: publicationSession.close,
    openSession: regular
      ? { localDate: local.localDate, open: calendar.regularOpenMinute, close }
      : null,
    lastClosedSession,
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
    marketSession: 'unknown',
    publicationMode: 'unknown',
    publicationPlacement: 'not_classified',
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
  placement: ReferencePublicationPlacementV1;
  session: MarketRealityReferenceStateV1['session'];
  marketSession: MarketRealityReferenceStateV1['marketSession'];
  publicationMode: MarketRealityReferenceStateV1['publicationMode'];
  status: MarketRealityReferenceStateV1['status'];
  freshness: MarketRealityReferenceStateV1['freshness'];
  reasonCode: MarketRealityReferenceStateV1['reasonCode'];
  reason: string;
}): MarketRealityReferenceStateV1 {
  const { configuration, observation, calendar } = input;
  return MarketRealityReferenceStateV1Schema.parse({
    status: input.status,
    session: input.session,
    marketSession: input.marketSession,
    publicationMode: input.publicationMode,
    publicationPlacement: input.placement,
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
          publicationSessionLocalDate: calendar.publicationSessionLocalDate,
          publicationSessionOpenMinute: calendar.publicationSessionOpenMinute,
          publicationSessionCloseMinute: calendar.publicationSessionCloseMinute,
        }
      : null,
    evidence: observation.evidence,
    // Kept false for Phase 10C.1 consumers. Phase 10C.2A comparability lives in
    // the separate typed basis decision and is never inferred from this flag.
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
      placement: 'not_classified',
      session: 'unknown',
      marketSession: 'unknown',
      publicationMode: 'unknown',
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
      placement: 'not_classified',
      session: 'unknown',
      marketSession: 'unknown',
      publicationMode: 'unknown',
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
      placement: 'not_classified',
      session: 'unknown',
      marketSession: 'unknown',
      publicationMode: 'unknown',
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

  // Placed once, above every branch below. A held or stale feed still has a
  // last publication and where it sits is still evidence — that is exactly
  // how a reader tells a closed market from a frozen feed.
  const placement = placeReferencePublicationV1({
    referenceUpdatedAt: observation.referenceUpdatedAt,
    calendar,
    timeZone: configuration.calendar.timeZone,
  });
  if (observation.status === 'corporate_action_hold') {
    return observedStateV1({
      configuration,
      observation,
      calendar,
      placement,
      session: 'corporate_action_hold',
      marketSession: calendar.kind,
      publicationMode: 'corporate_action_hold',
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
      placement,
      session: 'stale',
      marketSession: calendar.kind,
      publicationMode: 'stale',
      status: 'stale',
      freshness: 'stale',
      reasonCode: 'reviewed_reference_stale',
      reason: 'The reviewed reference observation is outside its explicit freshness policy.',
    });
  }
  // Everything below is decided by WHERE THE FEED'S OWN LAST PUBLICATION SITS,
  // not by a configured belief about when this feed publishes. The reviewed
  // configuration is consulted for one thing only: whether an off-session
  // print means anything for this issuer at all.
  //
  // `session` is the legacy presentation blend and `marketSession` is the
  // market's own clock. The market clock never bends to the feed: a Saturday
  // stays a Saturday whatever the feed last printed.
  const session =
    placement === 'last_closed_session' && calendar.kind !== 'weekend'
      ? ('reference_holding_last_close' as const)
      : calendar.kind;
  if (configuration.outsideRegularHours === 'unknown' && placement !== 'inside_open_session') {
    return observedStateV1({
      configuration,
      observation,
      calendar,
      placement,
      session,
      marketSession: calendar.kind,
      publicationMode: 'unknown',
      status: 'fresh',
      freshness: 'fresh',
      reasonCode: 'calendar_semantics_missing',
      reason:
        'The calendar is reviewed, but this reference’s outside-session publication behavior is not.',
    });
  }
  const placed = {
    inside_open_session: {
      publicationMode: 'live_reference' as const,
      reasonCode: 'reviewed_calendar_regular_hours' as const,
      reason: 'The feed last published inside the reviewed core session that is open now.',
    },
    after_last_close: {
      publicationMode: 'live_reference' as const,
      reasonCode: 'reviewed_feed_publishing_off_session' as const,
      reason: 'The feed last published after the most recent reviewed session closed.',
    },
    last_closed_session: {
      publicationMode: 'holding_last_close' as const,
      reasonCode:
        calendar.kind === 'weekend'
          ? ('reviewed_calendar_weekend' as const)
          : ('reviewed_feed_holding_last_close' as const),
      reason: 'The feed has published nothing since the most recent reviewed session closed.',
    },
    before_last_close: {
      publicationMode: 'unknown' as const,
      reasonCode: 'reviewed_publication_precedes_last_close' as const,
      reason:
        'The feed’s last publication predates the most recent reviewed session, which has since closed.',
    },
    not_classified: {
      publicationMode: 'unknown' as const,
      reasonCode: 'calendar_classification_failed' as const,
      reason: 'The reviewed calendar could not place the feed’s own publication time.',
    },
  }[placement];
  return observedStateV1({
    configuration,
    observation,
    calendar,
    placement,
    session,
    marketSession: calendar.kind,
    status: 'fresh',
    freshness: 'fresh',
    ...placed,
  });
}
