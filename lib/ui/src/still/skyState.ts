import { TERMS, weekendWindow } from '@mioagent/still-engine/policy';
import type { StillTerms } from '@mioagent/still-engine/terms';
import { regularSessionV1 } from '@mioagent/rwa-market-reality/weekend-market';

// ---------------------------------------------------------------------------
// The visual sky follows Berlin's clock, including its daylight-saving rules.
// It is a fixed local schedule, not a claim about astronomical sunrise.
// US market state and every Still financial window remain New York based.
// A Berlin night can therefore coexist with an open US session, and a sunny
// weekend still has the closed-market borrowing limits. Earnings clouds keep
// their actual reviewed windows regardless of either display clock.
//
// Pure: the page passes the clock and the windows it read from Still's terms.
// ---------------------------------------------------------------------------

export type SkyPhaseV1 = 'day' | 'dusk' | 'night';
export type SkyMarketPhaseV1 = 'open' | 'before_open' | 'after_hours' | 'closed';

/** Still's shares of each protocol's limit, in percent, as its terms set them. */
export const STILL_SHARES_V1 = {
  full: Number(TERMS.shareOfProtocolBps) / 100,
  closed: Number(TERMS.weekendStockShareOfProtocolBps) / 100,
  earnings: Number(TERMS.earningsStockShareOfProtocolBps) / 100,
} as const;

export interface SkyEarningsV1 {
  /** The stock's ticker token, NVDAc. */
  asset: string;
  /** The company, for a sentence: NVIDIA. */
  name: string;
  startsAt: string;
  endsAt: string;
}

export interface SkyStateV1 {
  /** The instant the sky was computed for. */
  at: string;
  /** Visual phase on a fixed Europe/Berlin local-clock schedule. */
  phase: SkyPhaseV1;
  /** Share of Berlin's visual day, from 07:00 to 19:00. */
  sunShare: number | null;
  /** Berlin's 24-hour wall clock, "MON 19:05". */
  clock: string;
  clockZone: 'Europe/Berlin';
  daylightLabels: { open: string; close: string };
  /** US market state is independent of the Berlin visual phase. */
  marketPhase: SkyMarketPhaseV1;
  /** New York's wall clock, "MON 2:05 PM", for financial labels. */
  marketClock: string;
  /** Still's closed-market window: the one open now, or the next. */
  closed: { active: boolean; startsAt: string; endsAt: string };
  /** Today's regular session, when today has one. */
  session: { openAt: string; closeAt: string } | null;
  /** Stocks inside their earnings window now. */
  clouds: SkyEarningsV1[];
  /** Stocks counted at the earnings rate because their calendar was not read. */
  unread: string[];
  /** False until Still's terms were read: without them the sky names no limits. */
  limitsRead: boolean;
}

/** The earnings windows and unread stocks in Still's terms, for the sky. */
export function skyEarningsFromTermsV1(terms: StillTerms): { earnings: SkyEarningsV1[]; unread: string[] } {
  const nameOf = (id: string) => terms.assets.find((asset) => asset.id === id)?.name ?? id;
  const earnings: SkyEarningsV1[] = [];
  const unread: string[] = [];
  for (const stock of terms.earnings.stocks) {
    if (!stock.calendarRead) unread.push(nameOf(stock.id));
    else if (stock.windowStartsAt && stock.windowEndsAt) {
      earnings.push({ asset: stock.id, name: nameOf(stock.id), startsAt: stock.windowStartsAt, endsAt: stock.windowEndsAt });
    }
  }
  return { earnings, unread };
}

const CLOCK_V1 = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  weekday: 'short',
  hour: 'numeric',
  minute: '2-digit',
});

/** "MON 2:05 PM": the New York wall clock for financial labels. */
export function newYorkClockV1(at: Date): string {
  return CLOCK_V1.format(at).replace(',', '').toUpperCase();
}

const BERLIN_CLOCK_V1 = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Europe/Berlin', weekday: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});

function berlinVisualTimeV1(now: Date): Pick<SkyStateV1, 'phase' | 'sunShare' | 'clock'> {
  const parts = BERLIN_CLOCK_V1.formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(row => row.type === type)?.value ?? '';
  const minute = Number(part('hour')) * 60 + Number(part('minute')) + Number(part('second')) / 60;
  const day = minute >= 7 * 60 && minute < 19 * 60;
  const dusk = minute >= 6 * 60 && minute < 20 * 60;
  return {
    phase: day ? 'day' : dusk ? 'dusk' : 'night',
    sunShare: day ? (minute - 7 * 60) / (12 * 60) : null,
    clock: `${part('weekday').toUpperCase()} ${part('hour')}:${part('minute')}`,
  };
}

