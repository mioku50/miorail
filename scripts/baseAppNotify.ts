/**
 * Base App notifications, from what Miorail already records.
 *
 * Base App pushes a notification to a WALLET ADDRESS that pinned Miorail and
 * turned its notifications on, through the Base Dashboard REST API (the app is
 * registered at dashboard.base.org as https://miorail.xyz). Who did that is
 * Base's list: it is asked for on every pass that has something to say, and
 * never copied here.
 *
 * What is said, and to whom:
 *
 *   - to everyone opted in: what the ISSUER did onchain — a corporate-action
 *     announcement, a multiplier change, scheduled or called off. Rare, and a
 *     fact about the token itself.
 *   - to a wallet that watches the token: its cash exit moved past the
 *     threshold, its market appeared or stopped answering, a lookalike of it
 *     was launched.
 *   - to a wallet that set a Radar watch: every event on that exact question.
 *
 * What is NOT said: a token entering or leaving one of Base's lists. On
 * 2026-09-04 six tickers were added, removed and added again on one page in
 * one day; as pushes that is twelve announcements of nothing.
 *
 * A wallet is sent at most one push per pass — several changes become one
 * summary — and at most `dailyCap` per UTC day. Nothing older than `maxAgeMs`
 * is sent: a change from yesterday is not news. The first pass over a source
 * only opens its cursor, so the history recorded before this existed is never
 * announced.
 *
 * The API key is read here and sent as one header. It is never logged, never
 * put in an error, never returned.
 */
import type {
  BaseAppNotificationRepositoryV1,
  RadarEventNoticeRowV1,
  RwaSignalRowV1,
} from '@mioagent/route-storage';
import { weekendWindowV1, type WeeklyCloseChangesV1 } from '@mioagent/rwa-market-reality/weekend-market';

export const BASE_APP_NOTIFY_ENDPOINT_V1 = 'https://dashboard.base.org/api/v1/notifications';
export const BASE_APP_TITLE_MAX_V1 = 30;
export const BASE_APP_MESSAGE_MAX_V1 = 200;
export const BASE_APP_BATCH_MAX_V1 = 1000;

export interface BaseAppNotifyLimitsV1 {
  /** Rows read per source per pass. */
  perSource: number;
  /** Pushes per wallet per UTC day. */
  dailyCap: number;
  /** Send requests per pass; Base allows 20 requests a minute per IP. */
  maxRequests: number;
  /** A change recorded longer ago than this is not sent. */
  maxAgeMs: number;
  /** Between two requests to Base. */
  gapMs: number;
}

export const BASE_APP_NOTIFY_LIMITS_V1: Readonly<BaseAppNotifyLimitsV1> = {
  perSource: 200,
  dailyCap: 4,
  maxRequests: 12,
  maxAgeMs: 12 * 60 * 60 * 1000,
  gapMs: 3_500,
};

/** Issuer events, sent to everyone opted in. */
export const BASE_APP_BROADCAST_KINDS_V1: ReadonlySet<string> = new Set([
  'official_asset_corporate_action_announced',
  'official_asset_multiplier_changed',
  'official_asset_multiplier_change_scheduled',
  'official_asset_multiplier_change_cancelled',
]);

/** Market transitions, sent to the wallets that watch the token. */
export const BASE_APP_WATCHER_KINDS_V1: ReadonlySet<string> = new Set([
  'official_asset_cash_exit_changed',
  'official_asset_market_became_active',
  'official_asset_market_became_unreachable',
  'official_asset_lookalike_created',
]);

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface BaseAppNotifyConfigV1 {
  apiKey: string;
  appUrl: string;
}

/**
 * The key is `BASE_DEV_API` — the name the operator gave it — or
 * `BASE_DASHBOARD_API_KEY`. `MIORAIL_BASE_APP_NOTIFICATIONS_V1=off` stops
 * sending without removing the key. Null means: send nothing.
 */
export function baseAppNotifyConfigV1(env: NodeJS.ProcessEnv): BaseAppNotifyConfigV1 | null {
  if ((env.MIORAIL_BASE_APP_NOTIFICATIONS_V1 ?? '').trim().toLowerCase() === 'off') return null;
  const apiKey = (env.BASE_DEV_API ?? env.BASE_DASHBOARD_API_KEY ?? '')
    .trim()
    .replace(/^"(.*)"$/, '$1')
    .replace(/^'(.*)'$/, '$1');
  if (!/^[A-Za-z0-9._~+/=-]{8,512}$/.test(apiKey)) return null;
  const appUrl = (env.MIORAIL_BASE_APP_URL ?? 'https://miorail.xyz').trim().replace(/\/+$/, '');
  if (!/^https:\/\/[a-z0-9.-]+(\/[A-Za-z0-9._~-]+)*$/.test(appUrl)) return null;
  return { apiKey, appUrl };
}

// ---------------------------------------------------------------------------
// The Base Dashboard client
// ---------------------------------------------------------------------------

/** A refusal from Base, in status codes only: the body may echo a request. */
export class BaseAppNotifyErrorV1 extends Error {
  constructor(
    readonly status: number | null,
    /** Worth trying again on a later pass: 429, 5xx, or no answer at all. */
    readonly transient: boolean,
    message: string,
  ) {
    super(message);
    this.name = 'BaseAppNotifyErrorV1';
  }
}

export interface BaseAppNotifySendResultV1 {
  sent: string[];
  /** Per reason, counted: who they were is not kept. */
  failed: { notSaved: number; disabled: number; other: number };
}

export interface BaseAppNotifyClientV1 {
  /** Lowercase wallets that pinned the app and have notifications on. */
  enabledWallets(): Promise<Set<string>>;
  send(input: {
    wallets: readonly string[];
    title: string;
    message: string;
    targetPath: string;
  }): Promise<BaseAppNotifySendResultV1>;
}

const WALLET_V1 = /^0x[0-9a-f]{40}$/;

