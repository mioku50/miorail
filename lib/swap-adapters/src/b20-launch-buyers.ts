import { UNISWAP_V4_POOL_MANAGER_V1 } from './uniswap-v4-pinned.js';
import type { RawLogV1 } from './uniswap-v4-pool.js';

// ---------------------------------------------------------------------------
// Who bought out of the pool in a launch's own window, and how concentrated
// that buying was.
//
// The exit-first question this answers: if one wallet bought everything that
// left the pool, your exit is contingent on that wallet not selling first.
// Measured across ten B20 launches where the rail found BOTH legs, the answer
// varies enough to be worth stating — 0, 1, 1, 2, 2, 3, 8, 32 and 76 distinct
// buyers, with the largest holding between 13.8% and 100% of everything bought.
// Across ten launches picked WITHOUT that filter, eight had no buyer at all.
// So this has content only for launches that actually trade, which is a
// minority, and an empty result is the common and correct one.
//
// A buy is a `Transfer` whose SENDER is the v4 PoolManager: tokens leaving the
// singleton are tokens somebody took. That rule excludes the mint, the launch
// hook and the pool seeding by construction rather than by a heuristic about
// what a launch usually looks like.
//
// Three things this deliberately does NOT claim:
//
//   * Not "snipers". Intent is not on chain. These are the addresses that
//     received tokens out of the pool in a bounded window; whether that was
//     fast, automated or coordinated is not something a Transfer log says.
//   * Not holdings. This is GROSS buying in the window. A buyer may have sold
//     everything since, and a concentration figure read as "who holds the
//     supply" would be a different and unsupported claim.
//   * Not a complete picture of a buyer. If a swap routes through an
//     intermediary contract, that contract is what the pool paid, so it counts
//     as the buyer here. Distinct-address counts in the sample were far larger
//     than one, so this is not collapsing everything into a single router —
//     but a single row may still name a contract rather than a person.
// ---------------------------------------------------------------------------

/** `Transfer(address,address,uint256)`. */
export const ERC20_TRANSFER_TOPIC_V1 =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef' as const;

const WORD_V1 = /^0x[0-9a-f]{64}$/;

function lower(value: string | undefined): string {
  return (value ?? '').toLowerCase();
}

function addressFromTopic(topic: string | undefined): string | null {
  const value = lower(topic);
  if (!WORD_V1.test(value)) return null;
  return `0x${value.slice(26)}`;
}

export interface B20LaunchBuyerV1 {
  address: string;
  /** Gross tokens received out of the pool in the window, atomic. */
  boughtAtomic: string;
  /** Share of everything bought in the window, in basis points. */
  shareBps: number;
}

export interface B20LaunchBuyersV1 {
  fromBlock: number;
  toBlock: number;
  /** Distinct addresses the pool paid tokens to. Zero is a real answer. */
  buyerCount: number;
  totalBoughtAtomic: string;
  /** Largest first. Bounded by `limit` — the tail is summarised by the counts,
   * not truncated silently into the shares. */
  buyers: B20LaunchBuyerV1[];
  /** The largest single buyer's share, in bps. Null when nobody bought — a
   * concentration of zero buyers is not 0%, it is not a number. */
  topBuyerShareBps: number | null;
  /** The three largest together, in bps. Null for the same reason. */
  topThreeShareBps: number | null;
}

export type B20LaunchBuyersResultV1 =
  | { ok: true; distribution: B20LaunchBuyersV1 }
  | { ok: false; refusal: 'endpoint_unavailable' };

/**
 * Reads Transfer logs into a buying distribution. Pure — the caller fetches.
 *
 * Callers must pass only logs they actually received. An endpoint that refused
 * has to arrive as `endpoint_unavailable` from the fetching layer and must
 * never be handed here as an empty array: "nobody bought" and "we could not
 * ask" are different facts, and only the first is about the token.
 */
