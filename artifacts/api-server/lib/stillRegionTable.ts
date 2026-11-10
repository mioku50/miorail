import { isIPv4, isIPv6 } from 'node:net';

// ---------------------------------------------------------------------------
// Which country an IP address is registered in, from DB-IP's free country
// database ("IP to Country Lite", CC BY 4.0, https://db-ip.com), turned into
// one small file of sorted ranges.
//
// DB-IP publishes the database as a CSV of `start,end,country` rows that cover
// every IPv4 and IPv6 address, in order, with no gap: a reserved or private
// range is the country `ZZ`. A row's end is the next row's start minus one, so
// the file keeps only each range's start and its country, and a lookup is one
// binary search. Nothing here reads a file or the network; regionTableUpdate.ts
// downloads and writes, stillRegion.ts reads.
//
// The file (all integers little-endian):
//   0   'MRRT', then version 1 and three zero bytes
//   8   u32 IPv4 range count, u32 IPv6 range count
//   16  the source month, 'YYYY-MM', padded with zeros to 8 bytes
//   24  8 zero bytes
//   32  IPv4 starts, u32 each; IPv6 starts, two u64 each (high, low);
//       IPv4 countries, then IPv6 countries, u16 each (two ASCII letters)
// ---------------------------------------------------------------------------

const MAGIC_V1 = 'MRRT';
const HEADER_BYTES_V1 = 32;
const UNKNOWN_V1 = 0x5a5a; // 'ZZ'
const MASK_64_V1 = (BigInt(1) << BigInt(64)) - BigInt(1);
const IPV6_LAST_V1 = (BigInt(1) << BigInt(128)) - BigInt(1);

export interface StillRegionTableV1 {
  /** The month DB-IP published this database for, `YYYY-MM`. */
  month: string;
  starts4: Uint32Array;
  countries4: Uint16Array;
  starts6High: BigUint64Array;
  starts6Low: BigUint64Array;
  countries6: Uint16Array;
}

export class StillRegionTableErrorV1 extends Error {}

function countryCodeV1(code: string): number {
  if (!/^[A-Z]{2}$/.test(code)) throw new StillRegionTableErrorV1('a country code is not two capital letters');
  return (code.charCodeAt(0) << 8) | code.charCodeAt(1);
}
function countryTextV1(code: number): string | null {
  return code === UNKNOWN_V1 ? null : String.fromCharCode(code >> 8, code & 0xff);
}

export function ipv4NumberV1(address: string): number | null {
  if (!isIPv4(address)) return null;
  return address.split('.').reduce((value, part) => value * 256 + Number(part), 0);
}

/** An IPv6 address as one 128-bit number, or null; an IPv4 address mapped into IPv6 stays IPv6 here. */
export function ipv6NumberV1(address: string): bigint | null {
  const bare = address.split('%')[0] ?? '';
  if (!isIPv6(bare)) return null;
  let text = bare, tail: number[] = [];
  const dotted = /:(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted) {
    const v4 = ipv4NumberV1(dotted[1]!);
    if (v4 === null) return null;
    tail = [Math.floor(v4 / 65536), v4 % 65536];
    text = text.slice(0, -dotted[1]!.length) + '0:0';
  }
  const [head = '', rest] = text.split('::');
  const left = head ? head.split(':') : [], right = rest === undefined ? [] : rest ? rest.split(':') : [];
  const groups = rest === undefined ? left : [...left, ...Array(8 - left.length - right.length).fill('0'), ...right];
  if (groups.length !== 8) return null;
  const words = groups.map(group => parseInt(group, 16));
  if (tail.length) words.splice(6, 2, ...tail);
  return words.reduce((value, word) => (value << BigInt(16)) | BigInt(word), BigInt(0));
}

/** The table from DB-IP's CSV. It refuses rows out of order, a gap, an overlap, a country that is
 * not two letters, and a table that does not cover both address spaces from the first address to the last. */
