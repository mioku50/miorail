import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import express from 'express';
import request from 'supertest';
import { InMemoryStillLoopDrawRepositoryV1, InMemoryStillLoopRepositoryV1 } from '@mioagent/route-storage';
import { LOOP_DRAWS_V1, loopDrawListHashV1, loopDrawWinnerV1, loopDrawWinnersV1, type LoopDrawBlockV1 } from '@mioagent/still-engine/loop-draws';
import { keccak256, stringToHex } from 'viem';

import { STOCKS } from '@mioagent/still-engine/registry';

import type { LoanExecutionV1 } from '../lib/loanExecutionStore.js';
import { loanReadyFixture } from '../lib/loanExecutionTestFixtures.js';
import { settleStillLoopDrawsV1, stillLoopDrawRuntimeV1, type StillLoopDeliveryWordV1 } from '../lib/stillLoopDraws.js';
import { stillRegionRuntimeV1 } from '../lib/stillRegion.js';
import { stillLoopsRuntimeV1 } from '../lib/stillLoops.js';
import { forgetStillLoopsPublicV1, publicStillLoopsRouter, stillLoopDrawLoansRuntimeV1, stillLoopsRouter } from './stillLoops.js';

const A = `0x${'a'.repeat(40)}`, B = `0x${'b'.repeat(40)}`, C = `0x${'c'.repeat(40)}`, TEAM = `0x${'d'.repeat(40)}`, D = `0x${'e'.repeat(40)}`;
const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const AAPLC = STOCKS.find((stock) => stock.id === 'AAPLc')!.token.toLowerCase();
/** A confirmed loan against Apple that paid an Apple card: a Loop, confirmed at `confirmedAt`. Synthetic throughout. */
function paidLoan(n: number, walletAddress: string, confirmedAt: string, state: LoanExecutionV1['state'] = 'confirmed'): LoanExecutionV1 {
  const run = loanReadyFixture();
  run.facts = { ...run.facts, operation: 'borrow', venue: 'aave-v4', collateralTokenAddress: AAPLC, collateralSymbol: 'AAPLc',
    payment: { merchant: 'bitrefill', orderId: id(100 + n), payTo: `0x${'3'.repeat(40)}`, assets: '27340000', productName: 'iTunes Germany',
      packageValue: '25', faceCurrency: 'EUR', expiresAt: '2026-11-22T12:15:00.000Z', productId: 'itunes-germany' } };
  return { tenantId: `eip155:8453:${walletAddress}`, walletAddress, executionId: id(n), draftId: `d${n}`, state, run, attemptId: null, batchId: null,
    transactionHash: null, verification: null, errorCode: null, version: 3,
    createdAt: new Date(Date.parse(confirmedAt) - 60_000).toISOString(), updatedAt: confirmedAt };
}

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

const loops = { ...stillLoopsRuntimeV1 }, draws = { ...stillLoopDrawRuntimeV1 }, region = { ...stillRegionRuntimeV1 }, loans = { ...stillLoopDrawLoansRuntimeV1 };
let loopRepo: InMemoryStillLoopRepositoryV1, drawRepo: InMemoryStillLoopDrawRepositoryV1, now: Date, verified: Set<string>, codes: string[], reads: number;
/** Each wallet's paid loans, and Bitrefill's word on each card by loan (absent: the open order is forgotten). */
let paid: LoanExecutionV1[], words: Map<string, StillLoopDeliveryWordV1>, asked: string[];
/** What each time-stamping authority was asked, and whether it answers. */
let stamped: { text: string; tsa: string; at: string }[], tsaDown: Set<string>;
const TSAS = ['https://tsa-one.example/tsr', 'https://tsa-two.example/tsr'];

