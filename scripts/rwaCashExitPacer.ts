import type { CashExitQuotePacingV1 } from '@mioagent/rwa-cash-exit';

// ---------------------------------------------------------------------------
// The pace of the hourly cash-exit pass (audit OPS-3, 2026-11-10).
//
// A ladder is about a dozen router quotes for one asset, and the pass asks for
// thousands. It sent each ladder as fast as it was answered, then waited
// between assets. KyberSwap's public limit is three requests a second
// (docs.kyberswap.com, "Rate Limits & Authentication"), and from 2026-11-07,
// the day after the move to a new address, it answered 429 to most of the
// pass: for days the ladder of some sixty percent of the assets was never
// finished, the stock board said "did not finish" under their names, and Swap
// AI, which asks the same router from the same server, shared the throttle.
// The journal printed only "measurement_failed", and nothing raised an alarm.
//
// So every quote of the pass now waits its turn. A 429 is waited out and the
// quote asked once more; the wait doubles while the throttle lasts, with a
// random half either way so that what comes back does not come back in step,
// and the pass spends at most eight minutes waiting this way. A pass that
// still ends mostly throttled says so with its exit code, and the service
// alerts carry that to Telegram.
//
// The pace finds itself (2026-11-11). At one quote every 400 ms the first two
// paced passes still ended 11% and 33% throttled: the limit is counted for the
// server, and the watchlist sweep, the market tail and Swap AI ask the same
// router from it. So the pass starts at one quote every 700 ms, lengthens that
// by half at every 429, up to 1.5 s, and shortens it by a tenth after every
// thirty quotes that got through. At its slowest a pass of 2,700 quotes still
// ends inside the unit's ninety minutes.
// ---------------------------------------------------------------------------

export interface QuotePacerOptionsV1 {
  /** Least time between two quotes being asked: where the pace starts, and what it returns to. */
  minGapMs: number;
  /** The longest the time between two quotes grows to under throttling. Absent: the pace is fixed. */
  maxGapMs?: number;
  /** The first wait after a 429; doubled for each one that follows without a quote getting through. */
  backoffMs: number;
  maxBackoffMs: number;
  /** All the waiting after 429s one pass may do. Past it a 429 is recorded as it came. */
  backoffBudgetMs: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** 0 to 1. */
  random?: () => number;
}

export const QUOTE_PACER_DEFAULTS_V1 = { minGapMs: 700, maxGapMs: 1_500, backoffMs: 3_000, maxBackoffMs: 30_000, backoffBudgetMs: 8 * 60_000 } as const;
/** A 429 lengthens the time between quotes by this much. */
const GAP_GROWTH_V1 = 1.5;
/** This many quotes in a row that got through shorten it by a tenth. */
const GAP_EASE_AFTER_V1 = 30;

export interface QuotePacerCountsV1 {
  /** Quotes that got a final answer. */
  quotes: number;
  /** 429s seen, the ones a second ask got past included. */
  throttled: number;
  /** Quotes asked a second time after a wait. */
  retried: number;
  /** Quotes whose final answer was still a 429. */
  rateLimited: number;
  waitedMs: number;
  /** The time between two quotes as the pass ended, and the longest it was. */
  gapMs: number;
  longestGapMs: number;
}

export function createQuotePacerV1(options: QuotePacerOptionsV1): { pacing: Required<CashExitQuotePacingV1>; counts: () => QuotePacerCountsV1 } {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((done) => { setTimeout(done, ms); }));
  const random = options.random ?? Math.random;
  const maxGapMs = Math.max(options.minGapMs, options.maxGapMs ?? options.minGapMs);
  let lastAskedAt = Number.NEGATIVE_INFINITY, backoff = options.backoffMs, gap = options.minGapMs, through = 0;
  const counts: QuotePacerCountsV1 = { quotes: 0, throttled: 0, retried: 0, rateLimited: 0, waitedMs: 0, gapMs: gap, longestGapMs: gap };
  return {
    pacing: {
      async beforeQuote() {
        const wait = lastAskedAt + gap - now();
        if (wait > 0) await sleep(wait);
        lastAskedAt = now();
      },
      async rateLimited() {
        counts.throttled += 1;
        // The router said "slower": every quote after this one waits longer, whatever becomes of this one.
        gap = Math.min(Math.round(gap * GAP_GROWTH_V1), maxGapMs);
        through = 0;
        counts.gapMs = gap;
        counts.longestGapMs = Math.max(counts.longestGapMs, gap);
        const left = options.backoffBudgetMs - counts.waitedMs;
        if (left <= 0) return false;
        const wait = Math.min(Math.round(backoff * (0.5 + random())), left);
        backoff = Math.min(backoff * 2, options.maxBackoffMs);
        counts.waitedMs += wait;
        await sleep(wait);
        counts.retried += 1;
        return true;
      },
      answered(rateLimited) {
        counts.quotes += 1;
        if (rateLimited) counts.rateLimited += 1;
        // A quote got through: the next throttle starts from the first wait again, and enough of them
        // in a row let the pace come back a little.
        else {
          backoff = options.backoffMs;
          through += 1;
          if (through >= GAP_EASE_AFTER_V1 && gap > options.minGapMs) {
            gap = Math.max(options.minGapMs, Math.round(gap * 0.9));
            through = 0;
            counts.gapMs = gap;
          }
        }
      },
    },
    counts: () => ({ ...counts }),
  };
}

/** A pass asks thousands of quotes; fewer than this is an operator's own narrow run, which is not judged. */
export const THROTTLED_PASS_MIN_QUOTES_V1 = 200;
/** More than this share of a pass ending rate limited is a pass that did not do its work. */
export const THROTTLED_PASS_SHARE_V1 = 0.3;
/** EX_TEMPFAIL: the pass ran, and its provider did not let most of it through. The service alerts name it. */
export const THROTTLED_PASS_EXIT_CODE_V1 = 75;

/** Whether a pass ended mostly rate limited. */
export function throttledPassV1(counts: Pick<QuotePacerCountsV1, 'quotes' | 'rateLimited'>): boolean {
  return counts.quotes >= THROTTLED_PASS_MIN_QUOTES_V1 && counts.rateLimited / counts.quotes > THROTTLED_PASS_SHARE_V1;
}

/** "provider_rate_limited ×8, cash_size_anchor_no_route ×2": why the rungs of one ladder, or of a pass, were not finished. */
export function errorCodeSummaryV1(codes: Iterable<string | null | undefined>): string {
  const counted = new Map<string, number>();
  for (const code of codes) if (code) counted.set(code, (counted.get(code) ?? 0) + 1);
  return [...counted].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([code, count]) => `${code} ×${count}`).join(', ');
}
