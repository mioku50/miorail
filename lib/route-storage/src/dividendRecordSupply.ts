// ---------------------------------------------------------------------------
// How many tokens existed when a dividend's record date closed (migration
// 0075). A token is owed a dividend only if it existed then, and the calendar
// needs that fact to tell "not owed" from "owed and not converted".
//
// One immutable row per token and record date. A second write of the same pair
// is refused silently rather than updated: the past does not change, and a
// later read of an old block can only agree or come from a worse endpoint.
// ---------------------------------------------------------------------------

export interface DividendRecordSupplyV1 {
  chainId: 8453;
  tokenAddress: string;
  /** New York date, YYYY-MM-DD. */
  recordDate: string;
  /** 16:00 New York on the record date, ISO. */
  recordCloseAt: string;
  blockNumber: number;
  /** The block's own timestamp, ISO. At or before `recordCloseAt`. */
  blockTime: string;
  totalSupplyAtomic: string;
  decimals: number;
  readAt: string;
}

export interface DividendRecordSupplyRepositoryV1 {
  /** `recorded` the first time, `already_recorded` after. */
  record(input: DividendRecordSupplyV1): Promise<'recorded' | 'already_recorded'>;
  supplies(input: { chainId: 8453; tokenAddresses: readonly string[] }): Promise<DividendRecordSupplyV1[]>;
}

const TOKEN_V1 = /^0x[0-9a-f]{40}$/;
const DATE_V1 = /^\d{4}-\d{2}-\d{2}$/;

export function assertDividendRecordSupplyV1(input: DividendRecordSupplyV1): void {
  if (input.chainId !== 8453) throw new Error('dividend_record_supply_chain');
  if (!TOKEN_V1.test(input.tokenAddress)) throw new Error('dividend_record_supply_token');
  if (!DATE_V1.test(input.recordDate)) throw new Error('dividend_record_supply_date');
  if (!/^[0-9]+$/.test(input.totalSupplyAtomic)) throw new Error('dividend_record_supply_amount');
  if (!Number.isInteger(input.decimals) || input.decimals < 0 || input.decimals > 36) {
    throw new Error('dividend_record_supply_decimals');
  }
  if (!Number.isSafeInteger(input.blockNumber) || input.blockNumber <= 0) throw new Error('dividend_record_supply_block');
  const close = Date.parse(input.recordCloseAt);
  const block = Date.parse(input.blockTime);
  if (!Number.isFinite(close) || !Number.isFinite(block) || !Number.isFinite(Date.parse(input.readAt))) {
    throw new Error('dividend_record_supply_time');
  }
  if (block > close) throw new Error('dividend_record_supply_after_close');
}

/** Tokens, as a decimal string: "6113.6938" from 611369380000 and 8 decimals. */
export function dividendSupplyDecimalV1(row: Pick<DividendRecordSupplyV1, 'totalSupplyAtomic' | 'decimals'>): string {
  const digits = row.totalSupplyAtomic.replace(/^0+(?=\d)/, '');
  if (row.decimals === 0) return digits;
  const padded = digits.padStart(row.decimals + 1, '0');
  const whole = padded.slice(0, padded.length - row.decimals);
  const fraction = padded.slice(padded.length - row.decimals).replace(/0+$/, '');
  return fraction.length > 0 ? `${whole}.${fraction}` : whole;
}
