// What Still's limit is worth, in numbers: the protocol's own limit beside
// Still's, the share between them, and how far the collateral could fall
// before liquidation with the debt at Still's full limit.
//
// Aave V4 and Morpho both liquidate at the factor they lend at, so borrowing a
// protocol's full limit leaves no margin at all; Still's share of it is the
// margin. The two limits are the server's own figures, at one block; the page
// only prints them.

const BPS = 10_000n;

/** Why a stock counts at a lower share now. */
export type StillShareLoweredV1 =
  /** Wall Street is closed: weekends and market holidays, until 20:00 New York time before the next session. */
  | { reason: 'market_closed'; until: string }
  /** Around the company's earnings report. */
  | { reason: 'earnings'; reportDate: string; until: string }
  /** The earnings calendar could not be read, so the stock counts at the earnings share. */
  | { reason: 'earnings_unread' }
  /** The calendar answered with no date for this stock (SPCXc, listed 2026-11-04): it counts at the earnings share too. */
  | { reason: 'earnings_unlisted' };

export interface StillLimitComparisonWireV1 {
  protocol: 'Aave V4' | 'Morpho';
  /** The protocol's own ceiling for total debt against this collateral. */
  protocolLimitAtomic: string;
  /** Still's ceiling for the same debt. */
  stillLimitAtomic: string;
  /** Still's share of the protocol's factor for the selected collateral. */
  shareBps: number;
  /** The share by which all the collateral may fall before liquidation, with the debt at Still's full limit; rounded down. */
  marginAtStillLimitBps: number;
  lowered: StillShareLoweredV1 | null;
}

/** Null when there is nothing to compare: no protocol limit, or figures that do not describe one account. */
export function stillLimitComparisonV1(input: {
  protocol: StillLimitComparisonWireV1['protocol'];
  protocolLimitAssets: bigint;
  stillLimitAssets: bigint;
  shareBps: number | bigint | undefined;
  lowered: StillShareLoweredV1 | null;
}): StillLimitComparisonWireV1 | null {
  const share = input.shareBps === undefined ? null : Number(input.shareBps);
  if (share === null || !Number.isInteger(share) || share <= 0 || share > 10_000) return null;
  if (input.protocolLimitAssets <= 0n || input.stillLimitAssets < 0n || input.stillLimitAssets > input.protocolLimitAssets) return null;
  // 1 − still / protocol, rounded down: ceil(still × BPS / protocol) is subtracted.
  const used = (input.stillLimitAssets * BPS + input.protocolLimitAssets - 1n) / input.protocolLimitAssets;
  return {
    protocol: input.protocol,
    protocolLimitAtomic: input.protocolLimitAssets.toString(),
    stillLimitAtomic: input.stillLimitAssets.toString(),
    shareBps: share,
    marginAtStillLimitBps: Number(BPS - used),
    lowered: input.lowered,
  };
}
