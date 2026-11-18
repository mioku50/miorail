import { ERC20_TRANSFER_TOPIC_V1 } from './constants.js';

// ---------------------------------------------------------------------------
// The token's own ledger, parsed. Pure -- the caller fetches.
//
// Callers must pass only logs they actually received. An endpoint that refused
// has to arrive as a refusal from the fetching layer and must never be handed
// here as an empty array: "nothing moved" and "we could not ask" are different
// facts, and only the first is about the asset.
// ---------------------------------------------------------------------------

export interface RawLogV1 {
  address?: string;
  topics?: readonly string[];
  data?: string;
  blockNumber?: string;
  transactionHash?: string;
  logIndex?: string;
}

export interface AssetTransferV1 {
  tokenAddress: string;
  from: string;
  to: string;
  amountAtomic: string;
  blockNumber: number;
  transactionHash: string;
  logIndex: number;
}

const WORD_V1 = /^0x[0-9a-f]{64}$/;
const ADDRESS_V1 = /^0x[0-9a-f]{40}$/;
const TX_HASH_V1 = /^0x[0-9a-f]{64}$/;

/** A field the endpoint sent, as lowercase text, or '' for anything that is
 * not a string: these come from JSON, and a number or a null in a field is an
 * unreadable log, not a reason to throw. */
function lower(value: unknown): string {
  return typeof value === 'string' ? value.toLowerCase() : '';
}

function addressFromTopic(topic: unknown): string | null {
  const value = lower(topic);
  if (!WORD_V1.test(value)) return null;
  return `0x${value.slice(26)}`;
}

function quantityFromHex(value: unknown): number | null {
  const hex = lower(value);
  if (!/^0x[0-9a-f]{1,16}$/.test(hex)) return null;
  const parsed = Number.parseInt(hex, 16);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export interface AssetTransferReadingV1 {
  transfers: AssetTransferV1[];
  /**
   * Transfer logs of a tracked token that could not be read in full: a side,
   * an amount, or the block, transaction and index that key the row. Each one
   * is a movement this read did not see, so a pass that meets one must not
   * move its cursor past it. Skipping them returned a clean, shorter list, and
   * the tail then marked the whole range read (re-audit P2 market tail,
   * 2026-11-18).
   */
  unreadable: number;
}

/**
 * Transfer logs into transfers, for the tokens we asked about.
 *
 * The token filter is applied again here even though the request carried it.
 * A log for an address nobody tracked means the request was not the one we
 * think it was, and silently folding it in would attribute another token's
 * movement to this vertical.
 *
 * Only a log that READS as not ours is skipped: another token's address, or a
 * topic that is not Transfer. Anything else answered a request for the tracked
 * tokens' Transfers, so it is one of them, and it reads in full or it is
 * counted as unreadable.
 */
export function assetTransfersFromLogsV1(input: {
  logs: readonly RawLogV1[];
  trackedTokens: readonly string[];
}): AssetTransferReadingV1 {
  const tracked = new Set(input.trackedTokens.map((token) => lower(token)));
  const transfers: AssetTransferV1[] = [];
  let unreadable = 0;

  for (const log of input.logs) {
    const tokenAddress = lower(log.address);
    if (ADDRESS_V1.test(tokenAddress) && !tracked.has(tokenAddress)) continue;
    const topics: readonly unknown[] = Array.isArray(log.topics) ? log.topics : [];
    const topic0 = lower(topics[0]);
    if (WORD_V1.test(topic0) && topic0 !== ERC20_TRANSFER_TOPIC_V1) continue;

    const from = addressFromTopic(topics[1]);
    const to = addressFromTopic(topics[2]);
    const data = lower(log.data);
    const blockNumber = quantityFromHex(log.blockNumber);
    const logIndex = quantityFromHex(log.logIndex);
    const transactionHash = lower(log.transactionHash);
    if (
      // An address or a topic that did not read: not provably someone else's.
      !tracked.has(tokenAddress) ||
      topic0 !== ERC20_TRANSFER_TOPIC_V1 ||
      !from ||
      !to ||
      !ADDRESS_V1.test(from) ||
      !ADDRESS_V1.test(to) ||
      // An amount that cannot be read is never treated as zero: a zero is a
      // real and different observation.
      !/^0x[0-9a-f]{1,64}$/.test(data) ||
      // Without block, transaction and index there is no idempotency key, and a
      // row that cannot be deduplicated will be written again on every re-read.
      blockNumber === null ||
      logIndex === null ||
      !TX_HASH_V1.test(transactionHash)
    ) {
      unreadable += 1;
      continue;
    }

    transfers.push({
      tokenAddress,
      from,
      to,
      amountAtomic: BigInt(data).toString(),
      blockNumber,
      transactionHash,
      logIndex,
    });
  }
  return { transfers, unreadable };
}
