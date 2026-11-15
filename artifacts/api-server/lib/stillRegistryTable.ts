import { mkdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  StillRegionTableErrorV1,
  buildStillRegionTableV1,
  ipv4NumberV1,
  ipv6NumberV1,
  parseStillRegionTableV1,
  stillRegionCountryV1,
  type StillRegionTableV1,
} from './stillRegionTable.js';

// ---------------------------------------------------------------------------
// Which regional internet registry holds an address block: ARIN, the RIPE NCC,
// APNIC, LACNIC or AFRINIC, from the "delegated-extended" file each of them
// publishes every day.
//
// Why (2026-11-15): DB-IP placed the operator's VPN exit, a Frankfurt network,
// in the United States. The block had moved from ARIN to the RIPE NCC, and the
// RIPE database records the network itself as in Germany. These files cannot
// say that: their country is the holder's, and they listed this one as US. So
// they say only WHO holds a block. When DB-IP places an address in the United
// States and a registry other than ARIN holds it, that registry's own record
// of the network is asked (stillRegionRdap.ts). A block ARIN holds is never
// asked about, and the address itself is never sent anywhere.
//
// The table is the region table's file (stillRegionTable.ts), with a
// registry's code where a country would be and `ZZ` where no registry has
// given out the addresses.
// ---------------------------------------------------------------------------

export const STILL_REGISTRIES_V1 = ['arin', 'ripencc', 'apnic', 'lacnic', 'afrinic'] as const;
export type StillRegistryV1 = (typeof STILL_REGISTRIES_V1)[number];

/** Two letters per registry, meaningful in this table only. */
const CODE_OF_V1: Record<StillRegistryV1, string> = { arin: 'AR', ripencc: 'RE', apnic: 'AP', lacnic: 'LA', afrinic: 'AF' };
const REGISTRY_OF_V1 = new Map<string, StillRegistryV1>(STILL_REGISTRIES_V1.map((registry) => [CODE_OF_V1[registry], registry]));

export const STILL_REGISTRY_SOURCES_V1: Record<StillRegistryV1, string> = {
  arin: 'https://ftp.arin.net/pub/stats/arin/delegated-arin-extended-latest',
  ripencc: 'https://ftp.ripe.net/pub/stats/ripencc/delegated-ripencc-extended-latest',
  apnic: 'https://ftp.apnic.net/stats/apnic/delegated-apnic-extended-latest',
  lacnic: 'https://ftp.lacnic.net/pub/stats/lacnic/delegated-lacnic-extended-latest',
  afrinic: 'https://ftp.afrinic.net/pub/stats/afrinic/delegated-afrinic-extended-latest',
};

interface BlockV1 { start: bigint; end: bigint; code: string }

const IPV4_LAST_V1 = BigInt(0xffffffff);
const IPV6_LAST_V1 = (BigInt(1) << BigInt(128)) - BigInt(1);
/** A block two registries both list, while it moves between them: the first one keeps it. More than this many is not a whole set of files. */
const MAX_OVERLAPS_V1 = 1000;

