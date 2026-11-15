import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { parseStillRegionTableV1 } from './stillRegionTable.js';
import {
  STILL_REGISTRIES_V1,
  STILL_REGISTRY_SOURCES_V1,
  buildStillRegistryTableV1,
  delegatedBlocksV1,
  registryTableFromFilesV1,
  stillRegistryOfAddressV1,
  updateStillRegistryTableV1,
  type StillRegistryV1,
} from './stillRegistryTable.js';

// The registries' "delegated-extended" files, as the RIPE NCC wrote them on 2026-11-14: a version line,
// summaries, then one row per block. The blocks below are made up unless a comment says otherwise.
const RIPE_SAMPLE_V1 = [
  '2|ripencc|1794697199|261292|19700101|20261114|+0100',
  'ripencc|*|ipv4|*|101234|summary',
  'ripencc|*|ipv6|*|110372|summary',
  'ripencc|PS|ipv4|1.178.112.0|4096|20071126|allocated|c81dd501-f374-4508-abf5-89a8c09b951c',
  'ripencc|NL|ipv4|5.0.0.0|256|20100101|assigned|x',
  'ripencc|ZZ|ipv4|5.0.1.0|256||available|',
  'ripencc|EU|ipv4|5.0.2.0|256|20100101|reserved|x',
  'ripencc|NL|ipv6|2001:67c::|32|20100101|allocated|x',
  'ripencc|NL|asn|3333|1|19930901|assigned|x',
  'apnic|AU|ipv4|1.0.0.0|256|20110811|assigned|someone else’s row',
].join('\n');

const files = (overrides: Partial<Record<StillRegistryV1, string>> = {}): Record<StillRegistryV1, string> => ({
  arin: 'arin|US|ipv4|8.0.0.0|16777216|19921201|allocated|a',
  ripencc: RIPE_SAMPLE_V1,
  apnic: 'apnic|AU|ipv4|1.0.0.0|256|20110811|assigned|p',
  lacnic: 'lacnic|BR|ipv4|200.0.0.0|256|20100101|allocated|l',
  afrinic: 'afrinic|ZA|ipv4|196.0.0.0|256|20100101|allocated|f',
  ...overrides,
});

describe('a registry’s delegated file', () => {
  it('gives its own allocated and assigned IPv4 and IPv6 blocks, and nothing else', () => {
    const blocks = delegatedBlocksV1(RIPE_SAMPLE_V1, 'ripencc');
    assert.deepEqual(blocks.v4.map((block) => [block.start.toString(16), (block.end - block.start + BigInt(1)).toString()]), [['1b27000', '4096'], ['5000000', '256']]);
    assert.deepEqual(blocks.v6.map((block) => [block.start.toString(16), (block.end - block.start + BigInt(1)).toString(16)]), [['2001067c000000000000000000000000', '1000000000000000000000000']]);
  });

  it('refuses a row that is not a block of addresses', () => {
    for (const row of ['ripencc|NL|ipv4|5.0.0.300|256|x|allocated|x', 'ripencc|NL|ipv4|255.255.255.0|512|x|allocated|x', 'ripencc|NL|ipv4|5.0.0.0|0|x|allocated|x',
      'ripencc|NL|ipv6|2001:67c::|0|x|allocated|x', 'ripencc|NL|ipv6|2001:67c::1|32|x|allocated|x', 'ripencc|NL|ipv6|nonsense|32|x|allocated|x']) {
      assert.throws(() => delegatedBlocksV1(row, 'ripencc'), row);
    }
  });
});

describe('the registries’ table', () => {
  const table = parseStillRegionTableV1(buildStillRegistryTableV1(files(), '2026-11').file);

  it('says which registry holds an address, and nothing where none has given it out', () => {
    assert.equal(stillRegistryOfAddressV1(table, '8.8.8.8'), 'arin');
    assert.equal(stillRegistryOfAddressV1(table, '::ffff:8.8.8.8'), 'arin');
    assert.equal(stillRegistryOfAddressV1(table, '1.178.120.9'), 'ripencc');
    assert.equal(stillRegistryOfAddressV1(table, '5.0.0.200'), 'ripencc');
    assert.equal(stillRegistryOfAddressV1(table, '5.0.1.1'), null, 'available is no one’s yet');
    assert.equal(stillRegistryOfAddressV1(table, '5.0.2.1'), null, 'reserved is no one’s');
    assert.equal(stillRegistryOfAddressV1(table, '2001:67c:2e8::1'), 'ripencc');
    assert.equal(stillRegistryOfAddressV1(table, '1.0.0.7'), 'apnic');
    assert.equal(stillRegistryOfAddressV1(table, '200.0.0.1'), 'lacnic');
    assert.equal(stillRegistryOfAddressV1(table, '196.0.0.1'), 'afrinic');
    assert.equal(stillRegistryOfAddressV1(table, '10.0.0.1'), null);
    assert.equal(stillRegistryOfAddressV1(table, 'not an address'), null);
  });

  it('joins a registry’s neighbouring blocks into one range', () => {
    const joined = parseStillRegionTableV1(buildStillRegistryTableV1(files({
      ripencc: 'ripencc|NL|ipv4|5.0.0.0|256|x|allocated|a\nripencc|DE|ipv4|5.0.1.0|256|x|assigned|b\nripencc|FR|ipv4|5.0.2.0|512|x|allocated|c',
    }), '2026-11').file);
    // 0.0.0.0 to 0.255.255.255 is no one's, then APNIC's 1.0.0.0/24, a gap, RIPE's three blocks as one range, ...
    const at = joined.starts4.indexOf(0x05000000);
    assert.notEqual(at, -1);
    assert.equal(joined.starts4[at + 1], 0x05000400);
  });

  it('keeps the first of two registries listing the same block, and refuses a set of files where many do', () => {
    const moving = 'ripencc|DE|ipv4|8.8.8.0|256|x|allocated|r';
    const kept = parseStillRegionTableV1(buildStillRegistryTableV1(files({ ripencc: moving }), '2026-11').file);
    assert.equal(stillRegistryOfAddressV1(kept, '8.8.8.8'), 'arin');
    const many = Array.from({ length: 1001 }, (_, i) => `ripencc|DE|ipv4|8.${Math.floor(i / 256)}.${i % 256}.0|256|x|allocated|r`).join('\n');
    assert.throws(() => buildStillRegistryTableV1(files({ ripencc: many }), '2026-11'), /too many of the same addresses/);
  });
});