export function buildStillRegionTableV1(csv: string, month: string): Buffer {
  if (!/^\d{4}-\d{2}$/.test(month)) throw new StillRegionTableErrorV1('the month is not YYYY-MM');
  const starts4: number[] = [], countries4: number[] = [], starts6: bigint[] = [], countries6: number[] = [];
  let next4 = 0, next6 = BigInt(0), done4 = false, done6 = false;
  for (const raw of csv.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const [start = '', end = '', country = '', extra] = line.split(',');
    if (extra !== undefined) throw new StillRegionTableErrorV1('a row has more than three fields');
    const code = countryCodeV1(country);
    const s4 = ipv4NumberV1(start), e4 = ipv4NumberV1(end);
    if (s4 !== null && e4 !== null) {
      if (done4 || s4 !== next4 || e4 < s4) throw new StillRegionTableErrorV1('the IPv4 ranges are not contiguous');
      starts4.push(s4); countries4.push(code);
      if (e4 === 0xffffffff) done4 = true; else next4 = e4 + 1;
      continue;
    }
    const s6 = ipv6NumberV1(start), e6 = ipv6NumberV1(end);
    if (s6 === null || e6 === null) throw new StillRegionTableErrorV1('a row is not an address range');
    if (done6 || s6 !== next6 || e6 < s6) throw new StillRegionTableErrorV1('the IPv6 ranges are not contiguous');
    starts6.push(s6); countries6.push(code);
    if (e6 === IPV6_LAST_V1) done6 = true; else next6 = e6 + BigInt(1);
  }
  if (!done4 || !done6) throw new StillRegionTableErrorV1('the ranges do not reach the last address');
  const size = HEADER_BYTES_V1 + starts4.length * 4 + starts6.length * 16 + (countries4.length + countries6.length) * 2;
  const out = Buffer.alloc(size);
  out.write(MAGIC_V1, 0, 'ascii');
  out.writeUInt8(1, 4);
  out.writeUInt32LE(starts4.length, 8);
  out.writeUInt32LE(starts6.length, 12);
  out.write(month, 16, 'ascii');
  let at = HEADER_BYTES_V1;
  for (const value of starts4) { out.writeUInt32LE(value, at); at += 4; }
  for (const value of starts6) { out.writeBigUInt64LE(value >> BigInt(64), at); out.writeBigUInt64LE(value & MASK_64_V1, at + 8); at += 16; }
  for (const value of [...countries4, ...countries6]) { out.writeUInt16LE(value, at); at += 2; }
  return out;
}

export function parseStillRegionTableV1(file: Buffer): StillRegionTableV1 {
  if (file.length < HEADER_BYTES_V1 || file.toString('ascii', 0, 4) !== MAGIC_V1 || file.readUInt8(4) !== 1) {
    throw new StillRegionTableErrorV1('not a region table');
  }
  const count4 = file.readUInt32LE(8), count6 = file.readUInt32LE(12);
  const month = file.toString('ascii', 16, 24).replace(/\0+$/, '');
  if (!/^\d{4}-\d{2}$/.test(month) || count4 === 0 || count6 === 0 ||
      file.length !== HEADER_BYTES_V1 + count4 * 4 + count6 * 16 + (count4 + count6) * 2) {
    throw new StillRegionTableErrorV1('the region table is truncated');
  }
  const starts4 = new Uint32Array(count4), starts6High = new BigUint64Array(count6), starts6Low = new BigUint64Array(count6);
  const countries4 = new Uint16Array(count4), countries6 = new Uint16Array(count6);
  let at = HEADER_BYTES_V1;
  for (let i = 0; i < count4; i++, at += 4) starts4[i] = file.readUInt32LE(at);
  for (let i = 0; i < count6; i++, at += 16) { starts6High[i] = file.readBigUInt64LE(at); starts6Low[i] = file.readBigUInt64LE(at + 8); }
  for (let i = 0; i < count4; i++, at += 2) countries4[i] = file.readUInt16LE(at);
  for (let i = 0; i < count6; i++, at += 2) countries6[i] = file.readUInt16LE(at);
  if (starts4[0] !== 0 || starts6High[0] !== BigInt(0) || starts6Low[0] !== BigInt(0)) throw new StillRegionTableErrorV1('the region table does not start at the first address');
  return { month, starts4, countries4, starts6High, starts6Low, countries6 };
}

/** The last range that starts at or below the address: the ranges are contiguous, so it holds it. */
function lastAtOrBelowV1(count: number, below: (index: number) => boolean): number {
  let low = 0, high = count - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (below(middle)) low = middle; else high = middle - 1;
  }
  return low;
}

/** The country an address is registered in, as two capital letters; null for a reserved or private
 * address, and for anything that is not an IP address. An IPv4 address mapped into IPv6 is read as IPv4. */
export function stillRegionCountryV1(table: StillRegionTableV1, address: string): string | null {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address.trim());
  const v4 = ipv4NumberV1(mapped ? mapped[1]! : address.trim());
  if (v4 !== null) return countryTextV1(table.countries4[lastAtOrBelowV1(table.starts4.length, i => table.starts4[i]! <= v4)]!);
  const v6 = ipv6NumberV1(address.trim());
  if (v6 === null) return null;
  const high = v6 >> BigInt(64), low = v6 & MASK_64_V1;
  const index = lastAtOrBelowV1(table.starts6High.length, i => table.starts6High[i]! < high || (table.starts6High[i] === high && table.starts6Low[i]! <= low));
  return countryTextV1(table.countries6[index]!);
}