/** One registry's file: the IPv4 and IPv6 blocks it has allocated or assigned. Throws on a row that is not a block. */
export function delegatedBlocksV1(text: string, registry: StillRegistryV1): { v4: BlockV1[]; v6: BlockV1[] } {
  const v4: BlockV1[] = [], v6: BlockV1[] = [], code = CODE_OF_V1[registry];
  for (const raw of text.split('\n')) {
    const field = raw.trim().split('|');
    // The version line starts with its number, a summary has `*` for a country, a comment `#`.
    if (field.length < 7 || field[0] !== registry || field[1] === '*') continue;
    const [, , type, start = '', value = '', , status] = field;
    if (status !== 'allocated' && status !== 'assigned') continue;
    if (type === 'ipv4') {
      const first = ipv4NumberV1(start), count = Number(value);
      if (first === null || !Number.isSafeInteger(count) || count < 1 || first + count - 1 > 0xffffffff) {
        throw new StillRegionTableErrorV1(`${registry}: an IPv4 row is not a block of addresses`);
      }
      v4.push({ start: BigInt(first), end: BigInt(first + count - 1), code });
    } else if (type === 'ipv6') {
      const first = ipv6NumberV1(start), length = Number(value);
      if (first === null || !Number.isInteger(length) || length < 1 || length > 128) throw new StillRegionTableErrorV1(`${registry}: an IPv6 row is not a prefix`);
      const size = BigInt(1) << BigInt(128 - length);
      if (first % size !== BigInt(0)) throw new StillRegionTableErrorV1(`${registry}: an IPv6 row does not start its prefix`);
      v6.push({ start: first, end: first + size - BigInt(1), code });
    }
  }
  return { v4, v6 };
}

const ipv4TextV1 = (value: bigint) => [24, 16, 8, 0].map((shift) => ((value >> BigInt(shift)) & BigInt(255)).toString()).join('.');
const ipv6TextV1 = (value: bigint) => Array.from({ length: 8 }, (_, i) => ((value >> BigInt(112 - 16 * i)) & BigInt(0xffff)).toString(16)).join(':');

/** Rows that cover a whole address space in order, `ZZ` between blocks, neighbours of one registry joined. */
function contiguousRowsV1(blocks: BlockV1[], family: 4 | 6): { rows: string[]; overlaps: number } {
  const last = family === 4 ? IPV4_LAST_V1 : IPV6_LAST_V1, text = family === 4 ? ipv4TextV1 : ipv6TextV1;
  const sorted = [...blocks].sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : a.end > b.end ? -1 : a.end < b.end ? 1 : 0));
  const runs: BlockV1[] = [];
  let next = BigInt(0), overlaps = 0;
  const add = (run: BlockV1) => {
    const previous = runs[runs.length - 1];
    if (previous && previous.code === run.code && previous.end + BigInt(1) === run.start) previous.end = run.end;
    else runs.push({ ...run });
  };
  for (const block of sorted) {
    if (block.start < next) { overlaps++; continue; }
    if (block.start > next) add({ start: next, end: block.start - BigInt(1), code: 'ZZ' });
    add(block);
    next = block.end + BigInt(1);
  }
  if (next <= last) add({ start: next, end: last, code: 'ZZ' });
  return { rows: runs.map((run) => `${text(run.start)},${text(run.end)},${run.code}`), overlaps };
}

/** The table from the five registries' files, in the region table's format. */
export function buildStillRegistryTableV1(files: Record<StillRegistryV1, string>, month: string): { file: Buffer; blocks: Record<StillRegistryV1, number> } {
  const v4: BlockV1[] = [], v6: BlockV1[] = [];
  const blocks = {} as Record<StillRegistryV1, number>;
  for (const registry of STILL_REGISTRIES_V1) {
    const found = delegatedBlocksV1(files[registry], registry);
    blocks[registry] = found.v4.length + found.v6.length;
    v4.push(...found.v4);
    v6.push(...found.v6);
  }
  const rows4 = contiguousRowsV1(v4, 4), rows6 = contiguousRowsV1(v6, 6);
  if (rows4.overlaps + rows6.overlaps > MAX_OVERLAPS_V1) throw new StillRegionTableErrorV1('the registries list too many of the same addresses');
  return { file: buildStillRegionTableV1([...rows4.rows, ...rows6.rows].join('\n'), month), blocks };
}

/** The registry that holds an address's block, or null for addresses no registry has given out. */
export function stillRegistryOfAddressV1(table: StillRegionTableV1, address: string): StillRegistryV1 | null {
  const code = stillRegionCountryV1(table, address);
  return code === null ? null : REGISTRY_OF_V1.get(code) ?? null;
}

