import { createPublicClient, http, type Hash } from 'viem';
import { base } from 'viem/chains';
import { USER_OPERATION_EVENT_TOPIC_V1, type BaseReceiptReader, type VerifiedReceiptSourceV1 } from '@mioagent/route-proof';
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
  /** What this account is now: a plain one, one delegated by EIP-7702, or a contract. Null when unread. */
  getAccountKind?(address: string): Promise<'eoa' | 'eip7702' | 'contract' | null>;
  /** How many transactions this address had sent as of a block. Null when unread. */
  getTransactionCountAt?(address: string, blockNumber: bigint): Promise<number | null>;
  /** An ERC-4337 account's next nonce at one EntryPoint, key 0, as of a block or now. Null when unread. */
  getEntryPointNonce?(entryPoint: string, sender: string, at: bigint | 'latest'): Promise<bigint | null>;
  /** Every transaction a plain or EIP-7702 account sent after a block (listOwnTransactionsAfterV1). */
  listOwnTransactionsAfter?(address: string, afterBlock: bigint, limit: number): Promise<{ hashes: HashV1[]; complete: boolean } | null>;
  /** Every user operation a smart account landed at one EntryPoint after a block (listOwnOperationsAfterV1). */
  listOwnOperationsAfter?(entryPoint: string, sender: string, afterBlock: bigint, limit: number): Promise<{ hashes: HashV1[]; complete: boolean } | null>;
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

type OwnTransactionsClientV1 = {
  getCode(args: { address: `0x${string}` }): Promise<string | undefined>;
  getBlockNumber(): Promise<bigint>;
  getTransactionCount(args: { address: `0x${string}`; blockNumber: bigint }): Promise<number>;
  getBlock(args: { blockNumber: bigint; includeTransactions: true }): Promise<{ transactions: readonly { hash: string; from: string; nonce: number }[] }>;
};
type SearchOptionsV1 = { pause?: (ms: number) => Promise<void>; onError?: (error: unknown) => void };

/** The search behind `findOwnTransactionsAfter`, over any client that can read counts at a block. */
export async function findOwnTransactionsAfterV1(client: OwnTransactionsClientV1, address: string, afterBlock: bigint,
  options: SearchOptionsV1 = {}): Promise<HashV1[] | null> {
  const found = await searchOwnTransactionsV1(client, address, afterBlock, { ...options, limit: OWN_TRANSACTIONS_LIMIT_V1, delegatedOnly: true, toHead: false });
  return found ? found.hashes : null;
}

/**
 * Every transaction an account sent after a block, oldest first, by its own count: the first block whose
 * count is past each nonce holds the account's transaction with that nonce. For a plain account or an
 * EIP-7702 one; null for a smart contract wallet, whose operations bundlers send, or when unread.
 * `complete` says the search reached every transaction up to the head: not when there were more than
 * `limit`, nor when one landed in the last blocks below the head, which a lagging node may not hold yet
 * (audit LL-2, 2026-11-14: a release must see all of them, not the first four).
 */
export async function listOwnTransactionsAfterV1(client: OwnTransactionsClientV1, address: string, afterBlock: bigint,
  options: SearchOptionsV1 & { limit: number }): Promise<{ hashes: HashV1[]; complete: boolean } | null> {
  return searchOwnTransactionsV1(client, address, afterBlock, { ...options, delegatedOnly: false, toHead: true });
}

