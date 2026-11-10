import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { buildStillRegionTableV1, parseStillRegionTableV1, stillRegionCountryV1 } from './stillRegionTable.js';

// ---------------------------------------------------------------------------
// Monthly: DB-IP's free country database (CC BY 4.0), as the region table the
// API reads (stillRegion.ts). Run by miorail-region-table.timer, through
// artifacts/api-server/regionTableUpdate.ts.
//
// DB-IP publishes one file a month, named for the month. This takes the
// current month's, or the month before while the new one is not out yet; a
// table already of that month is left as it is. The download must build a
// table that covers every address, holds as many ranges as a whole database
// does, and places addresses whose country is not in question where they are.
// Anything else leaves the table in place and fails the unit, so the API keeps
// the table it has and the failed unit is reported like any other.
// ---------------------------------------------------------------------------

const SOURCE_V1 = (month: string) => `https://download.db-ip.com/free/dbip-country-lite-${month}.csv.gz`;
const MAX_DOWNLOAD_BYTES_V1 = 64 * 1024 * 1024;
const MAX_CSV_BYTES_V1 = 256 * 1024 * 1024;

/** Addresses whose country does not move: Google's and Level 3's resolvers, and loopback. */
const SANITY_V1: ReadonlyArray<[string, string | null]> = [['8.8.8.8', 'US'], ['4.2.2.2', 'US'], ['127.0.0.1', null], ['10.0.0.1', null]];

export interface RegionTableUpdateDepsV1 {
  path: string;
  now: Date;
  fetch: (url: string) => Promise<{ status: number; body: Buffer }>;
}
export type RegionTableUpdateResultV1 =
  | { outcome: 'current'; month: string }
  | { outcome: 'updated'; month: string; ipv4Ranges: number; ipv6Ranges: number; previous: string | null };

const monthOfV1 = (date: Date) => `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;

/** The month a table on disk was built from, or null when there is none to read. */
function currentMonthOnDiskV1(path: string): string | null {
  try { return parseStillRegionTableV1(readFileSync(path)).month; } catch { return null; }
}

/** Builds the table from one month's download and checks it; throws on anything it would not trust. */
export function regionTableFromDownloadV1(gz: Buffer, month: string): { file: Buffer; ipv4Ranges: number; ipv6Ranges: number } {
  const csv = gunzipSync(gz, { maxOutputLength: MAX_CSV_BYTES_V1 }).toString('utf8');
  const file = buildStillRegionTableV1(csv, month);
  const table = parseStillRegionTableV1(file);
  if (table.starts4.length < 100_000 || table.starts6High.length < 100_000) throw new Error('the download holds too few ranges for a whole database');
  for (const [address, country] of SANITY_V1) {
    if (stillRegionCountryV1(table, address) !== country) throw new Error(`the download places ${address} outside ${country ?? 'reserved space'}`);
  }
  const countries = new Set([...table.countries4, ...table.countries6]);
  if (countries.size < 200) throw new Error('the download names too few countries for a whole database');
  return { file, ipv4Ranges: table.starts4.length, ipv6Ranges: table.starts6High.length };
}

export async function updateStillRegionTableV1(deps: RegionTableUpdateDepsV1): Promise<RegionTableUpdateResultV1> {
  const previous = currentMonthOnDiskV1(deps.path);
  const thisMonth = monthOfV1(deps.now);
  const lastMonth = monthOfV1(new Date(Date.UTC(deps.now.getUTCFullYear(), deps.now.getUTCMonth() - 1, 1)));
  for (const month of [thisMonth, lastMonth]) {
    // Never older than what is in place.
    if (previous !== null && previous >= month) return { outcome: 'current', month: previous };
    const answer = await deps.fetch(SOURCE_V1(month));
    if (answer.status === 404) continue;
    if (answer.status !== 200) throw new Error(`DB-IP answered ${answer.status} for ${month}`);
    if (answer.body.length > MAX_DOWNLOAD_BYTES_V1) throw new Error('the download is larger than a whole database');
    const built = regionTableFromDownloadV1(answer.body, month);
    mkdirSync(dirname(deps.path), { recursive: true });
    const temporary = `${deps.path}.${process.pid}.tmp`;
    try {
      writeFileSync(temporary, built.file, { mode: 0o644 });
      renameSync(temporary, deps.path);
    } finally { rmSync(temporary, { force: true }); }
    return { outcome: 'updated', month, ipv4Ranges: built.ipv4Ranges, ipv6Ranges: built.ipv6Ranges, previous };
  }
  throw new Error(`DB-IP has no database for ${thisMonth} or ${lastMonth}`);
}

/** The download, refused past the size of a whole database before it is read. */
export async function fetchRegionTableBytesV1(url: string): Promise<{ status: number; body: Buffer }> {
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000), headers: { 'user-agent': 'miorail-region-table/1' } });
  if (response.status !== 200) return { status: response.status, body: Buffer.alloc(0) };
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (declared > MAX_DOWNLOAD_BYTES_V1) return { status: 413, body: Buffer.alloc(0) };
  return { status: 200, body: Buffer.from(await response.arrayBuffer()) };
}
