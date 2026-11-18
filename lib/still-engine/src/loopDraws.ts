import { concat, keccak256, stringToHex, type Hex } from 'viem';

// ---------------------------------------------------------------------------
// The Loop draws: when each one is open, what its list's hash is, and which
// entry a Base block picks. The server and scripts/verify_loop_draw.ts share
// these functions, so anybody can check a draw with the same arithmetic.
//
// - A draw is open from `opensAt` until `closesAt`. Its list is fixed after it
//   closes: one entry per wallet, in the order they came, each by its label.
// - The list's hash is keccak256 of the JSON {drawId, closesAt, lockedAt, winners, labels}: everything the
//   result depends on, so the time-stamps fix the picking block and the number of winners as well as the list
//   (audit, 2026-11-18: lockedAt sets the block and was outside the stamped text, so a later lockedAt could
//   have moved the draw to another block with every check still passing).
// - The block is the first Base block whose timestamp is at least five
//   minutes after the later of the close and the moment the list was fixed:
//   the hash is shown before that block exists.
// - The first winner is entry keccak256(blockHash ‖ drawId) mod N + 1. A draw
//   with more winners picks each next one the same way, from the entries not
//   yet picked, the k-th with "/k" after the draw: keccak256(blockHash ‖
//   drawId/k) mod (entries left), counted along the list.
// ---------------------------------------------------------------------------

export interface LoopDrawV1 {
  /** The close's day, as 2026-11-28. */
  drawId: string;
  opensAt: string;
  closesAt: string;
  /** How many entries win; fewer when fewer entered. */
  winners: number;
  /** Whole USDC to each winner, as "10". */
  prizeUsdc: string;
}

export const LOOP_DRAWS_V1: readonly LoopDrawV1[] = [
  { drawId: '2026-11-28', opensAt: '2026-11-21T00:00:00.000Z', closesAt: '2026-11-28T18:00:00.000Z', winners: 3, prizeUsdc: '5' },
  { drawId: '2026-12-03', opensAt: '2026-11-28T18:00:00.000Z', closesAt: '2026-12-03T18:00:00.000Z', winners: 3, prizeUsdc: '5' },
];

/** The most winners one draw may have. */
export const LOOP_DRAW_MAX_WINNERS_V1 = 20;

/** Seconds between the list being fixed and the block that picks from it. */
export const LOOP_DRAW_BLOCK_DELAY_S_V1 = 300;

/** The draw open at `now`, or null. */
export function loopDrawOpenAtV1(now: Date, draws: readonly LoopDrawV1[] = LOOP_DRAWS_V1): LoopDrawV1 | null {
  const t = now.getTime();
  return draws.find((draw) => Date.parse(draw.opensAt) <= t && t < Date.parse(draw.closesAt)) ?? null;
}

/** The draw open at `now`, else the next to open, else null. */
export function loopDrawCurrentV1(now: Date, draws: readonly LoopDrawV1[] = LOOP_DRAWS_V1): LoopDrawV1 | null {
  const t = now.getTime();
  return loopDrawOpenAtV1(now, draws) ?? [...draws].filter((draw) => Date.parse(draw.opensAt) > t)
    .sort((a, b) => Date.parse(a.opensAt) - Date.parse(b.opensAt))[0] ?? null;
}

/** What a draw's list commits to: the draw, its close, the moment its list was fixed, its winners, and the list. */
export interface LoopDrawListInputV1 {
  drawId: string;
  closesAt: string;
  /** Any ISO form: the text always says it as `toISOString()` does. */
  lockedAt: string;
  winners: number;
  labels: readonly string[];
}

/** The list as published, the exact text its hash and its time-stamps are of:
 * {"drawId":…,"closesAt":…,"lockedAt":…,"winners":…,"labels":[…]}. */
export function loopDrawListTextV1(input: LoopDrawListInputV1): string {
  const lockedAt = new Date(input.lockedAt);
  if (!Number.isFinite(lockedAt.getTime())) throw new Error('loop_draw_locked_at_invalid');
  if (!Number.isSafeInteger(input.winners) || input.winners < 1 || input.winners > LOOP_DRAW_MAX_WINNERS_V1) throw new Error('loop_draw_winners_invalid');
  return JSON.stringify({ drawId: input.drawId, closesAt: input.closesAt, lockedAt: lockedAt.toISOString(), winners: input.winners, labels: [...input.labels] });
}

