import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import express from 'express';
import request from 'supertest';
import type { MirrorOutcome, MirrorService } from '@mioagent/still-engine';

import { stillMineRouter, stillMineRuntimeV1 } from './stillMine.js';

const original = { ...stillMineRuntimeV1 };
afterEach(() => Object.assign(stillMineRuntimeV1, original));

const WALLET = `0x${'1'.repeat(40)}`;

function app(wallet: string | null, answer: (input: string) => Promise<MirrorOutcome>) {
  const asked: string[] = [];
  const service: MirrorService = {
    check: async (input) => {
      asked.push(input);
      return answer(input);
    },
    earnings: async () => ({ ok: false }),
    dividends: async () => assert.fail('not asked'),
  };
  stillMineRuntimeV1.service = () => service;
  const server = express();
  server.use((req, _res, next) => {
    Object.assign(req, { session: { user: wallet ? { id: `eip155:8453:${wallet}`, address: wallet, chainId: 8453 } : null } });
    next();
  });
  server.use('/api/still', stillMineRouter);
  return { server, asked };
}

const report = (address: string) =>
  ({ outcome: 'report', report: { kind: 'still.mirror', subject: { address, name: null, input: address } }, cached: false }) as unknown as MirrorOutcome;

test('the session’s wallet and nobody else’s: no session, the zero address and a named account are refused', async () => {
  for (const wallet of [null, `0x${'0'.repeat(40)}`]) {
    const { server, asked } = app(wallet, async () => assert.fail('not asked'));
    assert.equal((await request(server).get('/api/still/mine')).status, 401);
    assert.deepEqual(asked, []);
  }
  const { server, asked } = app(WALLET, async () => assert.fail('not asked'));
  const named = await request(server).get('/api/still/mine').query({ subject: `0x${'2'.repeat(40)}` });
  assert.equal(named.status, 400);
  assert.deepEqual(asked, []);
});

test('answers the wallet’s report, never cached by anyone in between', async () => {
  const { server, asked } = app(WALLET, async (input) => report(input));
  const res = await request(server).get('/api/still/mine');
  assert.equal(res.status, 200);
  assert.equal(res.headers['cache-control'], 'private, no-store');
  assert.equal(res.body.report.subject.address, WALLET);
  assert.deepEqual(asked, [WALLET]);
});

test('a report about another address is our failure and is never shown', async () => {
  const { server } = app(WALLET, async () => report(`0x${'2'.repeat(40)}`));
  const res = await request(server).get('/api/still/mine');
  assert.equal(res.status, 500);
  assert.deepEqual(res.body, { outcome: 'internal_error' });
});

test('an unreadable chain is 503 and names no provider address', async () => {
  const { server } = app(WALLET, async () => ({ outcome: 'chain_unavailable', attempts: [{ provider: 'base-public', kind: 'throttled' }] }));
  const res = await request(server).get('/api/still/mine');
  assert.equal(res.status, 503);
  assert.doesNotMatch(res.text, /https?:/);
  const failing = app(WALLET, async () => {
    throw new Error('https://base-mainnet.example/v3/SECRET failed');
  });
  const failed = await request(failing.server).get('/api/still/mine');
  assert.equal(failed.status, 500);
  assert.doesNotMatch(failed.text, /SECRET|https?:/);
});
