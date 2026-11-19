import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import express from 'express';
import request from 'supertest';
import { InMemoryStillLoopRepositoryV1, type StillLoopCandidateV1 } from '@mioagent/route-storage';

import { stillLoopsRuntimeV1, stillLoopWeekStartV1 } from '../lib/stillLoops.js';
import { forgetStillLoopsPublicV1, publicStillLoopsRouter, stillLoopsRouter } from './stillLoops.js';

const WALLET = `0x${'a'.repeat(40)}`, OTHER = `0x${'b'.repeat(40)}`;
const NOW = new Date('2026-11-20T15:00:00.000Z');
const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const candidate = (n: number, patch: Partial<StillLoopCandidateV1> = {}): StillLoopCandidateV1 => ({
  executionId: id(n), walletAddress: WALLET, brand: 'apple', collateral: 'AAPLc', productId: 'itunes-germany', productName: 'iTunes Germany',
  packageLabel: '25 EUR', priceRoundedAtomic: '27000000', venue: 'aave-v4', via: 'claude', team: false, confirmedAt: '2026-11-20T12:34:56.000Z', ...patch,
});

function app(owner: string | null = WALLET) {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => {
    if (owner) Object.defineProperty(req, 'session', { value: { user: { id: `eip155:8453:${owner}`, address: owner, chainId: 8453 } } });
    next();
  });
  a.use('/api/public/still', publicStillLoopsRouter);
  a.use('/api/still/loops', stillLoopsRouter);
  return a;
}

const original = { ...stillLoopsRuntimeV1 };
let repository: InMemoryStillLoopRepositoryV1, names: Record<string, string | null>;
beforeEach(async () => {
  forgetStillLoopsPublicV1();
  repository = new InMemoryStillLoopRepositoryV1();
  names = {};
  Object.assign(stillLoopsRuntimeV1, { enabled: () => true, repository: () => repository, now: () => NOW, basename: async (wallet: string) => names[wallet] ?? null });
  await repository.record([candidate(1), candidate(2, { via: 'web', walletAddress: OTHER }), candidate(3, { team: true })]);
  for (const n of [1, 2, 3]) await repository.markDelivery({ executionId: id(n), outcome: 'complete', at: NOW });
});
afterEach(() => {
  Object.assign(stillLoopsRuntimeV1, original);
  forgetStillLoopsPublicV1();
});

describe('Loops in public', () => {
  it('say nothing while Loops are off', async () => {
    Object.assign(stillLoopsRuntimeV1, { enabled: () => false });
    assert.equal((await request(app(null)).get('/api/public/still/loops')).status, 404);
    assert.equal((await request(app()).post(`/api/still/loops/${id(1)}/wall`).send({ showName: false })).status, 404);
  });

  it('count complete Loops outside the team, and show only those their owners put on the wall, with no wallet', async () => {
    const empty = await request(app(null)).get('/api/public/still/loops').expect(200);
    assert.deepEqual(empty.body.counts, { total: 2, week: 2, byBrand: { apple: 2, amazon: 0, google: 0, meta: 0, microsoft: 0 }, viaAssistant: 1 });
    assert.equal(empty.body.weekStartsAt, '2026-11-16T00:00:00.000Z');
    assert.deepEqual(empty.body.wall, []);
    names[WALLET] = 'alice.base.eth';
    const walled = await request(app()).post(`/api/still/loops/${id(1)}/wall`).send({ showName: true }).expect(200);
    assert.deepEqual([walled.body.label, walled.body.loop.onWall, walled.body.nameShown], ['alice.base.eth', true, true]);
    const wall = (await request(app(null)).get('/api/public/still/loops').expect(200)).body.wall;
    assert.deepEqual(wall, [{ loopNo: 1, brand: 'apple', brandName: 'Apple', card: 'Apple gift card', productName: 'iTunes Germany', packageLabel: '25 EUR',
      priceUsdc: '27', venueName: 'Aave', via: 'claude', day: '2026-11-20', label: 'alice.base.eth' }]);
    assert.doesNotMatch(JSON.stringify(wall), new RegExp(WALLET.slice(2, 12)));
  });

  it('take a Loop to the wall only from its own owner, once its card arrived, and show a name only when asked and plain', async () => {
    assert.equal((await request(app(null)).post(`/api/still/loops/${id(1)}/wall`).send({ showName: false })).status, 401);
    assert.equal((await request(app()).post('/api/still/loops/not-an-id/wall').send({ showName: false })).status, 400);
    assert.equal((await request(app()).post(`/api/still/loops/${id(1)}/wall`).send({ showName: 'yes' })).status, 400);
    assert.equal((await request(app(OTHER)).post(`/api/still/loops/${id(1)}/wall`).send({ showName: false })).status, 409);
    assert.equal((await request(app()).post(`/api/still/loops/${id(3)}/wall`).send({ showName: false })).status, 409, 'the team’s');
    await repository.record([candidate(4)]);
    assert.equal((await request(app()).post(`/api/still/loops/${id(4)}/wall`).send({ showName: false })).status, 409, 'before the card arrived');
    names[WALLET] = 'Ålice.base.eth';
    const plain = await request(app()).post(`/api/still/loops/${id(1)}/wall`).send({ showName: true }).expect(200);
    assert.deepEqual([plain.body.label, plain.body.nameShown], [null, false], 'a name it cannot show plainly is not shown');
  });

  it('start the week on Monday, UTC', () => {
    assert.equal(stillLoopWeekStartV1(new Date('2026-11-16T00:00:00.000Z')).toISOString(), '2026-11-16T00:00:00.000Z');
    assert.equal(stillLoopWeekStartV1(new Date('2026-11-22T23:59:59.000Z')).toISOString(), '2026-11-16T00:00:00.000Z');
    assert.equal(stillLoopWeekStartV1(new Date('2026-11-23T00:00:00.000Z')).toISOString(), '2026-11-23T00:00:00.000Z');
  });
});

describe('a wallet’s own Loops', () => {
  it('are its own alone, newest first, with the number, the card and the wall, and need its session', async () => {
    const mine = await request(app()).get('/api/still/loops/mine');
    assert.equal(mine.status, 200);
    assert.equal(mine.headers['cache-control'], 'private, no-store');
    assert.deepEqual(mine.body, { outcome: 'mine', loops: [{ loopNo: 1, brand: 'apple', complete: true, undelivered: null, onWall: false, team: false,
      executionId: id(1), productName: 'iTunes Germany', packageLabel: '25 EUR', day: '2026-11-20' }] });
    assert.equal((await request(app(OTHER)).get('/api/still/loops/mine')).body.loops.length, 1);
    assert.equal((await request(app(null)).get('/api/still/loops/mine')).status, 401);
    Object.assign(stillLoopsRuntimeV1, { enabled: () => false });
    assert.equal((await request(app()).get('/api/still/loops/mine')).status, 404);
  });
});