export function b20LaunchBuyersFromLogsV1(input: {
  logs: readonly RawLogV1[];
  token: string;
  fromBlock: number;
  toBlock: number;
  /** How many rows to return. The counts and shares are computed over ALL
   * buyers regardless, so a limit changes what is listed, never what is
   * claimed. */
  limit?: number;
}): B20LaunchBuyersV1 {
  const token = lower(input.token);
  const poolManager = UNISWAP_V4_POOL_MANAGER_V1;
  const bought = new Map<string, bigint>();

  for (const log of input.logs) {
    // Only this token's own ledger. A Transfer emitted by another contract
    // says nothing about who bought this one.
    if (lower(log.address) !== token) continue;
    const topics = log.topics ?? [];
    if (topics.length < 3 || lower(topics[0]) !== ERC20_TRANSFER_TOPIC_V1) continue;
    const from = addressFromTopic(topics[1]);
    const to = addressFromTopic(topics[2]);
    if (!from || !to) continue;
    // Tokens leaving the singleton are tokens somebody took.
    if (from !== poolManager) continue;
    // A pool paying itself is accounting, not a buy.
    if (to === poolManager) continue;
    const data = lower(log.data);
    // An amount that cannot be read is not silently a zero: skipping keeps it
    // out of the totals rather than deflating everyone else's share.
    if (!/^0x[0-9a-f]{1,64}$/.test(data)) continue;
    const amount = BigInt(data);
    if (amount <= 0n) continue;
    bought.set(to, (bought.get(to) ?? 0n) + amount);
  }

  const ranked = [...bought.entries()].sort((left, right) => {
    if (right[1] !== left[1]) return right[1] > left[1] ? 1 : -1;
    // A stable tie-break, so the same logs always produce the same rows.
    return left[0] < right[0] ? -1 : 1;
  });
  const total = ranked.reduce((sum, [, amount]) => sum + amount, 0n);
  const shareBps = (amount: bigint): number =>
    total === 0n ? 0 : Number((amount * 10_000n) / total);

  const limit = Math.max(1, input.limit ?? 10);
  return {
    fromBlock: input.fromBlock,
    toBlock: input.toBlock,
    buyerCount: ranked.length,
    totalBoughtAtomic: total.toString(),
    buyers: ranked.slice(0, limit).map(([address, amount]) => ({
      address,
      boughtAtomic: amount.toString(),
      shareBps: shareBps(amount),
    })),
    topBuyerShareBps: ranked.length > 0 ? shareBps(ranked[0]![1]) : null,
    topThreeShareBps: ranked.length > 0
      ? shareBps(ranked.slice(0, 3).reduce((sum, [, amount]) => sum + amount, 0n))
      : null,
  };
}

/**
 * Fetches the window and reads it, keeping the one distinction that matters.
 *
 * A refused or failed request becomes `endpoint_unavailable`, never an empty
 * distribution. Miorail has shipped the opposite mistake three times — an
 * endpoint failure rendered as a finding about a token — and here it would be
 * especially convincing, because "no buyers" is also the COMMON true answer.
 * A silent zero would be indistinguishable from the real thing.
 */
export async function b20LaunchBuyersV1(input: {
  token: string;
  launchBlock: number;
  windowBlocks?: number;
  limit?: number;
  getLogs: (query: {
    address: string;
    fromBlock: number;
    toBlock: number;
    topics: (string | null)[];
  }) => Promise<readonly RawLogV1[]>;
}): Promise<B20LaunchBuyersResultV1> {
  const fromBlock = input.launchBlock;
  const toBlock = fromBlock + (input.windowBlocks ?? B20_BUYER_WINDOW_BLOCKS_V1);
  let logs: readonly RawLogV1[];
  try {
    logs = await input.getLogs({
      address: input.token,
      fromBlock,
      toBlock,
      // Filtered to this token's Transfers server-side; sender and recipient
      // stay unfiltered because both are needed to tell a buy from the mint.
      topics: [ERC20_TRANSFER_TOPIC_V1],
    });
  } catch {
    return { ok: false, refusal: 'endpoint_unavailable' };
  }
  return {
    ok: true,
    distribution: b20LaunchBuyersFromLogsV1({
      logs, token: input.token, fromBlock, toBlock, limit: input.limit,
    }),
  };
}

/**
 * How far past the launch to look.
 *
 * 10,000 blocks is about five and a half hours of Base, and `mainnet.base.org`
 * serves that range in ONE `eth_getLogs` — Alchemy's free tier would need a
 * thousand. The window is part of every claim this produces, because
 * "concentration" without a window is not a measurement.
 */
export const B20_BUYER_WINDOW_BLOCKS_V1 = 10_000;
