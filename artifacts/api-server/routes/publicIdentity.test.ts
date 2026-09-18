import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import request from 'supertest';

import { publicIdentityRouter, publicIdentityRuntime } from './publicIdentity.js';

const OFFICIAL = '0xb200000000000000000000c2e324d24d7eecd1fb';
const IMPOSTOR = '0x1111111111111111111111111111111111111111';

function appV1() {
  const app = express();
  app.use('/api/public', publicIdentityRouter);
  return app;
}

function readingV1(over: Record<string, unknown> = {}) {
  return {
    schemaVersion: 'address-identity/v1' as const,
    chainId: 8453 as const,
    tokenAddress: IMPOSTOR,
    standing: 'known_lookalike' as const,
    answer: 'No. It is not AAPLc.',
    official: null,
    issuerRepresentation: null,
    lookalike: {
      officialAddress: OFFICIAL,
      officialTicker: 'AAPLc',
      matchKind: 'symbol_exact',
      matchedAlias: 'underlying',
      matchedValue: 'aapl',
      declaredSymbol: 'AAPL',
      declaredName: 'apple on base',
      firstFlaggedAt: '2026-08-31T00:00:00.000Z',
    },
    corpus: { lookalikeRows: 160, lookalikesLastScannedAt: '2026-09-16T03:00:00.000Z' },
    caveats: ['Compare ADDRESSES, not symbols.'],
    generatedAt: '2026-09-16T08:00:00.000Z',
    ...over,
  };
}

test('the identity check answers with no session at all', async (t) => {
  const previous = publicIdentityRuntime.check;
  t.after(() => {
    publicIdentityRuntime.check = previous;
  });
  const asked: unknown[] = [];
  publicIdentityRuntime.check = async (args: unknown) => {
    asked.push(args);
    return readingV1() as never;
  };

  const response = await request(appV1()).get(`/api/public/identity/${IMPOSTOR}`).expect(200);
  assert.deepEqual(asked, [{ chainId: 8453, tokenAddress: IMPOSTOR }]);
  assert.equal(response.body.standing, 'known_lookalike');
  // The address to compare against travels with the verdict: a symbol is what
  // an impostor supplies.
  assert.equal(response.body.lookalike.officialAddress, OFFICIAL);
  assert.match(String(response.headers['cache-control']), /max-age=60/);
});

test('a ticker is refused rather than resolved to somebody', async (t) => {
  const previous = publicIdentityRuntime.check;
  let called = false;
  t.after(() => {
    publicIdentityRuntime.check = previous;
  });
  publicIdentityRuntime.check = async () => {
    called = true;
    return readingV1() as never;
  };
  const response = await request(appV1()).get('/api/public/identity/AAPLc').expect(400);
  assert.equal(response.body.code, 'exact_address_required');
  assert.match(String(response.body.detail), /different issuers publish different contracts/);
  assert.equal(called, false, 'a non-address must not reach the corpus');
});

test('an outage here says nothing about the token', async (t) => {
  const previous = publicIdentityRuntime.check;
  t.after(() => {
    publicIdentityRuntime.check = previous;
  });
  publicIdentityRuntime.check = async () => {
    throw Object.assign(new Error('boom'), { code: 'identity_check_unavailable' });
  };
  const response = await request(appV1()).get(`/api/public/identity/${OFFICIAL}`).expect(503);
  assert.equal(response.body.code, 'identity_check_unavailable');
  assert.match(String(response.body.detail), /says nothing about the token/);
  // Never the thrown sentence: a database message must not become a statement
  // about somebody's contract.
  assert.doesNotMatch(JSON.stringify(response.body), /boom/);
});

test('an address is accepted in any casing, and the reading is not a verdict on the corpus', async (t) => {
  const previous = publicIdentityRuntime.check;
  t.after(() => {
    publicIdentityRuntime.check = previous;
  });
  const asked: { tokenAddress?: string }[] = [];
  publicIdentityRuntime.check = async (args: unknown) => {
    asked.push(args as { tokenAddress?: string });
    return readingV1({
      tokenAddress: OFFICIAL,
      standing: 'unknown_to_miorail',
      answer: 'Miorail has nothing on file.',
      lookalike: null,
    }) as never;
  };
  const mixed = `0xB200000000000000000000C2E324D24D7EECD1FB`;
  const response = await request(appV1()).get(`/api/public/identity/${mixed}`).expect(200);
  // The route passes the address through; normalization belongs to the one
  // assembler that owns it, so two surfaces cannot normalize differently.
  assert.equal(asked[0]?.tokenAddress, mixed);
  assert.equal(response.body.standing, 'unknown_to_miorail');
});
