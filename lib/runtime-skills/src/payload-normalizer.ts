// ---------------------------------------------------------------------------
// One normalizer for every shape a reviewed plugin answers in.
//
// Every reviewed read used to reach into `payload.data` (or `.launches`, or
// `.poolGetPools`) directly, and every one of them had its own idea of what a
// payload looks like. That worked until a provider answered in a shape nobody
// had anticipated, and then the reply was "no readable rows" — a sentence
// about the PROVIDER that was actually a statement about us.
//
// Venice is the case that forced this file. `GET /api/v1/models?type=all`
// returns 265 KB. The HTTP executor sliced the body to 200 KB *before*
// parsing it, so `JSON.parse` threw on a JSON document cut mid-string, the
// catch handed back the raw text, and the read reported that Venice "returned
// no readable model rows" about a response containing 328 of them. Nothing in
// the trace said the payload had been truncated; the only visible artefact was
// a quoted string where an object should have been.
//
// So this module states the rule the reads were missing:
//
//   A payload we could not READ is never reported as a payload with no rows.
//
// `normalizeProviderPayloadV1` returns a discriminated outcome. `rows` returns
// null when it cannot find an array — and the caller must say WHY, using the
// outcome, instead of asserting emptiness.
// ---------------------------------------------------------------------------

export type ProviderPayloadOutcomeV1 =
  /** Parsed to a JSON value we can read. */
  | 'parsed'
  /** The body was not JSON at all (HTML error page, plain text). */
  | 'not_json'
  /** The body was JSON but arrived cut off, so it cannot be parsed. */
  | 'truncated'
  /** There was no body. */
  | 'empty';

export interface NormalizedProviderPayloadV1 {
  outcome: ProviderPayloadOutcomeV1;
  /** The parsed value; null unless `outcome === 'parsed'`. */
  value: unknown;
  /** How many decode layers were peeled: JSON-in-string, MCP envelope, SSE. */
  layers: readonly string[];
  /** Bytes of the original text, before any bounding. */
  byteLength: number;
}

/** Bounded so a hostile payload cannot spin this function. */
const MAX_JSON_STRING_LAYERS_V1 = 5;
const MAX_ENVELOPE_DEPTH_V1 = 6;

/** Envelope keys a provider may wrap its rows in, in the order we unwrap. */
const ENVELOPE_KEYS_V1: readonly string[] = ['data', 'result', 'results', 'payload', 'body', 'response'];

