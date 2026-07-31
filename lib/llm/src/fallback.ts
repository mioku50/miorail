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

/** Raised only when BOTH providers failed. It names both, because "OpenRouter
 * returned 429" on its own sends the operator to investigate a provider that
 * was never the primary. */
export class LlmChainExhaustedError extends Error {
  readonly primaryError: unknown;
  readonly fallbackError: unknown;

  constructor(primary: { label: string; error: unknown }, fallback: { label: string; error: unknown }) {
    super(
      `Every configured LLM provider failed. ` +
        `${primary.label}: ${messageOf(primary.error)} | ` +
        `${fallback.label}: ${messageOf(fallback.error)}`,
    );
    this.name = 'LlmChainExhaustedError';
    this.primaryError = primary.error;
    this.fallbackError = fallback.error;
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

export class FallbackLlmProvider implements LlmProvider {
  constructor(
    private readonly primary: NamedLlmProviderV1,
    private readonly fallback: NamedLlmProviderV1,
    private readonly options: FallbackLlmProviderOptions = {},
  ) {}

  async generate(request: LlmRequest): Promise<LlmResponse> {
    let primaryError: unknown;
    try {
      return await this.primary.provider.generate(request);
    } catch (error) {
      // A request that the fallback would reject identically is rethrown as-is,
      // so the caller sees the real cause rather than a second symptom.
      if (!shouldFallOverV1(error)) throw error;
      primaryError = error;
    }

    this.options.onFallover?.({
      from: this.primary.label,
      to: this.fallback.label,
      reason: messageOf(primaryError),
    });

    try {
      return await this.fallback.provider.generate(request);
    } catch (fallbackError) {
      throw new LlmChainExhaustedError(
        { label: this.primary.label, error: primaryError },
        { label: this.fallback.label, error: fallbackError },
      );
    }
  }
}
