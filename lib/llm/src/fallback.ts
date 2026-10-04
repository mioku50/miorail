import { LlmHttpError, LlmTimeoutError } from './openai.js';
import type { LlmProvider, LlmRequest, LlmResponse } from './types.js';

// ---------------------------------------------------------------------------
// A two-provider chain: try the primary, and on a failure that a different
// provider could plausibly survive, try the fallback.
//
// This exists because an LLM router is a single point of failure that dies
// quietly. A free tier runs out of credits and every route comparison starts
// answering 500 — the product looks broken, and the cause is one HTTP status
// nobody was watching.
//
// Two things it deliberately does NOT do:
//
//   * It does not retry the SAME provider. That is a different concern with a
//     different remedy (backoff), and doing both here would multiply latency on
//     a request a user is waiting on.
//   * It does not fall over on a request the fallback would reject identically.
//     Reporting the fallback's error for a malformed request would name the
//     wrong provider and send the operator to the wrong log.
// ---------------------------------------------------------------------------

/**
 * Statuses that mean "this request is wrong", not "this provider is unwell".
 *
 * A second provider fails these the same way, so falling over would double the
 * latency, spend a second quota, and then blame the fallback for a defect in
 * the caller. Everything else — quota (402/429), credentials (401/403), the
 * model being gone (404), the gateway being down (5xx), a timeout, a dropped
 * socket — is worth a second opinion.
 */
export const NON_FAILOVER_STATUSES_V1: readonly number[] = [400, 422];

export function shouldFallOverV1(error: unknown): boolean {
  if (error instanceof LlmHttpError) return !NON_FAILOVER_STATUSES_V1.includes(error.status);
  // Network errors, timeouts and malformed provider responses all reach here.
  // Every one of them is a property of the provider, not of the request.
  return true;
}

/**
 * Whether a failure says the link cannot serve ANY request for a while.
 *
 * 401 and 402 are the account: a refused key or a spent balance stays that
 * way for longer than any reader waits. A 429 counts only when the
 * provider's own header says the allowance is zero, which is how Mistral
 * answered a valid key from 2026-09-29; an ordinary 429 is a minute passing.
 *
 * 403 and 404 do not count. OpenRouter answers 403 for one flagged prompt and
 * 404 when no upstream takes one request's parameters, and resting a link
 * over one request would take it away from every other.
 */
export function linkCannotServeV1(error: unknown): boolean {
  if (!(error instanceof LlmHttpError)) return false;
  if (error.status === 401 || error.status === 402) return true;
  return error.status === 429 && error.zeroAllowance;
}

/** How long a link that cannot serve is skipped before it is asked again. */
export const LLM_LINK_REST_MS_V1 = 10 * 60_000;

/**
 * The links that said they cannot serve, and until when.
 *
 * Without it, a dead link kept its claim on every budget: the spare before
 * it was held to half of what was left so the dead one could spend the rest
 * failing in a tenth of a second. The factory shares one of these between
 * every chain it builds: chains are built per request, and a link's account
 * is the same in all of them.
 */
export class LlmLinkRestV1 {
  private readonly until = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now) {}

  resting(label: string): boolean {
    const until = this.until.get(label);
    if (until === undefined) return false;
    if (until > this.now()) return true;
    this.until.delete(label);
    return false;
  }

  rest(label: string, ms: number = LLM_LINK_REST_MS_V1): void {
    this.until.set(label, this.now() + ms);
  }

  clear(): void {
    this.until.clear();
  }
}

/** The chain's own guarantee: a link that ignores `timeoutMs` still loses
 * its turn when its share runs out. The client aborts its request too. */
async function withinShareV1<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new LlmTimeoutError(ms)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Raised only when EVERY provider failed. It names them all, because
 * "OpenRouter returned 429" on its own sends the operator to investigate a
 * provider that was never the primary. */
export class LlmChainExhaustedError extends Error {
  /** Every link that was tried, in order, with the error it produced. */
  readonly failures: ReadonlyArray<{ label: string; error: unknown }>;

  constructor(failures: ReadonlyArray<{ label: string; error: unknown }>) {
    super(
      `Every configured LLM provider failed. ` +
        failures.map((failure) => `${failure.label}: ${messageOf(failure.error)}`).join(' | '),
    );
    this.name = 'LlmChainExhaustedError';
    this.failures = failures;
  }

