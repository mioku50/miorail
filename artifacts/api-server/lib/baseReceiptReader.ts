import { createPublicClient, http, type Hash } from 'viem';
import { base } from 'viem/chains';
import type { BaseReceiptReader, VerifiedReceiptSourceV1 } from '@mioagent/route-proof';
import type { HashV1 } from '@mioagent/route-domain';
import { logger } from '@mioagent/utils';

// T58: the ONLY server-side chain-read seam for Route Proof reconciliation.
// The RPC URL comes exclusively from the server environment — NEVER from
// request data — and the reader is injected into the reconciler so tests
// always use mock readers (no live RPC in tests). Read-only: the server
// never signs or broadcasts through this client.

function baseRpcUrl(): string {
  return (
    process.env.BASE_MAINNET_RPC_URL ||
    process.env.BASE_RPC_URL ||
    'https://mainnet.base.org'
  );
}

/** What a transaction asked for, as the chain records it. */
export interface BaseTransactionSourceV1 {
  from: string;
  to: string | null;
  value: bigint;
  input: string;
  /** The sender's own transaction count when it sent this one; absent when the reader did not say. */
  nonce?: number;
}

export interface BaseChainReaderV1 extends BaseReceiptReader {
  /** Null when the transaction cannot be read, never a guess. */
  getTransaction(hash: HashV1): Promise<BaseTransactionSourceV1 | null>;
  /** How many transactions this address has sent, as of the latest block or with those the node holds
   * pending; null when it cannot be read. A reader without it is one that cannot say. */
  getTransactionCount?(address: string, blockTag: 'latest' | 'pending'): Promise<number | null>;
  /**
   * The account's own transactions that landed after `afterBlock`, oldest first, found by its own
   * transaction count. Only for an EIP-7702 account, which sends its batches itself (MetaMask,
   * 2026-11-09: its batch handle is the wallet's own, and nothing outside the wallet can name it). An
   * empty list when none landed; null for any other account, or when it cannot be read.
   */
  findOwnTransactionsAfter?(address: string, afterBlock: bigint): Promise<HashV1[] | null>;
}

/** An EIP-7702 delegation designator: the account's code is 0xef0100 followed by its delegate. */
export function isDelegatedAccountCodeV1(code: string | null | undefined): boolean {
  return typeof code === 'string' && /^0xef0100[0-9a-f]{40}$/i.test(code);
}

const OWN_TRANSACTIONS_LIMIT_V1 = 4;
/**
 * How far below the head the search reads. Base makes a block every 200 ms, and the node behind a
 * load balancer that answers a count may not hold the block another node just named as the head
 * (2026-11-09: the first live search returned nothing while the same search from a script found the
 * loan). A transaction this fresh is found on the next read.
 */
export const OWN_TRANSACTIONS_HEAD_MARGIN_V1 = 30n;
const OWN_TRANSACTIONS_READ_ATTEMPTS_V1 = 3;

/** One read, asked again after a short pause when a node answers with an error. */
async function readAgainV1<T>(read: () => Promise<T>, pause: (ms: number) => Promise<void>): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try { return await read(); } catch (error) {
      if (attempt >= OWN_TRANSACTIONS_READ_ATTEMPTS_V1) throw error;
      await pause(250 * attempt);
    }
  }
}
// What a search found, by account, review block and the account's count then: a page that asks every
// few seconds does not search the chain again until the account sends something more.
const ownTransactionsSeenV1 = new Map<string, HashV1[]>();

