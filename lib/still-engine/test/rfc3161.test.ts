import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { rfc3161RequestV1, rfc3161ResponseV1, rfc3161StampsV1 } from '../src/rfc3161.js';

// A real reply: DigiCert's public time-stamping service stamped the SHA-256 of a random test line on
// 2026-11-17 (audit LOOP-4). Nothing in it is anyone's; its signature checks with openssl against the system's roots.
const fixture = (name: string) => new URL(`./fixtures/${name}`, import.meta.url);
const REPLY = new Uint8Array(Buffer.from(readFileSync(fixture('rfc3161-digicert.tsr.b64'), 'utf8'), 'base64'));
const DATA = readFileSync(fixture('rfc3161-digicert.data.txt'), 'utf8');
const DIGEST = createHash('sha256').update(DATA, 'utf8').digest();

describe('RFC 3161 time-stamps', () => {
  it('asks for a SHA-256 imprint, a nonce and the authority’s certificate, in DER', () => {
    const request = rfc3161RequestV1(new Uint8Array(32).fill(0xab), Uint8Array.from([0x80, 1, 2, 3]));
    assert.equal(Buffer.from(request).toString('hex'),
      '3040020101' + '3031300d060960864801650304020105000420' + 'ab'.repeat(32) + '02050080010203' + '0101ff');
    assert.throws(() => rfc3161RequestV1(new Uint8Array(31), Uint8Array.of(1)), RangeError);
  });

  it('reads the status, the imprint, the time and the nonce from a real reply', () => {
    const reading = rfc3161ResponseV1(REPLY);
    assert.deepEqual(reading, {
      status: 0, hashOid: '2.16.840.1.101.3.4.2.1', imprint: DIGEST.toString('hex'),
      genTime: '2026-11-17T23:37:19.000Z', nonce: reading?.nonce,
    });
    assert.match(reading!.nonce!, /^[0-9a-f]{1,32}$/);
    assert.equal(rfc3161StampsV1(reading, DIGEST), true);
    assert.equal(rfc3161StampsV1(reading, createHash('sha256').update(`${DATA}.`).digest()), false, 'another list');
    assert.equal(rfc3161StampsV1(reading, DIGEST, Uint8Array.of(1, 2, 3)), false, 'another request');
  });

  it('is nothing for what is not a reply, and a refusal says so with no stamp', () => {
    assert.equal(rfc3161ResponseV1(new Uint8Array()), null);
    assert.equal(rfc3161ResponseV1(REPLY.subarray(0, 200)), null);
    assert.equal(rfc3161ResponseV1(Uint8Array.from([0x30, 0x03, 0x02, 0x01, 0x00, 0x00])), null);
    // status 2: rejection, with no token.
    const refused = rfc3161ResponseV1(Uint8Array.from([0x30, 0x05, 0x30, 0x03, 0x02, 0x01, 0x02]));
    assert.deepEqual(refused, { status: 2, hashOid: null, imprint: null, genTime: null, nonce: null });
    assert.equal(rfc3161StampsV1(refused, DIGEST), false);
  });
});
