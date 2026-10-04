import {
  callManyV1,
  decodeAddressWordV1,
  decodeUint8V1,
  decodeUintV1,
  encodeAddressArgV1,
  encodeNoArgsV1,
  selectorV1,
  type B20ReaderV1,
} from '@mioagent/b20-control';
import type { PoolYieldReadingV1 } from '@mioagent/route-storage';

// ---------------------------------------------------------------------------
// What an Aerodrome concentrated-liquidity pool pays, read from the pool.
//
// Two payments, and a position gets ONE of them. In Slipstream a position
// staked in the pool's gauge earns AERO and gives its share of the swap fees
// to voters; a position that is not staked earns the fees (less the pool's
// unstaked fee) and no AERO. So the card states two alternatives and never
// their sum.
//
// Both are said per dollar in the pool, on average: AERO over a year at this
// week's emission rate and today's AERO price, and fees over the week that
// was measured. Measured on the NVDAc/USDC pool on 2026-10-04, 97% of the
// in-range liquidity was staked and most of it in ranges far narrower than
// ±10%, so a dollar in a wide range earns much less than the average, and a
// dollar in a narrow one more, for as long as the price stays inside it.
// ---------------------------------------------------------------------------

/** `Swap(address,address,int256,int256,uint160,uint128,int24)`, the same
 * topic as Uniswap v3: amount0 and amount1 are the first two data words,
 * positive for what went into the pool. */
export const CL_SWAP_TOPIC_V1 = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67' as const;

/** Chainlink AERO / USD on Base (8 decimals, 0.5% deviation, 24 h
 * heartbeat), from Chainlink's own feed directory on 2026-10-04. */
export const AERO_USD_FEED_BASE_V1 = '0x4ec5970fc728c5f65ba413992cd5ff6fd70fcff0' as const;


const SELECTORS_V1 = {
  token0: selectorV1('token0()'),
  token1: selectorV1('token1()'),
  gauge: selectorV1('gauge()'),
  fee: selectorV1('fee()'),
  unstakedFee: selectorV1('unstakedFee()'),
  liquidity: selectorV1('liquidity()'),
  stakedLiquidity: selectorV1('stakedLiquidity()'),
  slot0: selectorV1('slot0()'),
  rewardRate: selectorV1('rewardRate()'),
  periodFinish: selectorV1('periodFinish()'),
  decimals: selectorV1('decimals()'),
  balanceOf: selectorV1('balanceOf(address)'),
  latestRoundData: selectorV1('latestRoundData()'),
} as const;

const firstWordV1 = (data: string): bigint | null => {
  const hex = data.replace(/^0x/, '');
  return /^[0-9a-fA-F]{64}/.test(hex) ? BigInt(`0x${hex.slice(0, 64)}`) : null;
};
const wordAtV1 = (data: string, index: number): bigint | null => {
  const hex = data.replace(/^0x/, '').slice(index * 64, (index + 1) * 64);
  return /^[0-9a-fA-F]{64}$/.test(hex) ? BigInt(`0x${hex}`) : null;
};

/** Everything a reading holds except its block, time and swaps. */
export type PoolYieldStateV1 = Omit<
  PoolYieldReadingV1,
  'chainId' | 'tokenAddress' | 'blockNumber' | 'blockAt' | 'readAt' | 'swaps'
>;

/**
 * The pool and its gauge at one block, or why it could not be read.
 *
 * All or nothing: a reading missing its liquidity or its rate cannot be
 * turned into a yield, and a half-read is not stored as a whole one. The AERO
 * price alone may be missing (then it is null), because the fee figure does
 * not need it.
 */
