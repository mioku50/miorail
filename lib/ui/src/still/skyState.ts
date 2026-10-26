import { TERMS, weekendWindow } from '@mioagent/still-engine/policy';
import type { StillTerms } from '@mioagent/still-engine/terms';
import { regularSessionV1 } from '@mioagent/rwa-market-reality/weekend-market';

// ---------------------------------------------------------------------------
// The market sky: New York's time, and which of Still's rules hold under it.
//
// The sky is a claim, so it is computed, never drawn by mood. Day is the
// regular session on a day the reviewed market calendar has one. Night is
// Still's closed-market window: weekends and market holidays, when stocks
// count at 40% of the protocol's limit. Dusk is everything else on a trading
// day: before the open and after the close, when the overnight session keeps
// the reference prices moving and the full limits hold. Clouds are earnings
// windows, one per stock reporting now. A stock whose report date could not
// be read counts at the earnings rate too, and the caption says so instead of
// promising full limits.
//
// Pure: the page passes the clock and the windows it read from Still's terms.
// ---------------------------------------------------------------------------

export type SkyPhaseV1 = 'day' | 'dusk' | 'night';

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
  phase: SkyPhaseV1;
  /** Share of the regular session behind us, 0 at the open and 1 at the close, while the sun is up. */
  sunShare: number | null;
  /** New York's wall clock, "MON 2:05 PM". */
  clock: string;
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

/** "MON 2:05 PM": the New York wall clock, as the sky's caption prints it. */
export function newYorkClockV1(at: Date): string {
  return CLOCK_V1.format(at).replace(',', '').toUpperCase();
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
  let phase: SkyPhaseV1 = 'dusk';
  let sunShare: number | null = null;
  if (closed.active) phase = 'night';
  else if (session && Date.parse(session.openAt) <= t && t < Date.parse(session.closeAt)) {
    phase = 'day';
    sunShare = (t - Date.parse(session.openAt)) / (Date.parse(session.closeAt) - Date.parse(session.openAt));
  }
  const limitsRead = input.earnings !== undefined && input.earnings !== null;
  return { at: now.toISOString(), phase, sunShare, clock: newYorkClockV1(now), closed, session, clouds, unread: [...(input.unread ?? [])], limitsRead };
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
      : `${listV1(reporting)} ${reporting.length === 1 ? 'reports' : 'report'} now: new loans against ${reporting.length === 1 ? 'it' : 'them'} count at ${STILL_SHARES_V1.earnings}% of the protocol’s limit until ${newYorkMomentV1(maxIsoV1(sky.clouds.map((c) => c.endsAt)))}.`,
    sky.unread.length === 0
      ? null
      : `The earnings calendar could not be read just now: new loans against ${sky.unread.length > 3 ? 'stocks' : listV1(sky.unread)} count at ${STILL_SHARES_V1.earnings}% of the protocol’s limit until it is.`,
  ].filter((line): line is string => line !== null);
  const earningsDetail = details.length ? details.join(' ') : null;
  const limits = !sky.limitsRead ? null : sky.clouds.length > 0 || sky.unread.length > 0 ? 'earnings limits' : 'full limits';
  if (sky.phase === 'night') {
    return {
      headline: 'Wall Street is closed. Base is open.',
      detail: `Until ${newYorkMomentV1(sky.closed.endsAt)} new loans against stocks count at ${STILL_SHARES_V1.closed}% of the protocol’s limit, not ${STILL_SHARES_V1.full}%. Loans you have are not touched.`,
    };
  }
  if (sky.phase === 'day') {
    return { headline: limits ? `Market open · ${limits}` : 'Market open', detail: earningsDetail };
  }
  const beforeOpen = sky.session !== null && Date.parse(sky.at) < Date.parse(sky.session.openAt);
  return {
    headline: `${beforeOpen ? 'Before the open' : 'After hours'}${limits ? ` · ${limits}` : ''}`,
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