  /** The first link's error. Kept because a two-provider chain is still the
   * common case and callers read these by name. */
  get primaryError(): unknown {
    return this.failures[0]?.error;
  }

  /** The LAST link's error — the one that ended the chain. */
  get fallbackError(): unknown {
    return this.failures[this.failures.length - 1]?.error;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface NamedLlmProviderV1 {
  /** Host, never a key — this string goes into error messages and logs. */
  label: string;
  provider: LlmProvider;
}

export interface FallbackLlmProviderOptions {
  /** Called when the primary fails and the fallback is about to be tried. The
   * reason is already redacted by the client that produced it. */
  onFallover?: (event: { from: string; to: string; reason: string }) => void;
  /** Skip links that said they cannot serve (see `linkCannotServeV1`). Off
   * unless given. */
  rest?: LlmLinkRestV1;
  /** Called once, when a link starts resting. */
  onRest?: (event: { label: string; reason: string; restMs: number }) => void;
  /** Test seam for the budget's clock. */
  now?: () => number;
}

/**
 * An ordered chain of providers, tried until one answers.
 *
 * Two links is the shape this started as and still the common one; a third
 * exists because the primary here answers 429 on most requests and a single
 * spare is then not a spare at all. Order is cheapest-first: the chain spends
 * the free tier before the paid one, and a link is only reached when every
 * link before it failed in a way a different provider could survive.
 *
 * When the request names a budget (`timeoutMs`), a link may spend at most
 * half of what is left, and the last link all of it: with 30 s the primary
 * gets 15 s and a slow primary can no longer spend the time the spare needed.
 * Half rather than an equal share, because the links are in order of
 * preference: on the narrator corpus the primary verified 85-90% and the
 * spare 55% (2026-10-04), and an equal split with a dead third link left the
 * primary 10 s.
 */
export class LlmProviderChainV1 implements LlmProvider {
  constructor(
    private readonly links: ReadonlyArray<NamedLlmProviderV1>,
    private readonly options: FallbackLlmProviderOptions = {},
  ) {
    if (links.length === 0) throw new Error('An LLM chain needs at least one provider');
  }

  async generate(request: LlmRequest): Promise<LlmResponse> {
    const now = this.options.now ?? Date.now;
    const rest = this.options.rest;
    const awake = rest ? this.links.filter((link) => !rest.resting(link.label)) : this.links;
    // Every link resting is no reason to answer nobody: ask them all anyway.
    const links = awake.length > 0 ? awake : this.links;
    const deadline = request.timeoutMs === undefined ? null : now() + request.timeoutMs;

    const failures: Array<{ label: string; error: unknown }> = [];
    for (const [index, link] of links.entries()) {
      let share: number | null = null;
      if (deadline !== null) {
        const left = deadline - now();
        if (left <= 0) {
          // The links not reached are named, so the exhausted error does not
          // read as though they had been asked and failed on their own.
          for (const untried of links.slice(index)) {
            failures.push({ label: untried.label, error: new Error('not asked: the budget was spent') });
          }
          break;
        }
        share = Math.max(1, index === links.length - 1 ? left : Math.floor(left / 2));
      }
      if (index > 0) {
        this.options.onFallover?.({
          from: links[index - 1]!.label,
          to: link.label,
          reason: messageOf(failures[failures.length - 1]?.error),
        });
      }
      try {
        return share === null
          ? await link.provider.generate(request)
          : await withinShareV1(link.provider.generate({ ...request, timeoutMs: share }), share);
      } catch (error) {
        // A request the NEXT provider would reject identically is rethrown
        // as-is, so the caller sees the real cause rather than a second symptom.
        if (!shouldFallOverV1(error)) throw error;
        if (rest && linkCannotServeV1(error)) {
          rest.rest(link.label, LLM_LINK_REST_MS_V1);
          this.options.onRest?.({ label: link.label, reason: messageOf(error), restMs: LLM_LINK_REST_MS_V1 });
        }
        failures.push({ label: link.label, error });
      }
    }
    throw new LlmChainExhaustedError(failures);
  }
}

/** The two-link chain, kept as its own name because that is how most callers
 * and every existing test describe it. */
export class FallbackLlmProvider extends LlmProviderChainV1 {
  constructor(
    primary: NamedLlmProviderV1,
    fallback: NamedLlmProviderV1,
    options: FallbackLlmProviderOptions = {},
  ) {
    super([primary, fallback], options);
  }
}