// A whole set: each registry's sanity addresses where they belong, and a thousand blocks of its own.
function wholeSet(overrides: Partial<Record<StillRegistryV1, string>> = {}): Record<StillRegistryV1, string> {
  const own = (registry: StillRegistryV1, firstOctet: number) => Array.from({ length: 1000 }, (_, i) =>
    `${registry}|XX|ipv4|${firstOctet}.${Math.floor(i / 256)}.${i % 256}.0|256|x|allocated|z`.replace('XX', 'DE')).join('\n');
  return {
    arin: `arin|US|ipv4|8.0.0.0|16777216|x|allocated|a\narin|US|ipv6|2001:4860::|32|x|allocated|a\n${own('arin', 20)}`,
    ripencc: `ripencc|NL|ipv4|193.0.0.0|2048|x|assigned|r\nripencc|NL|ipv6|2001:67c::|32|x|allocated|r\n${own('ripencc', 30)}`,
    apnic: `apnic|AU|ipv4|1.1.1.0|256|x|assigned|p\n${own('apnic', 40)}`,
    lacnic: `lacnic|BR|ipv4|200.160.0.0|4096|x|allocated|l\n${own('lacnic', 50)}`,
    afrinic: `afrinic|ZA|ipv4|196.216.0.0|1024|x|allocated|f\n${own('afrinic', 60)}`,
    ...overrides,
  };
}

describe('the weekly update', () => {
  const NOW = new Date('2026-11-15T06:00:00Z');
  const serve = (set: Record<StillRegistryV1, string>, status: Partial<Record<StillRegistryV1, number>> = {}) => {
    const asked: string[] = [];
    const fetch = async (url: string) => {
      asked.push(url);
      const registry = STILL_REGISTRIES_V1.find((name) => STILL_REGISTRY_SOURCES_V1[name] === url)!;
      return { status: status[registry] ?? 200, body: Buffer.from(set[registry], 'utf8') };
    };
    return { asked, fetch };
  };

  it('builds the table from the five files when there is none, and leaves one younger than a week alone', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'still-registry-'));
    try {
      const path = join(directory, 'registry-v1.bin'), { asked, fetch } = serve(wholeSet());
      const result = await updateStillRegistryTableV1({ path, now: NOW, fetch });
      assert.equal(result.outcome, 'updated');
      assert.deepEqual(asked, STILL_REGISTRIES_V1.map((registry) => STILL_REGISTRY_SOURCES_V1[registry]));
      const table = parseStillRegionTableV1(readFileSync(path));
      assert.equal(table.month, '2026-11');
      assert.equal(stillRegistryOfAddressV1(table, '193.0.6.139'), 'ripencc');
      const again = serve(wholeSet());
      utimesSync(path, new Date(NOW.getTime() - 6 * 24 * 3600_000), new Date(NOW.getTime() - 6 * 24 * 3600_000));
      assert.equal((await updateStillRegistryTableV1({ path, now: NOW, fetch: again.fetch })).outcome, 'current');
      assert.deepEqual(again.asked, []);
      utimesSync(path, new Date(NOW.getTime() - 8 * 24 * 3600_000), new Date(NOW.getTime() - 8 * 24 * 3600_000));
      assert.equal((await updateStillRegistryTableV1({ path, now: NOW, fetch: again.fetch })).outcome, 'updated');
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('a registry that does not answer, a thin file or a misplaced address leaves the table in place', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'still-registry-'));
    try {
      const path = join(directory, 'registry-v1.bin');
      writeFileSync(path, 'the table already in place');
      utimesSync(path, new Date(NOW.getTime() - 30 * 24 * 3600_000), new Date(NOW.getTime() - 30 * 24 * 3600_000));
      const failures: Array<[ReturnType<typeof serve>, RegExp]> = [
        [serve(wholeSet(), { lacnic: 503 }), /lacnic answered 503/],
        [serve(wholeSet({ afrinic: 'afrinic|ZA|ipv4|196.216.0.0|1024|x|allocated|f' })), /afrinic file holds too few blocks/],
        [serve(wholeSet({ apnic: `apnic|AU|ipv4|1.2.0.0|256|x|assigned|p\n${wholeSet().apnic.split('\n').slice(1).join('\n')}` })), /place 1\.1\.1\.1 outside apnic/],
      ];
      for (const [served, error] of failures) {
        await assert.rejects(updateStillRegistryTableV1({ path, now: NOW, fetch: served.fetch }), error);
        assert.equal(readFileSync(path, 'utf8'), 'the table already in place');
      }
      assert.equal(existsSync(`${path}.${process.pid}.tmp`), false);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('a whole set of files passes the checks a real one must', () => {
    const built = registryTableFromFilesV1(wholeSet(), '2026-11');
    assert.ok(Object.values(built.blocks).every((count) => count >= 1000));
  });
});
