import { createPublicClient, http } from 'viem';
import { base } from 'viem/chains';
import type {
  NftChainReaderV1,
  NftObservedOwnerV1,
  NftObservedTransactionV1,
} from '@mioagent/nft-engine';
import { baseRpcUrlV1 } from './earnPreflight.js';

// ---------------------------------------------------------------------------
// T65.1 §5 — the production chain reader.
//
// Mirrors baseReceiptReader.ts: the RPC URL comes from the environment only,
// and every failure returns null rather than throwing. Null means "this read
// did not answer", which the proof records as a GAP — never as a finding about
// who owns the token.
// ---------------------------------------------------------------------------

const ERC721_OWNER_OF_ABI_V1 = [
  {
    type: 'function',
    name: 'ownerOf',
    stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [{ name: 'owner', type: 'address' }],
  },
] as const;

export function createViemNftChainReaderV1(env: NodeJS.ProcessEnv = process.env): NftChainReaderV1 {
  const client = createPublicClient({ chain: base, transport: http(baseRpcUrlV1(env)) });

  return {
    async readTransaction(input): Promise<NftObservedTransactionV1 | null> {
      try {
        const receipt = await client.getTransactionReceipt({ hash: input.hash as `0x${string}` });
        if (receipt.status !== 'success' && receipt.status !== 'reverted') return null;
        // The value comes from the TRANSACTION, not the receipt: a receipt says
        // what happened, the transaction says what was sent.
        const transaction = await client.getTransaction({ hash: input.hash as `0x${string}` });
        return {
          receipt: {
            status: receipt.status,
            transactionHash: receipt.transactionHash.toLowerCase(),
            blockNumber: receipt.blockNumber,
            gasUsed: receipt.gasUsed,
            logs: receipt.logs.map((log) => ({
              address: log.address,
              topics: log.topics as readonly string[],
              data: log.data,
            })),
          },
          actualNativeValueWei: transaction.value.toString(),
        };
      } catch {
        // An unmined or unknown transaction is pending, not failed.
        return null;
      }
    },

    async readOwnerOf(input): Promise<NftObservedOwnerV1 | null> {
      try {
        // The block is captured FIRST, so the number recorded alongside the
        // owner is never later than the state that produced it.
        const blockNumber = await client.getBlockNumber();
        const owner = await client.readContract({
          address: input.contractAddress as `0x${string}`,
          abi: ERC721_OWNER_OF_ABI_V1,
          functionName: 'ownerOf',
          args: [BigInt(input.tokenId)],
          blockNumber,
        });
        return { owner: String(owner).toLowerCase(), blockNumber: blockNumber.toString() };
      } catch {
        // A burned token reverts here. That is an unanswered read, not a claim
        // that someone else owns it.
        return null;
      }
    },
  };
}
