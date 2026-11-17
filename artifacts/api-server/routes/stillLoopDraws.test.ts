import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import express from 'express';
import request from 'supertest';
import { InMemoryStillLoopDrawRepositoryV1, InMemoryStillLoopRepositoryV1, type StillLoopCandidateV1 } from '@mioagent/route-storage';
import { LOOP_DRAWS_V1, loopDrawListHashV1, loopDrawWinnerV1, loopDrawWinnersV1, type LoopDrawBlockV1 } from '@mioagent/still-engine/loop-draws';
import { keccak256, stringToHex } from 'viem';

import { settleStillLoopDrawsV1, stillLoopDrawRuntimeV1 } from '../lib/stillLoopDraws.js';
import { stillRegionRuntimeV1 } from '../lib/stillRegion.js';
import { stillLoopsRuntimeV1 } from '../lib/stillLoops.js';
import { forgetStillLoopsPublicV1, publicStillLoopsRouter, stillLoopsRouter } from './stillLoops.js';

const A = `0x${'a'.repeat(40)}`, B = `0x${'b'.repeat(40)}`, C = `0x${'c'.repeat(40)}`, TEAM = `0x${'d'.repeat(40)}`, D = `0x${'e'.repeat(40)}`;
const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const candidate = (n: number, patch: Partial<StillLoopCandidateV1> = {}): StillLoopCandidateV1 => ({
  executionId: id(n), walletAddress: A, brand: 'apple', collateral: 'AAPLc', productId: 'itunes-germany', productName: 'iTunes Germany',
  packageLabel: '25 EUR', priceRoundedAtomic: '27000000', venue: 'aave-v4', via: 'claude', team: false, confirmedAt: '2026-11-22T08:00:00.000Z', ...patch,
});

