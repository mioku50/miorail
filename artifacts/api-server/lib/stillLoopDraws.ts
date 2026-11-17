import { randomInt } from 'node:crypto';

import { createPublicClient, http, type Hex, type PublicClient } from 'viem';
import { base } from 'viem/chains';
import { client } from '@mioagent/db';
import {
  createDatabaseStillLoopDrawRepositoryV1,
  type SqlTemplateExecutor,
  type StillLoopDrawEntryV1,
  type StillLoopDrawRecordV1,
  type StillLoopDrawRepositoryV1,
  type StillLoopRepositoryV1,
} from '@mioagent/route-storage';
import {
  LOOP_DRAWS_V1,
  loopDrawCurrentV1,
  loopDrawFirstBlockAtOrAfterV1,
  loopDrawListHashV1,
  loopDrawLockMomentV1,
  loopDrawOpenAtV1,
  loopDrawTargetSecondsV1,
  loopDrawWinnersV1,
  type LoopDrawBlockV1,
  type LoopDrawV1,
} from '@mioagent/still-engine/loop-draws';
import { logger } from '@mioagent/utils';

import { coinbaseVerifiedAccountV1, type CoinbaseVerifiedReaderV1 } from './coinbaseVerified.js';
import { stillLoopsEnabledV1, stillLoopsRuntimeV1 } from './stillLoops.js';

// ---------------------------------------------------------------------------
// The Loop draws on the server (lib/still-engine/src/loopDraws.ts has the
// schedule and the arithmetic).
//
// Two ways in, the same chance: a Loop whose card arrived while the draw was
// open enters its wallet by itself; anybody else enters free, once, from a
// wallet that holds Coinbase's Verified Account attestation and from where
// Still is offered. One entry per wallet: whichever came first. The Still
// team never enters.
//
// 30 seconds after the close the list is fixed and its hash written; five
// minutes after that, the first Base block picks the winners. Both happen in
// this process, on a 30-second tick and on any read of the public page, and
// each is one write that happens once. Open only while STILL_LOOPS_V1=on and
// STILL_LOOP_DRAW_V1=on.
// ---------------------------------------------------------------------------

export function stillLoopDrawEnabledV1(env: NodeJS.ProcessEnv = process.env): boolean {
  return stillLoopsEnabledV1(env) && (env.STILL_LOOP_DRAW_V1 ?? '').trim().toLowerCase() === 'on';
}

/** A free entry that began before the close is written well within this. */
export const STILL_LOOP_DRAW_LOCK_AFTER_MS_V1 = 30_000;
/** The picking block is read a minute after it is due, not the second it may appear. */
const READ_BLOCK_AFTER_S_V1 = 60n;
const CODE_ALPHABET_V1 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

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
  loops: (): StillLoopRepositoryV1 => stillLoopsRuntimeV1.repository(),
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
};

const prizeAtomicV1 = (prizeUsdc: string): string => (BigInt(prizeUsdc) * 1_000_000n).toString();

/** Up to and including `now`: what an open draw holds so far. */
const soFarV1 = (now: Date): Date => new Date(now.getTime() + 1);

/** The draw's entries made before `before` (at most its close): one per wallet, the first it made, in the order they came. */
export async function stillLoopDrawEntriesV1(draw: LoopDrawV1, before: Date): Promise<StillLoopDrawEntryV1[]> {
  const runtime = stillLoopDrawRuntimeV1;
  const until = new Date(Math.min(before.getTime(), Date.parse(draw.closesAt)));
  const [loops, free] = await Promise.all([
    runtime.loops().drawEntrants({ since: new Date(draw.opensAt), before: until }),
    runtime.repository().freeEntries({ drawId: draw.drawId, before: until }),
  ]);
  const team = runtime.team();
  const first = new Map<string, StillLoopDrawEntryV1>();
  const offer = (entry: StillLoopDrawEntryV1) => {
    if (team.has(entry.walletAddress)) return;
    const had = first.get(entry.walletAddress);
    if (!had || Date.parse(entry.enteredAt) < Date.parse(had.enteredAt)) first.set(entry.walletAddress, entry);
  };
  for (const row of loops) offer({ label: `Loop #${row.loopNo}`, walletAddress: row.walletAddress, kind: 'loop', loopNo: row.loopNo, enteredAt: row.deliveredAt });
  for (const row of free) offer({ label: `Entry ${row.code}`, walletAddress: row.walletAddress, kind: 'free', loopNo: null, enteredAt: row.enteredAt });
  return [...first.values()].sort((a, b) => Date.parse(a.enteredAt) - Date.parse(b.enteredAt) || a.label.localeCompare(b.label));
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
      record = await repository.lock({
        drawId: draw.drawId, opensAt: draw.opensAt, closesAt: draw.closesAt, prizeAtomic: prizeAtomicV1(draw.prizeUsdc), winnerCount: draw.winners, entries,
        entriesHash: loopDrawListHashV1({ drawId: draw.drawId, closesAt: draw.closesAt, labels: entries.map((entry) => entry.label) }),
        lockedAt: loopDrawLockMomentV1(now),
      });
      logger.info('Still Loop draw list fixed', { drawId: draw.drawId, entries: record.entryCount });
    }
    if (record.drawnAt !== null) continue;
    if (record.entryCount === 0) {
      await repository.drawn({ drawId: draw.drawId, block: null, winnerNos: null, at: now });
      continue;
    }
    const target = loopDrawTargetSecondsV1({ closesAt: record.closesAt, lockedAt: record.lockedAt });
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
}

