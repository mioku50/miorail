import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { STILL_ELIGIBILITY_VERSION_V1 } from '@mioagent/still-engine/eligibility';
import { loadStillRegionTableV1, stillEligibilityConfirmedV1, stillEligibilityReadV1, stillEntryGateV1, stillRegionOfRequestV1, stillRegionRuntimeV1 } from './stillRegion.js';
import { buildStillRegionTableV1, parseStillRegionTableV1 } from './stillRegionTable.js';
import { SYNTHETIC_REGION_CSV_V1, syntheticRegionTableV1 } from './stillRegionTable.fixture.js';
import { buildStillRegistryTableV1 } from './stillRegistryTable.js';

const WALLET = '0x1111111111111111111111111111111111111111';
const NOW = Date.parse('2026-11-10T12:00:00Z');
const original = { ...stillRegionRuntimeV1 };
const env = { ...process.env };
const table = syntheticRegionTableV1();

function request(ip: string | undefined, confirmed: { version?: string; wallet?: string; confirmedAt?: string } | null = null) {
  return { ip, session: { user: { address: WALLET },
    ...(confirmed ? { stillEligibility: { version: STILL_ELIGIBILITY_VERSION_V1, wallet: WALLET, confirmedAt: new Date(NOW).toISOString(), ...confirmed } } : {}) } } as never;
}

beforeEach(() => {
  Object.assign(stillRegionRuntimeV1, { enabled: () => true, table: () => table, registryTable: () => null, networkCountry: async () => null, now: () => NOW });
});
afterEach(() => {
  Object.assign(stillRegionRuntimeV1, original);
  process.env = { ...env };
});

describe('where a request comes from', () => {
  it('is the country of the address Express read; the United States and its territories are restricted', async () => {
    assert.deepEqual(await stillRegionOfRequestV1({ ip: '11.2.3.4' }), { state: 'allowed', country: 'DE' });
    assert.deepEqual(await stillRegionOfRequestV1({ ip: '8.8.8.8' }), { state: 'restricted', country: 'US' });
    assert.deepEqual(await stillRegionOfRequestV1({ ip: '::ffff:9.1.1.1' }), { state: 'restricted', country: 'PR' });
    assert.deepEqual(await stillRegionOfRequestV1({ ip: '2001:db8::1' }), { state: 'restricted', country: 'US' });
  });

  it('cannot be placed without an address, a table, or a country for the address', async () => {
    assert.deepEqual(await stillRegionOfRequestV1({ ip: undefined } as never), { state: 'unchecked', reason: 'no_address' });
    assert.deepEqual(await stillRegionOfRequestV1({ ip: '127.0.0.1' }), { state: 'unchecked', reason: 'unknown_address' });
    stillRegionRuntimeV1.table = () => null;
    assert.deepEqual(await stillRegionOfRequestV1({ ip: '11.2.3.4' }), { state: 'unchecked', reason: 'no_table' });
  });

  it('is on in production unless turned off, and off elsewhere unless turned on', async () => {
    Object.assign(stillRegionRuntimeV1, { enabled: original.enabled });
    process.env.NODE_ENV = 'production'; delete process.env.STILL_REGION_GATE_V1;
    assert.equal(stillRegionRuntimeV1.enabled(), true);
    process.env.STILL_REGION_GATE_V1 = 'off';
    assert.equal(stillRegionRuntimeV1.enabled(), false);
    process.env.NODE_ENV = 'test'; delete process.env.STILL_REGION_GATE_V1;
    assert.equal(stillRegionRuntimeV1.enabled(), false);
    process.env.STILL_REGION_GATE_V1 = 'ON';
    assert.equal(stillRegionRuntimeV1.enabled(), true);
  });

  it('restricts a configured list of countries, and never leaves out the United States or a sanctioned country (audit BASE-2)', async () => {
    delete process.env.STILL_RESTRICTED_COUNTRIES_V1;
    assert.deepEqual([...original.restricted()].sort(), ['AS', 'CU', 'GU', 'IR', 'KP', 'MP', 'PR', 'SY', 'UM', 'US', 'VI']);
    process.env.STILL_RESTRICTED_COUNTRIES_V1 = 'ca, gb ,x1';
    assert.deepEqual([...original.restricted()].sort(), ['CA', 'CU', 'GB', 'IR', 'KP', 'SY', 'US']);
    process.env.STILL_RESTRICTED_COUNTRIES_V1 = 'nonsense';
    assert.equal(original.restricted().has('PR'), true);
  });

  it('refuses a connection from a sanctioned country, and says so of that country, not of the United States (audit BASE-2)', async () => {
    // A synthetic table: one range of addresses placed in Iran, the rest as the shared fixture has them.
    const csv = SYNTHETIC_REGION_CSV_V1.replace('128.0.0.0,255.255.255.255,FR', '128.0.0.0,199.255.255.255,FR\n200.0.0.0,255.255.255.255,IR');
    const withIran = parseStillRegionTableV1(buildStillRegionTableV1(csv, '2026-11'));
    stillRegionRuntimeV1.table = () => withIran;
    Object.assign(stillRegionRuntimeV1, { restricted: original.restricted });
    delete process.env.STILL_RESTRICTED_COUNTRIES_V1;
    assert.deepEqual(await stillRegionOfRequestV1({ ip: '200.1.2.3' }), { state: 'restricted', country: 'IR' });
    // Confirming the sentence does not open it, as it does not open the United States.
    const gate = await stillEntryGateV1(request('200.1.2.3', {}), { kind: 'loan', confirmation: true });
    assert.equal(!gate.ok && gate.refusal, 'region_restricted');
    assert.match(!gate.ok ? gate.detail : '', /^Still prepares no new loan, purchase or stock buy for a connection from Iran, a country under comprehensive US sanctions\. You can still repay a loan, take your collateral back and sell\.$/);
    assert.doesNotMatch(!gate.ok ? gate.detail : '', /United States/);
    const read = await stillEligibilityReadV1(request('200.1.2.3'));
    assert.deepEqual(read.region, { state: 'restricted', country: 'IR', reason: null });
    assert.match(read.restrictedReason, /from Iran, a country under comprehensive US sanctions\.$/);
    // France is placed and offered.
    assert.deepEqual(await stillRegionOfRequestV1({ ip: '150.1.2.3' }), { state: 'allowed', country: 'FR' });
  });
});