export async function readPoolYieldStateV1(input: {
  reader: B20ReaderV1;
  poolAddress: string;
  blockTag: string;
}): Promise<{ ok: true; state: PoolYieldStateV1 } | { ok: false; reason: string }> {
  const pool = input.poolAddress.toLowerCase();
  const at = (data: `0x${string}`, to = pool) => ({ to, data, blockTag: input.blockTag });
  const first = await callManyV1(input.reader, [
    at(encodeNoArgsV1(SELECTORS_V1.token0)),
    at(encodeNoArgsV1(SELECTORS_V1.token1)),
    at(encodeNoArgsV1(SELECTORS_V1.gauge)),
    at(encodeNoArgsV1(SELECTORS_V1.fee)),
    at(encodeNoArgsV1(SELECTORS_V1.unstakedFee)),
    at(encodeNoArgsV1(SELECTORS_V1.liquidity)),
    at(encodeNoArgsV1(SELECTORS_V1.stakedLiquidity)),
    at(encodeNoArgsV1(SELECTORS_V1.slot0)),
    at(encodeNoArgsV1(SELECTORS_V1.rewardRate)),
    at(encodeNoArgsV1(SELECTORS_V1.periodFinish)),
    at(encodeNoArgsV1(SELECTORS_V1.latestRoundData), AERO_USD_FEED_BASE_V1),
  ]);
  const value = (index: number): string | null => {
    const result = first[index];
    return result?.ok ? result.value : null;
  };
  const token0 = value(0) ? decodeAddressWordV1(value(0)!) : null;
  const token1 = value(1) ? decodeAddressWordV1(value(1)!) : null;
  const gaugeWord = value(2) ? decodeAddressWordV1(value(2)!) : null;
  const fee = value(3) ? decodeUintV1(value(3)!) : null;
  const unstakedFee = value(4) ? decodeUintV1(value(4)!) : null;
  const liquidity = value(5) ? decodeUintV1(value(5)!) : null;
  const stakedLiquidity = value(6) ? decodeUintV1(value(6)!) : null;
  const sqrtPrice = value(7) ? firstWordV1(value(7)!) : null;
  const rewardRate = value(8) ? decodeUintV1(value(8)!) : null;
  const periodFinish = value(9) ? decodeUintV1(value(9)!) : null;
  if (
    !token0 ||
    !token1 ||
    fee === null ||
    unstakedFee === null ||
    liquidity === null ||
    stakedLiquidity === null ||
    sqrtPrice === null ||
    rewardRate === null ||
    periodFinish === null
  ) {
    return { ok: false, reason: 'the pool did not answer every read this pass' };
  }
  if (fee > 1_000_000n || unstakedFee > 1_000_000n) return { ok: false, reason: 'the pool answered a fee out of range' };

  const second = await callManyV1(input.reader, [
    at(encodeNoArgsV1(SELECTORS_V1.decimals), token0),
    at(encodeNoArgsV1(SELECTORS_V1.decimals), token1),
    at(encodeAddressArgV1(SELECTORS_V1.balanceOf, pool), token0),
    at(encodeAddressArgV1(SELECTORS_V1.balanceOf, pool), token1),
  ]);
  const decimals0 = second[0]?.ok ? decodeUint8V1(second[0].value) : null;
  const decimals1 = second[1]?.ok ? decodeUint8V1(second[1].value) : null;
  const balance0 = second[2]?.ok ? decodeUintV1(second[2].value) : null;
  const balance1 = second[3]?.ok ? decodeUintV1(second[3].value) : null;
  if (decimals0 === null || decimals1 === null || balance0 === null || balance1 === null) {
    return { ok: false, reason: 'the pool’s tokens did not answer every read this pass' };
  }

  // AERO in dollars: Chainlink's answer and its own update time. A feed that
  // did not answer leaves the price null; the fees still stand.
  const round = value(10);
  const answer = round ? wordAtV1(round, 1) : null;
  const updatedAt = round ? wordAtV1(round, 3) : null;
  const aeroUsd = answer !== null && answer > 0n && answer < 2n ** 128n ? Number(answer) / 1e8 : null;
  const aeroAt = updatedAt !== null && updatedAt > 0n ? new Date(Number(updatedAt) * 1_000).toISOString() : null;
  const gauge = gaugeWord && !/^0x0{40}$/.test(gaugeWord) ? gaugeWord.toLowerCase() : null;

  return {
    ok: true,
    state: {
      poolAddress: pool,
      gaugeAddress: gauge,
      token0Address: token0.toLowerCase(),
      token1Address: token1.toLowerCase(),
      decimals0,
      decimals1,
      balance0Atomic: balance0.toString(),
      balance1Atomic: balance1.toString(),
      sqrtPriceX96: sqrtPrice.toString(),
      liquidity: liquidity.toString(),
      stakedLiquidity: stakedLiquidity.toString(),
      feePips: Number(fee),
      unstakedFeePips: Number(unstakedFee),
      rewardRate: gauge ? rewardRate.toString() : '0',
      periodFinish: Number(periodFinish),
      aeroUsd: aeroUsd !== null && aeroAt !== null ? aeroUsd : null,
      aeroUsdUpdatedAt: aeroUsd !== null && aeroAt !== null ? aeroAt : null,
    },
  };
}

/** What a list of `Swap` logs paid into the pool, side by side. A log that
 * is not this pool's swap, or is malformed, makes the whole read null: a
 * total with a hole in it is not a total. */
export function sumPoolSwapsV1(
  poolAddress: string,
  logs: readonly { address?: unknown; topics?: unknown; data?: unknown }[],
): { count: number; amount0In: bigint; amount1In: bigint } | null {
  const pool = poolAddress.toLowerCase();
  let amount0In = 0n;
  let amount1In = 0n;
  for (const log of logs) {
    const topics = Array.isArray(log.topics) ? log.topics : [];
    if (String(log.address ?? '').toLowerCase() !== pool || String(topics[0] ?? '').toLowerCase() !== CL_SWAP_TOPIC_V1) {
      return null;
    }
    const data = typeof log.data === 'string' ? log.data : '';
    const amount0 = wordAtV1(data, 0);
    const amount1 = wordAtV1(data, 1);
    if (amount0 === null || amount1 === null) return null;
    const signed0 = BigInt.asIntN(256, amount0);
    const signed1 = BigInt.asIntN(256, amount1);
    if (signed0 > 0n) amount0In += signed0;
    if (signed1 > 0n) amount1In += signed1;
  }
  return { count: logs.length, amount0In, amount1In };
}
