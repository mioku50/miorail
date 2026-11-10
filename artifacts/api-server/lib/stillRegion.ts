import { readFileSync, statSync } from 'node:fs';
import type { Request } from 'express';
import { logger } from '@mioagent/utils';
import { STILL_ELIGIBILITY_STATEMENT_V1, STILL_ELIGIBILITY_VERSION_V1, STILL_REGION_ATTRIBUTION_V1, STILL_REGION_OPEN_V1 } from '@mioagent/still-engine/eligibility';
import { parseStillRegionTableV1, stillRegionCountryV1, type StillRegionTableV1 } from './stillRegionTable.js';

// ---------------------------------------------------------------------------
// Still is not offered in the United States or to US persons (operator,
// 2026-11-10). Before the server hands out the calls of a NEW position (a
// loan, a Spend purchase, a stock bought through a swap or a stock page) it
// asks two things:
//
//   1. Where the request comes from: the country the browser's IP address is
//      registered in, by DB-IP's database. The United States and its
//      territories are refused. An address that cannot be placed is refused
//      too: an assistant's server, Still's own card in a chat, a private or
//      reserved address, or no database at all. This is the one check here a
//      person cannot answer for themselves, so it fails closed.
//   2. Whether the person confirmed, in this sign-in, that they are not a US
//      person and not in the United States: a US citizen abroad is a US person,
//      and no IP address says so.
//
// Nothing that closes a position is gated: repaying, taking collateral back,
// selling, sending a stock, reading. A person who moved, or whose VPN ends in
// the United States, can always get out. A VPN gets around the first check, as
// it does at every interface that has one; the second is the person's own word.
// ---------------------------------------------------------------------------

declare module 'express-session' {
  interface SessionData {
    /** The sentence the signed-in wallet confirmed, and when; a new sign-in starts without one. */
    stillEligibility?: { version: string; wallet: string; confirmedAt: string };
  }
}

export const STILL_REGION_TABLE_PATH_DEFAULT_V1 = '/var/lib/miorail-region/region-v1.bin';
/** The United States and its inhabited territories, and the minor outlying islands. */
export const STILL_RESTRICTED_COUNTRIES_DEFAULT_V1 = ['US', 'PR', 'GU', 'VI', 'AS', 'MP', 'UM'] as const;
const CONFIRMATION_LIFETIME_MS_V1 = 30 * 24 * 60 * 60 * 1000;
const MISSING_RETRY_MS_V1 = 60_000;
const RECHECK_MS_V1 = 60 * 60 * 1000;

export type StillRegionV1 =
  | { state: 'allowed'; country: string }
  | { state: 'restricted'; country: string }
  | { state: 'unchecked'; reason: 'no_table' | 'no_address' | 'unknown_address' };

interface LoadedTableV1 { table: StillRegionTableV1 | null; path: string | null; mtimeMs: number | null; checkedAt: number; failed: boolean }
let loadedV1: LoadedTableV1 = { table: null, path: null, mtimeMs: null, checkedAt: 0, failed: false };

/** The table at `path`, read again when the file changes (checked once an hour) and, while it is
 * missing or unreadable, asked for again once a minute. A table that loaded stays in use until a
 * newer one loads: a broken update never takes the check away. */
export function loadStillRegionTableV1(path: string, now = Date.now()): StillRegionTableV1 | null {
  if (loadedV1.path !== path) loadedV1 = { table: null, path, mtimeMs: null, checkedAt: 0, failed: false };
  if (now - loadedV1.checkedAt < (loadedV1.table ? RECHECK_MS_V1 : MISSING_RETRY_MS_V1)) return loadedV1.table;
  loadedV1.checkedAt = now;
  try {
    const mtimeMs = statSync(path).mtimeMs;
    if (loadedV1.table && mtimeMs === loadedV1.mtimeMs) return loadedV1.table;
    const table = parseStillRegionTableV1(readFileSync(path));
    loadedV1 = { table, path, mtimeMs, checkedAt: now, failed: false };
    logger.info('Still region table loaded', { month: table.month, ipv4Ranges: table.starts4.length, ipv6Ranges: table.starts6High.length });
  } catch (cause) {
    if (!loadedV1.failed) logger.warn('Still region table unreadable', { errorName: cause instanceof Error ? cause.name : typeof cause, kept: loadedV1.table !== null });
    loadedV1.failed = true;
  }
  return loadedV1.table;
}

export const stillRegionRuntimeV1 = {
  /** On in production unless STILL_REGION_GATE_V1=off; elsewhere only with STILL_REGION_GATE_V1=on. */
  enabled: (): boolean => {
    const value = process.env.STILL_REGION_GATE_V1?.trim().toLowerCase();
    return value === 'on' || (value !== 'off' && process.env.NODE_ENV === 'production');
  },
  restricted: (): ReadonlySet<string> => {
    const listed = (process.env.STILL_RESTRICTED_COUNTRIES_V1 ?? '').split(',').map(code => code.trim().toUpperCase()).filter(code => /^[A-Z]{2}$/.test(code));
    // The United States is never left out by a list that forgets it.
    return new Set([...(listed.length ? listed : STILL_RESTRICTED_COUNTRIES_DEFAULT_V1), 'US']);
  },
  table: (): StillRegionTableV1 | null => loadStillRegionTableV1(process.env.STILL_REGION_TABLE_PATH_V1?.trim() || STILL_REGION_TABLE_PATH_DEFAULT_V1),
  now: (): number => Date.now(),
};

