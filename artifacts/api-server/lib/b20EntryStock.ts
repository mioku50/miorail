import { client } from '@mioagent/db';
import { createDatabaseUnderlyingAssetRepository } from '@mioagent/route-storage';
import { createCoinbaseStockMetaCacheV1 } from './coinbaseStockMeta.js';

// ---------------------------------------------------------------------------
// Whether a token is a tokenized stock, for the B20 entry (audits AUTH-4 and
// SS-5, 2026-11-14).
//
// The entry buys a B20 token through Aerodrome, and Coinbase's stocks are B20
// tokens. Swap AI and the stock review buy a stock only after asking where the
// person is and that they are not a U.S. person; the entry asks neither, so it
// does not buy a stock at all (lib/b20EntryRunner.ts). A stock is one in
// Still's reviewed corpus, whoever issued it, as Swap AI recognises it, or one
// in Coinbase's own live list: a stock Coinbase listed since the corpus was
// last read is there first. A corpus that cannot be read throws, and the
// entry is refused rather than guessed.
// ---------------------------------------------------------------------------

export interface TokenizedStockDepsV1 {
  /** Whether the token represents anything in the reviewed corpus; throws when the corpus cannot be read. */
  inCorpus: (tokenAddress: string) => Promise<boolean>;
  /** Coinbase's live list; false when it was never read (the corpus still decides). */
  coinbaseListed: (tokenAddress: string) => Promise<boolean>;
}

export async function isTokenizedStockV1(tokenAddress: string, deps: TokenizedStockDepsV1): Promise<boolean> {
  const address = tokenAddress.toLowerCase();
  if (await deps.inCorpus(address)) return true;
  try {
    return await deps.coinbaseListed(address);
  } catch {
    // The live list only adds to the corpus: one that could not be read is no answer either way.
    return false;
  }
}

// Coinbase's names and icons for its tokens, read here only for which addresses it lists; one per process.
const coinbaseListV1 = createCoinbaseStockMetaCacheV1();

export const b20EntryStockRuntimeV1 = {
  deps: (): TokenizedStockDepsV1 => ({
    inCorpus: async (tokenAddress) =>
      (await createDatabaseUnderlyingAssetRepository(client).underlyingOf({ chainId: 8453, tokenAddress })) !== null,
    coinbaseListed: async (tokenAddress) => (await coinbaseListV1.read()).has(tokenAddress),
  }),
};

export const isB20EntryTokenizedStockV1 = (tokenAddress: string): Promise<boolean> =>
  isTokenizedStockV1(tokenAddress, b20EntryStockRuntimeV1.deps());
