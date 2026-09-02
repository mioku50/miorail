import { partnerFetch } from '@mioagent/security/httpAllowlist';

import type { UnderlyingAssetClassV1 } from '@mioagent/route-storage';

// ---------------------------------------------------------------------------
// A second source for the identifier, and the only source for what kind of
// security it is.
//
// The Dinari binding takes a composite FIGI from a catalogue read in the
// SANDBOX environment. Its security fields are real — a FIGI for Apple does not
// vary by environment — but "real because it looks real" is not a standard this
// repository accepts, so every FIGI is put to OpenFIGI, which is the registry
// that issues them, before it becomes an underlying key.
//
// The same response answers a question nothing else could: `securityType` says
// whether the row is a common stock or an exchange-traded product. Miorail's
// asset class was otherwise going to be inferred from a company name, and
// "Trust" appearing in a string is not a fund.
//
// A disagreement is a REFUSAL, not a correction. If OpenFIGI returns a
// different FIGI for that ticker, the two sources disagree about which security
// this is, and binding either one would be choosing a winner on no grounds.
// ---------------------------------------------------------------------------

export const OPENFIGI_MAPPING_URL_V1 = 'https://api.openfigi.com/v3/mapping';

/** Unauthenticated OpenFIGI accepts 10 jobs per request. */
export const OPENFIGI_MAX_JOBS_V1 = 10;

export interface OpenFigiRowV1 {
  ticker: string | null;
  compositeFigi: string | null;
  securityType: string | null;
  securityType2: string | null;
  marketSector: string | null;
}

export type OpenFigiVerdictV1 =
  /** The registry returns the same composite FIGI for this ticker. */
  | { state: 'agrees'; row: OpenFigiRowV1 }
  /** The registry returns a DIFFERENT FIGI. Two sources, one ticker, two
   * securities — binding either is a coin flip. */
  | { state: 'disagrees'; expected: string; found: string[] }
  /** No answer, or no row. Never read as agreement. */
  | { state: 'unknown'; reason: string };

/**
 * What kind of thing this is, from the registry rather than from a name.
 *
 * `Common Stock` is the only value mapped to `equity`; every exchange-traded
 * product, fund and trust is a `fund_share`. Anything else is `other` — this
 * function never returns `unknown`, because a row that answered is not an
 * absence, and `unknown` in this repository means nobody looked.
 */
export function assetClassFromSecurityTypeV1(
  securityType: string | null,
  securityType2: string | null,
): UnderlyingAssetClassV1 {
  const primary = (securityType ?? '').trim().toLowerCase();
  const secondary = (securityType2 ?? '').trim().toLowerCase();
  if (primary === 'common stock' || secondary === 'common stock') return 'equity';
  const fundish = ['etp', 'mutual fund', 'fund', 'trust', 'closed-end fund', 'unit', 'reit'];
  if (fundish.some((word) => primary.includes(word) || secondary.includes(word))) return 'fund_share';
  if (primary.length === 0 && secondary.length === 0) return 'other';
  return 'other';
}

export function openFigiVerdictV1(
  expectedCompositeFigi: string,
  rows: readonly OpenFigiRowV1[],
): OpenFigiVerdictV1 {
  const expected = expectedCompositeFigi.trim().toUpperCase();
  if (rows.length === 0) return { state: 'unknown', reason: 'openfigi returned no row for this ticker' };
  const found = [...new Set(rows.map((row) => (row.compositeFigi ?? '').trim().toUpperCase()).filter(Boolean))];
  const agreeing = rows.find((row) => (row.compositeFigi ?? '').trim().toUpperCase() === expected);
  if (agreeing) return { state: 'agrees', row: agreeing };
  if (found.length === 0) return { state: 'unknown', reason: 'openfigi rows carry no composite FIGI' };
  return { state: 'disagrees', expected, found };
}

export interface OpenFigiJobV1 {
  ticker: string;
  /** `US` unless a row says otherwise. A ticker without an exchange matches
   * every listing of it worldwide, which is how one name becomes four FIGIs. */
  exchCode?: string;
}

export type OpenFigiLookupV1 = Map<string, OpenFigiRowV1[]>;

function parseRowV1(row: Record<string, unknown>): OpenFigiRowV1 {
  const text = (value: unknown) => (typeof value === 'string' && value.length > 0 ? value : null);
  return {
    ticker: text(row.ticker),
    compositeFigi: text(row.compositeFIGI),
    securityType: text(row.securityType),
    securityType2: text(row.securityType2),
    marketSector: text(row.marketSector),
  };
}

/**
 * Tickers to rows, in batches the registry accepts.
 *
 * A batch that fails leaves its tickers ABSENT from the map rather than empty
 * in it: absent is "not looked up", empty is "looked up and not found", and the
 * caller must be able to tell a transport failure from a missing security.
 */
export async function lookupOpenFigiV1(
  jobs: readonly OpenFigiJobV1[],
  options?: { apiKey?: string | null; pauseMs?: number; endpoint?: string },
): Promise<OpenFigiLookupV1> {
  const found: OpenFigiLookupV1 = new Map();
  const endpoint = options?.endpoint ?? OPENFIGI_MAPPING_URL_V1;
  for (let index = 0; index < jobs.length; index += OPENFIGI_MAX_JOBS_V1) {
    const chunk = jobs.slice(index, index + OPENFIGI_MAX_JOBS_V1);
    const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json' };
    if (options?.apiKey) headers['X-OPENFIGI-APIKEY'] = options.apiKey;
    let response: Response;
    try {
      response = await partnerFetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(
          chunk.map((job) => ({
            idType: 'TICKER',
            idValue: job.ticker,
            exchCode: job.exchCode ?? 'US',
          })),
        ),
      });
    } catch {
      continue;
    }
    if (!response.ok) continue;
    const body: unknown = await response.json();
    if (!Array.isArray(body)) continue;
    body.forEach((block, position) => {
      const job = chunk[position];
      if (!job) return;
      const rows = (block as { data?: unknown })?.data;
      found.set(job.ticker, Array.isArray(rows) ? rows.map((row) => parseRowV1(row as Record<string, unknown>)) : []);
    });
    if (index + OPENFIGI_MAX_JOBS_V1 < jobs.length) {
      // 25 requests a minute unauthenticated. Pacing is cheaper than being
      // refused and reading the refusal as "no such security".
      await new Promise((resolve) => setTimeout(resolve, options?.pauseMs ?? 2600));
    }
  }
  return found;
}
