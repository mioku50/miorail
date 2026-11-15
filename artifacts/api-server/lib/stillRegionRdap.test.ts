import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import {
  rdapNetworkCountryV1,
  resetStillRegionRdapV1,
  stillRegionRdapRuntimeV1,
  stillRegistryNetworkCountryV1,
  stillRegistryNetworkOfV1,
} from './stillRegionRdap.js';

const original = { ...stillRegionRdapRuntimeV1 };
afterEach(() => {
  Object.assign(stillRegionRdapRuntimeV1, original);
  resetStillRegionRdapV1();
});

// An RDAP "ip network" as the RIPE database answered for a Frankfurt network on 2026-11-15, trimmed.
const NETWORK_V1 = { objectClassName: 'ip network', handle: '198.51.100.0 - 198.51.100.255', startAddress: '198.51.100.0', endAddress: '198.51.100.255',
  ipVersion: 'v4', name: 'example-fra', type: 'ASSIGNED PA', country: 'DE' };

function serving(answers: Array<{ status: number; body?: unknown; location?: string }>) {
  const asked: Array<{ url: string; redirect: string | undefined; accept: string | null }> = [];
  let next = 0;
  const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    asked.push({ url: String(input), redirect: init.redirect, accept: new Headers(init.headers).get('accept') });
    const answer = answers[next++];
    if (!answer) throw new Error('asked once too often');
    return new Response(answer.body === undefined ? null : JSON.stringify(answer.body), {
      status: answer.status, headers: answer.location ? { location: answer.location } : { 'content-type': 'application/rdap+json' } });
  }) as typeof fetch;
  return { asked, fetchImpl };
}

describe('the network a registry is asked about', () => {
  it('is the /24 or the /48, never the address', () => {
    assert.equal(stillRegistryNetworkOfV1('198.51.100.77'), '198.51.100.0');
    assert.equal(stillRegistryNetworkOfV1('::ffff:198.51.100.77'), '198.51.100.0');
    assert.equal(stillRegistryNetworkOfV1('2001:db8:1234:5678::9'), '2001:db8:1234::');
    assert.equal(stillRegistryNetworkOfV1('2001:67c:2e8::1'), '2001:67c:2e8::');
    assert.equal(stillRegistryNetworkOfV1('not an address'), null);
  });
});

describe('one RDAP question', () => {
  it('reads the country of the network’s record, asking without following redirects by itself', async () => {
    const { asked, fetchImpl } = serving([{ status: 200, body: NETWORK_V1 }]);
    assert.equal(await rdapNetworkCountryV1('ripencc', '198.51.100.0', fetchImpl), 'DE');
    assert.deepEqual(asked, [{ url: 'https://rdap.db.ripe.net/ip/198.51.100.0', redirect: 'manual', accept: 'application/rdap+json, application/json;q=0.9' }]);
  });

  it('follows a registry to another registry it hands the question to, and to Brazil’s', async () => {
    const { asked, fetchImpl } = serving([{ status: 307, location: 'https://rdap.registro.br/ip/200.160.2.0' }, { status: 200, body: { ...NETWORK_V1, country: 'br' } }]);
    assert.equal(await rdapNetworkCountryV1('lacnic', '200.160.2.0', fetchImpl), 'BR');
    assert.deepEqual(asked.map((call) => call.url), ['https://rdap.lacnic.net/rdap/ip/200.160.2.0', 'https://rdap.registro.br/ip/200.160.2.0']);
  });

  it('a redirect to ARIN or anywhere else, a refusal, or a body that is not a network with a country is no answer', async () => {
    const cases: Array<Array<{ status: number; body?: unknown; location?: string }>> = [
      [{ status: 301, location: 'https://rdap.arin.net/registry/ip/8.8.8.0' }],
      [{ status: 302, location: 'http://rdap.db.ripe.net/ip/198.51.100.0' }],
      [{ status: 302 }],
      [{ status: 404, body: { errorCode: 404 } }],
      [{ status: 200, body: { ...NETWORK_V1, objectClassName: 'entity' } }],
      [{ status: 200, body: { ...NETWORK_V1, country: undefined } }],
      [{ status: 200, body: { ...NETWORK_V1, country: 'Germany' } }],
      [{ status: 200, body: ['not', 'an', 'object'] }],
      [{ status: 301, location: 'https://rdap.apnic.net/ip/1' }, { status: 301, location: 'https://rdap.db.ripe.net/ip/2' }, { status: 301, location: 'https://rdap.apnic.net/ip/3' }],
    ];
    for (const answers of cases) {
      const { fetchImpl } = serving(answers);
      assert.equal(await rdapNetworkCountryV1('ripencc', '198.51.100.0', fetchImpl), null, JSON.stringify(answers));
    }
  });
});

describe('asking about a network once a day', () => {
  it('keeps an answer for a day and a failure for a quarter of an hour, and asks once for questions at the same time', async () => {
    let now = Date.parse('2026-11-15T06:00:00Z');
    const asked: string[] = [];
    let answer: string | null = null;
    Object.assign(stillRegionRdapRuntimeV1, { now: () => now, ask: async (registry: string, network: string) => { asked.push(`${registry} ${network}`); return answer; } });
    // A failure first: kept a quarter of an hour.
    assert.equal(await stillRegistryNetworkCountryV1('ripencc', '198.51.100.7'), null);
    now += 14 * 60_000;
    assert.equal(await stillRegistryNetworkCountryV1('ripencc', '198.51.100.8'), null);
    assert.equal(asked.length, 1);
    now += 2 * 60_000;
    answer = 'DE';
    const [one, two] = await Promise.all([stillRegistryNetworkCountryV1('ripencc', '198.51.100.9'), stillRegistryNetworkCountryV1('ripencc', '198.51.100.10')]);
    assert.deepEqual([one, two, asked.length], ['DE', 'DE', 2]);
    now += 23 * 3600_000;
    answer = 'US';
    assert.equal(await stillRegistryNetworkCountryV1('ripencc', '198.51.100.11'), 'DE');
    now += 2 * 3600_000;
    assert.equal(await stillRegistryNetworkCountryV1('ripencc', '198.51.100.12'), 'US');
    assert.deepEqual(asked, ['ripencc 198.51.100.0', 'ripencc 198.51.100.0', 'ripencc 198.51.100.0']);
    // Another network, or another registry, is its own question.
    await stillRegistryNetworkCountryV1('ripencc', '198.51.101.1');
    await stillRegistryNetworkCountryV1('apnic', '198.51.100.1');
    assert.deepEqual(asked.slice(3), ['ripencc 198.51.101.0', 'apnic 198.51.100.0']);
  });

  it('a question that throws is a failure, kept like one', async () => {
    let calls = 0;
    Object.assign(stillRegionRdapRuntimeV1, { ask: async () => { calls++; throw new Error('timeout'); } });
    assert.equal(await stillRegistryNetworkCountryV1('afrinic', '196.216.2.1'), null);
    assert.equal(await stillRegistryNetworkCountryV1('afrinic', '196.216.2.9'), null);
    assert.equal(calls, 1);
  });
});
