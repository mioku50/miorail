// The prize arithmetic and its one locked write live with the draws' storage; re-exported for the operator's script.
export { loopPrizesCoveredV1, recordLoopPrizesV1 } from '@mioagent/route-storage';

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
