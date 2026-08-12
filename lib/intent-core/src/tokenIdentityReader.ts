import { createPublicClient, http, parseAbi, type PublicClient } from 'viem';
import { base } from 'viem/chains';
import {
  addressesInTextV1,
  identifyTokenV1,
  trustedByAddressV1,
  type TokenIdentityReaderV1,
  type TokenIdentityV1,
} from './tokenIdentity.js';

// ---------------------------------------------------------------------------
// Reading a token's own answers off Base.
//
// This is the only place a chain call is made on behalf of the intent layer,
// and it exists so `identifyTokenV1` can stay a pure set of rules with the
// network injected.
//
// Two constraints shape everything here:
//
//   1. **The RPC endpoint never leaves this file.** A URL carries a key. So
//      every failure is swallowed into `null` — no message, no cause, no
//      rethrow. A token that could not be read is refused upstream, which is
//      the correct outcome anyway; a leaked endpoint would not be.
//   2. **Only addresses the USER typed are ever looked up.** A model asked
//      about "the MIO token" will produce an address that looks exactly like a
//      real one. `addressesInTextV1` reads the user's own words, and nothing
//      else reaches `readContract`.
// ---------------------------------------------------------------------------

const ERC20_METADATA_ABI_V1 = parseAbi([
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
]);

/** Some pre-standard tokens answer `symbol()` with a padded bytes32 rather
 * than a string. viem rejects that as a decode error, so the raw call is
 * retried and the padding trimmed. */
const ERC20_SYMBOL_BYTES32_ABI_V1 = parseAbi(['function symbol() view returns (bytes32)']);

export interface ChainTokenIdentityReaderOptionsV1 {
  /** Base mainnet JSON-RPC. Never stored, never logged, never returned. */
  rpcUrl: string;
  timeoutMs?: number;
  /** Injectable for tests; production builds its own from `rpcUrl`. */
  client?: PublicClient;
}

function bytes32ToSymbolV1(raw: unknown): string | null {
  if (typeof raw !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(raw)) return null;
  const bytes = raw.slice(2).match(/.{2}/g) ?? [];
  const chars: string[] = [];
  for (const pair of bytes) {
    const code = Number.parseInt(pair, 16);
    if (code === 0) break;
    chars.push(String.fromCharCode(code));
  }
  const symbol = chars.join('').trim();
  return symbol.length > 0 ? symbol : null;
}

export function createChainTokenIdentityReaderV1(
  options: ChainTokenIdentityReaderOptionsV1,
): TokenIdentityReaderV1 {
  const client =
    options.client ??
    (createPublicClient({
      chain: base,
      transport: http(options.rpcUrl, { timeout: options.timeoutMs ?? 8_000, retryCount: 1 }),
    }) as PublicClient);

  return {
    async readSymbol(address) {
      try {
        const symbol = await client.readContract({
          address,
          abi: ERC20_METADATA_ABI_V1,
          functionName: 'symbol',
        });
        return typeof symbol === 'string' ? symbol : null;
      } catch {
        // Not "the call failed" — it may simply be a bytes32 symbol, which is
        // a decode error rather than a network one. Both are retried the same
        // way because telling them apart would mean reading the error.
        try {
          const raw = await client.readContract({
            address,
            abi: ERC20_SYMBOL_BYTES32_ABI_V1,
            functionName: 'symbol',
          });
          return bytes32ToSymbolV1(raw);
        } catch {
          return null;
        }
      }
    },
    async readDecimals(address) {
      try {
        const decimals = await client.readContract({
          address,
          abi: ERC20_METADATA_ABI_V1,
          functionName: 'decimals',
        });
        return typeof decimals === 'number' ? decimals : Number(decimals);
      } catch {
        return null;
      }
    },
  };
}

/** At most this many contracts are read for one message. A sentence can hold
 * any number of addresses; a request must not turn into an unbounded fan-out
 * of chain calls, and no honest swap names more than two tokens. */
export const MAX_IDENTIFIED_TOKENS_PER_MESSAGE_V1 = 4;

export interface IdentifiedMessageTokensV1 {
  identities: TokenIdentityV1[];
  /** Addresses the user named that could NOT be identified. Kept so the caller
   * can say WHICH address it refused, rather than refusing the whole message
   * with no reason. */
  unreadable: `0x${string}`[];
}

/**
 * Every token the user named by address in this message, identified on chain.
 *
 * Addresses already in the trusted registry are skipped — they are known, and
 * asking the chain to confirm what is pinned would only add a way to fail.
 */
export async function identifyMessageTokensV1(
  message: string,
  reader: TokenIdentityReaderV1,
  trusted: readonly { address: string | null }[],
): Promise<IdentifiedMessageTokensV1> {
  const named = addressesInTextV1(message).filter((address) => !trustedByAddressV1(address, trusted));
  const identities: TokenIdentityV1[] = [];
  const unreadable: `0x${string}`[] = [];
  for (const address of named.slice(0, MAX_IDENTIFIED_TOKENS_PER_MESSAGE_V1)) {
    const result = await identifyTokenV1(address, reader);
    if (result.outcome === 'identified') identities.push(result.identity);
    else unreadable.push(address);
  }
  // Anything past the cap is reported as unreadable rather than ignored: a
  // silently dropped address is an address the user thinks was considered.
  for (const address of named.slice(MAX_IDENTIFIED_TOKENS_PER_MESSAGE_V1)) unreadable.push(address);
  return { identities, unreadable };
}