describe('the check before a new position', () => {
  it('refuses the United States with what stays open, and logs no address', async () => {
    const gate = await stillEntryGateV1(request('8.8.8.8', {}), { kind: 'loan', confirmation: true });
    assert.equal(gate.ok, false);
    if (gate.ok) return;
    assert.equal(gate.refusal, 'region_restricted');
    assert.match(gate.detail, /United States/);
    assert.match(gate.detail, /repay a loan, take your collateral back and sell/);
    assert.equal(gate.detail.length <= 500, true);
  });

  it('refuses what it cannot place, and tells a request with no address where to open it', async () => {
    const noAddress = await stillEntryGateV1(request(undefined, {}), { kind: 'loan', confirmation: true });
    assert.equal(!noAddress.ok && noAddress.refusal, 'region_unchecked');
    assert.match(!noAddress.ok ? noAddress.detail : '', /miorail\.xyz in your own browser/);
    const reserved = await stillEntryGateV1(request('10.1.1.1', {}), { kind: 'stock_buy', confirmation: true });
    assert.equal(!reserved.ok && reserved.refusal, 'region_unchecked');
    assert.match(!reserved.ok ? reserved.detail : '', /could not tell where this request comes from/);
  });

  it('asks for the confirmation only where it was asked to, and takes only this wallet’s, current and recent', async () => {
    assert.deepEqual(await stillEntryGateV1(request('11.2.3.4'), { kind: 'loan', confirmation: false }), { ok: true });
    const missing = await stillEntryGateV1(request('11.2.3.4'), { kind: 'loan', confirmation: true });
    assert.equal(!missing.ok && missing.refusal, 'eligibility_required');
    assert.deepEqual(await stillEntryGateV1(request('11.2.3.4', {}), { kind: 'loan', confirmation: true }), { ok: true });
    for (const stale of [{ wallet: '0x2222222222222222222222222222222222222222' }, { version: 'not-us-person-2026-01-01' },
      { confirmedAt: new Date(NOW - 31 * 24 * 3600_000).toISOString() }, { confirmedAt: new Date(NOW + 3600_000).toISOString() }, { confirmedAt: 'yesterday' },
      // The sentence of 2026-11-10 named the United States alone: a confirmation of it is not one of today's.
      { version: 'not-us-person-2026-11-10' }]) {
      const gate = await stillEntryGateV1(request('11.2.3.4', stale), { kind: 'purchase', confirmation: true });
      assert.equal(!gate.ok && gate.refusal, 'eligibility_required', JSON.stringify(stale));
    }
    // A confirmation does not open the United States.
    const us = await stillEntryGateV1(request('8.8.8.8', {}), { kind: 'loan', confirmation: true });
    assert.equal(!us.ok && us.refusal, 'region_restricted');
  });

  it('lets everything through while it is off', async () => {
    stillRegionRuntimeV1.enabled = () => false;
    assert.deepEqual(await stillEntryGateV1(request('8.8.8.8'), { kind: 'loan', confirmation: true }), { ok: true });
  });

  it('reads back the region, the table and the confirmation for a page', async () => {
    const read = await stillEligibilityReadV1(request('11.2.3.4', {}));
    assert.equal(read.gate, 'on');
    assert.deepEqual(read.region, { state: 'allowed', country: 'DE', reason: null });
    assert.deepEqual(read.table, { loaded: true, month: '2026-11' });
    assert.deepEqual(read.registryTable, { loaded: false, month: null });
    assert.equal(read.confirmed, true);
    assert.equal(read.statement, 'I am not a U.S. person, and I am not currently located in the United States, Cuba, Iran, North Korea, Syria, Crimea, or the so-called Donetsk or Luhansk People’s Republics.');
    assert.equal(read.version, 'not-us-person-or-sanctioned-2026-11-14');
    assert.equal(stillEligibilityConfirmedV1(request('11.2.3.4')), null);
    const us = await stillEligibilityReadV1(request('8.8.8.8'));
    assert.deepEqual(us.region, { state: 'restricted', country: 'US', reason: null });
    assert.equal(us.restrictedReason, 'Still prepares no new loan, purchase or stock buy for a connection from the United States or its territories, or for a U.S. person.');
  });
});

