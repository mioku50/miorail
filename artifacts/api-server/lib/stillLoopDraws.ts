import { createHash, randomBytes, randomInt } from 'node:crypto';

import { createPublicClient, http, type Hex, type PublicClient } from 'viem';
import { base } from 'viem/chains';
import { client } from '@mioagent/db';
import {
  createDatabaseStillLoopDrawRepositoryV1,
  type SqlTemplateExecutor,
  type StillLoopDrawEntryV1,
  type StillLoopDrawRecordV1,
  type StillLoopDrawRepositoryV1,
  type StillLoopDrawStampV1,
} from '@mioagent/route-storage';
import {
  LOOP_DRAWS_V1,
  loopDrawCurrentV1,
  loopDrawFirstBlockAtOrAfterV1,
  loopDrawListHashV1,
  loopDrawListTextV1,
  loopDrawLockMomentV1,
  loopDrawOpenAtV1,
  loopDrawTargetSecondsV1,
  loopDrawWinnersV1,
  type LoopDrawBlockV1,
  type LoopDrawV1,
} from '@mioagent/still-engine/loop-draws';
import { rfc3161RequestV1, rfc3161ResponseV1, rfc3161StampsV1 } from '@mioagent/still-engine/rfc3161';
import { logger } from '@mioagent/utils';

import { coinbaseVerifiedAccountV1, type CoinbaseVerifiedReaderV1 } from './coinbaseVerified.js';
import type { LoanExecutionV1 } from './loanExecutionStore.js';
import { stillLoopOfExecutionV1, stillLoopsEnabledV1, stillLoopsRuntimeV1 } from './stillLoops.js';

// ---------------------------------------------------------------------------
// The Loop draws on the server (lib/still-engine/src/loopDraws.ts has the
// schedule and the arithmetic).
//
// Two ways in, the same chance, and the same press (audits LOOP-1 and LOOP-2,
// 2026-11-18): the owner enters, once per wallet, with the rules accepted and
// from where Still is offered, before the close. A wallet that made a Loop
// while the draw is open enters with it; any other enters free, with
// Coinbase's Verified Account attestation. A Loop counts when Still confirmed
// its loan after the draw opened and Bitrefill did not report its card
// undelivered: Still asks Bitrefill itself while it holds the open order, and
// a card on its way waits for its word. An entry is one write, at the time
// its owner made it, so nothing depends on when a page was read. The Still
// team never enters.
//
// 30 seconds after the close the list is fixed and its hash written; its hash
// is time-stamped by public authorities at once (RFC 3161, LOOP-4); five
// minutes after the list was fixed, the first Base block picks the winners.
// All of it happens in this process, on a 30-second tick and on any read of
// the public page, and each is one write that happens once. Open only while
// STILL_LOOPS_V1=on and STILL_LOOP_DRAW_V1=on.
// ---------------------------------------------------------------------------

export function stillLoopDrawEnabledV1(env: NodeJS.ProcessEnv = process.env): boolean {
  return stillLoopsEnabledV1(env) && (env.STILL_LOOP_DRAW_V1 ?? '').trim().toLowerCase() === 'on';
}

/** A free entry that began before the close is written well within this. */
export const STILL_LOOP_DRAW_LOCK_AFTER_MS_V1 = 30_000;
/** The picking block is read a minute after it is due, not the second it may appear. */
const READ_BLOCK_AFTER_S_V1 = 60n;
const CODE_ALPHABET_V1 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * The public time-stamping authorities a fixed list's hash is sent to (RFC 3161), each a service its own
 * company runs for anybody, whose signatures check against the roots operating systems ship. Only the
 * SHA-256 of the published list goes to them.
 */
export const STILL_LOOP_DRAW_TSAS_V1 = ['http://timestamp.digicert.com', 'http://timestamp.sectigo.com'] as const;

