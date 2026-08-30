import { encodeFunctionData, decodeFunctionResult } from 'viem';

import { createB20ReaderV1 } from '@mioagent/b20-control';

// ---------------------------------------------------------------------------
// Connected Intelligence 2 — a representation's own decimals and symbol.
//
// A reviewed representation binding carries an address and an issuer; it does
// not carry decimals. And a wrong decimals does not produce a wrong-looking
// number — it produces a DIFFERENT SIZE, silently, in the direction of a
// thousand-fold. So this reads the contract rather than assuming eighteen, and
// refuses rather than guessing when the read does not come back.
//
// Its own module so the private MCP surface can reach it without importing the
// Market Reality route, which would pull an Express router into a tool layer
// that has no business holding one.
// ---------------------------------------------------------------------------

const ERC20_METADATA_ABI_V1 = [
  {
    type: 'function',
    name: 'decimals',
    inputs: [],
    outputs: [{ type: 'uint8' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'symbol',
    inputs: [],
    outputs: [{ type: 'string' }],
    stateMutability: 'view',
  },
] as const;

function rpcUrlV1(): string {
  return (process.env.BASE_MAINNET_RPC_URL || process.env.BASE_RPC_URL || '').trim();
}

export type StockRepresentationTokenV1 =
  | { ok: true; decimals: number; symbol: string }
  | { ok: false };

/**
 * `decimals()` and `symbol()` for one exact representation, at a pinned block.
 *
 * Anchored rather than read at head for the same reason every other chain read
 * in this product is: two reads at two blocks are two facts, and an exact size
 * deserves one.
 */
export async function readStockRepresentationTokenV1(
  tokenAddress: string,
): Promise<StockRepresentationTokenV1> {
  const rpcUrl = rpcUrlV1();
  if (!rpcUrl) return { ok: false };
  if (!/^0x[0-9a-fA-F]{40}$/.test(tokenAddress)) return { ok: false };

  try {
    const reader = createB20ReaderV1({ rpcUrl });
    const anchor = await reader.readBlockAnchor();
    if (!anchor.ok) return { ok: false };

    const reads = await Promise.all(
      (['decimals', 'symbol'] as const).map((functionName) =>
        reader.call({
          to: tokenAddress as `0x${string}`,
          data: encodeFunctionData({ abi: ERC20_METADATA_ABI_V1, functionName }),
          blockTag: anchor.value.blockTag,
        }),
      ),
    );
    if (reads.some((read) => !read.ok)) return { ok: false };

    const decimals = Number(
      decodeFunctionResult({
        abi: ERC20_METADATA_ABI_V1,
        functionName: 'decimals',
        data: (reads[0] as { value: `0x${string}` }).value,
      }),
    );
    const symbol = String(
      decodeFunctionResult({
        abi: ERC20_METADATA_ABI_V1,
        functionName: 'symbol',
        data: (reads[1] as { value: `0x${string}` }).value,
      }),
    );
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) return { ok: false };
    return { ok: true, decimals, symbol: symbol.length > 0 ? symbol : 'TOKEN' };
  } catch {
    // A read that did not complete is not a token with eighteen decimals.
    return { ok: false };
  }
}