function app(owner: string | null) {
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

// A Base whose blocks come every two seconds from GENESIS.
const GENESIS = Date.parse('2026-11-01T00:00:00.000Z') / 1000;
const blockAt = (n: bigint): LoopDrawBlockV1 => ({ number: n, hash: keccak256(stringToHex(`block ${n}`)), timestamp: BigInt(GENESIS) + n * 2n });

const loops = { ...stillLoopsRuntimeV1 }, draws = { ...stillLoopDrawRuntimeV1 }, region = { ...stillRegionRuntimeV1 };
let loopRepo: InMemoryStillLoopRepositoryV1, drawRepo: InMemoryStillLoopDrawRepositoryV1, now: Date, verified: Set<string>, codes: string[], reads: number;

beforeEach(() => {
  forgetStillLoopsPublicV1();
  loopRepo = new InMemoryStillLoopRepositoryV1();
  drawRepo = new InMemoryStillLoopDrawRepositoryV1();
  now = new Date('2026-11-22T10:00:00.000Z');
  verified = new Set([A, B, TEAM]);
  codes = ['K3F9X2', 'AB12CD', 'QW34ER', 'ZX56CV'];
  reads = 0;
  const team = new Set([TEAM]);
  Object.assign(stillLoopsRuntimeV1, { enabled: () => true, team: () => team, repository: () => loopRepo, now: () => now });
  Object.assign(stillLoopDrawRuntimeV1, {
    enabled: () => true, repository: () => drawRepo, loops: () => loopRepo, team: () => team, now: () => now,
    verified: async (wallet: string) => verified.has(wallet), code: () => codes.shift() ?? 'QQQQQQ',
    head: async () => { reads += 1; return blockAt((BigInt(Math.floor(now.getTime() / 1000)) - BigInt(GENESIS)) / 2n); },
    block: async (n: bigint) => { reads += 1; return blockAt(n); },
  });
});
afterEach(() => {
  Object.assign(stillLoopsRuntimeV1, loops);
  Object.assign(stillLoopDrawRuntimeV1, draws);
  Object.assign(stillRegionRuntimeV1, region);
  forgetStillLoopsPublicV1();
});

const enter = (wallet: string | null, body: unknown = { rules: true }) => request(app(wallet)).post('/api/still/loops/draw/enter').send(body as object);
const publicLoops = async () => { forgetStillLoopsPublicV1(); return (await request(app(null)).get('/api/public/still/loops').expect(200)).body; };

describe('the Loop draws', () => {
  it('say nothing and take nothing while off', async () => {
    Object.assign(stillLoopDrawRuntimeV1, { enabled: () => false });
    assert.equal((await publicLoops()).draws, null);
    assert.equal((await enter(A)).status, 404);
    assert.equal((await request(app(A)).get('/api/still/loops/draw')).status, 404);
    assert.equal((await request(app(null)).get('/api/public/still/loops/draws/2026-11-28')).status, 404);
  });

  it('take one free entry per verified wallet while open, and none from the team, the unverified, the signed out or before it opens', async () => {
    assert.equal((await enter(null)).status, 401);
    assert.equal((await enter(A, {})).status, 400, 'the rules are accepted, not assumed');
    assert.equal((await enter(A, { rules: true, extra: 1 })).status, 400);
    const first = await enter(A).expect(200);
    assert.deepEqual(first.body, { outcome: 'entered', drawId: '2026-11-28', closesAt: '2026-11-28T18:00:00.000Z', entry: { label: 'Entry K3F9X2', kind: 'free' } });
    assert.deepEqual((await enter(A).expect(200)).body.entry, { label: 'Entry K3F9X2', kind: 'free' });
    assert.equal((await enter(A).expect(200)).body.outcome, 'already');
    const unverified = await enter(C).expect(403);
    assert.equal(unverified.body.error, 'not_verified');
    assert.equal(unverified.body.url, 'https://www.coinbase.com/onchain-verify');
    assert.equal((await enter(TEAM).expect(409)).body.error, 'draw_team');
    now = new Date('2026-11-20T23:59:59.000Z');
    const early = await enter(B).expect(409);
    assert.deepEqual([early.body.error, early.body.next], ['draw_not_open', { drawId: '2026-11-28', opensAt: '2026-11-21T00:00:00.000Z' }]);
    now = new Date('2026-11-22T11:00:00.000Z');
    const mine = (await request(app(A)).get('/api/still/loops/draw').expect(200)).body;
    assert.deepEqual(mine.current, { drawId: '2026-11-28', closesAt: '2026-11-28T18:00:00.000Z', entry: { label: 'Entry K3F9X2', kind: 'free' } });
    assert.equal((await request(app(TEAM)).get('/api/still/loops/draw').expect(200)).body.team, true);
    const open = (await publicLoops()).draws.current;
    assert.deepEqual([open.drawId, open.state, open.entries, open.prizeUsdc, open.entriesHash], ['2026-11-28', 'open', 1, '10', null]);
  });

  it('ask the region and the confirmation a new loan asks, before anything is read or written', async () => {
    Object.assign(stillRegionRuntimeV1, { enabled: () => true, table: () => null, registryTable: () => null });
    const refused = await enter(A).expect(403);
    assert.equal(refused.body.error, 'region_unchecked');
    assert.equal(await drawRepo.freeEntry({ drawId: '2026-11-28', walletAddress: A }), null);
  });

  it('count a Loop whose card arrived while open as its wallet’s entry, with no attestation asked', async () => {
    await loopRepo.record([candidate(1, { walletAddress: C })]);
    await loopRepo.markDelivery({ executionId: id(1), outcome: 'complete', at: new Date('2026-11-22T09:00:00.000Z') });
    const already = await enter(C).expect(200);
    assert.deepEqual([already.body.outcome, already.body.entry], ['already', { label: 'Loop #1', kind: 'loop' }]);
    assert.deepEqual((await request(app(C)).get('/api/still/loops/draw').expect(200)).body.current.entry, { label: 'Loop #1', kind: 'loop' });
  });

  it('fix the list after the close, then let the first Base block five minutes on pick the winner, as anybody can check', async () => {
    await enter(A).expect(200);                                             // Entry K3F9X2, 10:00
    await loopRepo.record([candidate(1, { walletAddress: C }), candidate(2, { walletAddress: A }), candidate(3, { walletAddress: TEAM, team: true })]);
    await loopRepo.markDelivery({ executionId: id(1), outcome: 'complete', at: new Date('2026-11-22T09:00:00.000Z') });   // Loop #1, before A
    await loopRepo.markDelivery({ executionId: id(2), outcome: 'complete', at: new Date('2026-11-23T09:00:00.000Z') });   // A's Loop: A entered first
    await loopRepo.markDelivery({ executionId: id(3), outcome: 'complete', at: new Date('2026-11-23T09:00:00.000Z') });   // the team's: never
    now = new Date('2026-11-28T17:59:59.000Z');
    await enter(B).expect(200);                                             // Entry AB12CD, a second before the close
    now = new Date('2026-11-28T18:00:10.000Z');
    verified.add(D);
    assert.equal((await enter(D).expect(200)).body.drawId, '2026-12-03', 'after the close, an entry is in the next draw');
    await settleStillLoopDrawsV1();
    assert.equal(await drawRepo.byId('2026-11-28'), null, 'not fixed before 30 seconds');
    assert.equal((await request(app(null)).get('/api/public/still/loops/draws/2026-11-28')).status, 404);
    assert.equal((await publicLoops()).draws.past[0].state, 'closing');
    now = new Date('2026-11-28T18:00:30.400Z');
    await settleStillLoopDrawsV1();
    const fixed = (await request(app(null)).get('/api/public/still/loops/draws/2026-11-28').expect(200)).body;
    const labels = ['Loop #1', 'Entry K3F9X2', 'Entry AB12CD'];
    assert.deepEqual(fixed.labels, labels);
    assert.equal(fixed.lockedAt, '2026-11-28T18:00:31.000Z');
    assert.equal(fixed.entriesHash, loopDrawListHashV1({ drawId: '2026-11-28', closesAt: '2026-11-28T18:00:00.000Z', labels }));
    assert.equal(fixed.blockAt, '2026-11-28T18:05:31.000Z');
    assert.deepEqual([fixed.block, fixed.winnerNos, fixed.winnerCount], [null, null, 1]);
    assert.doesNotMatch(JSON.stringify(fixed), /0x(a|b|c|d|e){40}/);
    now = new Date('2026-11-28T18:06:00.000Z');
    await settleStillLoopDrawsV1();
    assert.equal((await drawRepo.byId('2026-11-28'))?.drawnAt, null, 'the block is read a minute after it is due');
    now = new Date('2026-11-28T18:06:31.000Z');
    await settleStillLoopDrawsV1();
    const drawn = (await request(app(null)).get('/api/public/still/loops/draws/2026-11-28').expect(200)).body;
    const target = Date.parse('2026-11-28T18:05:31.000Z') / 1000;
    const expected = blockAt(BigInt(Math.ceil((target - GENESIS) / 2)));
    assert.deepEqual(drawn.block, { number: expected.number.toString(), hash: expected.hash, time: new Date(Number(expected.timestamp) * 1000).toISOString() });
    assert.deepEqual(drawn.winnerNos, [loopDrawWinnerV1({ blockHash: expected.hash, drawId: '2026-11-28', count: 3 })]);
    assert.ok(reads <= 30, `${reads} block reads`);
    const winnerNo: number = drawn.winnerNos[0];
    const winner = [C, A, B][winnerNo - 1]!;
    const mine = (await request(app(winner)).get('/api/still/loops/draw').expect(200)).body;
    assert.deepEqual(mine.entered, [{ drawId: '2026-11-28', label: labels[winnerNo - 1], won: true, paid: false, prizeUsdc: '10' }]);
    const past = (await publicLoops()).draws.past[0];
    assert.deepEqual([past.state, past.entries, past.winners], ['drawn', 3, [{ no: winnerNo, label: labels[winnerNo - 1], paid: false }]]);
    await drawRepo.paid({ drawId: '2026-11-28', no: winnerNo, paidTx: `0x${'7'.repeat(64)}`, at: now });
    assert.deepEqual((await publicLoops()).draws.past[0].winners[0].paid, true);
    assert.equal((await request(app(winner)).get('/api/still/loops/draw').expect(200)).body.entered[0].paid, true);
    const loser = [C, A, B].find((wallet) => wallet !== winner)!;
    assert.equal((await request(app(loser)).get('/api/still/loops/draw').expect(200)).body.entered[0].won, false);
    assert.deepEqual((await request(app(D)).get('/api/still/loops/draw').expect(200)).body.current.entry, { label: 'Entry QW34ER', kind: 'free' });
    assert.deepEqual((await request(app(D)).get('/api/still/loops/draw').expect(200)).body.entered, [], 'not in the first');
  });

  it('draw a list nobody entered with no block and no winner', async () => {
    now = new Date('2026-11-28T18:00:31.000Z');
    await settleStillLoopDrawsV1();
    const record = await drawRepo.byId('2026-11-28');
    assert.deepEqual([record?.entryCount, record?.drawnAt, record?.winnerNos, record?.blockHash], [0, now.toISOString(), null, null]);
    assert.equal(reads, 0, 'no block read for nobody');
  });

  it('pick several winners when the draw has them, none twice, each paid on its own', async () => {
    Object.assign(stillLoopDrawRuntimeV1, { draws: () => [{ ...LOOP_DRAWS_V1[0]!, winners: 3, prizeUsdc: '5' }, LOOP_DRAWS_V1[1]!] });
    const wallets = [A, B, C, D, `0x${'f'.repeat(40)}`];
    wallets.forEach((wallet) => verified.add(wallet));
    codes = ['K3F9X2', 'AB12CD', 'QW34ER', 'ZX56CV', 'MN78BV'];
    for (const wallet of wallets) await enter(wallet).expect(200);
    const open = (await publicLoops()).draws.current;
    assert.deepEqual([open.winnerCount, open.prizeUsdc, open.entries], [3, '5', 5]);
    now = new Date('2026-11-28T18:00:30.000Z');
    await settleStillLoopDrawsV1();
    now = new Date('2026-11-28T18:06:31.000Z');
    await settleStillLoopDrawsV1();
    const drawn = (await request(app(null)).get('/api/public/still/loops/draws/2026-11-28').expect(200)).body;
    assert.equal(drawn.winnerCount, 3);
    assert.deepEqual(drawn.winnerNos, loopDrawWinnersV1({ blockHash: drawn.block.hash, drawId: '2026-11-28', count: 5, winners: 3 }));
    assert.equal(new Set(drawn.winnerNos).size, 3);
    const won = await Promise.all(wallets.map(async (wallet) => (await request(app(wallet)).get('/api/still/loops/draw').expect(200)).body.entered[0].won));
    assert.equal(won.filter(Boolean).length, 3);
    await drawRepo.paid({ drawId: '2026-11-28', no: drawn.winnerNos[1], paidTx: `0x${'7'.repeat(64)}`, at: now });
    const past = (await publicLoops()).draws.past[0];
    assert.deepEqual(past.winners.map((row: { paid: boolean }) => row.paid), [false, true, false]);
    assert.doesNotMatch(JSON.stringify(past), /0x(a|b|c|d|e|f){40}/);
  });
});
