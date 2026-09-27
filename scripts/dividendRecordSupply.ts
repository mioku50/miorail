import { b20BlockAtOrBeforeV1, type B20BlockHeaderV1, type B20ReaderV1 } from '@mioagent/b20-control';
import { DIVIDEND_DECLARATIONS_V1, recordCloseV1, type DividendDeclarationV1 } from '@mioagent/rwa-market-reality/dividends';
import type { DividendRecordSupplyRepositoryV1 } from '@mioagent/route-storage';

// ---------------------------------------------------------------------------
// How many tokens existed when each dividend's record date closed.
//
// A token is owed a dividend only if it existed at the close of business on
// the record date: AAPLc had no supply at Apple's 2026-08-10 record date, and
// MSFTc none at Microsoft's 2026-08-20. This reads each token's totalSupply()
// once, at the last block at or before 16:00 New York on that date, and keeps
// it (migration 0075). A date still ahead is left for a later pass.
//
// A token with no code at that block did not exist yet: its supply then was
// zero, and that is recorded as zero. Decimals never change, so they are read
// at the latest block.
// ---------------------------------------------------------------------------

const TOTAL_SUPPLY_V1 = '0x18160ddd';
const DECIMALS_V1 = '0x313ce567';

export interface DividendSupplyPassV1 {
  recorded: number;
  known: number;
  /** Record dates still ahead. */
  pending: number;
  failed: string[];
}

export async function recordDividendSuppliesV1(input: {
  reader: B20ReaderV1;
  repository: DividendRecordSupplyRepositoryV1;
  /** Coinbase's representations, each with the underlying it stands for. */
  tokens: readonly { tokenAddress: string; underlyingKey: string }[];
  declarations?: readonly DividendDeclarationV1[];
  now: Date;
}): Promise<DividendSupplyPassV1> {
  const declarations = input.declarations ?? DIVIDEND_DECLARATIONS_V1;
  const pass: DividendSupplyPassV1 = { recorded: 0, known: 0, pending: 0, failed: [] };
  const tokens = input.tokens.filter((token) => declarations.some((d) => d.underlyingKey === token.underlyingKey));
  if (tokens.length === 0) return pass;
  const stored = await input.repository.supplies({ chainId: 8453, tokenAddresses: tokens.map((token) => token.tokenAddress) });
  const known = new Set(stored.map((row) => `${row.tokenAddress}|${row.recordDate}`));
  // One search per record date, shared by every token that needs that date.
  const blocks = new Map<string, B20BlockHeaderV1 | null>();
  const decimalsOf = new Map<string, number | null>();

  for (const declaration of declarations) {
    const close = recordCloseV1(declaration.recordDate);
    for (const token of tokens.filter((row) => row.underlyingKey === declaration.underlyingKey)) {
      if (close.getTime() > input.now.getTime()) {
        pass.pending += 1;
        continue;
      }
      if (known.has(`${token.tokenAddress}|${declaration.recordDate}`)) {
        pass.known += 1;
        continue;
      }
      let block = blocks.get(declaration.recordDate);
      if (block === undefined) {
        const found = await b20BlockAtOrBeforeV1(input.reader, close.getTime());
        block = found.ok ? found.value : null;
        blocks.set(declaration.recordDate, block);
        if (!found.ok) pass.failed.push(`${declaration.recordDate}:block_${found.reason}`);
      }
      if (!block) continue;

      let decimals = decimalsOf.get(token.tokenAddress);
      if (decimals === undefined) {
        const read = await input.reader.call({ to: token.tokenAddress, data: DECIMALS_V1, blockTag: 'latest' });
        decimals = read.ok ? Number(BigInt(read.value)) : null;
        decimalsOf.set(token.tokenAddress, decimals);
      }
      const supply = await input.reader.call({
        to: token.tokenAddress,
        data: TOTAL_SUPPLY_V1,
        blockTag: `0x${block.blockNumber.toString(16)}`,
      });
      const atomic = supply.ok ? BigInt(supply.value).toString() : supply.reason === 'empty_result' ? '0' : null;
      if (atomic === null || decimals === null) {
        pass.failed.push(`${token.tokenAddress}:${declaration.recordDate}:${supply.ok ? 'decimals' : supply.reason}`);
        continue;
      }
      const outcome = await input.repository.record({
        chainId: 8453,
        tokenAddress: token.tokenAddress,
        recordDate: declaration.recordDate,
        recordCloseAt: close.toISOString(),
        blockNumber: block.blockNumber,
        blockTime: new Date(block.timestamp * 1000).toISOString(),
        totalSupplyAtomic: atomic,
        decimals,
        readAt: input.now.toISOString(),
      });
      if (outcome === 'recorded') pass.recorded += 1;
      else pass.known += 1;
      known.add(`${token.tokenAddress}|${declaration.recordDate}`);
    }
  }
  return pass;
}
