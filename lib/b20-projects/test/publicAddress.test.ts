import assert from 'node:assert/strict';
import { createServer, type AddressInfo, type LookupFunction } from 'node:net';
import { describe, it } from 'node:test';
import { isNonPublicHostV1 } from '../src/claimFile.js';
import { B20NonPublicAddressError, createPublicOnlyFetchV1, createPublicOnlyLookupV1, nonPublicAddressV1 } from '../src/publicAddress.js';

// The guard read the host as text, so IPv6 literals passed, and a name passed by definition: the fetch then
// connected to whatever DNS answered (audit AUTH-5, 2026-11-14).
describe('only a public address is connected to', () => {
  it('refuses the IPv6 forms that passed, by the hostname a URL gives', () => {
    for (const url of ['https://[::ffff:127.0.0.1]/', 'https://[::ffff:169.254.169.254]/', 'https://[::]/', 'https://[fe80::1]/', 'https://[::127.0.0.1]/',
      'https://[::1]/', 'https://[fc00::1]/', 'https://[fd12:3456::1]/', 'https://[ff02::1]/', 'https://[2001:db8::1]/', 'https://[64:ff9b::7f00:1]/',
      'https://[2002:7f00:1::1]/', 'https://[2001::1]/', 'https://[fec0::1]/', 'https://[100::1]/',
      'https://0x7f.1/', 'https://2130706433/', 'https://127.1/', 'https://100.64.0.1/', 'https://198.18.0.1/', 'https://224.0.0.1/',
      'https://240.0.0.1/', 'https://255.255.255.255/', 'https://192.0.2.1/', 'https://0.0.0.0/']) {
      assert.equal(isNonPublicHostV1(new URL(url).hostname), true, `${url} (${new URL(url).hostname}) passed`);
    }
    for (const host of ['8.8.8.8', '1.1.1.1', '[2606:4700:4700::1111]', '2a00:1450:4001:82a::200e', 'miorail.xyz', 'fdroid.org', 'fcm.example']) {
      assert.equal(isNonPublicHostV1(host), false, `${host} was refused`);
    }
    for (const host of ['claims.internal', 'printer.home.arpa', 'localhost.', 'a.localhost']) assert.equal(isNonPublicHostV1(host), true, host);
  });

  it('a name is resolved and refused when any of its addresses is not public', async () => {
    const lookupWith = (addresses: { address: string; family: number }[]) => createPublicOnlyLookupV1((_host, callback) => callback(null, addresses));
    const ask = (lookup: LookupFunction, options: { all?: boolean; family?: number } = {}) =>
      new Promise<{ error: unknown; address: unknown; family: unknown }>((resolve) => {
        lookup('claims.example.org', options as never, (error, address, family) => resolve({ error, address, family }));
      });
    assert.deepEqual(await ask(lookupWith([{ address: '93.184.216.34', family: 4 }])), { error: null, address: '93.184.216.34', family: 4 });
    const both = [{ address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 }, { address: '93.184.216.34', family: 4 }];
    assert.deepEqual((await ask(lookupWith(both), { all: true })).address, both);
    assert.deepEqual(await ask(lookupWith(both), { family: 4 }), { error: null, address: '93.184.216.34', family: 4 });
    for (const answer of [[{ address: '127.0.0.1', family: 4 }], [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.7', family: 4 }],
      [{ address: '::ffff:169.254.169.254', family: 6 }], [{ address: 'fd00::1', family: 6 }], []]) {
      const { error } = await ask(lookupWith(answer));
      assert.ok(error instanceof B20NonPublicAddressError, JSON.stringify(answer));
    }
  });

  it('a name that resolves to this machine is never connected to', async () => {
    let connections = 0;
    const server = createServer((socket) => { connections += 1; socket.destroy(); });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    try {
      const fetchPublic = createPublicOnlyFetchV1({ lookup: createPublicOnlyLookupV1((_host, callback) => callback(null, [{ address: '127.0.0.1', family: 4 }])) });
      await assert.rejects(fetchPublic(`https://rebound.example.org:${port}/claim.json`), (error: unknown) => error instanceof B20NonPublicAddressError);
      await assert.rejects(fetchPublic(`https://[::ffff:127.0.0.1]:${port}/claim.json`), (error: unknown) => error instanceof B20NonPublicAddressError);
      await assert.rejects(fetchPublic(`http://example.org:${port}/`), /only https/);
      assert.equal(connections, 0);
    } finally {
      server.close();
    }
  });

  it('classifies an address literal on its own, brackets and interface scopes included', () => {
    assert.deepEqual(['8.8.8.8', '[2606:4700::1111]', 'fe80::1%eth0', 'not-an-address', '999.1.1.1', '1::2::3'].map(nonPublicAddressV1), [false, false, true, true, true, true]);
  });
});
