import type { StillLoopDrawRecordV1 } from '@mioagent/route-storage';

// ---------------------------------------------------------------------------
// What a prize transaction proves, worked out from its receipt
// (still_loop_draw_prize.ts, audit LOOP-3, 2026-11-18). Pure, so it is tested
// without Base or the database.
// ---------------------------------------------------------------------------

const USDC_V1 = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const TRANSFER_TOPIC_V1 = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const topicAddressV1 = (topic: string | undefined): string | null =>
  topic && /^0x0{24}[0-9a-f]{40}$/i.test(topic) ? `0x${topic.slice(-40).toLowerCase()}` : null;

/** The USDC each wallet received in these logs from `from` alone. */
export function loopPrizeTransfersV1(logs: readonly { address: string; topics: readonly string[]; data: string }[], from: string): Map<string, bigint> {
  const sent = new Map<string, bigint>();
  for (const log of logs) {
    if (log.address.toLowerCase() !== USDC_V1 || log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC_V1) continue;
    const sender = topicAddressV1(log.topics[1]), to = topicAddressV1(log.topics[2]);
    if (sender !== from.toLowerCase() || to === null || !/^0x[0-9a-f]{1,64}$/i.test(log.data)) continue;
    sent.set(to, (sent.get(to) ?? 0n) + BigInt(log.data));
  }
  return sent;
}

/**
 * The unpaid winners of `draw` this transaction pays: each wallet's USDC from it, less every prize already recorded
 * with this same transaction to that wallet in any draw, must still hold this draw's prize, once per winner.
 */
export function loopPrizesCoveredV1(input: {
  tx: string;
  sent: ReadonlyMap<string, bigint>;
  prize: bigint;
  draw: Pick<StillLoopDrawRecordV1, 'drawId' | 'entries'>;
  unpaid: readonly number[];
  draws: readonly Pick<StillLoopDrawRecordV1, 'drawId' | 'entries' | 'payouts' | 'prizeAtomic'>[];
}): number[] {
  const left = new Map(input.sent);
  for (const draw of input.draws) {
    for (const payout of draw.payouts) {
      if (payout.tx.toLowerCase() !== input.tx.toLowerCase()) continue;
      const wallet = draw.entries[payout.no - 1]?.walletAddress.toLowerCase();
      if (wallet) left.set(wallet, (left.get(wallet) ?? 0n) - BigInt(draw.prizeAtomic));
    }
  }
  const covered: number[] = [];
  for (const no of input.unpaid) {
    const wallet = input.draw.entries[no - 1]?.walletAddress.toLowerCase();
    if (!wallet || (left.get(wallet) ?? 0n) < input.prize) continue;
    left.set(wallet, left.get(wallet)! - input.prize);
    covered.push(no);
  }
  return covered;
}