// ---------------------------------------------------------------------------
// The weekly update, run by miorail-region-table.service with the DB-IP table
// (regionTableUpdate.ts). A table younger than a week is left as it is. All
// five files must arrive and build a table that places addresses whose
// registry is not in question with that registry; anything else leaves the
// table in place and fails the unit.
// ---------------------------------------------------------------------------

const MAX_FILE_BYTES_V1 = 64 * 1024 * 1024;
const REFRESH_MS_V1 = 7 * 24 * 60 * 60 * 1000;
const MIN_BLOCKS_V1 = 1000;
/** Each registry's own resolvers and websites, and Google's: where these are is not in question. */
const SANITY_V1: ReadonlyArray<[string, StillRegistryV1]> = [
  ['8.8.8.8', 'arin'], ['193.0.6.139', 'ripencc'], ['1.1.1.1', 'apnic'], ['200.160.2.3', 'lacnic'], ['196.216.2.1', 'afrinic'],
  ['2001:4860:4860::8888', 'arin'], ['2001:67c:2e8::1', 'ripencc'],
];

export interface RegistryTableUpdateDepsV1 {
  path: string;
  now: Date;
  fetch: (url: string) => Promise<{ status: number; body: Buffer }>;
}
export type RegistryTableUpdateResultV1 =
  | { outcome: 'current'; builtAt: string }
  | { outcome: 'updated'; blocks: Record<StillRegistryV1, number>; ipv4Ranges: number; ipv6Ranges: number };

/** Builds the table from the five files and checks it; throws on anything it would not trust. */
export function registryTableFromFilesV1(files: Record<StillRegistryV1, string>, month: string): { file: Buffer; blocks: Record<StillRegistryV1, number>; ipv4Ranges: number; ipv6Ranges: number } {
  const built = buildStillRegistryTableV1(files, month);
  for (const registry of STILL_REGISTRIES_V1) {
    if (built.blocks[registry] < MIN_BLOCKS_V1) throw new Error(`the ${registry} file holds too few blocks for a whole registry`);
  }
  const table = parseStillRegionTableV1(built.file);
  for (const [address, registry] of SANITY_V1) {
    if (stillRegistryOfAddressV1(table, address) !== registry) throw new Error(`the files place ${address} outside ${registry}`);
  }
  return { ...built, ipv4Ranges: table.starts4.length, ipv6Ranges: table.starts6High.length };
}

export async function updateStillRegistryTableV1(deps: RegistryTableUpdateDepsV1): Promise<RegistryTableUpdateResultV1> {
  let builtAt: number | null;
  try { builtAt = statSync(deps.path).mtimeMs; } catch { builtAt = null; }
  if (builtAt !== null && deps.now.getTime() - builtAt < REFRESH_MS_V1) return { outcome: 'current', builtAt: new Date(builtAt).toISOString() };
  const files = {} as Record<StillRegistryV1, string>;
  for (const registry of STILL_REGISTRIES_V1) {
    const answer = await deps.fetch(STILL_REGISTRY_SOURCES_V1[registry]);
    if (answer.status !== 200) throw new Error(`${registry} answered ${answer.status} for its delegated file`);
    if (answer.body.length > MAX_FILE_BYTES_V1) throw new Error(`the ${registry} file is larger than a whole registry`);
    files[registry] = answer.body.toString('utf8');
  }
  const month = `${deps.now.getUTCFullYear()}-${String(deps.now.getUTCMonth() + 1).padStart(2, '0')}`;
  const built = registryTableFromFilesV1(files, month);
  mkdirSync(dirname(deps.path), { recursive: true });
  const temporary = `${deps.path}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, built.file, { mode: 0o644 });
    renameSync(temporary, deps.path);
  } finally { rmSync(temporary, { force: true }); }
  return { outcome: 'updated', blocks: built.blocks, ipv4Ranges: built.ipv4Ranges, ipv6Ranges: built.ipv6Ranges };
}
