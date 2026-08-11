import { LlmHttpError } from './openai.js';
import { LlmProvider, LlmRequest, LlmResponse } from './types.js';

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
}

/**
 * An ordered chain of providers, tried until one answers.
 *
 * Two links is the shape this started as and still the common one; a third
 * exists because the primary here answers 429 on most requests and a single
 * spare is then not a spare at all. Order is cheapest-first: the chain spends
 * the free tier before the paid one, and a link is only reached when every
 * link before it failed in a way a different provider could survive.
 */
export class LlmProviderChainV1 implements LlmProvider {
  constructor(
    private readonly links: ReadonlyArray<NamedLlmProviderV1>,
    private readonly options: FallbackLlmProviderOptions = {},
  ) {
    if (links.length === 0) throw new Error('An LLM chain needs at least one provider');
  }

  async generate(request: LlmRequest): Promise<LlmResponse> {
    const failures: Array<{ label: string; error: unknown }> = [];
    for (const [index, link] of this.links.entries()) {
      if (index > 0) {
        this.options.onFallover?.({
          from: this.links[index - 1]!.label,
          to: link.label,
          reason: messageOf(failures[failures.length - 1]?.error),
        });
      }
      try {
        return await link.provider.generate(request);
      } catch (error) {
        // A request the NEXT provider would reject identically is rethrown
        // as-is, so the caller sees the real cause rather than a second symptom.
        if (!shouldFallOverV1(error)) throw error;
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
