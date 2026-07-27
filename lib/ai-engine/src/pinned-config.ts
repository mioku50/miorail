// ---------------------------------------------------------------------------
// T66A — everything the Private AI family refuses to take from a response, an
// environment variable, or a caller.
//
// The host and every path are CONSTANTS here. There is no configurable base
// URL and no way to compose a path from outside this file: a "provider URL"
// setting is precisely the hole through which private prompts get pointed at
// someone else's server, so the setting does not exist.
//
// Venice can tell us what its models cost and what they can do. It cannot tell
// us where to send a prompt.
// ---------------------------------------------------------------------------

export const VENICE_HOST_V1 = 'api.venice.ai' as const;
export const VENICE_BASE_URL_V1 = 'https://api.venice.ai' as const;

/** The pinned Venice v1 paths. Built here so no caller composes one. */
export const VENICE_PATHS_V1 = {
  /** Text models only. The catalogue is filtered by the provider, and filtered
   * again locally — an image or audio model reaching the text path would be a
   * request this family cannot price or bound. */
  textModels: () => '/api/v1/models?type=text',
  chatCompletions: () => '/api/v1/chat/completions',
} as const;

export const VENICE_TIMEOUT_MS_DEFAULT_V1 = 30_000;
/** Catalogue readings older than this are refused as evidence. A price and a
 * capability list are facts with an age. */
export const VENICE_CATALOGUE_TTL_MS_DEFAULT_V1 = 300_000;

/** Venice's own published privacy values. Anything else is `unknown`. */
export const VENICE_PRIVACY_VALUES_V1 = ['private', 'anonymized'] as const;

/**
 * The provider reference recorded on every candidate and every evidence row.
 *
 * `data_provider` rather than a bespoke kind: Venice supplies model metadata
 * and inference, and neither makes it a protocol or a venue.
 */
export const VENICE_PROVIDER_REF_V1 = {
  id: 'venice',
  displayName: 'Venice',
  kind: 'data_provider',
  operator: 'Venice AI',
} as const;

/**
 * Parses MIORAIL_VENICE_MODEL_ALLOWLIST.
 *
 * FAILS CLOSED. An unset or empty allowlist yields an empty list, and an empty
 * list means no model is eligible — not "every model is eligible". A private
 * inference family whose default is "send the prompt to whatever the provider
 * happens to list today" would defeat its own purpose, and an operator adding
 * the variable later is a smaller problem than one who never knew they needed
 * it.
 */
export function parseVeniceModelAllowlistV1(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0 && /^[a-zA-Z0-9._-]+$/.test(entry));
}

/** True when `modelId` is on the parsed allowlist. Compared exactly — no
 * prefix, no wildcard, no case folding beyond the ids themselves. */
export function isAllowlistedVeniceModelV1(modelId: string, allowlist: readonly string[]): boolean {
  return allowlist.includes(modelId);
}
