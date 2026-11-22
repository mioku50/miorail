import { ASSETS } from './registry.js';

// ---------------------------------------------------------------------------
// Still Agent: a person's own agent, named by them, that brings what they
// asked for on the day they asked (operator, 2026-11-22).
//
// An errand is a card the person wants on a day: a subscription's card every
// month, a gift card on a birthday. On that day the agent prepares it: a
// reminder in Telegram, and Spend opened on that card. Nothing more. Bitrefill's
// invoice is opened only when the person presses Pay, because its price and
// its life are short. The person signs in their own wallet, from their USDC or
// with a loan against the collateral they chose when they set the errand. The
// agent never picks what to pledge, never signs, and never opens a loan
// because the USDC was short.
//
// Times are the person's own: an errand is due at 09:00 where they are, by the
// IANA zone their browser named when they set it.
// ---------------------------------------------------------------------------

export const STILL_AGENT_AVATARS_V1 = ['pip', 'orbit', 'spark', 'leaf', 'wave', 'star'] as const;
export type StillAgentAvatarV1 = (typeof STILL_AGENT_AVATARS_V1)[number];

export const STILL_AGENT_LANGUAGES_V1 = ['en', 'ru'] as const;
export type StillAgentLanguageV1 = (typeof STILL_AGENT_LANGUAGES_V1)[number];

/** Errands a wallet may keep active: one for everyone, ten with an Agent Pass. */
export const STILL_AGENT_FREE_ERRANDS_V1 = 1;
export const STILL_AGENT_PASS_ERRANDS_V1 = 10;

/** The local hour an errand is due at. */
export const STILL_AGENT_HOUR_V1 = 9;

/** A name the person gave their agent: letters of any script, digits, spaces, and - . ' between them; 1 to 24. */
export function stillAgentNameV1(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const name = raw.normalize('NFC').trim().replace(/\s+/g, ' ');
  if (name.length < 1 || Array.from(name).length > 24) return null;
  return /^[\p{L}\p{N}](?:[\p{L}\p{N} .'-]*[\p{L}\p{N}.])?$/u.test(name) ? name : null;
}

/** A name a gift is for, as the person wrote it: the same letters, 1 to 30. */
export function stillErrandRecipientV1(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const name = raw.normalize('NFC').trim().replace(/\s+/g, ' ');
  if (name.length < 1 || Array.from(name).length > 30) return null;
  return /^[\p{L}\p{N}](?:[\p{L}\p{N} .'-]*[\p{L}\p{N}.])?$/u.test(name) ? name : null;
}

/** An IANA time zone this runtime knows, or null. */
export function stillTimeZoneV1(raw: unknown): string | null {
  if (typeof raw !== 'string' || !/^[A-Za-z][A-Za-z0-9_+\-/]{1,63}$/.test(raw)) return null;
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: raw }).resolvedOptions().timeZone === raw ? raw : null;
  } catch {
    return null;
  }
}

export type StillErrandKindV1 = 'subscription' | 'gift';

/** Every month on a day (1 to 28, so every month has it), or every year on a date. */
export type StillErrandScheduleV1 = { every: 'month'; day: number } | { every: 'year'; month: number; day: number };

const DAYS_IN_MONTH_V1 = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

export function stillErrandScheduleV1(raw: unknown): StillErrandScheduleV1 | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const whole = (n: unknown, min: number, max: number): n is number => typeof n === 'number' && Number.isInteger(n) && n >= min && n <= max;
  if (value.every === 'month' && Object.keys(value).length === 2 && whole(value.day, 1, 28)) return { every: 'month', day: value.day };
  if (value.every === 'year' && Object.keys(value).length === 3 && whole(value.month, 1, 12) && whole(value.day, 1, DAYS_IN_MONTH_V1[(value.month as number) - 1]!)) {
    return { every: 'year', month: value.month as number, day: value.day as number };
  }
  return null;
}

/** The errand a kind may carry: a subscription comes every month, a gift on a date every year. */
export function stillErrandKindFitsV1(kind: StillErrandKindV1, schedule: StillErrandScheduleV1): boolean {
  return kind === 'subscription' ? schedule.every === 'month' : schedule.every === 'year';
}

