import { partnerFetch } from '@mioagent/security/httpAllowlist';
import { stableHashV1, type HashV1 } from '@mioagent/route-domain';
import {
  VENICE_BASE_URL_V1,
  VENICE_HOST_V1,
  VENICE_PATHS_V1,
  VENICE_PRIVACY_VALUES_V1,
  VENICE_TIMEOUT_MS_DEFAULT_V1,
} from './pinned-config.js';

// ---------------------------------------------------------------------------
// T66A — the Venice API adapter.
//
// Every request goes through `partnerFetch`, so the host allowlist and a
// bounded timeout apply to all of them, and every path comes from
// VENICE_PATHS_V1 — no caller composes a URL.
//
// TWO THINGS THIS MODULE NEVER DOES.
//
//   1. It never puts the API key anywhere but the Authorization header. The
//      key is not in a request hash, not in a URL, not in an error string, and
//      `redactVeniceTextV1` scrubs it out of provider messages before they can
//      reach a log.
//
//   2. It never hashes, stores, returns or logs prompt or completion TEXT.
//      `runInference` takes the messages, sends them, and hands back the
//      completion to exactly one caller. The `responseHash` it computes is
//      over the response METADATA — model, usage, cost, finish reason — and
//      deliberately not over the text, so a stored hash cannot be used to
//      confirm a guessed completion.
//
// Like the OpenSea adapter, this one refuses to interpret. It reads the
// response, checks it against the pinned constants, and hands back either a
// typed observation or a reason. It never repairs a field and never
// substitutes a default for a missing one.
// ---------------------------------------------------------------------------

export type VeniceGatewayReasonV1 =
  | 'not_configured'
  | 'unauthorized'
  | 'not_found'
  | 'rate_limited'
  | 'payment_required'
  | 'provider_unavailable'
  | 'provider_timeout'
  | 'provider_invalid_response'
  | 'model_not_allowlisted'
  | 'model_offline'
  | 'no_text_models'
  | 'content_filtered';