/** One authority's stamp of this text, checked to be of it; null when it gave none. */
async function stampV1(text: string, tsa: string): Promise<StillLoopDrawStampV1 | null> {
  const digest = createHash('sha256').update(text, 'utf8').digest();
  const nonce = randomBytes(8);
  const response = await fetch(tsa, {
    method: 'POST', headers: { 'content-type': 'application/timestamp-query' }, body: Buffer.from(rfc3161RequestV1(digest, nonce)),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) return null;
  const der = new Uint8Array(await response.arrayBuffer());
  if (der.length > 16_000) return null;
  const reading = rfc3161ResponseV1(der);
  return rfc3161StampsV1(reading, digest, nonce) ? { tsa, genTime: reading.genTime, token: Buffer.from(der).toString('base64') } : null;
}

let readerV1: PublicClient | null = null;
function baseReaderV1(): PublicClient {
  if (!readerV1) {
    const url = process.env.BASE_MAINNET_RPC_URL || process.env.BASE_RPC_URL || 'https://mainnet.base.org';
    readerV1 = createPublicClient({ chain: base, transport: http(url, { retryCount: 1, timeout: 8_000 }) }) as PublicClient;
  }
  return readerV1;
}

const blockOfV1 = (block: { number: bigint | null; hash: Hex | null; timestamp: bigint }): LoopDrawBlockV1 => {
  if (block.number === null || block.hash === null) throw new Error('loop_draw_block_pending');
  return { number: block.number, hash: block.hash, timestamp: block.timestamp };
};

export const stillLoopDrawRuntimeV1 = {
  enabled: (): boolean => stillLoopDrawEnabledV1(),
  draws: (): readonly LoopDrawV1[] => LOOP_DRAWS_V1,
  repository: (): StillLoopDrawRepositoryV1 => createDatabaseStillLoopDrawRepositoryV1(client as unknown as SqlTemplateExecutor),
  team: (): ReadonlySet<string> => stillLoopsRuntimeV1.team(),
  now: (): Date => new Date(),
  /** Coinbase's Verified Account attestation on Base; throws when Base could not be read. */
  verified: (wallet: string): Promise<boolean> => coinbaseVerifiedAccountV1(wallet, baseReaderV1() as unknown as CoinbaseVerifiedReaderV1, new Date()),
  head: async (): Promise<LoopDrawBlockV1> => blockOfV1(await baseReaderV1().getBlock({ blockTag: 'latest' })),
  /** One block, a tenth of a second apart, so the search never bursts the RPC. */
  block: async (number: bigint): Promise<LoopDrawBlockV1> => {
    await new Promise((resolve) => setTimeout(resolve, 100));
    return blockOfV1(await baseReaderV1().getBlock({ blockNumber: number }));
  },
  code: (): string => Array.from({ length: 6 }, () => CODE_ALPHABET_V1[randomInt(CODE_ALPHABET_V1.length)]).join(''),
  tsas: (): readonly string[] => STILL_LOOP_DRAW_TSAS_V1,
  stamp: (text: string, tsa: string): Promise<StillLoopDrawStampV1 | null> => stampV1(text, tsa),
};

const prizeAtomicV1 = (prizeUsdc: string): string => (BigInt(prizeUsdc) * 1_000_000n).toString();

/** Up to and including `now`: what an open draw holds so far. */
const soFarV1 = (now: Date): Date => new Date(now.getTime() + 1);

/** The draw's entries made before `before` (at most its close): one per wallet, in the order made, never the team's. */
export async function stillLoopDrawEntriesV1(draw: LoopDrawV1, before: Date): Promise<StillLoopDrawEntryV1[]> {
  const runtime = stillLoopDrawRuntimeV1;
  const until = new Date(Math.min(before.getTime(), Date.parse(draw.closesAt)));
  const team = runtime.team();
  return (await runtime.repository().entries({ drawId: draw.drawId, before: until }))
    .filter((row) => !team.has(row.walletAddress))
    .map((row) => ({
      label: row.kind === 'loop' ? `Loop #${row.loopNo}` : `Entry ${row.code}`, walletAddress: row.walletAddress, kind: row.kind, loopNo: row.loopNo,
      enteredAt: row.enteredAt,
    }));
}

/** Bitrefill's word on a Loop's card as an entry asks it: settled, still on its way, or no longer askable (Still
 * holds an open order half an hour, and a restart forgets it). */
export type StillLoopDeliveryWordV1 = 'complete' | 'blocked' | 'denied' | 'payment_error' | 'pending' | 'forgotten';

/** What an entry reads of a wallet's loans; the route wires it (routes/stillLoops.ts). */
export interface StillLoopDrawLoansV1 {
  /** The wallet's loans that pay a Bitrefill invoice opened since `since`, each still under way read again from Base. */
  paidSince(since: Date): Promise<LoanExecutionV1[]>;
  delivery(execution: LoanExecutionV1): Promise<StillLoopDeliveryWordV1>;
}

/** A loan opened this long before a draw opened may still be confirmed in it. */
const PAID_LOOKBACK_MS_V1 = 3_600_000;

/**
 * This wallet's Loop of the draw: its first Loop whose loan Still confirmed after the draw opened, and up to now,
 * whose card Bitrefill did not report undelivered. Ready when Bitrefill said it arrived, or can no longer be asked;
 * not ready while Bitrefill says it is on its way. A Loop no page read yet is written here. Null when it made none.
 */
export async function stillLoopOfDrawV1(wallet: string, draw: LoopDrawV1, loans: StillLoopDrawLoansV1, now: Date): Promise<{ loopNo: number; ready: boolean } | null> {
  if (stillLoopDrawRuntimeV1.team().has(wallet)) return null;
  const opens = Date.parse(draw.opensAt), until = Math.min(soFarV1(now).getTime(), Date.parse(draw.closesAt));
  let pending: number | null = null;
  for (const record of await loans.paidSince(new Date(opens - PAID_LOOKBACK_MS_V1))) {
    if (record.state !== 'confirmed') continue;
    let loop = await stillLoopOfExecutionV1(record);
    if (!loop || !(Date.parse(loop.confirmedAt) >= opens && Date.parse(loop.confirmedAt) < until) || loop.undelivered !== null) continue;
    if (loop.deliveredAt === null) {
      const word = await loans.delivery(record).catch((): StillLoopDeliveryWordV1 => 'pending');
      if (word === 'pending') {
        pending ??= loop.loopNo;
        continue;
      }
      if (word !== 'forgotten') {
        loop = (await stillLoopOfExecutionV1(record, word)) ?? loop;
        if (loop.deliveredAt === null) continue;
      }
    }
    return { loopNo: loop.loopNo, ready: true };
  }
  return pending === null ? null : { loopNo: pending, ready: false };
}

async function settleOnceV1(): Promise<void> {
  const runtime = stillLoopDrawRuntimeV1;
  if (!runtime.enabled()) return;
  const repository = runtime.repository();
  for (const draw of runtime.draws()) {
    const now = runtime.now();
    if (now.getTime() < Date.parse(draw.closesAt) + STILL_LOOP_DRAW_LOCK_AFTER_MS_V1) continue;
    let record = await repository.byId(draw.drawId);
    if (!record) {
      const entries = await stillLoopDrawEntriesV1(draw, new Date(draw.closesAt));
      // The moment and the winners are inside the hash and the stamped text: they decide the result too.
      const lockedAt = loopDrawLockMomentV1(now);
      record = await repository.lock({
        drawId: draw.drawId, opensAt: draw.opensAt, closesAt: draw.closesAt, prizeAtomic: prizeAtomicV1(draw.prizeUsdc), winnerCount: draw.winners, entries,
        entriesHash: loopDrawListHashV1({ drawId: draw.drawId, closesAt: draw.closesAt, lockedAt: lockedAt.toISOString(), winners: draw.winners,
          labels: entries.map((entry) => entry.label) }),
        lockedAt,
      });
      logger.info('Still Loop draw list fixed', { drawId: draw.drawId, entries: record.entryCount });
    }
    if (record.drawnAt !== null) continue;
    if (record.entryCount === 0) {
      await repository.drawn({ drawId: draw.drawId, block: null, winnerNos: null, at: now });
      continue;
    }
    const target = loopDrawTargetSecondsV1({ closesAt: record.closesAt, lockedAt: record.lockedAt });
    // Time-stamped by each authority while that still proves something: before the picking block is due.
    if (BigInt(Math.floor(now.getTime() / 1000)) < target) await stampListV1(repository, record);
    if (BigInt(Math.floor(now.getTime() / 1000)) < target + READ_BLOCK_AFTER_S_V1) continue;
    const block = await loopDrawFirstBlockAtOrAfterV1({ target, head: runtime.head, at: runtime.block });
    if (!block) continue;
    const hash = block.hash.toLowerCase() as Hex;
    const winnerNos = loopDrawWinnersV1({ blockHash: hash, drawId: draw.drawId, count: record.entryCount, winners: record.winnerCount });
    await repository.drawn({
      drawId: draw.drawId, winnerNos, at: runtime.now(),
      block: { number: block.number.toString(), hash, time: new Date(Number(block.timestamp) * 1000).toISOString() },
    });
    logger.info('Still Loop draw drawn', { drawId: draw.drawId, entries: record.entryCount, winners: winnerNos.length, block: block.number.toString() });
  }
}

/** Asks each authority not stamped yet for the list's stamp, once per pass; a refusal or a failure waits for the next. */
async function stampListV1(repository: StillLoopDrawRepositoryV1, record: StillLoopDrawRecordV1): Promise<void> {
  const runtime = stillLoopDrawRuntimeV1;
  const text = loopDrawListTextV1({ drawId: record.drawId, closesAt: record.closesAt, lockedAt: record.lockedAt, winners: record.winnerCount,
    labels: record.entries.map((entry) => entry.label) });
  for (const tsa of runtime.tsas()) {
    if (record.stamps.some((stamp) => stamp.tsa === tsa)) continue;
    const stamp = await runtime.stamp(text, tsa).catch(() => null);
    if (stamp) logger.info('Still Loop draw list stamped', { drawId: record.drawId, tsa, genTime: stamp.genTime });
    else logger.warn('Still Loop draw list not stamped', { drawId: record.drawId, tsa });
    if (stamp) await repository.stamp({ drawId: record.drawId, stamp });
  }
}

let settlingV1: Promise<void> | null = null;
/** Fixes the lists and draws the winners that are due; one pass at a time, and every step happens once. */
export function settleStillLoopDrawsV1(): Promise<void> {
  if (!settlingV1) settlingV1 = settleOnceV1().finally(() => { settlingV1 = null; });
  return settlingV1;
}

/** Every 30 seconds while the draws are on; the timer never keeps the process up. */
export function startStillLoopDrawTickerV1(intervalMs = 30_000): () => void {
  const timer = setInterval(() => {
    if (!stillLoopDrawRuntimeV1.enabled()) return;
    settleStillLoopDrawsV1().catch((error: unknown) => {
      logger.warn('Still Loop draw not settled', { errorName: error instanceof Error ? error.name : typeof error });
    });
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

/** A draw as anybody may see it: labels and numbers, never a wallet. */
export interface StillLoopDrawPublicV1 {
  drawId: string;
  opensAt: string;
  closesAt: string;
  /** How many entries win, each `prizeUsdc`. */
  winnerCount: number;
  prizeUsdc: string;
  /** upcoming, open, closing (closed, list not fixed yet), drawing (fixed, block not read yet), drawn. */
  state: 'upcoming' | 'open' | 'closing' | 'drawing' | 'drawn';
  /** So far while open, or in the fixed list. */
  entries: number;
  entriesHash: string | null;
  lockedAt: string | null;
  /** When the picking block is due: its timestamp is at least this. */
  blockAt: string | null;
  block: { number: string; hash: string; time: string } | null;
  /** In the order picked, each with whether its prize was sent. */
  winners: Array<{ no: number; label: string; paid: boolean }>;
  /** The public authorities that time-stamped the fixed list, and when by their clocks. */
  stamps: Array<{ tsa: string; genTime: string }>;
}

function publicOfV1(draw: LoopDrawV1, record: StillLoopDrawRecordV1 | null, now: Date, soFar: number): StillLoopDrawPublicV1 {
  const facts = { drawId: draw.drawId, opensAt: draw.opensAt, closesAt: draw.closesAt, winnerCount: record?.winnerCount ?? draw.winners, prizeUsdc: draw.prizeUsdc };
  if (!record) {
    const state = now.getTime() < Date.parse(draw.opensAt) ? 'upcoming' as const : now.getTime() < Date.parse(draw.closesAt) ? 'open' as const : 'closing' as const;
    return { ...facts, state, entries: state === 'upcoming' ? 0 : soFar, entriesHash: null, lockedAt: null, blockAt: null, block: null, winners: [], stamps: [] };
  }
  const blockAt = record.entryCount > 0
    ? new Date(Number(loopDrawTargetSecondsV1({ closesAt: record.closesAt, lockedAt: record.lockedAt })) * 1000).toISOString() : null;
  const winners = (record.winnerNos ?? []).map((no) => ({ no, label: record.entries[no - 1]?.label ?? '', paid: record.payouts.some((payout) => payout.no === no) }));
  return {
    ...facts, state: record.drawnAt !== null ? 'drawn' : 'drawing', entries: record.entryCount, entriesHash: record.entriesHash, lockedAt: record.lockedAt,
    blockAt, block: record.blockHash ? { number: record.blockNumber!, hash: record.blockHash, time: record.blockTime! } : null, winners,
    stamps: record.stamps.map((stamp) => ({ tsa: stamp.tsa, genTime: stamp.genTime })),
  };
}

/** The draw open now or next, and the ones that closed, the latest first. */
export async function stillLoopDrawsPublicV1(now: Date): Promise<{ current: StillLoopDrawPublicV1 | null; past: StillLoopDrawPublicV1[] }> {
  const runtime = stillLoopDrawRuntimeV1;
  const records = new Map((await runtime.repository().all()).map((record) => [record.drawId, record]));
  const current = loopDrawCurrentV1(now, runtime.draws());
  const out: StillLoopDrawPublicV1[] = [];
  for (const draw of runtime.draws()) {
    const record = records.get(draw.drawId) ?? null;
    const counting = !record && Date.parse(draw.opensAt) <= now.getTime();
    out.push(publicOfV1(draw, record, now, counting ? (await stillLoopDrawEntriesV1(draw, soFarV1(now))).length : 0));
  }
  return {
    current: current ? out.find((draw) => draw.drawId === current.drawId) ?? null : null,
    past: out.filter((draw) => Date.parse(draw.closesAt) <= now.getTime()).sort((a, b) => Date.parse(b.closesAt) - Date.parse(a.closesAt)),
  };
}

/** A fixed list as anybody can check it: its labels in order, the hash, the block and the winner's number. */
export async function stillLoopDrawListV1(drawId: string) {
  const draw = stillLoopDrawRuntimeV1.draws().find((row) => row.drawId === drawId);
  const record = draw ? await stillLoopDrawRuntimeV1.repository().byId(drawId) : null;
  if (!draw || !record) return null;
  const view = publicOfV1(draw, record, stillLoopDrawRuntimeV1.now(), record.entryCount);
  return {
    schemaVersion: 'still-loop-draw/v1' as const, drawId: record.drawId, opensAt: draw.opensAt, closesAt: draw.closesAt, prizeUsdc: draw.prizeUsdc,
    winnerCount: record.winnerCount, lockedAt: record.lockedAt, entriesHash: record.entriesHash, labels: record.entries.map((entry) => entry.label),
    blockAt: view.blockAt, block: view.block, winnerNos: record.winnerNos,
    // Each a whole RFC 3161 reply over the SHA-256 of the list's text: `openssl ts -verify` checks it.
    stamps: record.stamps.map((stamp) => ({ tsa: stamp.tsa, genTime: stamp.genTime, token: stamp.token })),
  };
}

export interface StillLoopDrawMineV1 {
  team: boolean;
  /** The draw open now: this wallet's entry in it, or the Loop it may enter with. */
  current: {
    drawId: string; closesAt: string;
    entry: { label: string; kind: 'loop' | 'free' } | null;
    /** Its Loop of this draw; `ready` false while Bitrefill says the card is on its way. Null when it made none or is in. */
    loop: { loopNo: number; ready: boolean } | null;
  } | null;
  /** Draws whose fixed list holds this wallet. */
  entered: Array<{ drawId: string; label: string; won: boolean; paid: boolean; prizeUsdc: string }>;
}

export async function stillLoopDrawMineV1(wallet: string, now: Date, loans: StillLoopDrawLoansV1): Promise<StillLoopDrawMineV1> {
  const runtime = stillLoopDrawRuntimeV1;
  const team = runtime.team().has(wallet);
  const open = loopDrawOpenAtV1(now, runtime.draws());
  let current: StillLoopDrawMineV1['current'] = null;
  if (open) {
    const mine = team ? null : await runtime.repository().entryOf({ drawId: open.drawId, walletAddress: wallet });
    const entry = mine ? { label: mine.kind === 'loop' ? `Loop #${mine.loopNo}` : `Entry ${mine.code}`, kind: mine.kind } : null;
    current = { drawId: open.drawId, closesAt: open.closesAt, entry, loop: team || entry ? null : await stillLoopOfDrawV1(wallet, open, loans, now) };
  }
  const entered: StillLoopDrawMineV1['entered'] = [];
  for (const record of await runtime.repository().all()) {
    const at = record.entries.findIndex((entry) => entry.walletAddress === wallet);
    if (at < 0) continue;
    const draw = runtime.draws().find((row) => row.drawId === record.drawId);
    const won = record.winnerNos?.includes(at + 1) === true;
    entered.push({ drawId: record.drawId, label: record.entries[at]!.label, won, paid: won && record.payouts.some((payout) => payout.no === at + 1),
      prizeUsdc: draw?.prizeUsdc ?? (BigInt(record.prizeAtomic) / 1_000_000n).toString() });
  }
  return { team, current, entered: entered.reverse() };
}

export type StillLoopDrawEnterOutcomeV1 =
  | { outcome: 'entered' | 'already'; drawId: string; closesAt: string; entry: { label: string; kind: 'loop' | 'free' } }
  | { outcome: 'not_open'; next: { drawId: string; opensAt: string } | null }
  | { outcome: 'team' }
  | { outcome: 'not_verified' }
  /** Its Loop's card is on its way, and the wallet holds no attestation for a free entry. */
  | { outcome: 'loop_pending'; loopNo: number };

/** The draw open now, if any, and whether this wallet is in it already: what an entry checks before anything else. */
export async function stillLoopDrawBeforeEntryV1(wallet: string, now: Date): Promise<StillLoopDrawEnterOutcomeV1 | { outcome: 'ask'; draw: LoopDrawV1 }> {
  const runtime = stillLoopDrawRuntimeV1;
  const open = loopDrawOpenAtV1(now, runtime.draws());
  if (!open) {
    const next = loopDrawCurrentV1(now, runtime.draws());
    return { outcome: 'not_open', next: next ? { drawId: next.drawId, opensAt: next.opensAt } : null };
  }
  if (runtime.team().has(wallet)) return { outcome: 'team' };
  const mine = await runtime.repository().entryOf({ drawId: open.drawId, walletAddress: wallet });
  if (mine) {
    return { outcome: 'already', drawId: open.drawId, closesAt: open.closesAt,
      entry: { label: mine.kind === 'loop' ? `Loop #${mine.loopNo}` : `Entry ${mine.code}`, kind: mine.kind } };
  }
  return { outcome: 'ask', draw: open };
}

/** The entry itself, once the region and the confirmations were checked: with the wallet's Loop of the draw when it
 * has one ready, otherwise free with the attestation; one write while the draw is still open. */
export async function enterStillLoopDrawV1(wallet: string, draw: LoopDrawV1, loans: StillLoopDrawLoansV1): Promise<StillLoopDrawEnterOutcomeV1> {
  const runtime = stillLoopDrawRuntimeV1;
  const loop = await stillLoopOfDrawV1(wallet, draw, loans, runtime.now());
  const withLoop = loop !== null && loop.ready;
  if (!withLoop && !(await runtime.verified(wallet))) return loop ? { outcome: 'loop_pending', loopNo: loop.loopNo } : { outcome: 'not_verified' };
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const at = runtime.now();
    if (at.getTime() >= Date.parse(draw.closesAt)) {
      const next = loopDrawCurrentV1(at, runtime.draws());
      return { outcome: 'not_open', next: next ? { drawId: next.drawId, opensAt: next.opensAt } : null };
    }
    const written = await runtime.repository().enter({ drawId: draw.drawId, walletAddress: wallet, code: runtime.code(),
      kind: withLoop ? 'loop' : 'free', loopNo: withLoop ? loop.loopNo : null, at });
    if (written.outcome === 'entered' || written.outcome === 'already') {
      const row = written.entry;
      return { outcome: written.outcome, drawId: draw.drawId, closesAt: draw.closesAt,
        entry: { label: row.kind === 'loop' ? `Loop #${row.loopNo}` : `Entry ${row.code}`, kind: row.kind } };
    }
    if (written.outcome === 'locked') return { outcome: 'not_open', next: null };
  }
  throw new Error('still_loop_draw_code_exhausted');
}