/** Where a request comes from: the address Express read through the one proxy it trusts (nginx). */
export function stillRegionOfRequestV1(req: Pick<Request, 'ip'>): StillRegionV1 {
  const address = typeof req.ip === 'string' ? req.ip.trim() : '';
  if (!address) return { state: 'unchecked', reason: 'no_address' };
  const table = stillRegionRuntimeV1.table();
  if (!table) return { state: 'unchecked', reason: 'no_table' };
  const country = stillRegionCountryV1(table, address);
  if (!country) return { state: 'unchecked', reason: 'unknown_address' };
  return stillRegionRuntimeV1.restricted().has(country) ? { state: 'restricted', country } : { state: 'allowed', country };
}

type SessionRequestV1 = Pick<Request, 'ip'> & { session?: { user?: { address?: string }; stillEligibility?: { version: string; wallet: string; confirmedAt: string } } };

/** The confirmation this sign-in gave, for its own wallet and the current sentence, in the last 30 days. */
export function stillEligibilityConfirmedV1(req: SessionRequestV1): { confirmedAt: string } | null {
  const wallet = req.session?.user?.address?.toLowerCase(), record = req.session?.stillEligibility;
  if (!wallet || !record || record.version !== STILL_ELIGIBILITY_VERSION_V1 || record.wallet !== wallet) return null;
  const at = Date.parse(record.confirmedAt), now = stillRegionRuntimeV1.now();
  return Number.isFinite(at) && at <= now + 60_000 && now - at <= CONFIRMATION_LIFETIME_MS_V1 ? { confirmedAt: record.confirmedAt } : null;
}

export type StillEntryKindV1 = 'loan' | 'purchase' | 'stock_buy';
export type StillEntryRefusalV1 = 'region_restricted' | 'region_unchecked' | 'eligibility_required';
export type StillEntryGateResultV1 = { ok: true } | { ok: false; refusal: StillEntryRefusalV1; detail: string };

const RESTRICTED_DETAIL_V1 = 'Still is not available where you are connecting from. It prepares no new loan, purchase or stock buy for anyone in the United States, '
  + `or for a US person. ${STILL_REGION_OPEN_V1}`;
const NO_ADDRESS_DETAIL_V1 = 'Still checks where a new loan, purchase or stock buy is asked from, and it cannot check that here. '
  + `Open it on miorail.xyz in your own browser. ${STILL_REGION_OPEN_V1}`;
const UNCHECKED_DETAIL_V1 = 'Still could not tell where this request comes from, so it prepares no new loan, purchase or stock buy right now. '
  + `${STILL_REGION_OPEN_V1} Try again later.`;
const CONFIRM_DETAIL_V1 = 'Before Still prepares a new loan, purchase or stock buy, confirm that you are not a US person and not in the United States. '
  + 'Still is not offered to US persons.';

/** Whether this request may be handed the calls of a new position. `confirmation: false` asks only
 * where it comes from: for a step that hands out nothing yet, where the review it leads to asks the rest. */
export function stillEntryGateV1(req: SessionRequestV1, input: { kind: StillEntryKindV1; confirmation: boolean }): StillEntryGateResultV1 {
  if (!stillRegionRuntimeV1.enabled()) return { ok: true };
  const region = stillRegionOfRequestV1(req);
  let refused: { refusal: StillEntryRefusalV1; detail: string } | null = null;
  if (region.state === 'restricted') refused = { refusal: 'region_restricted', detail: RESTRICTED_DETAIL_V1 };
  else if (region.state === 'unchecked') refused = { refusal: 'region_unchecked', detail: region.reason === 'no_address' ? NO_ADDRESS_DETAIL_V1 : UNCHECKED_DETAIL_V1 };
  else if (input.confirmation && !stillEligibilityConfirmedV1(req)) refused = { refusal: 'eligibility_required', detail: CONFIRM_DETAIL_V1 };
  if (!refused) return { ok: true };
  // The country and the kind only: never the address, never the wallet.
  if (refused.refusal !== 'eligibility_required') {
    logger.info('Still entry refused by region', { kind: input.kind, refusal: refused.refusal,
      country: region.state === 'restricted' ? region.country : null, reason: region.state === 'unchecked' ? region.reason : null });
  }
  return { ok: false, ...refused };
}

/** What a page reads before it offers a new position: the region the server sees, and this sign-in's confirmation. */
export function stillEligibilityReadV1(req: SessionRequestV1) {
  const enabled = stillRegionRuntimeV1.enabled(), region = stillRegionOfRequestV1(req), table = stillRegionRuntimeV1.table();
  const confirmed = stillEligibilityConfirmedV1(req);
  return {
    schemaVersion: 'still-eligibility/v1' as const,
    gate: enabled ? 'on' as const : 'off' as const,
    region: region.state === 'unchecked' ? { state: 'unchecked' as const, country: null, reason: region.reason } : { state: region.state, country: region.country, reason: null },
    table: { loaded: table !== null, month: table?.month ?? null },
    signedIn: Boolean(req.session?.user?.address),
    confirmed: confirmed !== null, confirmedAt: confirmed?.confirmedAt ?? null,
    statement: STILL_ELIGIBILITY_STATEMENT_V1, version: STILL_ELIGIBILITY_VERSION_V1,
    restrictedDetail: RESTRICTED_DETAIL_V1, open: STILL_REGION_OPEN_V1, attribution: STILL_REGION_ATTRIBUTION_V1,
  };
}