// 2026-11-15: DB-IP placed the operator's Frankfurt VPN exit in the United States. Its block had moved from
// ARIN to the RIPE NCC, whose record of the network says Germany. Made-up blocks in the registries' file shape.
const REGISTRY_FILES_V1 = {
  arin: 'arin|US|ipv4|8.0.0.0|524288|19921201|allocated|a\narin|US|ipv4|9.0.0.0|16777216|19921201|allocated|a',
  ripencc: 'ripencc|US|ipv4|8.8.0.0|65536|20240101|allocated|r\nripencc|NL|ipv6|2001:db8::|32|20240101|allocated|r',
  apnic: 'apnic|AU|ipv4|1.0.0.0|256|20110811|assigned|p',
  lacnic: 'lacnic|BR|ipv4|200.0.0.0|256|20100101|allocated|l',
  afrinic: 'afrinic|ZA|ipv4|196.0.0.0|256|20100101|allocated|f',
};
const registryTable = parseStillRegionTableV1(buildStillRegistryTableV1(REGISTRY_FILES_V1, '2026-11').file);

describe('a second opinion from the network’s own registry', () => {
  function asking(answer: string | null) {
    const asked: string[] = [];
    Object.assign(stillRegionRuntimeV1, { registryTable: () => registryTable,
      networkCountry: async (registry: string, address: string) => { asked.push(`${registry} ${address}`); return answer; } });
    return asked;
  }

  it('lets an address DB-IP places in the United States through when the registry holding it records the network elsewhere', async () => {
    const asked = asking('DE');
    assert.deepEqual(await stillRegionOfRequestV1({ ip: '8.8.8.8' }), { state: 'allowed', country: 'DE', placedBy: 'registry', geolocated: 'US' });
    assert.deepEqual(await stillRegionOfRequestV1({ ip: '2001:db8::1' }), { state: 'allowed', country: 'DE', placedBy: 'registry', geolocated: 'US' });
    assert.deepEqual(asked, ['ripencc 8.8.8.8', 'ripencc 2001:db8::1']);
    // The person is asked to confirm, as from anywhere else; then the entry opens.
    const unconfirmed = await stillEntryGateV1(request('8.8.8.8'), { kind: 'loan', confirmation: true });
    assert.equal(!unconfirmed.ok && unconfirmed.refusal, 'eligibility_required');
    assert.deepEqual(await stillEntryGateV1(request('8.8.8.8', {}), { kind: 'loan', confirmation: true }), { ok: true });
    const read = await stillEligibilityReadV1(request('8.8.8.8'));
    assert.deepEqual(read.region, { state: 'allowed', country: 'DE', reason: null, placedBy: 'registry' });
    assert.deepEqual(read.registryTable, { loaded: true, month: '2026-11' });
  });

  it('refuses as before when the record says the United States or a sanctioned country, or nothing at all', async () => {
    for (const answer of ['US', 'PR', 'IR', null]) {
      asking(answer);
      assert.deepEqual(await stillRegionOfRequestV1({ ip: '8.8.8.8' }), { state: 'restricted', country: 'US' }, String(answer));
    }
    // Without the registries' table nothing is asked.
    const asked = asking('DE');
    stillRegionRuntimeV1.registryTable = () => null;
    assert.deepEqual(await stillRegionOfRequestV1({ ip: '8.8.8.8' }), { state: 'restricted', country: 'US' });
    assert.deepEqual(asked, []);
  });

  it('never asks about a block ARIN holds, nor about an address DB-IP places anywhere else', async () => {
    const asked = asking('DE');
    assert.deepEqual(await stillRegionOfRequestV1({ ip: '8.1.2.3' }), { state: 'restricted', country: 'US' });
    assert.deepEqual(await stillRegionOfRequestV1({ ip: '::ffff:9.1.1.1' }), { state: 'restricted', country: 'PR' });
    assert.deepEqual(await stillRegionOfRequestV1({ ip: '11.2.3.4' }), { state: 'allowed', country: 'DE' });
    assert.deepEqual(asked, []);
  });

  it('never reopens a sanctioned country', async () => {
    const csv = SYNTHETIC_REGION_CSV_V1.replace('128.0.0.0,255.255.255.255,FR', '128.0.0.0,199.255.255.255,FR\n200.0.0.0,255.255.255.255,IR');
    stillRegionRuntimeV1.table = () => parseStillRegionTableV1(buildStillRegionTableV1(csv, '2026-11'));
    const asked = asking('BR');
    assert.deepEqual(await stillRegionOfRequestV1({ ip: '200.0.0.9' }), { state: 'restricted', country: 'IR' });
    assert.deepEqual(asked, []);
  });

  it('a registry that cannot be asked refuses, it does not fail the request', async () => {
    Object.assign(stillRegionRuntimeV1, { registryTable: () => registryTable, networkCountry: async () => { throw new Error('timeout'); } });
    assert.deepEqual(await stillRegionOfRequestV1({ ip: '8.8.8.8' }), { state: 'restricted', country: 'US' });
  });
});

