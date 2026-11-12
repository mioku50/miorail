// ---------------------------------------------------------------------------
// What browsers say about the page's script rule (audit AUTH-7).
//
// The rule for scripts ("the page's own files only") has been sent as
// report-only since 2026-11-10, to be enforced once it had been watched in
// real browsers. It named nowhere to report to, so there was nothing to watch:
// a violation showed only in the console of the person it happened to.
//
// The rule now names POST /api/public/csp-report. What is kept of a report is
// what answers "which script, from where, on which page": the directive, the
// origin that was blocked, the origin of the file that asked, and the first
// segment of the page's path. Never an address, a user agent, a full URL, a
// query or a sample of the script.
// ---------------------------------------------------------------------------

export interface CspReportFactV1 {
  directive: string;
  /** `inline`, `eval`, a scheme, or an origin. */
  blocked: string;
  /** The origin of the file that asked, or `none`. */
  source: string;
  /** The first segment of the page's path: `/`, `/stocks`, `/still`. */
  page: string;
  disposition: 'report' | 'enforce';
}

/** Reports read from one request at most: a browser batches a few, an abuser many. */
export const CSP_REPORTS_PER_REQUEST_V1 = 10;
/** Distinct reports written to the journal in one hour; the rest are counted, not written. */
export const CSP_REPORT_LINES_PER_HOUR_V1 = 40;

// The directives a browser can name. A word that is not one of them is not a report.
const DIRECTIVES_V1 = new Set([
  'default-src', 'script-src', 'script-src-elem', 'script-src-attr', 'worker-src', 'child-src', 'frame-src',
  'connect-src', 'style-src', 'style-src-elem', 'style-src-attr', 'img-src', 'font-src', 'media-src',
  'manifest-src', 'object-src', 'base-uri', 'form-action', 'frame-ancestors',
  'require-trusted-types-for', 'trusted-types',
]);
const KEYWORDS_V1 = new Set(['inline', 'eval', 'wasm-eval', 'self', 'data', 'blob', 'about', 'trusted-types-policy', 'trusted-types-sink']);
const HOST_V1 = /^[a-z0-9.-]{1,80}(?::[0-9]{1,5})?$/;
const SCHEME_V1 = /^[a-z][a-z0-9+.-]{1,30}$/;

/** A blocked or asking address reduced to what identifies its origin, and nothing more. */
export function cspPlaceV1(value: unknown): string {
  if (typeof value !== 'string') return 'none';
  const text = value.trim().toLowerCase();
  if (text.length === 0) return 'none';
  if (text.length > 2_000) return 'other';
  if (KEYWORDS_V1.has(text)) return text;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return 'other';
  }
  const scheme = url.protocol.slice(0, -1);
  if (!SCHEME_V1.test(scheme)) return 'other';
  if (scheme === 'http' || scheme === 'https') return HOST_V1.test(url.host) ? `${scheme}://${url.host}` : 'other';
  // A Chrome extension's id is the extension's, the same for everyone who installed it: it says which
  // wallet injected the script. Firefox gives each installation its own random host, which says who.
  if (scheme === 'chrome-extension') return /^[a-p]{32}$/.test(url.host) ? `chrome-extension://${url.host}` : 'chrome-extension';
  return scheme;
}

/** The first segment of the page's path. A share code or an address further along is not kept. */
export function cspPageV1(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2_000) return '/other';
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return '/other';
  }
  const first = url.pathname.split('/')[1] ?? '';
  if (first === '') return '/';
  return /^[a-z0-9-]{1,24}$/i.test(first) ? `/${first.toLowerCase()}` : '/other';
}

function factV1(report: Record<string, unknown>, names: { directive: string[]; blocked: string; source: string; page: string }): CspReportFactV1 | null {
  const stated = names.directive.map((name) => report[name]).find((value) => typeof value === 'string' && value.length > 0);
  // `violated-directive` may carry the whole directive; its name is the first word.
  const directive = typeof stated === 'string' ? (stated.trim().toLowerCase().split(/\s+/)[0] ?? '') : '';
  if (!DIRECTIVES_V1.has(directive)) return null;
  return {
    directive,
    blocked: cspPlaceV1(report[names.blocked]),
    source: cspPlaceV1(report[names.source]),
    page: cspPageV1(report[names.page]),
    disposition: report.disposition === 'enforce' ? 'enforce' : 'report',
  };
}

const isRecordV1 = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The facts in one request body, in either shape a browser sends: `{ "csp-report": {…} }` for
 * `report-uri`, or a list of `{ type: "csp-violation", body: {…} }` for the Reporting API.
 * Anything else is no report, and is ignored rather than refused: the sender is a browser.
 */
export function cspReportFactsV1(body: unknown): CspReportFactV1[] {
  const facts: CspReportFactV1[] = [];
  if (isRecordV1(body) && isRecordV1(body['csp-report'])) {
    const fact = factV1(body['csp-report'], {
      directive: ['effective-directive', 'violated-directive'],
      blocked: 'blocked-uri',
      source: 'source-file',
      page: 'document-uri',
    });
    if (fact) facts.push(fact);
    return facts;
  }
  if (!Array.isArray(body)) return facts;
  for (const entry of body.slice(0, CSP_REPORTS_PER_REQUEST_V1)) {
    if (!isRecordV1(entry) || entry.type !== 'csp-violation' || !isRecordV1(entry.body)) continue;
    const fact = factV1(entry.body, {
      directive: ['effectiveDirective'],
      blocked: 'blockedURL',
      source: 'sourceFile',
      page: 'documentURL',
    });
    if (fact) facts.push(fact);
  }
  return facts;
}

export interface CspReportRecorderV1 {
  /** True when the fact was written: its first sighting this hour, within the hour's budget. */
  record(fact: CspReportFactV1): boolean;
}

/**
 * Writes each distinct fact once an hour. A page that breaks the rule breaks it on every load, so the
 * journal needs the fact, not a line per visitor; and an endpoint anyone can post to must not be a way
 * to fill a disk.
 */
export function createCspReportRecorderV1(input: {
  write: (fact: CspReportFactV1) => void;
  nowMs?: () => number;
  linesPerHour?: number;
}): CspReportRecorderV1 {
  const nowMs = input.nowMs ?? Date.now;
  const budget = input.linesPerHour ?? CSP_REPORT_LINES_PER_HOUR_V1;
  let hour = -1;
  let seen = new Set<string>();
  return {
    record(fact) {
      const current = Math.floor(nowMs() / 3_600_000);
      if (current !== hour) {
        hour = current;
        seen = new Set();
      }
      const key = `${fact.disposition}|${fact.directive}|${fact.blocked}|${fact.source}|${fact.page}`;
      if (seen.has(key) || seen.size >= budget) return false;
      seen.add(key);
      input.write(fact);
      return true;
    },
  };
}