/** The search behind `findOwnTransactionsAfter`, over any client that can read counts at a block. */
export async function findOwnTransactionsAfterV1(client: {
  getCode(args: { address: `0x${string}` }): Promise<string | undefined>;
  getBlockNumber(): Promise<bigint>;
  getTransactionCount(args: { address: `0x${string}`; blockNumber: bigint }): Promise<number>;
  getBlock(args: { blockNumber: bigint; includeTransactions: true }): Promise<{ transactions: readonly { hash: string; from: string; nonce: number }[] }>;
}, address: string, afterBlock: bigint, options: { pause?: (ms: number) => Promise<void>; onError?: (error: unknown) => void } = {}): Promise<HashV1[] | null> {
  const pause = options.pause ?? ((ms: number) => new Promise<void>(resolve => { setTimeout(resolve, ms); }));
  try {
    const wallet = address.toLowerCase() as `0x${string}`;
    // A smart contract wallet's operations are sent by bundlers: its own count never moves.
    if (!isDelegatedAccountCodeV1(await readAgainV1(() => client.getCode({ address: wallet }), pause))) return null;
    const latest = (await readAgainV1(() => client.getBlockNumber(), pause)) - OWN_TRANSACTIONS_HEAD_MARGIN_V1;
    if (afterBlock >= latest) return [];
    const countAt = (blockNumber: bigint) => readAgainV1(() => client.getTransactionCount({ address: wallet, blockNumber }), pause);
    const [first, last] = await Promise.all([countAt(afterBlock), countAt(latest)]);
    if (last <= first) return [];
    const key = `${wallet}|${afterBlock}|${last}`;
    const seen = ownTransactionsSeenV1.get(key);
    if (seen) return [...seen];
    const hashes: HashV1[] = [];
    let low = afterBlock;
    for (let nonce = first; nonce < last && hashes.length < OWN_TRANSACTIONS_LIMIT_V1; nonce += 1) {
      // The first block whose count is past `nonce` holds the account's transaction with that nonce.
      let lo = low, hi = latest;
      while (hi - lo > 1n) {
        const mid = (lo + hi) / 2n;
        if ((await countAt(mid)) > nonce) hi = mid; else lo = mid;
      }
      const block = await readAgainV1(() => client.getBlock({ blockNumber: hi, includeTransactions: true }), pause);
      const own = block.transactions.find(tx => tx.from.toLowerCase() === wallet && tx.nonce === nonce);
      if (!own) return null;
      hashes.push(own.hash.toLowerCase() as HashV1);
      // The next one may have landed in the same block.
      low = hi - 1n;
    }
    if (ownTransactionsSeenV1.size >= 256) ownTransactionsSeenV1.delete(ownTransactionsSeenV1.keys().next().value!);
    ownTransactionsSeenV1.set(key, hashes);
    return [...hashes];
  } catch (error) {
    options.onError?.(error);
    return null;
  }
}

export function createViemBaseReceiptReader(): BaseChainReaderV1 {
  const publicClient = createPublicClient({ chain: base, transport: http(baseRpcUrl()) });
  return {
    async getTransaction(hash: HashV1): Promise<BaseTransactionSourceV1 | null> {
      try {
        const transaction = await publicClient.getTransaction({ hash: hash as Hash });
        return {
          from: transaction.from.toLowerCase(),
          to: transaction.to ? transaction.to.toLowerCase() : null,
          value: transaction.value,
          input: transaction.input.toLowerCase(),
          nonce: transaction.nonce,
        };
      } catch {
        return null;
      }
    },
    async getTransactionCount(address: string, blockTag: 'latest' | 'pending'): Promise<number | null> {
      try {
        return await publicClient.getTransactionCount({ address: address as `0x${string}`, blockTag });
      } catch {
        return null;
      }
    },
    async findOwnTransactionsAfter(address: string, afterBlock: bigint): Promise<HashV1[] | null> {
      return findOwnTransactionsAfterV1(publicClient as unknown as Parameters<typeof findOwnTransactionsAfterV1>[0], address, afterBlock, {
        // A search that could not be read leaves a loan "sent"; the journal says why, never which wallet.
        onError: error => logger.warn('Own transaction search unread', { errorName: error instanceof Error ? error.name : typeof error,
          detail: error instanceof Error ? error.message.replace(/0x[0-9a-fA-F]{40,}/g, '0x…').replace(/https?:\/\/\S+/g, '(url)').slice(0, 160) : null }),
      });
    },
    async getTransactionReceipt(hash: HashV1): Promise<VerifiedReceiptSourceV1 | null> {
      let receipt;
      try {
        receipt = await publicClient.getTransactionReceipt({ hash: hash as Hash });
      } catch {
        // Not found / transport failure — honestly unavailable, never a
        // fabricated status. The reconciler maps null to `unknown`.
        return null;
      }
      if (receipt.status !== 'success' && receipt.status !== 'reverted') return null;
      return {
        transactionHash: (receipt.transactionHash as string).toLowerCase() as HashV1,
        status: receipt.status,
        blockNumber: receipt.blockNumber,
        gasUsed: receipt.gasUsed,
        effectiveGasPriceWei: receipt.effectiveGasPrice ?? null,
        logs: receipt.logs.map((log) => ({
          address: log.address,
          topics: log.topics as readonly string[],
          data: log.data,
        })),
        from: receipt.from.toLowerCase(),
      };
    },
  };
}
