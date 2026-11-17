import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { encodeAbiParameters } from 'viem';

import { COINBASE_VERIFIED_V1, coinbaseVerifiedAccountV1, type CoinbaseVerifiedReaderV1 } from './coinbaseVerified.js';

const WALLET = `0x${'ab'.repeat(20)}`;
const UID = `0x${'12'.repeat(32)}`;
const NOW = new Date('2026-11-22T10:00:00.000Z');
const TRUE = encodeAbiParameters([{ type: 'bool' }], [true]);

function reader(patch: Record<string, unknown> = {}, uid: string = UID) {
  const calls: string[] = [];
  const attestation = {
    uid: UID, schema: COINBASE_VERIFIED_V1.schema, time: 1n, expirationTime: 0n, revocationTime: 0n, refUID: `0x${'0'.repeat(64)}`,
    recipient: WALLET.toUpperCase().replace('0X', '0x'), attester: COINBASE_VERIFIED_V1.attester, revocable: true, data: TRUE, ...patch,
  };
  const r: CoinbaseVerifiedReaderV1 = {
    readContract: async (args) => {
      calls.push(`${args.address}:${args.functionName}`);
      if (args.functionName === 'getAttestationUid') {
        assert.deepEqual(args.args, [WALLET, COINBASE_VERIFIED_V1.schema]);
        return uid;
      }
      assert.deepEqual(args.args, [uid]);
      return attestation;
    },
  };
  return { r, calls };
}

describe('Coinbase’s Verified Account attestation', () => {
  it('counts a live one from Coinbase’s attester, of its schema, for this wallet, saying true', async () => {
    const { r, calls } = reader();
    assert.equal(await coinbaseVerifiedAccountV1(WALLET, r, NOW), true);
    assert.deepEqual(calls, [`${COINBASE_VERIFIED_V1.indexer}:getAttestationUid`, `${COINBASE_VERIFIED_V1.eas}:getAttestation`]);
    assert.equal(await coinbaseVerifiedAccountV1(WALLET, reader({ expirationTime: BigInt(NOW.getTime() / 1000 + 60) }).r, NOW), true, 'not expired yet');
  });

  it('counts nothing else, and reads nothing for what is not an address', async () => {
    const { r, calls } = reader({}, `0x${'0'.repeat(64)}`);
    assert.equal(await coinbaseVerifiedAccountV1(WALLET, r, NOW), false, 'no attestation');
    assert.equal(calls.length, 1);
    for (const patch of [
      { attester: `0x${'99'.repeat(20)}` }, { revocationTime: 5n }, { expirationTime: BigInt(NOW.getTime() / 1000) }, { schema: `0x${'34'.repeat(32)}` },
      { recipient: `0x${'cd'.repeat(20)}` }, { uid: `0x${'56'.repeat(32)}` }, { data: encodeAbiParameters([{ type: 'bool' }], [false]) }, { data: '0x' },
    ]) {
      assert.equal(await coinbaseVerifiedAccountV1(WALLET, reader(patch).r, NOW), false, JSON.stringify(patch, (_k, v) => typeof v === 'bigint' ? String(v) : v));
    }
    const none = reader();
    assert.equal(await coinbaseVerifiedAccountV1('nope', none.r, NOW), false);
    assert.deepEqual(none.calls, []);
  });

  it('throws when Base could not be read, so a failure is never read as unverified', async () => {
    const failing: CoinbaseVerifiedReaderV1 = { readContract: async () => { throw new Error('rpc down'); } };
    await assert.rejects(coinbaseVerifiedAccountV1(WALLET, failing, NOW), /rpc down/);
  });
});