const MOMENT_V1 = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  weekday: 'short',
  hour: 'numeric',
  minute: '2-digit',
});

/** "Sun 8 PM": a moment ahead, in New York time, minutes only when they are not zero. */
export function newYorkMomentV1(iso: string): string {
  return MOMENT_V1.format(new Date(iso)).replace(',', '').replace(':00', '');
}

/** `earnings` absent means Still's terms were not read, not that nobody reports. */
export function skyStateV1(input: { now: Date; earnings?: readonly SkyEarningsV1[] | null; unread?: readonly string[] }): SkyStateV1 {
  const { now } = input;
  const window = weekendWindow(now);
  const closed = { active: window.active, startsAt: window.startsAt.toISOString(), endsAt: window.endsAt.toISOString() };
  const session = regularSessionV1(now);
  const t = now.getTime();
  const clouds = (input.earnings ?? []).filter((e) => Date.parse(e.startsAt) <= t && t < Date.parse(e.endsAt));
  const marketPhase: SkyMarketPhaseV1 = closed.active ? 'closed'
    : session && Date.parse(session.openAt) <= t && t < Date.parse(session.closeAt) ? 'open'
      : session && t < Date.parse(session.openAt) ? 'before_open' : 'after_hours';
  const visual = berlinVisualTimeV1(now);
  const limitsRead = input.earnings !== undefined && input.earnings !== null;
  return {
    at: now.toISOString(), ...visual, clockZone: 'Europe/Berlin', daylightLabels: { open: '07:00', close: '19:00' },
    marketPhase, marketClock: newYorkClockV1(now), closed, session, clouds, unread: [...(input.unread ?? [])], limitsRead,
  };
}

export interface SkyCaptionV1 {
  /** One line under the clock: what the market is doing and which limits hold. */
  headline: string;
  /** The rule that changes, and until when. Null when nothing does. */
  detail: string | null;
}

/** What the sky says in words. Every sentence names a time a reader can check. */
export function skyCaptionV1(sky: SkyStateV1): SkyCaptionV1 {
  const reporting = sky.clouds.map((c) => c.name);
  const details = [
    sky.clouds.length === 0
      ? null
      : `${listV1(reporting)} ${reporting.length === 1 ? 'reports' : 'report'} now: new loans against ${reporting.length === 1 ? 'it' : 'them'} count at ${STILL_SHARES_V1.earnings}% of the protocol’s limit until ${newYorkMomentV1(maxIsoV1(sky.clouds.map((c) => c.endsAt)))} New York.`,
    sky.unread.length === 0
      ? null
      : `The earnings calendar could not be read just now: new loans against ${sky.unread.length > 3 ? 'stocks' : listV1(sky.unread)} count at ${STILL_SHARES_V1.earnings}% of the protocol’s limit until it is.`,
  ].filter((line): line is string => line !== null);
  const earningsDetail = details.length ? details.join(' ') : null;
  const limits = !sky.limitsRead ? null : sky.clouds.length > 0 || sky.unread.length > 0 ? 'earnings limits' : 'full limits';
  if (sky.marketPhase === 'closed') {
    return {
      headline: 'Wall Street is closed. Base is open.',
      detail: `Until ${newYorkMomentV1(sky.closed.endsAt)} New York, new loans against stocks count at ${STILL_SHARES_V1.closed}% of the protocol’s limit, not ${STILL_SHARES_V1.full}%. Loans you have are not touched.`,
    };
  }
  if (sky.marketPhase === 'open') {
    return { headline: limits ? `Market open · ${limits}` : 'Market open', detail: earningsDetail };
  }
  return {
    headline: `${sky.marketPhase === 'before_open' ? 'Before the open' : 'After hours'}${limits ? ` · ${limits}` : ''}`,
    detail: earningsDetail,
  };
}

function listV1(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

function maxIsoV1(values: readonly string[]): string {
  return values.reduce((a, b) => (Date.parse(b) > Date.parse(a) ? b : a));
}