beforeEach(() => {
  forgetStillLoopsPublicV1();
  loopRepo = new InMemoryStillLoopRepositoryV1();
  drawRepo = new InMemoryStillLoopDrawRepositoryV1();
  now = new Date('2026-11-22T10:00:00.000Z');
  verified = new Set([A, B, TEAM]);
  codes = ['K3F9X2', 'AB12CD', 'QW34ER', 'ZX56CV'];
  reads = 0;
  stamped = [];
  tsaDown = new Set();
  paid = [];
  words = new Map();
  asked = [];
  Object.assign(stillLoopDrawLoansRuntimeV1, { of: (wallet: string) => ({
    paidSince: async (since: Date) => paid.filter((row) => row.walletAddress === wallet && Date.parse(row.createdAt) >= since.getTime()),
    delivery: async (row: LoanExecutionV1) => { asked.push(row.executionId); return words.get(row.executionId) ?? 'forgotten'; },
  }) });
  const team = new Set([TEAM]);
  Object.assign(stillLoopsRuntimeV1, { enabled: () => true, team: () => team, repository: () => loopRepo, now: () => now });
  Object.assign(stillLoopDrawRuntimeV1, {
    enabled: () => true, repository: () => drawRepo, team: () => team, now: () => now,
    verified: async (wallet: string) => verified.has(wallet), code: () => codes.shift() ?? 'QQQQQQ',
    head: async () => { reads += 1; return blockAt((BigInt(Math.floor(now.getTime() / 1000)) - BigInt(GENESIS)) / 2n); },
    block: async (n: bigint) => { reads += 1; return blockAt(n); },
    tsas: () => TSAS,
    stamp: async (text: string, tsa: string) => {
      stamped.push({ text, tsa, at: now.toISOString() });
      return tsaDown.has(tsa) ? null : { tsa, genTime: new Date(now.getTime() + 400).toISOString(), token: Buffer.from(`stamp of ${text}`).toString('base64') };
    },
  });
});
afterEach(() => {
  Object.assign(stillLoopsRuntimeV1, loops);
  Object.assign(stillLoopDrawRuntimeV1, draws);
  Object.assign(stillRegionRuntimeV1, region);
  Object.assign(stillLoopDrawLoansRuntimeV1, loans);
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
    assert.deepEqual(mine.current, { drawId: '2026-11-28', closesAt: '2026-11-28T18:00:00.000Z', entry: { label: 'Entry K3F9X2', kind: 'free' }, loop: null });
    assert.equal((await request(app(TEAM)).get('/api/still/loops/draw').expect(200)).body.team, true);
    const open = (await publicLoops()).draws.current;
    assert.deepEqual([open.drawId, open.state, open.entries, open.winnerCount, open.prizeUsdc, open.entriesHash], ['2026-11-28', 'open', 1, 3, '5', null]);
  });

  it('ask the region and the confirmation a new loan asks, before anything is read or written', async () => {
    Object.assign(stillRegionRuntimeV1, { enabled: () => true, table: () => null, registryTable: () => null });
    const refused = await enter(A).expect(403);
    assert.equal(refused.body.error, 'region_unchecked');
    assert.equal(await drawRepo.entryOf({ drawId: '2026-11-28', walletAddress: A }), null);
  });

  it('let a wallet that made a Loop while open enter with it, by its own press, with no attestation asked (audits LOOP-1, LOOP-2)', async () => {
    // C holds no attestation; its loan against Apple paid an Apple card and was confirmed after the draw opened.
    paid = [paidLoan(1, C, '2026-11-22T08:00:00.000Z')];
    const mine = (await request(app(C)).get('/api/still/loops/draw').expect(200)).body;
    assert.deepEqual([mine.current.entry, mine.current.loop], [null, { loopNo: 1, ready: true }], 'offered, not entered by itself');
    assert.equal((await publicLoops()).draws.current.entries, 0);
    assert.equal((await enter(C, {})).status, 400, 'the rules are accepted for a Loop too');
    const entered = await enter(C).expect(200);
    assert.deepEqual([entered.body.outcome, entered.body.entry], ['entered', { label: 'Loop #1', kind: 'loop' }]);
    assert.deepEqual((await drawRepo.entryOf({ drawId: '2026-11-28', walletAddress: C }))?.enteredAt, now.toISOString(), 'entered when pressed');
    assert.deepEqual((await request(app(C)).get('/api/still/loops/draw').expect(200)).body.current, {
      drawId: '2026-11-28', closesAt: '2026-11-28T18:00:00.000Z', entry: { label: 'Loop #1', kind: 'loop' }, loop: null });
    assert.equal((await enter(C).expect(200)).body.outcome, 'already');
  });

  it('wait for Bitrefill on a card on its way, and count no Loop it reported undelivered, from before the draw, or the team’s', async () => {
    paid = [paidLoan(1, C, '2026-11-22T08:00:00.000Z')];
    words.set(id(1), 'pending');
    assert.deepEqual((await request(app(C)).get('/api/still/loops/draw').expect(200)).body.current.loop, { loopNo: 1, ready: false });
    const waiting = await enter(C).expect(409);
    assert.deepEqual([waiting.body.error, waiting.body.loopNo], ['draw_loop_pending', 1]);
    assert.match(waiting.body.detail, /Bitrefill has not delivered the card of Loop #1 yet/);
    // Delivered: entered with it, and the Loop is complete.
    words.set(id(1), 'complete');
    assert.deepEqual((await enter(C).expect(200)).body.entry, { label: 'Loop #1', kind: 'loop' });
    assert.notEqual((await loopRepo.byExecution(id(1)))?.deliveredAt, null);
    // B's card was denied, and B is verified: it enters free. D's was denied too, and D is not: refused.
    paid.push(paidLoan(2, B, '2026-11-22T08:30:00.000Z'), paidLoan(3, D, '2026-11-22T08:40:00.000Z'));
    words.set(id(2), 'denied').set(id(3), 'denied');
    assert.deepEqual((await enter(B).expect(200)).body.entry.kind, 'free');
    assert.equal((await enter(D).expect(403)).body.error, 'not_verified');
    assert.equal((await loopRepo.byExecution(id(3)))?.undelivered, 'denied');
    // A loan confirmed before the draw opened, one not confirmed, and the team's: none of them.
    const E = `0x${'f'.repeat(40)}`;
    paid.push(paidLoan(4, E, '2026-11-20T23:59:00.000Z'), paidLoan(5, E, '2026-11-22T09:00:00.000Z', 'submitted'), paidLoan(6, TEAM, '2026-11-22T09:00:00.000Z'));
    assert.equal((await request(app(E)).get('/api/still/loops/draw').expect(200)).body.current.loop, null);
    assert.equal((await enter(E).expect(403)).body.error, 'not_verified');
    assert.equal((await enter(TEAM).expect(409)).body.error, 'draw_team');
    assert.equal(await loopRepo.byExecution(id(6)), null, 'the team’s loans make no Loop');
  });

  it('fix the list after the close, then let the first Base block five minutes on pick the winner, as anybody can check', async () => {
    // One winner here, so a loser can be told apart; three are picked below.
    Object.assign(stillLoopDrawRuntimeV1, { draws: () => LOOP_DRAWS_V1.map((draw) => ({ ...draw, winners: 1, prizeUsdc: '10' })) });
    paid = [paidLoan(1, C, '2026-11-22T08:00:00.000Z'), paidLoan(2, A, '2026-11-23T08:00:00.000Z')];
    now = new Date('2026-11-22T09:00:00.000Z');
    await enter(C).expect(200);                                             // Loop #1 (its write takes K3F9X2), 09:00
    now = new Date('2026-11-22T10:00:00.000Z');
    await enter(A).expect(200);                                             // Entry AB12CD, 10:00: A's own Loop came later
    now = new Date('2026-11-28T17:59:59.000Z');
    await enter(B).expect(200);                                             // Entry QW34ER, a second before the close
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
    const labels = ['Loop #1', 'Entry AB12CD', 'Entry QW34ER'];
    assert.deepEqual(fixed.labels, labels);
    assert.equal(fixed.lockedAt, '2026-11-28T18:00:31.000Z');
    assert.equal(fixed.entriesHash, loopDrawListHashV1({ drawId: '2026-11-28', closesAt: '2026-11-28T18:00:00.000Z', labels }));
    assert.equal(fixed.blockAt, '2026-11-28T18:05:31.000Z');
    assert.deepEqual([fixed.block, fixed.winnerNos, fixed.winnerCount], [null, null, 1]);
    // Time-stamped at once by both authorities, over the exact text whose hash is published (audit LOOP-4).
    const text = JSON.stringify({ drawId: '2026-11-28', closesAt: '2026-11-28T18:00:00.000Z', labels });
    assert.deepEqual(stamped.map((row) => [row.tsa, row.text]), TSAS.map((tsa) => [tsa, text]));
    assert.deepEqual(fixed.stamps, TSAS.map((tsa) => ({ tsa, genTime: '2026-11-28T18:00:30.800Z', token: Buffer.from(`stamp of ${text}`).toString('base64') })));
    assert.deepEqual((await publicLoops()).draws.past[0].stamps, TSAS.map((tsa) => ({ tsa, genTime: '2026-11-28T18:00:30.800Z' })));
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
    assert.deepEqual((await request(app(D)).get('/api/still/loops/draw').expect(200)).body.current.entry, { label: 'Entry ZX56CV', kind: 'free' });
    assert.deepEqual((await request(app(D)).get('/api/still/loops/draw').expect(200)).body.entered, [], 'not in the first');
  });

  it('ask an authority that did not stamp again on the next pass, and none once the picking block is due', async () => {
    verified.add(C);
    await enter(A).expect(200);
    tsaDown.add(TSAS[1]!);
    now = new Date('2026-11-28T18:00:31.000Z');
    await settleStillLoopDrawsV1();
    assert.deepEqual((await drawRepo.byId('2026-11-28'))?.stamps.map((stamp) => stamp.tsa), [TSAS[0]]);
    now = new Date('2026-11-28T18:01:01.000Z');
    await settleStillLoopDrawsV1();
    assert.deepEqual(stamped.map((row) => row.tsa), [TSAS[0], TSAS[1], TSAS[1]], 'only the one that has not stamped is asked again');
    tsaDown.clear();
    now = new Date('2026-11-28T18:05:31.000Z');
    await settleStillLoopDrawsV1();
    assert.equal(stamped.length, 3, 'a stamp after the block is due would prove nothing: not asked');
    assert.deepEqual((await drawRepo.byId('2026-11-28'))?.stamps.length, 1);
  });

  it('draw a list nobody entered with no block and no winner', async () => {
    now = new Date('2026-11-28T18:00:31.000Z');
    await settleStillLoopDrawsV1();
    const record = await drawRepo.byId('2026-11-28');
    assert.deepEqual([record?.entryCount, record?.drawnAt, record?.winnerNos, record?.blockHash], [0, now.toISOString(), null, null]);
    assert.equal(reads, 0, 'no block read for nobody');
    assert.equal(stamped.length, 0, 'and no list to stamp');
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