function publicOfV1(draw: LoopDrawV1, record: StillLoopDrawRecordV1 | null, now: Date, soFar: number): StillLoopDrawPublicV1 {
  const facts = { drawId: draw.drawId, opensAt: draw.opensAt, closesAt: draw.closesAt, winnerCount: record?.winnerCount ?? draw.winners, prizeUsdc: draw.prizeUsdc };
  if (!record) {
    const state = now.getTime() < Date.parse(draw.opensAt) ? 'upcoming' as const : now.getTime() < Date.parse(draw.closesAt) ? 'open' as const : 'closing' as const;
    return { ...facts, state, entries: state === 'upcoming' ? 0 : soFar, entriesHash: null, lockedAt: null, blockAt: null, block: null, winners: [] };
  }
  const blockAt = record.entryCount > 0
    ? new Date(Number(loopDrawTargetSecondsV1({ closesAt: record.closesAt, lockedAt: record.lockedAt })) * 1000).toISOString() : null;
  const winners = (record.winnerNos ?? []).map((no) => ({ no, label: record.entries[no - 1]?.label ?? '', paid: record.payouts.some((payout) => payout.no === no) }));
  return {
    ...facts, state: record.drawnAt !== null ? 'drawn' : 'drawing', entries: record.entryCount, entriesHash: record.entriesHash, lockedAt: record.lockedAt,
    blockAt, block: record.blockHash ? { number: record.blockNumber!, hash: record.blockHash, time: record.blockTime! } : null, winners,
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
  };
}

export interface StillLoopDrawMineV1 {
  team: boolean;
  /** The draw open now, and this wallet's entry in it. */
  current: { drawId: string; closesAt: string; entry: { label: string; kind: 'loop' | 'free' } | null } | null;
  /** Draws whose fixed list holds this wallet. */
  entered: Array<{ drawId: string; label: string; won: boolean; paid: boolean; prizeUsdc: string }>;
}

export async function stillLoopDrawMineV1(wallet: string, now: Date): Promise<StillLoopDrawMineV1> {
  const runtime = stillLoopDrawRuntimeV1;
  const team = runtime.team().has(wallet);
  const open = loopDrawOpenAtV1(now, runtime.draws());
  let current: StillLoopDrawMineV1['current'] = null;
  if (open) {
    const mine = team ? undefined : (await stillLoopDrawEntriesV1(open, soFarV1(now))).find((entry) => entry.walletAddress === wallet);
    current = { drawId: open.drawId, closesAt: open.closesAt, entry: mine ? { label: mine.label, kind: mine.kind } : null };
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

export type StillLoopDrawFreeOutcomeV1 =
  | { outcome: 'entered' | 'already'; drawId: string; closesAt: string; entry: { label: string; kind: 'loop' | 'free' } }
  | { outcome: 'not_open'; next: { drawId: string; opensAt: string } | null }
  | { outcome: 'team' }
  | { outcome: 'not_verified' };

/** The draw open now, if any, and whether this wallet is in it already: what a free entry checks before anything else. */
export async function stillLoopDrawBeforeFreeV1(wallet: string, now: Date): Promise<StillLoopDrawFreeOutcomeV1 | { outcome: 'ask'; draw: LoopDrawV1 }> {
  const runtime = stillLoopDrawRuntimeV1;
  const open = loopDrawOpenAtV1(now, runtime.draws());
  if (!open) {
    const next = loopDrawCurrentV1(now, runtime.draws());
    return { outcome: 'not_open', next: next ? { drawId: next.drawId, opensAt: next.opensAt } : null };
  }
  if (runtime.team().has(wallet)) return { outcome: 'team' };
  const mine = (await stillLoopDrawEntriesV1(open, soFarV1(now))).find((entry) => entry.walletAddress === wallet);
  if (mine) return { outcome: 'already', drawId: open.drawId, closesAt: open.closesAt, entry: { label: mine.label, kind: mine.kind } };
  return { outcome: 'ask', draw: open };
}

/** The free entry itself, once the region was checked: the attestation, then one write while the draw is still open. */
export async function enterStillLoopDrawFreeV1(wallet: string, draw: LoopDrawV1): Promise<StillLoopDrawFreeOutcomeV1> {
  const runtime = stillLoopDrawRuntimeV1;
  if (!(await runtime.verified(wallet))) return { outcome: 'not_verified' };
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const at = runtime.now();
    if (at.getTime() >= Date.parse(draw.closesAt)) {
      const next = loopDrawCurrentV1(at, runtime.draws());
      return { outcome: 'not_open', next: next ? { drawId: next.drawId, opensAt: next.opensAt } : null };
    }
    const written = await runtime.repository().enterFree({ drawId: draw.drawId, walletAddress: wallet, code: runtime.code(), at });
    if (written.outcome === 'entered' || written.outcome === 'already') {
      return { outcome: written.outcome, drawId: draw.drawId, closesAt: draw.closesAt, entry: { label: `Entry ${written.entry.code}`, kind: 'free' } };
    }
    if (written.outcome === 'locked') return { outcome: 'not_open', next: null };
  }
  throw new Error('still_loop_draw_code_exhausted');
}