function isRecordV1(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * `{"content":[{"type":"text","text":"…"}]}` — the MCP tool-result envelope.
 * The useful payload is the concatenated text parts, which are themselves JSON.
 */
function mcpContentTextV1(value: unknown): string | null {
  if (!isRecordV1(value) || !Array.isArray(value.content)) return null;
  const parts = value.content
    .filter((part): part is { type: string; text: string } =>
      isRecordV1(part) && part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text);
  return parts.length > 0 ? parts.join('') : null;
}

/**
 * Server-sent events. A provider that streams still ends with one final JSON
 * frame, and that frame — not the incremental ones — is the answer. `[DONE]`
 * is a sentinel, never a payload.
 */
function sseFinalJsonV1(text: string): string | null {
  if (!/^\s*(?:event:|data:)/mu.test(text)) return null;
  const frames = [...text.matchAll(/^data:[ \t]*(.*)$/gmu)]
    .map((match) => match[1].trim())
    .filter((frame) => frame.length > 0 && frame !== '[DONE]');
  for (let index = frames.length - 1; index >= 0; index -= 1) {
    const frame = frames[index];
    if (frame.startsWith('{') || frame.startsWith('[')) return frame;
  }
  return null;
}

/** Is this text a JSON document that was cut short rather than malformed? */
function looksTruncatedJsonV1(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return false;
  const last = trimmed.at(-1);
  return last !== '}' && last !== ']';
}

/**
 * Turn whatever a provider (or an MCP tool) answered with into a JSON value.
 *
 * Accepts, in any combination: a parsed object, a JSON string, a JSON string
 * holding another JSON string, the MCP `content[].text` envelope, and an SSE
 * stream whose final frame is JSON.
 */
export function normalizeProviderPayloadV1(input: unknown): NormalizedProviderPayloadV1 {
  const layers: string[] = [];
  const originalText = typeof input === 'string' ? input : null;
  const byteLength = originalText === null ? 0 : Buffer.byteLength(originalText, 'utf8');

  if (input === null || input === undefined) {
    return { outcome: 'empty', value: null, layers, byteLength };
  }
  if (typeof input === 'string' && input.trim() === '') {
    return { outcome: 'empty', value: null, layers, byteLength };
  }

  let current: unknown = input;
  for (let depth = 0; depth < MAX_JSON_STRING_LAYERS_V1; depth += 1) {
    if (typeof current === 'string') {
      const text = current;
      const sse = sseFinalJsonV1(text);
      if (sse !== null) {
        layers.push('sse');
        current = sse;
        continue;
      }
      try {
        current = JSON.parse(text);
        layers.push('json_string');
        continue;
      } catch {
        return {
          outcome: looksTruncatedJsonV1(text) ? 'truncated' : 'not_json',
          value: null,
          layers,
          byteLength: byteLength || Buffer.byteLength(text, 'utf8'),
        };
      }
    }
    const envelopeText = mcpContentTextV1(current);
    if (envelopeText !== null) {
      layers.push('mcp_content');
      current = envelopeText;
      continue;
    }
    break;
  }

  return { outcome: 'parsed', value: current, layers, byteLength };
}

/**
 * The rows inside a normalized payload.
 *
 * Looks through the common `{data: …}` / `{result: …}` envelopes and, when the
 * caller names them, through provider-specific keys (`launches`, `poolGetPools`).
 * Returns null when no array of objects is reachable — which the caller must
 * report as "this shape has no rows we can read", never as "the provider
 * returned nothing".
 */
export function providerRowsV1(
  value: unknown,
  preferredKeys: readonly string[] = [],
): Record<string, unknown>[] | null {
  const seen = new Set<unknown>();

  const walk = (node: unknown, depth: number): Record<string, unknown>[] | null => {
    if (depth > MAX_ENVELOPE_DEPTH_V1 || node === null || node === undefined) return null;
    if (typeof node === 'object') {
      if (seen.has(node)) return null;
      seen.add(node);
    }
    if (Array.isArray(node)) {
      const rows = node.filter(isRecordV1);
      // A mixed array is not a row set: reporting half of it as "the rows"
      // would silently drop whatever else the provider sent.
      return rows.length > 0 && rows.length === node.length ? rows : null;
    }
    if (!isRecordV1(node)) return null;
    for (const key of [...preferredKeys, ...ENVELOPE_KEYS_V1]) {
      if (!(key in node)) continue;
      const found = walk(node[key], depth + 1);
      if (found) return found;
    }
    return null;
  };

  return walk(value, 0);
}

/**
 * A single record inside a normalized payload — the one-object counterpart of
 * `providerRowsV1`, for endpoints that answer with `{launch: {…}}`.
 */
export function providerRecordV1(
  value: unknown,
  preferredKeys: readonly string[] = [],
): Record<string, unknown> | null {
  const walk = (node: unknown, depth: number): Record<string, unknown> | null => {
    if (depth > MAX_ENVELOPE_DEPTH_V1 || !isRecordV1(node)) return null;
    for (const key of preferredKeys) {
      const nested = node[key];
      if (isRecordV1(nested)) return nested;
    }
    for (const key of ENVELOPE_KEYS_V1) {
      const nested = node[key];
      if (!isRecordV1(nested)) continue;
      // The innermost record wins, and the envelope's own value is the answer
      // when there is nothing deeper. Returning null there is what made
      // `{success, data: {asset, mToken, …}}` look like a payload with no
      // record in it at all.
      return walk(nested, depth + 1) ?? nested;
    }
    return null;
  };
  return walk(value, 0);
}

/** The error code a caller reports when a payload could not be read at all. */
export function providerPayloadErrorCodeV1(outcome: ProviderPayloadOutcomeV1): string | null {
  switch (outcome) {
    case 'parsed':
      return null;
    case 'truncated':
      return 'provider_payload_truncated';
    case 'not_json':
      return 'provider_payload_not_json';
    case 'empty':
      return 'provider_payload_empty';
  }
}

/** One sentence naming what happened, for a reply the user reads. */
export function providerPayloadFailureCopyV1(
  providerDisplayName: string,
  outcome: ProviderPayloadOutcomeV1,
): string {
  switch (outcome) {
    case 'truncated':
      return `${providerDisplayName} answered, but its response reached Miorail cut short, so it could not be read. This is a Miorail limit, not a statement about what ${providerDisplayName} holds.`;
    case 'not_json':
      return `${providerDisplayName} answered with a body that is not JSON, so Miorail could not read it. The sanitized response is in the trace.`;
    case 'empty':
      return `${providerDisplayName} answered with an empty body. Nothing was read and nothing is claimed about its contents.`;
    case 'parsed':
      return `${providerDisplayName} answered and the response was read.`;
  }
}