export function createBaseAppNotifyClientV1(input: {
  config: BaseAppNotifyConfigV1;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  clock?: () => number;
  gapMs?: number;
  maxPages?: number;
}): BaseAppNotifyClientV1 {
  const doFetch = input.fetch ?? fetch;
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const clock = input.clock ?? Date.now;
  const gapMs = input.gapMs ?? BASE_APP_NOTIFY_LIMITS_V1.gapMs;
  const maxPages = input.maxPages ?? 20;
  let lastRequestAt: number | null = null;

  async function request(path: string, init: { method: 'GET' | 'POST'; body?: unknown }): Promise<unknown> {
    if (lastRequestAt !== null) {
      const wait = lastRequestAt + gapMs - clock();
      if (wait > 0) await sleep(wait);
    }
    lastRequestAt = clock();
    let response: Response;
    try {
      response = await doFetch(`${BASE_APP_NOTIFY_ENDPOINT_V1}${path}`, {
        method: init.method,
        headers: {
          'x-api-key': input.config.apiKey,
          ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (cause) {
      throw new BaseAppNotifyErrorV1(null, true, `base_app_unreachable:${cause instanceof Error ? cause.name : 'unknown'}`);
    }
    if (!response.ok) {
      const transient = response.status === 429 || response.status >= 500;
      throw new BaseAppNotifyErrorV1(response.status, transient, `base_app_http_${response.status}`);
    }
    try {
      return await response.json();
    } catch {
      throw new BaseAppNotifyErrorV1(response.status, true, 'base_app_unreadable_body');
    }
  }

  return {
    async enabledWallets() {
      const wallets = new Set<string>();
      let cursor: string | null = null;
      for (let page = 0; page < maxPages; page += 1) {
        const query = new URLSearchParams({
          app_url: input.config.appUrl,
          notification_enabled: 'true',
          limit: '500',
          ...(cursor ? { cursor } : {}),
        });
        const body = (await request(`/app/users?${query.toString()}`, { method: 'GET' })) as {
          users?: { address?: unknown; notificationsEnabled?: unknown }[];
          nextCursor?: unknown;
        } | null;
        for (const user of body?.users ?? []) {
          const address = typeof user.address === 'string' ? user.address.toLowerCase() : '';
          if (user.notificationsEnabled === true && WALLET_V1.test(address)) wallets.add(address);
        }
        cursor = typeof body?.nextCursor === 'string' && body.nextCursor !== '' ? body.nextCursor : null;
        if (!cursor) break;
      }
      return wallets;
    },

    async send(notice) {
      const body = (await request('/send', {
        method: 'POST',
        body: {
          app_url: input.config.appUrl,
          wallet_addresses: [...notice.wallets],
          title: notice.title,
          message: notice.message,
          target_path: notice.targetPath,
        },
      })) as { results?: { walletAddress?: unknown; sent?: unknown; failureReason?: unknown }[] } | null;
      const result: BaseAppNotifySendResultV1 = { sent: [], failed: { notSaved: 0, disabled: 0, other: 0 } };
      for (const row of body?.results ?? []) {
        const wallet = typeof row.walletAddress === 'string' ? row.walletAddress.toLowerCase() : '';
        if (row.sent === true && WALLET_V1.test(wallet)) {
          result.sent.push(wallet);
          continue;
        }
        const reason = String(row.failureReason ?? '');
        if (/not saved/i.test(reason)) result.failed.notSaved += 1;
        else if (/disabled/i.test(reason)) result.failed.disabled += 1;
        else result.failed.other += 1;
      }
      return result;
    },
  };
}

// ---------------------------------------------------------------------------
// What a push says
// ---------------------------------------------------------------------------

/** How a token is named in a push: the company's ticker and the token's own. */
export interface StockNamesV1 {
  /** The underlying's display symbol — "NVDA". Also the page the push opens. */
  symbol: string | null;
  /** The token's published ticker — "NVDAc". */
  representation: string | null;
  /** Who issued it, as the reviewed corpus records it — "coinbase". What a
   * multiplier change MEANS is the issuer's rule, never ours. */
  issuer?: string | null;
}
export type NamesOfV1 = (tokenAddress: string) => StockNamesV1 | null;

export interface NoticeV1 {
  /** Which row it came from, so one row is never said twice to one wallet. */
  key: string;
  /** A few words a summary can quote: "NVDA exit cost up". */
  label: string;
  title: string;
  message: string;
  targetPath: string;
}

const SYMBOL_PATH_V1 = /^[A-Za-z0-9][A-Za-z0-9.-]{0,15}$/;

export function clipV1(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

/** The public page for a stock, or the board when there is no symbol. */
export function stockPathV1(symbol: string | null): string {
  return symbol && SYMBOL_PATH_V1.test(symbol) ? `/stocks/${symbol.toLowerCase()}` : '/stocks';
}

function digitsV1(value: unknown, signed = false): bigint | null {
  if (typeof value !== 'string') return null;
  return (signed ? /^-?(0|[1-9][0-9]*)$/ : /^(0|[1-9][0-9]*)$/).test(value) ? BigInt(value) : null;
}

/** "$1,000" or "$12.50": whole dollars stay whole. */
export function usdV1(atomic: unknown, decimals = 6): string | null {
  const value = digitsV1(atomic);
  if (value === null || !Number.isInteger(decimals) || decimals < 0 || decimals > 36) return null;
  const scale = 10n ** BigInt(decimals);
  const whole = (value / scale).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const cents = ((value % scale) * 100n) / scale;
  return cents === 0n ? `$${whole}` : `$${whole}.${cents.toString().padStart(2, '0')}`;
}

/** "0.52%" from 52 basis points. */
export function percentFromBpsV1(value: unknown): string | null {
  const bps = digitsV1(value, true);
  if (bps === null) return null;
  const magnitude = bps < 0n ? -bps : bps;
  return `${bps < 0n ? '−' : ''}${magnitude / 100n}.${(magnitude % 100n).toString().padStart(2, '0')}%`;
}

/** A WAD multiplier as a plain number: 1000377118676784179 → "1.000377". */
export function multiplierV1(wad: unknown): string | null {
  const value = digitsV1(wad);
  if (value === null || value === 0n) return null;
  const scale = 10n ** 18n;
  const fraction = ((value % scale) * 1_000_000n) / scale;
  const text = `${value / scale}.${fraction.toString().padStart(6, '0')}`.replace(/\.?0+$/, '');
  return text === '' ? '0' : text;
}

function utcDateV1(iso: unknown): string | null {
  if (typeof iso !== 'string' || !Number.isFinite(Date.parse(iso))) return null;
  const date = new Date(iso);
  const month = date.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
  const time = date.toISOString().slice(11, 16);
  return `${month} ${date.getUTCDate()}, ${date.getUTCFullYear()} ${time} UTC`;
}

function noticeV1(input: { key: string; label: string; title: string; message: string; targetPath: string }): NoticeV1 {
  return {
    key: input.key,
    label: input.label,
    title: clipV1(input.title, BASE_APP_TITLE_MAX_V1),
    message: clipV1(input.message, BASE_APP_MESSAGE_MAX_V1),
    targetPath: input.targetPath,
  };
}

/** A recorded market or issuer change, as a push. Null when it cannot be
 * said truthfully — a kind this module does not send, or a token it cannot
 * name. */
export function noticeForSignalV1(signal: RwaSignalRowV1, names: NamesOfV1): NoticeV1 | null {
  const facts = signal.facts;
  const key = `rwa_signal:${signal.signalId}`;
  if (signal.kind === 'official_asset_lookalike_created') {
    const official = signal.officialAddress ? names(signal.officialAddress) : null;
    const officialTicker = typeof facts.officialTicker === 'string' ? facts.officialTicker : official?.representation ?? null;
    const who = official?.symbol ?? officialTicker;
    if (!who || !officialTicker) return null;
    // Quoted only when it reads as a ticker or a short name; anything else is
    // somebody's text and is not repeated in a push.
    const matched =
      typeof facts.matchedValue === 'string' && /^[A-Za-z0-9][A-Za-z0-9 .&'-]{0,23}$/.test(facts.matchedValue)
        ? facts.matchedValue
        : who;
    return noticeV1({
      key,
      label: `${who} lookalike token`,
      title: `${who}: lookalike token`,
      // The matched value is our own alias of the official token, never the
      // new token's own name: that name is anybody's text.
      message: `A new token on Base uses “${matched}” but is not ${officialTicker}. The official address is on its Miorail page.`,
      targetPath: stockPathV1(official?.symbol ?? null),
    });
  }

  const subject = names(signal.subjectAddress);
  const factTicker = typeof facts.ticker === 'string' ? facts.ticker : null;
  const representation = factTicker ?? subject?.representation ?? subject?.symbol ?? null;
  const who = subject?.symbol ?? representation;
  if (!who || !representation) return null;
  const targetPath = stockPathV1(subject?.symbol ?? null);
  const destination = facts.destination === 'ETH' ? 'ETH' : 'USDC';

  switch (signal.kind) {
    case 'official_asset_cash_exit_changed': {
      const size = usdV1(facts.requestedCashAtomic);
      const now = percentFromBpsV1(facts.roundTripCostBps);
      const was = percentFromBpsV1(facts.previousRoundTripCostBps);
      const change = digitsV1(facts.changeBps, true);
      if (!size || !now || !was || change === null || change === 0n) return null;
      const direction = change > 0n ? 'up' : 'down';
      return noticeV1({
        key,
        label: `${who} exit cost ${direction}`,
        title: `${who}: exit cost ${direction}`,
        message: `Round trip at ${size} (${destination} → ${representation} → ${destination}) now costs ${now}, was ${was}. Measured on Base.`,
        targetPath,
      });
    }
    case 'official_asset_market_became_active': {
      const size = usdV1(facts.requestedCashAtomic);
      const cost = percentFromBpsV1(facts.roundTripCostBps);
      return noticeV1({
        key,
        label: `${who} tradable on Base`,
        title: `${who}: tradable on Base`,
        message: `A reviewed route now buys and sells ${representation} for ${destination} on Base.${size && cost ? ` Round trip at ${size}: ${cost}.` : ''}`,
        targetPath,
      });
    }
    case 'official_asset_market_became_unreachable': {
      const size = usdV1(facts.requestedCashAtomic);
      return noticeV1({
        key,
        label: `${who} no route found`,
        title: `${who}: no route found`,
        message: `Miorail's latest completed measurement found no reviewed route for ${representation}${size ? ` at ${size}` : ''}. The one before it did.`,
        targetPath,
      });
    }
    case 'official_asset_corporate_action_announced':
      return noticeV1({
        key,
        label: `${who} corporate action`,
        title: `${who}: corporate action`,
        message: `The ${representation} contract posted a corporate-action announcement on Base.`,
        targetPath,
      });
    case 'official_asset_multiplier_changed': {
      const multiplier = multiplierV1(facts.multiplierWad);
      return noticeV1({
        key,
        label: `${who} multiplier changed`,
        title: `${who}: multiplier changed`,
        message: multiplier
          ? `The ${representation} contract set its share multiplier to ${multiplier}: one token now tracks ${multiplier} shares.`
          : `The ${representation} contract changed its share multiplier.`,
        targetPath,
      });
    }
    case 'official_asset_multiplier_change_scheduled': {
      const multiplier = multiplierV1(facts.multiplierWad);
      const when = utcDateV1(facts.effectiveAt);
      return noticeV1({
        key,
        label: `${who} multiplier scheduled`,
        title: `${who}: multiplier scheduled`,
        message: `The ${representation} contract scheduled a share multiplier change${multiplier ? ` to ${multiplier}` : ''}${when ? `, effective ${when}` : ''}. Until then it stays as it is.`,
        targetPath,
      });
    }
    case 'official_asset_multiplier_change_cancelled': {
      const multiplier = multiplierV1(facts.multiplierWad);
      return noticeV1({
        key,
        label: `${who} change cancelled`,
        title: `${who}: change cancelled`,
        message: `The scheduled multiplier change for ${representation}${multiplier ? ` to ${multiplier}` : ''} was cancelled.`,
        targetPath,
      });
    }
    default:
      return null;
  }
}

const SESSION_V1: Readonly<Record<string, string>> = {
  regular_hours: 'US market open',
  after_hours: 'US market closed',
  weekend: 'Weekend',
};

const PUBLICATION_V1: Readonly<Record<string, string>> = {
  live_reference: 'live',
  holding_last_close: 'holding the last close',
  corporate_action_hold: 'corporate-action hold',
  stale: 'stale',
};

/** One Radar event, to the person whose watch it is. */
export function noticeForRadarEventV1(event: RadarEventNoticeRowV1, names: NamesOfV1): NoticeV1 | null {
  const token = names(event.tokenAddress);
  const who = token?.symbol ?? token?.representation ?? null;
  if (!who) return null;
  const representation = token?.representation ?? who;
  const size = usdV1(event.requestedCashAtomic);
  if (!size) return null;
  const question =
    event.direction === 'sell'
      ? `Selling ${size} of ${representation} for ${event.destination}`
      : `Buying ${size} of ${representation} with ${event.destination}`;
  const facts = event.facts;
  const key = `radar_event:${event.eventId}`;
  const targetPath = stockPathV1(token?.symbol ?? null);
  const base = { key, targetPath };
  switch (event.kind) {
    case 'sell_exit_cost_changed': {
      const change = digitsV1(facts.changeBps, true);
      const was = percentFromBpsV1(facts.previousExitCostBps);
      const now = percentFromBpsV1(facts.exitCostBps);
      const backWas = usdV1(facts.previousCashBackAtomic);
      const backNow = usdV1(facts.cashBackAtomic);
      if (change === null || !was || !now) return null;
      const direction = change > 0n ? 'up' : change < 0n ? 'down' : 'changed';
      return noticeV1({
        ...base,
        label: `${who} exit cost ${direction}`,
        title: `${who}: exit cost ${direction}`,
        message: `${question}: exit cost ${was} → ${now}${backWas && backNow ? `, ${backWas} → ${backNow} back` : ''}.`,
      });
    }
    case 'buy_effective_price_changed': {
      const decimals = Number(facts.effectivePriceDecimals);
      const was = usdV1(facts.previousEffectivePriceAtomic, decimals);
      const now = usdV1(facts.effectivePriceAtomic, decimals);
      if (!was || !now) return null;
      return noticeV1({
        ...base,
        label: `${who} buy price changed`,
        title: `${who}: buy price changed`,
        message: `${question}: effective price ${was} → ${now}.`,
      });
    }
    case 'route_became_unavailable':
      return noticeV1({
        ...base,
        label: `${who} no route now`,
        title: `${who}: no route now`,
        message: `${question}: the latest completed measurement found no reviewed route. The one before it did.`,
      });
    case 'route_became_available':
      return noticeV1({
        ...base,
        label: `${who} route is back`,
        title: `${who}: route is back`,
        message: `${question}: a reviewed route is priced again.`,
      });
    case 'market_session_changed': {
      const from = SESSION_V1[String(facts.previousMarketSession)];
      const to = SESSION_V1[String(facts.marketSession)];
      if (!from || !to) return null;
      const pubFrom = PUBLICATION_V1[String(facts.previousPublicationMode)];
      const pubTo = PUBLICATION_V1[String(facts.publicationMode)];
      return noticeV1({
        ...base,
        label: `${who} session changed`,
        title: `${who}: session changed`,
        message: `${from} → ${to}.${pubFrom && pubTo ? ` The reference price went from ${pubFrom} to ${pubTo}.` : ''}`,
      });
    }
    case 'reference_became_stale':
      return noticeV1({
        ...base,
        label: `${who} reference stale`,
        title: `${who}: reference stale`,
        message: `The reviewed reference price for ${representation} went stale. Prices on Base are measured separately.`,
      });
    case 'representation_ratio_changed': {
      const values = [facts.previousRawValue, facts.previousScale, facts.rawValue, facts.scale];
      if (!values.every((value) => typeof value === 'string' && /^[0-9]{1,40}$/.test(value))) return null;
      return noticeV1({
        ...base,
        label: `${who} ratio changed`,
        title: `${who}: ratio changed`,
        message: `The ${representation} share ratio changed from ${values[0]}/${values[1]} to ${values[2]}/${values[3]}.`,
      });
    }
    default:
      return null;
  }
}

/** Several changes for one wallet in one pass, as one push. */
export function summaryNoticeV1(notices: readonly NoticeV1[]): NoticeV1 {
  if (notices.length === 1) return notices[0]!;
  const paths = new Set(notices.map((notice) => notice.targetPath));
  const labels: string[] = [];
  for (const notice of notices) {
    const rest = notices.length - labels.length - 1;
    const next = [...labels, notice.label].join('; ');
    if (`${next}${rest > 0 ? `; +${rest} more` : ''}.`.length > BASE_APP_MESSAGE_MAX_V1 - 30) break;
    labels.push(notice.label);
  }
  const more = notices.length - labels.length;
  return noticeV1({
    key: notices.map((notice) => notice.key).join(','),
    label: `${notices.length} updates`,
    title: `Miorail: ${notices.length} updates`,
    message: `${labels.join('; ')}${more > 0 ? `; +${more} more` : ''}. Open Miorail for the details.`,
    targetPath: paths.size === 1 ? [...paths][0]! : '/stocks',
  });
}

// ---------------------------------------------------------------------------
// What a holder is told
//
// A multiplier change reaches everyone opted in as a fact about the contract.
// The wallets that HOLD the token get it as a fact about their own tokens.
// For Coinbase's B20 stocks, a small rise in the multiplier is how a reinvested
// dividend arrives (GOOGLc, 2026-09-14: 1 → 1.000377). Almost nobody knows
// their stock paid them that way. Another issuer's multiplier means something
// else (Backed rebases), so the dividend sentence is Coinbase's alone.
// ---------------------------------------------------------------------------

/** Which of these tokens each wallet holds. A wallet holding none is absent. */
export type HoldingsV1 = ReadonlyMap<string, ReadonlySet<string>>;

/** The multiplier a token converted with before a change to `toWad`, or null. */
export type PreviousMultiplierV1 = (tokenAddress: string, toWad: string) => string | null;

/** A rise below this, on a Coinbase stock, reads as a reinvested dividend. A
 * split is a whole multiple; anything between is left unnamed. */
const DIVIDEND_RISE_MAX_PPM_V1 = 50_000;

/** The change from one WAD multiplier to another, in parts per million. */
export function multiplierChangePpmV1(fromWad: string, toWad: string): number | null {
  const from = digitsV1(fromWad);
  const to = digitsV1(toWad);
  if (from === null || to === null || from === 0n) return null;
  return Number(((to - from) * 1_000_000n) / from);
}

/** 377 ppm reads "0.038%"; a change of a percent or more keeps two decimals. */
export function ppmPercentV1(ppm: number): string {
  const percent = Math.abs(ppm) / 10_000;
  return `${percent < 1 ? percent.toFixed(3) : percent.toFixed(2)}%`;
}

export function holderMultiplierNoticeV1(
  signal: RwaSignalRowV1,
  names: NamesOfV1,
  previousWad: string | null,
): NoticeV1 | null {
  if (signal.kind !== 'official_asset_multiplier_changed') return null;
  const toWad = (signal.facts as { multiplierWad?: unknown }).multiplierWad;
  const to = multiplierV1(toWad);
  const name = names(signal.subjectAddress);
  const symbol = name?.symbol ?? name?.representation ?? null;
  if (!to || typeof toWad !== 'string' || !symbol) return null;
  const representation = name?.representation ?? symbol;
  const key = `holder:rwa_signal:${signal.signalId}`;
  const targetPath = stockPathV1(name?.symbol ?? null);
  const from = previousWad ? multiplierV1(previousWad) : null;
  const ppm = previousWad ? multiplierChangePpmV1(previousWad, toWad) : null;
  const coinbase = (name?.issuer ?? '').toLowerCase().startsWith('coinbase');
  if (coinbase && from && ppm !== null && ppm > 0 && ppm < DIVIDEND_RISE_MAX_PPM_V1) {
    return noticeV1({
      key,
      label: `${symbol} dividend in shares`,
      title: `${symbol}: dividend in shares`,
      message: `Your ${representation} now track ${ppmPercentV1(ppm)} more ${symbol} shares each: the multiplier went from ${from} to ${to}. That is how a reinvested dividend reaches a token holder.`,
      targetPath,
    });
  }
  return noticeV1({
    key,
    label: `${symbol} shares per token changed`,
    title: `${symbol}: shares per token`,
    message:
      from && ppm !== null && ppm !== 0
        ? `Your ${representation} now track ${to} ${symbol} shares each, ${ppm > 0 ? 'up' : 'down'} from ${from}.`
        : `Your ${representation} now track ${to} ${symbol} shares each.`,
    targetPath,
  });
}

// ---------------------------------------------------------------------------
// The weekly summary
//
// Once a week, in the evening after the week's last close: the holder hears
// how THEIR stocks did, everyone else hears how the market did, and both are
// told the tokens keep trading on Base over the weekend. The numbers are the
// reference at each close, so a week reads the way a brokerage statement does.
// ---------------------------------------------------------------------------

export interface WeeklySummaryV1 {
  week: WeeklyCloseChangesV1;
  /** Tokens whose multiplier rose as a dividend during the week. */
  dividends: ReadonlySet<string>;
}

/** From 20:45 ET after the week's last close, for twelve hours, and only when
 * a weekend follows: a mid-week holiday is not the end of a week. 20:45 ET
 * because the push lands on the Stocks board, and the weekend card there has
 * its three quotes per stock only once the cash-exit timer's Friday passes
 * (20:01, 20:14, 20:27 ET) have run. */
export function weeklySummaryDueV1(now: Date): { weekCloseAt: string } | null {
  const window = weekendWindowV1(now);
  if (!window) return null;
  const darkStart = Date.parse(window.darkStartAt);
  if (Date.parse(window.expectedReopenAt) - darkStart < 48 * 3_600_000) return null;
  const at = now.getTime();
  return at >= darkStart + 45 * 60_000 && at < darkStart + 12 * 3_600_000 ? { weekCloseAt: window.closeAt } : null;
}

function signedPercentFromBpsV1(bps: number): string {
  const text = percentFromBpsV1(String(bps)) ?? '0.00%';
  return bps > 0 ? `+${text}` : text;
}

/** One wallet's weekly push. `held` null means it holds none of these stocks. */
export function weeklyNoticeV1(input: {
  weekly: WeeklySummaryV1;
  held: ReadonlySet<string> | null;
}): NoticeV1 | null {
  const { week, dividends } = input.weekly;
  const rows = input.held ? week.stocks.filter((row) => input.held!.has(row.tokenAddress)) : week.stocks;
  if (rows.length === 0) return null;
  const top = rows
    .slice(0, 3)
    .map((row) => `${row.symbol} ${signedPercentFromBpsV1(row.changeBps)}`)
    .join(', ');
  if (input.held) {
    const paid = rows.filter((row) => dividends.has(row.tokenAddress)).map((row) => row.symbol);
    return noticeV1({
      key: `weekly:${week.weekCloseAt}:held`,
      label: 'your week',
      title: 'Your stocks this week',
      message: `${top} from last week's close.${paid.length > 0 ? ` ${paid.join(', ')} paid a dividend in shares.` : ''} They keep trading on Base this weekend.`,
      targetPath: '/stocks',
    });
  }
  return noticeV1({
    key: `weekly:${week.weekCloseAt}`,
    label: 'the week',
    title: 'The week on Base',
    message: `Tokenized stocks this week: ${top} from last week's close. They keep trading on Base while Wall Street is closed.`,
    targetPath: '/stocks',
  });
}

export function planWeeklySummaryV1(input: {
  weekly: WeeklySummaryV1;
  wallets: readonly string[];
  holdings: HoldingsV1;
  sentToday: ReadonlyMap<string, number>;
  limits?: Partial<BaseAppNotifyLimitsV1>;
}): { groups: BaseAppPushGroupV1[]; capped: number } {
  const limits = { ...BASE_APP_NOTIFY_LIMITS_V1, ...input.limits };
  const byMessage = new Map<string, BaseAppPushGroupV1>();
  let capped = 0;
  for (const wallet of [...input.wallets].sort()) {
    if ((input.sentToday.get(wallet) ?? 0) >= limits.dailyCap) {
      capped += 1;
      continue;
    }
    const held = input.holdings.get(wallet);
    const notice =
      weeklyNoticeV1({ weekly: input.weekly, held: held && held.size > 0 ? held : null }) ??
      weeklyNoticeV1({ weekly: input.weekly, held: null });
    if (!notice) continue;
    const id = JSON.stringify([notice.title, notice.message, notice.targetPath]);
    const group = byMessage.get(id) ?? { title: notice.title, message: notice.message, targetPath: notice.targetPath, wallets: [] };
    group.wallets.push(wallet);
    byMessage.set(id, group);
  }
  const groups: BaseAppPushGroupV1[] = [];
  for (const group of byMessage.values()) {
    for (let index = 0; index < group.wallets.length; index += BASE_APP_BATCH_MAX_V1) {
      groups.push({ ...group, wallets: group.wallets.slice(index, index + BASE_APP_BATCH_MAX_V1) });
    }
  }
  groups.sort((a, b) => b.wallets.length - a.wallets.length || a.message.localeCompare(b.message));
  return { groups: groups.slice(0, limits.maxRequests), capped };
}

// ---------------------------------------------------------------------------
// Who gets what
// ---------------------------------------------------------------------------

/** The wallet a Miorail user id names: `eip155:8453:<address>`. */
export function walletOfUserIdV1(userId: string): string | null {
  const match = /^eip155:8453:(0x[0-9a-fA-F]{40})$/.exec(userId);
  return match ? match[1]!.toLowerCase() : null;
}

export interface BaseAppPushGroupV1 {
  title: string;
  message: string;
  targetPath: string;
  wallets: string[];
}

export interface BaseAppNotifyPlanV1 {
  groups: BaseAppPushGroupV1[];
  /** Rows that became a notice for at least one opted-in wallet. */
  notices: number;
  /** Rows older than the cut-off. */
  stale: number;
  /** Rows this module does not send, or could not name. */
  unsent: number;
  /** Wallets a notice was for that have not opted in. */
  notEnabled: number;
  /** Wallets already at today's cap. */
  capped: number;
  /** Groups beyond one pass's request budget. */
  dropped: number;
}

export function planBaseAppNotificationsV1(input: {
  signals: readonly RwaSignalRowV1[];
  radarEvents: readonly RadarEventNoticeRowV1[];
  watchers: readonly { userId: string; tokenAddress: string }[];
  enabled: ReadonlySet<string>;
  sentToday: ReadonlyMap<string, number>;
  names: NamesOfV1;
  now: Date;
  limits?: Partial<BaseAppNotifyLimitsV1>;
  /** Who holds what, read this pass. Absent: everyone gets the contract's
   * version, exactly as before this existed. */
  holdings?: HoldingsV1;
  previousMultiplier?: PreviousMultiplierV1;
}): BaseAppNotifyPlanV1 {
  const limits = { ...BASE_APP_NOTIFY_LIMITS_V1, ...input.limits };
  const oldest = input.now.getTime() - limits.maxAgeMs;
  const perWallet = new Map<string, Map<string, NoticeV1>>();
  const notEnabled = new Set<string>();
  let stale = 0;
  let unsent = 0;
  let notices = 0;

  const watchersByToken = new Map<string, string[]>();
  for (const watch of input.watchers) {
    const wallet = walletOfUserIdV1(watch.userId);
    if (!wallet) continue;
    const token = watch.tokenAddress.toLowerCase();
    watchersByToken.set(token, [...(watchersByToken.get(token) ?? []), wallet]);
  }

  const deliver = (notice: NoticeV1, audience: Iterable<string>): void => {
    let reached = false;
    for (const wallet of audience) {
      if (!input.enabled.has(wallet)) {
        notEnabled.add(wallet);
        continue;
      }
      reached = true;
      const mine = perWallet.get(wallet) ?? new Map<string, NoticeV1>();
      mine.set(notice.key, notice);
      perWallet.set(wallet, mine);
    }
    if (reached) notices += 1;
  };

  for (const signal of input.signals) {
    if (Date.parse(signal.recordedAt) < oldest) {
      stale += 1;
      continue;
    }
    const broadcast = BASE_APP_BROADCAST_KINDS_V1.has(signal.kind);
    if (!broadcast && !BASE_APP_WATCHER_KINDS_V1.has(signal.kind)) {
      unsent += 1;
      continue;
    }
    const notice = noticeForSignalV1(signal, input.names);
    if (!notice) {
      unsent += 1;
      continue;
    }
    const watchedToken =
      signal.kind === 'official_asset_lookalike_created' ? signal.officialAddress : signal.subjectAddress;
    if (signal.kind === 'official_asset_multiplier_changed' && input.holdings) {
      const token = signal.subjectAddress.toLowerCase();
      const toWad = (signal.facts as { multiplierWad?: unknown }).multiplierWad;
      const previous =
        typeof toWad === 'string' && input.previousMultiplier ? input.previousMultiplier(token, toWad) : null;
      const holderNotice = holderMultiplierNoticeV1(signal, input.names, previous);
      const holders = [...input.enabled].filter((wallet) => input.holdings!.get(wallet)?.has(token));
      if (holderNotice && holders.length > 0) {
        deliver(holderNotice, holders);
        deliver(notice, [...input.enabled].filter((wallet) => !holders.includes(wallet)));
        continue;
      }
    }
    deliver(notice, broadcast ? input.enabled : new Set(watchersByToken.get(watchedToken?.toLowerCase() ?? '') ?? []));
  }

  for (const event of input.radarEvents) {
    if (Date.parse(event.recordedAt) < oldest) {
      stale += 1;
      continue;
    }
    const wallet = walletOfUserIdV1(event.userId);
    const notice = wallet ? noticeForRadarEventV1(event, input.names) : null;
    if (!wallet || !notice) {
      unsent += 1;
      continue;
    }
    deliver(notice, [wallet]);
  }

  const byMessage = new Map<string, BaseAppPushGroupV1>();
  let capped = 0;
  for (const [wallet, mine] of [...perWallet.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if ((input.sentToday.get(wallet) ?? 0) >= limits.dailyCap) {
      capped += 1;
      continue;
    }
    const push = summaryNoticeV1([...mine.values()]);
    const id = JSON.stringify([push.title, push.message, push.targetPath]);
    const group = byMessage.get(id) ?? { title: push.title, message: push.message, targetPath: push.targetPath, wallets: [] };
    group.wallets.push(wallet);
    byMessage.set(id, group);
  }

  const groups: BaseAppPushGroupV1[] = [];
  for (const group of byMessage.values()) {
    for (let index = 0; index < group.wallets.length; index += BASE_APP_BATCH_MAX_V1) {
      groups.push({ ...group, wallets: group.wallets.slice(index, index + BASE_APP_BATCH_MAX_V1) });
    }
  }
  // The biggest audiences first, so a pass over budget drops the pushes that
  // reach the fewest people.
  groups.sort((a, b) => b.wallets.length - a.wallets.length || a.message.localeCompare(b.message));
  const kept = groups.slice(0, limits.maxRequests);
  return {
    groups: kept,
    notices,
    stale,
    unsent,
    notEnabled: notEnabled.size,
    capped,
    dropped: groups.length - kept.length,
  };
}

// ---------------------------------------------------------------------------
// One pass
// ---------------------------------------------------------------------------

export interface BaseAppNotifyReportV1 {
  outcome: 'off' | 'opened' | 'idle' | 'delivered' | 'dry' | 'stopped';
  signalsRead: number;
  radarEventsRead: number;
  groups: number;
  sent: number;
  failed: number;
  notices: number;
  stale: number;
  unsent: number;
  notEnabled: number;
  capped: number;
  dropped: number;
  /** Why a pass stopped: our code for Base's answer, never its body. */
  stoppedBy: string | null;
  /** The weekly summary: null outside its window, else what happened. */
  weekly: { weekCloseAt: string; due: number; sent: number; capped: number } | null;
}

function utcDayV1(at: Date): string {
  return at.toISOString().slice(0, 10);
}

export async function runBaseAppNotifyV1(deps: {
  repository: BaseAppNotificationRepositoryV1;
  client: BaseAppNotifyClientV1 | null;
  /** Names for these tokens, fetched once per pass. */
  names: (tokenAddresses: readonly string[]) => Promise<NamesOfV1>;
  now: () => Date;
  dry?: boolean;
  limits?: Partial<BaseAppNotifyLimitsV1>;
  /** Which of these tokens each wallet holds, read from the chain now. */
  holdings?: (wallets: readonly string[], tokens: readonly string[]) => Promise<HoldingsV1>;
  /** The multiplier before each recorded change, read once per pass. */
  previousMultipliers?: () => Promise<PreviousMultiplierV1>;
  /** The week that just closed, and its dividends. Asked only inside the
   * summary's window. */
  weekly?: (now: Date) => Promise<WeeklySummaryV1 | null>;
}): Promise<BaseAppNotifyReportV1> {
  const limits = { ...BASE_APP_NOTIFY_LIMITS_V1, ...deps.limits };
  const report: BaseAppNotifyReportV1 = {
    outcome: 'idle',
    signalsRead: 0,
    radarEventsRead: 0,
    groups: 0,
    sent: 0,
    failed: 0,
    notices: 0,
    stale: 0,
    unsent: 0,
    notEnabled: 0,
    capped: 0,
    dropped: 0,
    stoppedBy: null,
    weekly: null,
  };
  if (!deps.client) return { ...report, outcome: 'off' };
  const now = deps.now();

  // The weekly summary rides no cursor: it is due by the clock, once per week
  // per wallet, and a pass that fails it leaves it due for the next pass.
  const due = deps.weekly ? weeklySummaryDueV1(now) : null;
  if (due && deps.weekly) {
    const weekly = await deps.weekly(now);
    if (weekly && weekly.week.stocks.length > 0) {
      let enabledNow: Set<string>;
      try {
        enabledNow = await deps.client.enabledWallets();
      } catch (cause) {
        return { ...report, outcome: 'stopped', stoppedBy: cause instanceof BaseAppNotifyErrorV1 ? cause.message : 'base_app_error' };
      }
      const already = await deps.repository.weeklySentTo({ weekCloseAt: due.weekCloseAt, wallets: [...enabledNow] });
      const pending = [...enabledNow].filter((wallet) => !already.has(wallet));
      report.weekly = { weekCloseAt: due.weekCloseAt, due: pending.length, sent: 0, capped: 0 };
      if (pending.length > 0) {
        // A holder must never be told the market's week instead of their own:
        // an unread balance leaves the summary for the next pass.
        let holdings: HoldingsV1 | null;
        try {
          holdings = deps.holdings
            ? await deps.holdings(pending, weekly.week.stocks.map((row) => row.tokenAddress))
            : new Map();
        } catch {
          holdings = null;
        }
        if (holdings) {
          const day = utcDayV1(now);
          const sentToday = await deps.repository.sentOn({ day, wallets: pending });
          const plan = planWeeklySummaryV1({ weekly, wallets: pending, holdings, sentToday, limits });
          report.weekly.capped = plan.capped;
          if (!deps.dry) {
            for (const group of plan.groups) {
              try {
                const result = await deps.client.send(group);
                report.weekly.sent += result.sent.length;
                report.failed += result.failed.notSaved + result.failed.disabled + result.failed.other;
                if (result.sent.length > 0) {
                  await deps.repository.recordSent({ day, wallets: result.sent });
                  await deps.repository.recordWeeklySent({ weekCloseAt: due.weekCloseAt, wallets: result.sent, at: now });
                }
              } catch (cause) {
                const error = cause instanceof BaseAppNotifyErrorV1 ? cause : null;
                if (error && error.status === 400) continue;
                return { ...report, outcome: 'stopped', stoppedBy: error ? error.message : 'base_app_error' };
              }
            }
          }
        }
      }
    }
  }

  // A dry pass writes nothing, so it cannot open a cursor; it reads from one
  // that is already open, or reports that none is.
  const cursors = {
    rwa_signal: await deps.repository.cursor('rwa_signal'),
    radar_event: await deps.repository.cursor('radar_event'),
  };
  if (deps.dry && (!cursors.rwa_signal || !cursors.radar_event)) return { ...report, outcome: 'dry' };
  let opened = false;
  for (const source of ['rwa_signal', 'radar_event'] as const) {
    if (cursors[source]) continue;
    const result = await deps.repository.openCursor({ source, at: now });
    cursors[source] = result.cursor;
    opened ||= result.openedNow;
  }
  // The pass that opens the cursors announces nothing: everything before them
  // is history.
  if (opened) return { ...report, outcome: 'opened' };

  const signals = await deps.repository.signalsAfter({ cursor: cursors.rwa_signal!, limit: limits.perSource });
  const radarEvents = await deps.repository.radarEventsAfter({ cursor: cursors.radar_event!, limit: limits.perSource });
  report.signalsRead = signals.length;
  report.radarEventsRead = radarEvents.length;

  const advance = async (): Promise<void> => {
    const lastSignal = signals.at(-1);
    if (lastSignal) {
      await deps.repository.advanceCursor({
        source: 'rwa_signal',
        cursorAt: lastSignal.recordedAt,
        cursorId: lastSignal.signalId,
        at: now,
      });
    }
    const lastEvent = radarEvents.at(-1);
    if (lastEvent) {
      await deps.repository.advanceCursor({
        source: 'radar_event',
        cursorAt: lastEvent.recordedAt,
        cursorId: lastEvent.eventId,
        at: now,
      });
    }
  };

  if (signals.length === 0 && radarEvents.length === 0) {
    if (!deps.dry) {
      const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      await deps.repository.pruneDaily({ before: utcDayV1(weekAgo) });
    }
    return (report.weekly?.sent ?? 0) > 0 ? { ...report, outcome: 'delivered' } : report;
  }

  // Only rows this module could send are worth asking Base about.
  const sendable = signals.filter(
    (signal) => BASE_APP_BROADCAST_KINDS_V1.has(signal.kind) || BASE_APP_WATCHER_KINDS_V1.has(signal.kind),
  );
  if (sendable.length === 0 && radarEvents.length === 0) {
    const plan = planBaseAppNotificationsV1({
      signals,
      radarEvents,
      watchers: [],
      enabled: new Set(),
      sentToday: new Map(),
      names: () => null,
      now,
      limits,
    });
    if (!deps.dry) await advance();
    return {
      ...report,
      stale: plan.stale,
      unsent: plan.unsent,
      outcome: deps.dry ? 'dry' : (report.weekly?.sent ?? 0) > 0 ? 'delivered' : 'idle',
    };
  }

  const tokens = new Set<string>();
  for (const signal of sendable) {
    tokens.add(signal.subjectAddress);
    if (signal.officialAddress) tokens.add(signal.officialAddress);
  }
  for (const event of radarEvents) tokens.add(event.tokenAddress);
  const names = await deps.names([...tokens]);
  const watched = sendable
    .filter((signal) => BASE_APP_WATCHER_KINDS_V1.has(signal.kind))
    .map((signal) =>
      signal.kind === 'official_asset_lookalike_created' ? signal.officialAddress ?? '' : signal.subjectAddress,
    )
    .filter(Boolean);
  const watchers = watched.length > 0 ? await deps.repository.watchersOf({ chainId: 8453, tokenAddresses: watched }) : [];

  let enabled: Set<string>;
  try {
    enabled = await deps.client.enabledWallets();
  } catch (cause) {
    // Nothing is advanced: the rows wait for a pass Base answers, and the
    // age cut-off keeps a long outage from arriving later as a burst.
    return { ...report, outcome: 'stopped', stoppedBy: cause instanceof BaseAppNotifyErrorV1 ? cause.message : 'base_app_error' };
  }

  const day = utcDayV1(now);
  const sentToday = await deps.repository.sentOn({ day, wallets: [...enabled] });
  // Holders are read only when a multiplier change is about to be sent. An
  // unread balance falls back to the contract's version for everyone, which
  // is exactly what this pass sent before holders existed.
  const multiplierTokens = [
    ...new Set(
      sendable
        .filter((signal) => signal.kind === 'official_asset_multiplier_changed')
        .map((signal) => signal.subjectAddress.toLowerCase()),
    ),
  ];
  let holdings: HoldingsV1 | undefined;
  let previousMultiplier: PreviousMultiplierV1 | undefined;
  if (multiplierTokens.length > 0 && deps.holdings && enabled.size > 0) {
    try {
      holdings = await deps.holdings([...enabled], multiplierTokens);
      previousMultiplier = deps.previousMultipliers ? await deps.previousMultipliers() : undefined;
    } catch {
      holdings = undefined;
      previousMultiplier = undefined;
    }
  }
  const plan = planBaseAppNotificationsV1({
    signals,
    radarEvents,
    watchers,
    enabled,
    sentToday,
    names,
    now,
    limits,
    ...(holdings ? { holdings } : {}),
    ...(previousMultiplier ? { previousMultiplier } : {}),
  });
  Object.assign(report, {
    groups: plan.groups.length,
    notices: plan.notices,
    stale: plan.stale,
    unsent: plan.unsent,
    notEnabled: plan.notEnabled,
    capped: plan.capped,
    dropped: plan.dropped,
  });
  if (deps.dry) return { ...report, outcome: 'dry' };

  for (const group of plan.groups) {
    try {
      const result = await deps.client.send(group);
      report.sent += result.sent.length;
      report.failed += result.failed.notSaved + result.failed.disabled + result.failed.other;
      if (result.sent.length > 0) await deps.repository.recordSent({ day, wallets: result.sent });
    } catch (cause) {
      const error = cause instanceof BaseAppNotifyErrorV1 ? cause : null;
      if (error && error.status === 400) {
        // Our payload, refused: the next pass would build the same one.
        report.failed += group.wallets.length;
        continue;
      }
      // Base is down, throttling, or no longer takes our key. Stop here and
      // leave the cursors: a retry of a push Base already delivered is
      // deduplicated by Base for 24 hours.
      return { ...report, outcome: 'stopped', stoppedBy: error ? error.message : 'base_app_error' };
    }
  }

  await advance();
  return { ...report, outcome: plan.groups.length > 0 || (report.weekly?.sent ?? 0) > 0 ? 'delivered' : 'idle' };
}
