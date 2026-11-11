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
// So every quote of the pass now waits its turn: at most one every 400 ms,
// which is two and a half a second with nothing else running and less in
// practice. A 429 is waited out and the quote asked once more; the wait
// doubles while the throttle lasts, with a random half either way so that
// what comes back does not come back in step, and the pass spends at most
// eight minutes waiting this way. A pass that still ends mostly throttled
// says so with its exit code, and the service alerts carry that to Telegram.
// ---------------------------------------------------------------------------

export interface QuotePacerOptionsV1 {
  /** Least time between two quotes being asked. */
  minGapMs: number;
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

export const QUOTE_PACER_DEFAULTS_V1 = { minGapMs: 400, backoffMs: 3_000, maxBackoffMs: 30_000, backoffBudgetMs: 8 * 60_000 } as const;

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
}

export function createQuotePacerV1(options: QuotePacerOptionsV1): { pacing: Required<CashExitQuotePacingV1>; counts: () => QuotePacerCountsV1 } {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((done) => { setTimeout(done, ms); }));
  const random = options.random ?? Math.random;
  let lastAskedAt = Number.NEGATIVE_INFINITY, backoff = options.backoffMs;
  const counts: QuotePacerCountsV1 = { quotes: 0, throttled: 0, retried: 0, rateLimited: 0, waitedMs: 0 };
  return {
    pacing: {
      async beforeQuote() {
        const wait = lastAskedAt + options.minGapMs - now();
        if (wait > 0) await sleep(wait);
        lastAskedAt = now();
      },
      async rateLimited() {
        counts.throttled += 1;
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
        // A quote got through: the next throttle starts from the first wait again.
        else backoff = options.backoffMs;
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
