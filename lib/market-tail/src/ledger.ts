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

function lower(value: string | undefined): string {
  return (value ?? '').toLowerCase();
}

function addressFromTopic(topic: string | undefined): string | null {
  const value = lower(topic);
  if (!WORD_V1.test(value)) return null;
  return `0x${value.slice(26)}`;
}

function quantityFromHex(value: string | undefined): number | null {
  const hex = lower(value);
  if (!/^0x[0-9a-f]{1,16}$/.test(hex)) return null;
  const parsed = Number.parseInt(hex, 16);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/**
 * Transfer logs into transfers, for the tokens we asked about.
 *
 * The token filter is applied again here even though the request carried it.
 * A log for an address nobody tracked means the request was not the one we
 * think it was, and silently folding it in would attribute another token's
 * movement to this vertical.
 */
export function assetTransfersFromLogsV1(input: {
  logs: readonly RawLogV1[];
  trackedTokens: readonly string[];
}): AssetTransferV1[] {
  const tracked = new Set(input.trackedTokens.map((token) => lower(token)));
  const transfers: AssetTransferV1[] = [];

  for (const log of input.logs) {
    const tokenAddress = lower(log.address);
    if (!tracked.has(tokenAddress)) continue;
    const topics = log.topics ?? [];
    if (topics.length < 3 || lower(topics[0]) !== ERC20_TRANSFER_TOPIC_V1) continue;
    const from = addressFromTopic(topics[1]);
    const to = addressFromTopic(topics[2]);
    if (!from || !to || !ADDRESS_V1.test(from) || !ADDRESS_V1.test(to)) continue;

    const data = lower(log.data);
    // An amount that cannot be read is skipped, never treated as zero: a zero
    // is a real and different observation.
    if (!/^0x[0-9a-f]{1,64}$/.test(data)) continue;

    const blockNumber = quantityFromHex(log.blockNumber);
    const logIndex = quantityFromHex(log.logIndex);
    const transactionHash = lower(log.transactionHash);
    // Without block, transaction and index there is no idempotency key, and a
    // row that cannot be deduplicated will be written again on every re-read.
    if (blockNumber === null || logIndex === null || !TX_HASH_V1.test(transactionHash)) continue;

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
  return transfers;
}