export interface VeniceGatewayConfigV1 {
  apiKey: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** One text model, as observed. Nullable fields mean the provider did not say;
 * none of them is filled in with a guess. */
export interface VeniceObservedModelV1 {
  modelId: string;
  modelName: string;
  modelVersion: string | null;
  description: string | null;
  privacyMode: 'private' | 'anonymized' | 'unknown';
  offline: boolean;
  contextTokens: number | null;
  maxCompletionTokens: number | null;
  inputUsdPerMillion: string | null;
  outputUsdPerMillion: string | null;
  supportsToolCalling: boolean | null;
  supportsResponseSchema: boolean | null;
  supportsReasoning: boolean | null;
  supportsWebSearch: boolean | null;
  supportsVision: boolean | null;
  optimizedForCode: boolean | null;
  quantization: string | null;
  traits: string[];
}

export interface VeniceCatalogueV1 {
  models: VeniceObservedModelV1[];
  requestHash: HashV1;
  responseHash: HashV1;
  observedAt: string;
}

/** The result of one inference call. `text` is handed to exactly one caller and
 * is not part of any hash computed here. */
export interface VeniceInferenceResultV1 {
  text: string;
  modelId: string;
  finishReason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'unknown';
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  /** What Venice says this call cost, when it says. Null is not zero. */
  actualCostUsd: string | null;
  latencyMs: number;
  /** Over response METADATA only — never over `text`. */
  responseHash: HashV1;
  observedAt: string;
}

export type VeniceGatewayResultV1<T> =
  | { ok: true; value: T }
  | { ok: false; reason: VeniceGatewayReasonV1; detail?: string };

export interface VeniceGatewayV1 {
  /** The text-model catalogue: capabilities, context, privacy mode, pricing. */
  readTextModels(input: { now: Date }): Promise<VeniceGatewayResultV1<VeniceCatalogueV1>>;
  /**
   * One completion from ONE model.
   *
   * `modelId` is checked against the caller-supplied allowlist here as well as
   * upstream — the last thing before the network call re-checks it, so a bug
   * in a route handler cannot send a prompt to an unlisted model.
   */
  runInference(input: {
    modelId: string;
    allowlist: readonly string[];
    systemText: string | null;
    messages: readonly { role: 'user' | 'assistant'; text: string }[];
    maxCompletionTokens: number;
    temperature: number | null;
    responseSchema: Record<string, unknown> | null;
    webSearch: boolean;
    now: Date;
  }): Promise<VeniceGatewayResultV1<VeniceInferenceResultV1>>;
}

/**
 * Removes the key and any URL from provider text before it can reach a log.
 *
 * Same shape as the Alchemy redaction added in T65.2: the provider's own words
 * are the only thing that makes a failure diagnosable, and they are only safe
 * to keep once the credential is out of them.
 */
export function redactVeniceTextV1(text: string, apiKey: string): string {
  const withoutKey = apiKey.length > 0 ? text.split(apiKey).join('<redacted>') : text;
  return withoutKey.replace(/https?:\/\/\S+/gi, '<url>').slice(0, 300);
}

function reasonForStatusV1(status: number): VeniceGatewayReasonV1 {
  if (status === 401 || status === 403) return 'unauthorized';
  if (status === 402) return 'payment_required';
  if (status === 404) return 'not_found';
  if (status === 429) return 'rate_limited';
  return 'provider_unavailable';
}

/** A finite non-negative integer, or null. Never NaN, never a coerced string
 * that happened to parse. */
function readPositiveInt(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const truncated = Math.trunc(value);
  return truncated > 0 ? truncated : null;
}

function readNonNegativeInt(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const truncated = Math.trunc(value);
  return truncated >= 0 ? truncated : null;
}

function readBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function readShortString(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.slice(0, max) : null;
}

/**
 * A USD rate as an exact decimal string.
 *
 * Venice publishes these as JSON numbers. `toFixed(12)` fixes the scale before
 * anything downstream does arithmetic, so a rate like 1e-7 becomes
 * "0.000000100000" rather than the string "1e-7" that no decimal parser in
 * this repository accepts.
 */
export function readUsdRateV1(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return value.toFixed(12).replace(/0+$/, '').replace(/\.$/, '') || '0';
}

function readPrivacyModeV1(value: unknown): 'private' | 'anonymized' | 'unknown' {
  if (typeof value !== 'string') return 'unknown';
  const normalized = value.trim().toLowerCase();
  return (VENICE_PRIVACY_VALUES_V1 as readonly string[]).includes(normalized)
    ? (normalized as 'private' | 'anonymized')
    : 'unknown';
}

function readFinishReasonV1(value: unknown): VeniceInferenceResultV1['finishReason'] {
  if (value === 'stop' || value === 'length' || value === 'tool_calls' || value === 'content_filter') {
    return value;
  }
  return 'unknown';
}

/**
 * Turns one catalogue entry into an observation, or drops it.
 *
 * Returns null for anything that cannot be read as a usable text model. A
 * dropped entry is not an error: Venice's catalogue legitimately carries model
 * types this family cannot price or bound, and refusing them one by one is
 * the point.
 */
export function observeVeniceModelV1(entry: unknown): VeniceObservedModelV1 | null {
  if (!entry || typeof entry !== 'object') return null;
  const model = entry as Record<string, unknown>;

  const modelId = readShortString(model.id, 120);
  if (modelId === null || !/^[a-zA-Z0-9._-]+$/.test(modelId)) return null;
  // The type is checked by value even though the request already filtered on
  // it. A response naming another type is refused, never reinterpreted.
  const type = readShortString(model.type, 40);
  if (type !== null && type.toLowerCase() !== 'text') return null;

  const spec = (model.model_spec ?? {}) as Record<string, unknown>;
  const capabilities = (spec.capabilities ?? {}) as Record<string, unknown>;
  const pricing = (spec.pricing ?? {}) as Record<string, unknown>;
  const input = (pricing.input ?? {}) as Record<string, unknown>;
  const output = (pricing.output ?? {}) as Record<string, unknown>;

  const contextTokens =
    readPositiveInt(spec.availableContextTokens) ?? readPositiveInt(model.context_length);
  const maxCompletionTokens = readPositiveInt(spec.maxCompletionTokens);

  return {
    modelId,
    modelName: readShortString(model.name, 200) ?? modelId,
    // Venice does not publish a separate version field; the traits list is
    // where a build marker shows up when there is one. Null when absent —
    // never the id repeated as if it were a version.
    modelVersion: readShortString(spec.modelSource, 120),
    description: readShortString(model.description, 400) ?? readShortString(spec.description, 400),
    privacyMode: readPrivacyModeV1(spec.privacy),
    offline: model.offline === true,
    contextTokens,
    // A model that does not state a completion bound is bounded by its
    // context, which is the only defensible fallback: it is the provider's own
    // hard limit rather than a number chosen here.
    maxCompletionTokens: maxCompletionTokens ?? contextTokens,
    inputUsdPerMillion: readUsdRateV1(input.usd),
    outputUsdPerMillion: readUsdRateV1(output.usd),
    supportsToolCalling: readBoolean(capabilities.supportsFunctionCalling),
    supportsResponseSchema: readBoolean(capabilities.supportsResponseSchema),
    supportsReasoning: readBoolean(capabilities.supportsReasoning),
    supportsWebSearch: readBoolean(capabilities.supportsWebSearch),
    supportsVision: readBoolean(capabilities.supportsVision),
    optimizedForCode: readBoolean(capabilities.optimizedForCode),
    quantization: readShortString(capabilities.quantization, 60),
    traits: Array.isArray(spec.traits)
      ? spec.traits.filter((trait): trait is string => typeof trait === 'string').slice(0, 20)
      : [],
  };
}

export function createVeniceGatewayV1(config: VeniceGatewayConfigV1): VeniceGatewayV1 {
  const timeoutMs = config.timeoutMs ?? VENICE_TIMEOUT_MS_DEFAULT_V1;

  async function call(
    path: string,
    init: RequestInit,
  ): Promise<VeniceGatewayResultV1<{ body: unknown; requestHash: HashV1 }>> {
    if (config.apiKey.length === 0) return { ok: false, reason: 'not_configured' };
    // The key never enters the request hash — the hash is evidence, and
    // evidence must be safe to store and show.
    const requestHash = stableHashV1('ai-venice-request/v1', {
      host: VENICE_HOST_V1,
      path,
      method: init.method ?? 'GET',
    });
    let response: Response;
    try {
      response = await partnerFetch(
        `${VENICE_BASE_URL_V1}${path}`,
        {
          ...init,
          headers: {
            ...(init.headers as Record<string, string> | undefined),
            authorization: `Bearer ${config.apiKey}`,
            accept: 'application/json',
          },
        },
        { timeoutMs, fetchImpl: config.fetchImpl },
      );
    } catch (error) {
      const name = error instanceof Error ? error.name : '';
      if (name === 'TimeoutError' || name === 'AbortError') return { ok: false, reason: 'provider_timeout' };
      return { ok: false, reason: 'provider_unavailable' };
    }
    if (!response.ok) {
      let detail: string | undefined;
      try {
        detail = redactVeniceTextV1(await response.text(), config.apiKey);
      } catch {
        detail = undefined;
      }
      return { ok: false, reason: reasonForStatusV1(response.status), detail };
    }
    try {
      return { ok: true, value: { body: await response.json(), requestHash } };
    } catch {
      return { ok: false, reason: 'provider_invalid_response' };
    }
  }

  return {
    async readTextModels(input) {
      const result = await call(VENICE_PATHS_V1.textModels(), { method: 'GET' });
      if (!result.ok) return result;
      const body = result.value.body as { data?: unknown };
      if (!Array.isArray(body.data)) return { ok: false, reason: 'provider_invalid_response' };

      const models: VeniceObservedModelV1[] = [];
      for (const entry of body.data) {
        const observed = observeVeniceModelV1(entry);
        if (observed !== null) models.push(observed);
      }
      if (models.length === 0) return { ok: false, reason: 'no_text_models' };

      return {
        ok: true,
        value: {
          models,
          requestHash: result.value.requestHash,
          // Over the catalogue as observed, not the raw body: this is what the
          // scoring actually read, and it is the thing a later run must be
          // comparable against.
          responseHash: stableHashV1('ai-venice-catalogue/v1', models),
          observedAt: input.now.toISOString(),
        },
      };
    },

    async runInference(input) {
      // The last check before the prompt leaves the process. Upstream code
      // already filtered the catalogue; this exists so a mistake in a route
      // handler cannot turn into a prompt sent to an unlisted model.
      if (!input.allowlist.includes(input.modelId)) {
        return { ok: false, reason: 'model_not_allowlisted' };
      }

      const messages: { role: string; content: string }[] = [];
      if (input.systemText !== null) messages.push({ role: 'system', content: input.systemText });
      for (const message of input.messages) messages.push({ role: message.role, content: message.text });

      const body: Record<string, unknown> = {
        model: input.modelId,
        messages,
        max_completion_tokens: input.maxCompletionTokens,
        stream: false,
        venice_parameters: {
          // Off unless the intent asked for it: web search sends parts of the
          // prompt to a third party, which is not a default for a family whose
          // whole claim is private inference.
          enable_web_search: input.webSearch ? 'auto' : 'off',
        },
      };
      if (input.temperature !== null) body.temperature = input.temperature;
      if (input.responseSchema !== null) {
        body.response_format = { type: 'json_schema', json_schema: input.responseSchema };
      }

      const startedAt = Date.now();
      const result = await call(VENICE_PATHS_V1.chatCompletions(), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const latencyMs = Math.max(0, Date.now() - startedAt);
      if (!result.ok) return result;

      const payload = result.value.body as Record<string, unknown>;
      const choices = payload.choices;
      if (!Array.isArray(choices) || choices.length === 0) {
        return { ok: false, reason: 'provider_invalid_response' };
      }
      const choice = choices[0] as Record<string, unknown>;
      const message = (choice.message ?? {}) as Record<string, unknown>;
      const text = typeof message.content === 'string' ? message.content : null;
      const finishReason = readFinishReasonV1(choice.finish_reason);
      if (text === null) {
        // A filtered completion is a RESULT the user is told about, not a
        // transport failure to retry.
        return finishReason === 'content_filter'
          ? { ok: false, reason: 'content_filtered' }
          : { ok: false, reason: 'provider_invalid_response' };
      }

      // The model that answered, as the response names it. When it disagrees
      // with the one that was asked for, the request is refused rather than
      // recorded under the wrong name — a proof that says "gpt-x answered"
      // must mean gpt-x answered.
      const answeredModel = readShortString(payload.model, 120);
      if (answeredModel !== null && answeredModel !== input.modelId) {
        return { ok: false, reason: 'provider_invalid_response', detail: 'model mismatch' };
      }

      const usage = (payload.usage ?? {}) as Record<string, unknown>;
      const cost = (payload.cost ?? {}) as Record<string, unknown>;
      const promptTokens = readNonNegativeInt(usage.prompt_tokens);
      const completionTokens = readNonNegativeInt(usage.completion_tokens);

      const metadata = {
        modelId: input.modelId,
        finishReason,
        promptTokens,
        completionTokens,
        totalTokens: readNonNegativeInt(usage.total_tokens),
        actualCostUsd: readUsdRateV1(cost.usd),
        // The LENGTH of the completion, which is shape rather than content.
        // The text itself is deliberately absent: a hash over it would let
        // anyone holding the proof confirm a guessed answer.
        completionChars: text.length,
      };

      return {
        ok: true,
        value: {
          text,
          modelId: input.modelId,
          finishReason,
          promptTokens,
          completionTokens,
          totalTokens: metadata.totalTokens,
          actualCostUsd: metadata.actualCostUsd,
          latencyMs,
          responseHash: stableHashV1('ai-venice-inference-response/v1', metadata),
          observedAt: input.now.toISOString(),
        },
      };
    },
  };
}
