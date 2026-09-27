import {
  assertDividendRecordSupplyV1,
  type DividendRecordSupplyRepositoryV1,
  type DividendRecordSupplyV1,
} from './dividendRecordSupply.js';

/** The same refusals and the same first-write-wins as Postgres. */
export class InMemoryDividendRecordSupplyRepositoryV1 implements DividendRecordSupplyRepositoryV1 {
  private readonly rows = new Map<string, DividendRecordSupplyV1>();

  async record(input: DividendRecordSupplyV1): Promise<'recorded' | 'already_recorded'> {
    assertDividendRecordSupplyV1(input);
    const key = `${input.chainId}:${input.tokenAddress}:${input.recordDate}`;
    if (this.rows.has(key)) return 'already_recorded';
    this.rows.set(key, { ...input });
    return 'recorded';
  }

  async supplies(input: { chainId: 8453; tokenAddresses: readonly string[] }): Promise<DividendRecordSupplyV1[]> {
    const wanted = new Set(input.tokenAddresses);
    return [...this.rows.values()]
      .filter((row) => row.chainId === input.chainId && wanted.has(row.tokenAddress))
      .sort((a, b) => a.tokenAddress.localeCompare(b.tokenAddress) || a.recordDate.localeCompare(b.recordDate))
      .map((row) => ({ ...row }));
  }
}