/** keccak256 of the list as published (loopDrawListTextV1). */
export function loopDrawListHashV1(input: LoopDrawListInputV1): Hex {
  return keccak256(stringToHex(loopDrawListTextV1(input)));
}

/** The moment the list was fixed, as written: the next whole second. */
export function loopDrawLockMomentV1(now: Date): Date {
  return new Date(Math.ceil(now.getTime() / 1000) * 1000);
}

/** Unix seconds the picking block's timestamp must reach: five minutes after the later of the close and the lock. */
export function loopDrawTargetSecondsV1(input: { closesAt: string; lockedAt: string }): bigint {
  const later = Math.max(Date.parse(input.closesAt), Date.parse(input.lockedAt));
  return BigInt(Math.ceil(later / 1000) + LOOP_DRAW_BLOCK_DELAY_S_V1);
}

/** The winning entries' numbers, from 1 to `count`, in the order picked: min(winners, count) of them, none twice. */
export function loopDrawWinnersV1(input: { blockHash: Hex; drawId: string; count: number; winners: number }): number[] {
  if (!Number.isSafeInteger(input.count) || input.count < 1) throw new Error('loop_draw_count_invalid');
  if (!Number.isSafeInteger(input.winners) || input.winners < 1 || input.winners > LOOP_DRAW_MAX_WINNERS_V1) throw new Error('loop_draw_winners_invalid');
  if (!/^0x[0-9a-f]{64}$/i.test(input.blockHash)) throw new Error('loop_draw_block_hash_invalid');
  const left = Array.from({ length: input.count }, (_, at) => at + 1);
  const picked: number[] = [];
  for (let k = 1; k <= Math.min(input.winners, input.count); k += 1) {
    const mixed = keccak256(concat([input.blockHash, stringToHex(k === 1 ? input.drawId : `${input.drawId}/${k}`)]));
    picked.push(left.splice(Number(BigInt(mixed) % BigInt(left.length)), 1)[0]!);
  }
  return picked;
}

/** The first winner's number, from 1 to `count`. */
export function loopDrawWinnerV1(input: { blockHash: Hex; drawId: string; count: number }): number {
  return loopDrawWinnersV1({ ...input, winners: 1 })[0]!;
}

export interface LoopDrawBlockV1 {
  number: bigint;
  hash: Hex;
  timestamp: bigint;
}

/** The first block whose timestamp is at least `target`, or null while the chain has not reached it.
 * Steps back from the head, then halves: about twenty reads for a target days old. */
export async function loopDrawFirstBlockAtOrAfterV1(input: {
  target: bigint;
  head: () => Promise<LoopDrawBlockV1>;
  at: (number: bigint) => Promise<LoopDrawBlockV1>;
}): Promise<LoopDrawBlockV1 | null> {
  const seen = new Map<bigint, LoopDrawBlockV1>();
  const read = async (number: bigint) => {
    const known = seen.get(number);
    if (known) return known;
    const block = await input.at(number);
    if (block.number !== number) throw new Error('loop_draw_block_mismatch');
    seen.set(number, block);
    return block;
  };
  const head = await input.head();
  seen.set(head.number, head);
  if (head.timestamp < input.target) return null;
  let hi = head.number;
  // Five blocks a second covers blocks as short as 200 ms; a wider step only costs a few more halvings.
  let step = (head.timestamp - input.target) * 5n + 10n;
  let lo = hi > step ? hi - step : 0n;
  let low = await read(lo);
  while (low.timestamp >= input.target) {
    if (lo === 0n) return low;
    hi = lo;
    step *= 2n;
    lo = hi > step ? hi - step : 0n;
    low = await read(lo);
  }
  // Here ts(lo) < target <= ts(hi).
  while (hi - lo > 1n) {
    const mid = (lo + hi) / 2n;
    if ((await read(mid)).timestamp >= input.target) hi = mid;
    else lo = mid;
  }
  return read(hi);
}