/** How the person pays when the day comes: their USDC, or a loan against the collateral they chose. */
export type StillErrandFundingV1 = { kind: 'usdc' } | { kind: 'loan'; collateral: string };

/** Collateral Still lends against: a reviewed stock, bitcoin, ether or gold. */
export function stillErrandCollateralV1(raw: unknown): string | null {
  return typeof raw === 'string' && ASSETS.some((asset) => asset.id === raw) ? raw : null;
}

// --- time ------------------------------------------------------------------

/** Milliseconds the zone is ahead of UTC at an instant. */
function zoneOffsetMsV1(timeZone: string, at: Date): number {
  const whole = Math.floor(at.getTime() / 1000) * 1000;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
  }).formatToParts(new Date(whole));
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second')) - whole;
}

/** The instant a local wall-clock hour falls on in a zone. An hour a clock change skips lands just after it. */
export function stillZonedInstantV1(input: { year: number; month: number; day: number; hour: number; timeZone: string }): Date {
  const wall = Date.UTC(input.year, input.month - 1, input.day, input.hour);
  let guess = wall - zoneOffsetMsV1(input.timeZone, new Date(wall));
  guess = wall - zoneOffsetMsV1(input.timeZone, new Date(guess));
  return new Date(guess);
}

/** The local calendar date of an instant in a zone. */
export function stillZonedDateV1(at: Date, timeZone: string): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: 'numeric', day: 'numeric' }).formatToParts(at);
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  return { year: get('year'), month: get('month'), day: get('day') };
}