describe('the table on disk', () => {
  let directory = '';
  beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'still-region-')); });
  afterEach(() => { rmSync(directory, { recursive: true, force: true }); });

  it('is asked for again a minute after it was missing, read again when it changes, and kept when a newer one is broken', async () => {
    const path = join(directory, 'region-v1.bin');
    const start = NOW;
    assert.equal(loadStillRegionTableV1(path, start), null);
    writeFileSync(path, buildStillRegionTableV1(SYNTHETIC_REGION_CSV_V1, '2026-10'));
    assert.equal(loadStillRegionTableV1(path, start + 30_000), null);
    assert.equal(loadStillRegionTableV1(path, start + 61_000)?.month, '2026-10');
    writeFileSync(path, buildStillRegionTableV1(SYNTHETIC_REGION_CSV_V1, '2026-11'));
    utimesSync(path, new Date(start + 120_000), new Date(start + 120_000));
    // Within the hour the table in use is kept without a look at the disk.
    assert.equal(loadStillRegionTableV1(path, start + 30 * 60_000)?.month, '2026-10');
    assert.equal(loadStillRegionTableV1(path, start + 62 * 60_000)?.month, '2026-11');
    writeFileSync(path, Buffer.from('broken'));
    utimesSync(path, new Date(start + 200_000), new Date(start + 200_000));
    assert.equal(loadStillRegionTableV1(path, start + 130 * 60_000)?.month, '2026-11');
  });
});
