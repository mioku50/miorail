import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildStillRegionTableV1, ipv6NumberV1, parseStillRegionTableV1, stillRegionCountryV1, StillRegionTableErrorV1 } from './stillRegionTable.js';
import { SYNTHETIC_REGION_CSV_V1 } from './stillRegionTable.fixture.js';


const table = parseStillRegionTableV1(buildStillRegionTableV1(SYNTHETIC_REGION_CSV_V1, '2026-11'));

describe('the region table', () => {
  it('places an address in the range that holds it, at both ends of every range', () => {
    const cases: Array<[string, string | null]> = [
      ['8.8.8.8', 'US'], ['8.0.0.0', 'US'], ['8.255.255.255', 'US'], ['9.1.1.1', 'PR'],
      ['7.255.255.255', null], ['10.0.0.1', null], ['127.0.0.1', null], ['0.0.0.0', null],
      ['11.0.0.0', 'DE'], ['126.255.255.255', 'DE'], ['128.0.0.0', 'FR'], ['255.255.255.255', 'FR'],
      ['::ffff:8.8.8.8', 'US'], ['::FFFF:9.0.0.1', 'PR'],
      ['2001:db8::1', 'US'], ['2001::', 'US'], ['2001:ffff:ffff:ffff:ffff:ffff:ffff:ffff', 'US'],
      ['2000:ffff:ffff:ffff:ffff:ffff:ffff:ffff', null], ['::1', null], ['2002::', 'DE'], ['fe80::1%eth0', 'DE'],
    ];
    for (const [address, country] of cases) assert.equal(stillRegionCountryV1(table, address), country, address);
  });

  it('places nothing that is not an IP address', () => {
    for (const address of ['', 'not-an-ip', '8.8.8', '8.8.8.8.8', '256.1.1.1', '1::2::3', '8.8.8.8/24']) {
      assert.equal(stillRegionCountryV1(table, address), null, address);
    }
  });

  it('reads an IPv6 address, with an IPv4 address written into its last 32 bits', () => {
    assert.equal(ipv6NumberV1('::'), BigInt(0));
    assert.equal(ipv6NumberV1('::1'), BigInt(1));
    assert.equal(ipv6NumberV1('1::'), BigInt(1) << BigInt(112));
    assert.equal(ipv6NumberV1('::ffff:1.2.3.4'), (BigInt(0xffff) << BigInt(32)) | BigInt(0x01020304));
    assert.equal(ipv6NumberV1('2001:db8:0:0:0:0:0:1'), ipv6NumberV1('2001:db8::1'));
    assert.equal(ipv6NumberV1('1.2.3.4'), null);
  });

  it('keeps the month it was built from', () => {
    assert.equal(table.month, '2026-11');
    assert.equal(table.starts4.length, 7);
    assert.equal(table.starts6High.length, 3);
  });

  it('refuses a database with a gap, an overlap, a row out of order, a bad country or a short end', () => {
    const rows = SYNTHETIC_REGION_CSV_V1.split('\n');
    const broken = {
      gap: rows.filter((_, i) => i !== 2),
      overlap: rows.map((row, i) => i === 2 ? '8.255.255.255,9.255.255.255,PR' : row),
      order: [rows[1]!, rows[0]!, ...rows.slice(2)],
      country: rows.map((row, i) => i === 1 ? '8.0.0.0,8.255.255.255,usa' : row),
      fields: rows.map((row, i) => i === 1 ? `${row},extra` : row),
      shortV4: rows.filter((_, i) => i !== 6),
      shortV6: rows.filter((_, i) => i !== 9),
      notAnAddress: rows.map((row, i) => i === 1 ? 'eight,8.255.255.255,US' : row),
    };
    for (const [name, csv] of Object.entries(broken)) {
      assert.throws(() => buildStillRegionTableV1(csv.join('\n'), '2026-11'), StillRegionTableErrorV1, name);
    }
    assert.throws(() => buildStillRegionTableV1(SYNTHETIC_REGION_CSV_V1, 'November'), StillRegionTableErrorV1);
  });

  it('refuses a file that is not a whole table', () => {
    const file = buildStillRegionTableV1(SYNTHETIC_REGION_CSV_V1, '2026-11');
    assert.throws(() => parseStillRegionTableV1(file.subarray(0, file.length - 2)), StillRegionTableErrorV1);
    assert.throws(() => parseStillRegionTableV1(Buffer.concat([Buffer.from('XXXX'), file.subarray(4)])), StillRegionTableErrorV1);
    const version = Buffer.from(file); version.writeUInt8(2, 4);
    assert.throws(() => parseStillRegionTableV1(version), StillRegionTableErrorV1);
    assert.throws(() => parseStillRegionTableV1(Buffer.alloc(8)), StillRegionTableErrorV1);
  });
});