async function searchOwnTransactionsV1(client: OwnTransactionsClientV1, address: string, afterBlock: bigint,
  options: SearchOptionsV1 & { limit: number; delegatedOnly: boolean; toHead: boolean }): Promise<{ hashes: HashV1[]; complete: boolean } | null> {
  const pause = options.pause ?? ((ms: number) => new Promise<void>(resolve => { setTimeout(resolve, ms); }));
  try {
    const wallet = address.toLowerCase() as `0x${string}`;
    // A smart contract wallet's operations are sent by bundlers: its own count never moves.
    const code = await readAgainV1(() => client.getCode({ address: wallet }), pause);
    const delegated = isDelegatedAccountCodeV1(code);
    if (options.delegatedOnly ? !delegated : !delegated && code !== undefined && code !== '0x') return null;
    const head = await readAgainV1(() => client.getBlockNumber(), pause);
    const latest = head - OWN_TRANSACTIONS_HEAD_MARGIN_V1;
    if (afterBlock >= latest) return { hashes: [], complete: !options.toHead };
    const countAt = (blockNumber: bigint) => readAgainV1(() => client.getTransactionCount({ address: wallet, blockNumber }), pause);
    const [first, last, atHead] = await Promise.all([countAt(afterBlock), countAt(latest), options.toHead ? countAt(head) : Promise.resolve(0)]);
    // Something landed in the margin below the head: found on a later read, so this one is not complete.
    const reachedHead = !options.toHead || atHead <= last;
    if (last <= first) return { hashes: [], complete: reachedHead };
    const key = `${wallet}|${afterBlock}|${last}|${options.limit}`;
    const seen = ownTransactionsSeenV1.get(key);
    const complete = reachedHead && last - first <= options.limit;
    if (seen) return { hashes: [...seen], complete };
    const hashes: HashV1[] = [];
    let low = afterBlock;
    for (let nonce = first; nonce < last && hashes.length < options.limit; nonce += 1) {
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
    return { hashes: [...hashes], complete };
  } catch (error) {
    options.onError?.(error);
    return null;
  }
}

type OwnOperationsClientV1 = {
  getBlockNumber(): Promise<bigint>;
  /** The account's next nonce at the EntryPoint, key 0, as of a block. */
  nonceAt(blockNumber: bigint): Promise<bigint>;
  /** The EntryPoint's logs in one block. */
  logsAt(blockNumber: bigint): Promise<readonly { transactionHash: string | null; topics: readonly string[]; data: string }[]>;
};

/**
 * Every user operation a smart account landed at one EntryPoint after a block (key 0, the only key Base
 * Account has used in a Still loan), oldest first, as the transactions that carried them: the first block
 * whose nonce is past each one holds its UserOperationEvent. `complete` as for an account's own
 * transactions (audit LL-2, 2026-11-14: any later operation of a Base Account made a release refuse for ever).
 */
export async function listOwnOperationsAfterV1(client: OwnOperationsClientV1, sender: string, afterBlock: bigint,
  options: SearchOptionsV1 & { limit: number }): Promise<{ hashes: HashV1[]; complete: boolean } | null> {
  const pause = options.pause ?? ((ms: number) => new Promise<void>(resolve => { setTimeout(resolve, ms); }));
  try {
    const wallet = sender.toLowerCase();
    const head = await readAgainV1(() => client.getBlockNumber(), pause);
    const latest = head - OWN_TRANSACTIONS_HEAD_MARGIN_V1;
    if (afterBlock >= latest) return { hashes: [], complete: false };
    const nonceAt = (blockNumber: bigint) => readAgainV1(() => client.nonceAt(blockNumber), pause);
    const [first, last, atHead] = await Promise.all([nonceAt(afterBlock), nonceAt(latest), nonceAt(head)]);
    const reachedHead = atHead <= last;
    if (last <= first) return { hashes: [], complete: reachedHead };
    const hashes: HashV1[] = [];
    let low = afterBlock;
    for (let nonce = first; nonce < last && BigInt(hashes.length) < BigInt(options.limit); nonce += 1n) {
      let lo = low, hi = latest;
      while (hi - lo > 1n) {
        const mid = (lo + hi) / 2n;
        if ((await nonceAt(mid)) > nonce) hi = mid; else lo = mid;
      }
      const logs = await readAgainV1(() => client.logsAt(hi), pause);
      // UserOperationEvent(userOpHash, sender indexed, paymaster, nonce, success, actualGasCost, actualGasUsed).
      const own = logs.find(log => log.topics[0]?.toLowerCase() === USER_OPERATION_EVENT_TOPIC_V1 && log.topics.length === 4 &&
        /^0x0{24}[0-9a-fA-F]{40}$/.test(log.topics[2] ?? '') && `0x${log.topics[2]!.slice(26).toLowerCase()}` === wallet &&
        /^0x[0-9a-fA-F]{256}$/.test(log.data) && BigInt(`0x${log.data.slice(2, 66)}`) === nonce);
      if (!own?.transactionHash || !/^0x[0-9a-fA-F]{64}$/.test(own.transactionHash)) return null;
      hashes.push(own.transactionHash.toLowerCase() as HashV1);
      low = hi - 1n;
    }
    return { hashes, complete: reachedHead && last - first <= BigInt(options.limit) };
  } catch (error) {
    options.onError?.(error);
    return null;
  }
}

const ENTRY_POINT_NONCE_ABI_V1 = [{ type: 'function', name: 'getNonce', stateMutability: 'view',
  inputs: [{ name: 'sender', type: 'address' }, { name: 'key', type: 'uint192' }], outputs: [{ name: 'nonce', type: 'uint256' }] }] as const;

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
    async getAccountKind(address: string): Promise<'eoa' | 'eip7702' | 'contract' | null> {
      try {
        const code = await publicClient.getCode({ address: address as `0x${string}` });
        if (!code || code === '0x') return 'eoa';
        return isDelegatedAccountCodeV1(code) ? 'eip7702' : 'contract';
      } catch {
        return null;
      }
    },
    async getTransactionCountAt(address: string, blockNumber: bigint): Promise<number | null> {
      try {
        return await publicClient.getTransactionCount({ address: address as `0x${string}`, blockNumber });
      } catch {
        return null;
      }
    },
    async getEntryPointNonce(entryPoint: string, sender: string, at: bigint | 'latest'): Promise<bigint | null> {
      try {
        return await publicClient.readContract({ address: entryPoint as `0x${string}`, abi: ENTRY_POINT_NONCE_ABI_V1, functionName: 'getNonce',
          args: [sender as `0x${string}`, 0n], ...(at === 'latest' ? {} : { blockNumber: at }) });
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
    async listOwnTransactionsAfter(address: string, afterBlock: bigint, limit: number) {
      return listOwnTransactionsAfterV1(publicClient as unknown as OwnTransactionsClientV1, address, afterBlock, { limit,
        onError: error => logger.warn('Own transaction list unread', { errorName: error instanceof Error ? error.name : typeof error }) });
    },
    async listOwnOperationsAfter(entryPoint: string, sender: string, afterBlock: bigint, limit: number) {
      return listOwnOperationsAfterV1({
        getBlockNumber: () => publicClient.getBlockNumber(),
        nonceAt: blockNumber => publicClient.readContract({ address: entryPoint as `0x${string}`, abi: ENTRY_POINT_NONCE_ABI_V1, functionName: 'getNonce',
          args: [sender as `0x${string}`, 0n], blockNumber }),
        logsAt: async blockNumber => (await publicClient.getLogs({ address: entryPoint as `0x${string}`, fromBlock: blockNumber, toBlock: blockNumber }))
          .map(log => ({ transactionHash: log.transactionHash, topics: log.topics as readonly string[], data: log.data })),
      }, sender, afterBlock, { limit,
        onError: error => logger.warn('Own operation list unread', { errorName: error instanceof Error ? error.name : typeof error }) });
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