function leapV1(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/** When an errand is next due: its day at 09:00 local, strictly after `after`. 29 February is the 28th in other years. */
export function stillErrandNextDueV1(schedule: StillErrandScheduleV1, timeZone: string, after: Date): Date {
  const today = stillZonedDateV1(after, timeZone);
  const at = (year: number, month: number, day: number) => stillZonedInstantV1({ year, month, day, hour: STILL_AGENT_HOUR_V1, timeZone });
  if (schedule.every === 'month') {
    for (let step = 0; step < 3; step += 1) {
      const index = today.month - 1 + step;
      const candidate = at(today.year + Math.floor(index / 12), (index % 12) + 1, schedule.day);
      if (candidate.getTime() > after.getTime()) return candidate;
    }
  } else {
    for (let step = 0; step < 3; step += 1) {
      const year = today.year + step;
      const day = schedule.month === 2 && schedule.day === 29 && !leapV1(year) ? 28 : schedule.day;
      const candidate = at(year, schedule.month, day);
      if (candidate.getTime() > after.getTime()) return candidate;
    }
  }
  throw new Error('still_errand_schedule_unreachable');
}

// --- the Agent Pass --------------------------------------------------------

export type StillAgentPassPlanIdV1 = 'intro' | 'month' | 'year';

export interface StillAgentPassPlanV1 {
  plan: StillAgentPassPlanIdV1;
  /** USDC, six decimals. */
  priceAtomic: string;
  days: number;
  /** Only a wallet's first pass. */
  firstOnly: boolean;
}

/** One USDC for the first thirty days, then three for thirty or thirty for a year. Paid once, never renewed by itself. */
export const STILL_AGENT_PASS_PLANS_V1: readonly StillAgentPassPlanV1[] = [
  { plan: 'intro', priceAtomic: '1000000', days: 30, firstOnly: true },
  { plan: 'month', priceAtomic: '3000000', days: 30, firstOnly: false },
  { plan: 'year', priceAtomic: '30000000', days: 365, firstOnly: false },
];

export function stillAgentPassPlanV1(raw: unknown): StillAgentPassPlanV1 | null {
  return STILL_AGENT_PASS_PLANS_V1.find((row) => row.plan === raw) ?? null;
}

/** A pass bought at `now`: it starts when the one still running ends, so days are never lost. */
export function stillAgentPassSpanV1(plan: StillAgentPassPlanV1, now: Date, runningUntil: Date | null): { startsAt: Date; endsAt: Date } {
  const startsAt = runningUntil && runningUntil.getTime() > now.getTime() ? runningUntil : now;
  return { startsAt, endsAt: new Date(startsAt.getTime() + plan.days * 24 * 60 * 60 * 1000) };
}

// --- the reminder ----------------------------------------------------------

function ordinalV1(day: number): string {
  const tens = day % 100;
  if (tens >= 11 && tens <= 13) return `${day}th`;
  return `${day}${({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[day % 10] ?? 'th'}`;
}

export interface StillErrandWordsInputV1 {
  language: StillAgentLanguageV1;
  agentName: string;
  kind: StillErrandKindV1;
  schedule: StillErrandScheduleV1;
  productName: string;
  packageLabel: string;
  funding: StillErrandFundingV1;
  recipient: string | null;
}

/** What the agent says on the day: who it is, what is ready, how the person chose to pay, and that nothing is signed. */
export function stillErrandReminderV1(input: StillErrandWordsInputV1): { title: string; lines: string[]; button: string } {
  const card = `${input.productName} (${input.packageLabel})`;
  if (input.language === 'ru') {
    const ready = input.kind === 'gift'
      ? `Подарок${input.recipient ? ` для: ${input.recipient}` : ''}. Карта ${card} готова к проверке.`
      : `Сегодня ${input.schedule.day}-е число: карта ${card} готова к проверке.`;
    const pay = input.funding.kind === 'usdc'
      ? 'Вы выбрали оплату своими USDC.'
      : `Вы выбрали займ под ${input.funding.collateral}. Займ — это долг, а залог могут ликвидировать.`;
    return {
      title: `${input.agentName} · Still Agent`,
      lines: [ready, pay, 'Ничего не подписано: цену вы увидите в Still и подпишете в своём кошельке.'],
      button: 'Проверить в Still',
    };
  }
  const ready = input.kind === 'gift'
    ? `A gift${input.recipient ? ` for ${input.recipient}` : ''}: the ${card} card is ready to review.`
    : `It's the ${ordinalV1(input.schedule.day)}: your ${card} card is ready to review.`;
  const pay = input.funding.kind === 'usdc'
    ? 'You chose to pay from your USDC.'
    : `You chose a loan against ${input.funding.collateral}. A loan is debt, and its collateral can be liquidated.`;
  return {
    title: `${input.agentName} · Still Agent`,
    lines: [ready, pay, 'Nothing has been signed: you see the price on Still and sign in your own wallet.'],
    button: 'Review on Still',
  };
}

// --- what the page reads ---------------------------------------------------

export interface StillErrandWireV1 {
  errandId: string;
  kind: StillErrandKindV1;
  schedule: StillErrandScheduleV1;
  timeZone: string;
  country: string;
  productId: string;
  productName: string;
  packageValue: string;
  packageLabel: string;
  funding: StillErrandFundingV1;
  recipient: string | null;
  nextDueAt: string;
  /** The day it last came due, while that is under three days old: its review is ready. */
  ready: { dueAt: string } | null;
  /** Over the free errand while no pass runs: kept, but no reminder goes. */
  paused: boolean;
}

export interface StillAgentWireV1 {
  outcome: 'agent';
  agent: { agentNo: number; name: string; avatar: StillAgentAvatarV1; language: StillAgentLanguageV1; timeZone: string } | null;
  errands: StillErrandWireV1[];
  limit: { active: number; max: number };
  telegram: {
    /** The agents bot runs on this server. */
    available: boolean;
    linked: boolean;
    /** Telegram can make a bot of the person's own here. */
    ownBotAvailable: boolean;
    ownBot: { username: string; started: boolean } | null;
  };
  pass: {
    /** Passes are sold on this server now. */
    offered: boolean;
    active: { plan: StillAgentPassPlanIdV1; endsAt: string } | null;
    introUsed: boolean;
  };
}

/** How long a due errand's review stays ready on the page. */
export const STILL_ERRAND_READY_MS_V1 = 3 * 24 * 60 * 60 * 1000;
