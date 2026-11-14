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

// ---------------------------------------------------------------------------
// Noise cannot hide a real report (audit AUTH-2, 2026-11-14).
//
// The hour's 40 lines were one budget for everyone, and the endpoint takes no
// session: four posts of ten made-up reports at the top of each hour took all
// of it, and a real report after them (a wallet's script the enforced rule now
// stops, so its people cannot sign) left no trace at all, not even a count.
// Each browser extension with its own origin is a distinct fact, so that much
// noise also comes without anyone meaning it.
//
// So one sender (an IPv4 address or an IPv6 /64) writes at most a few lines an
// hour; the last lines of the hour are kept for reports that name Still's own
// origin, the page's own files; and whatever is not written is counted, and the
// count is written as one line when the hour turns.
// ---------------------------------------------------------------------------

/** Distinct lines one sender may write in an hour. */
export const CSP_REPORT_LINES_PER_SENDER_PER_HOUR_V1 = 5;
/** Lines of the hour kept for reports that name one of Still's own origins. */
export const CSP_REPORT_OWN_ORIGIN_RESERVE_V1 = 10;
/** Senders counted in one hour; one past this is counted as not written. */
const CSP_REPORT_SENDERS_PER_HOUR_V1 = 5_000;

/** What an hour did not write: distinct reports refused by the sender's share or by the hour's budget. */
export interface CspReportDroppedV1 {
  hour: string;
  overSenderShare: number;
  overHourBudget: number;
  senders: number;
}

export interface CspReportRecorderV1 {
  /** True when the fact was written: its first sighting this hour, within its sender's share and the hour's budget. */
  record(fact: CspReportFactV1, sender?: string): boolean;
}

/**
 * Writes each distinct fact once an hour. A page that breaks the rule breaks it on every load, so the
 * journal needs the fact, not a line per visitor; and an endpoint anyone can post to must not be a way
 * to fill a disk, nor a way to fill the hour.
 */
export function createCspReportRecorderV1(input: {
  write: (fact: CspReportFactV1) => void;
  /** The hour's count of what was not written, when there is one, as the next hour begins. */
  writeDropped?: (dropped: CspReportDroppedV1) => void;
  nowMs?: () => number;
  linesPerHour?: number;
  linesPerSender?: number;
  /** Origins a report names when it is about Still's own page and files, such as `https://miorail.xyz`. */
  ownOrigins?: readonly string[];
  ownOriginReserve?: number;
}): CspReportRecorderV1 {
  const nowMs = input.nowMs ?? Date.now;
  const budget = input.linesPerHour ?? CSP_REPORT_LINES_PER_HOUR_V1;
  const perSender = input.linesPerSender ?? CSP_REPORT_LINES_PER_SENDER_PER_HOUR_V1;
  const own = new Set(input.ownOrigins ?? []);
  const reserve = Math.min(input.ownOriginReserve ?? (own.size > 0 ? CSP_REPORT_OWN_ORIGIN_RESERVE_V1 : 0), budget);
  let hour = -1;
  let seen = new Set<string>();
  let refused = new Set<string>();
  let bySender = new Map<string, number>();
  let dropped = { overSenderShare: 0, overHourBudget: 0, senders: new Set<string>() };
  const turn = (current: number) => {
    if (hour >= 0 && (dropped.overSenderShare > 0 || dropped.overHourBudget > 0)) {
      input.writeDropped?.({ hour: new Date(hour * 3_600_000).toISOString(), overSenderShare: dropped.overSenderShare,
        overHourBudget: dropped.overHourBudget, senders: dropped.senders.size });
    }
    hour = current;
    seen = new Set();
    refused = new Set();
    bySender = new Map();
    dropped = { overSenderShare: 0, overHourBudget: 0, senders: new Set() };
  };
  return {
    record(fact, sender = 'unknown') {
      const current = Math.floor(nowMs() / 3_600_000);
      if (current !== hour) turn(current);
      const key = `${fact.disposition}|${fact.directive}|${fact.blocked}|${fact.source}|${fact.page}`;
      // A repeat is the same fact from another page load: written once, never counted as lost.
      if (seen.has(key)) return false;
      const ours = own.has(fact.blocked) || own.has(fact.source);
      const room = ours ? budget : budget - reserve;
      const written = bySender.get(sender) ?? 0;
      const reason = written >= perSender || (!bySender.has(sender) && bySender.size >= CSP_REPORT_SENDERS_PER_HOUR_V1) ? 'overSenderShare'
        : seen.size >= room ? 'overHourBudget' : null;
      if (reason) {
        // Each distinct report is counted once, however often it is posted again.
        if (!refused.has(key)) {
          refused.add(key);
          dropped[reason] += 1;
          if (dropped.senders.size < CSP_REPORT_SENDERS_PER_HOUR_V1) dropped.senders.add(sender);
        }
        return false;
      }
      seen.add(key);
      bySender.set(sender, written + 1);
      input.write(fact);
      return true;
    },
  };
}
