import {
  aboutDollarsV1,
  aerodromeRewardsRuntimeV1,
  byValueV1,
  unitsV1,
  valueRewardAmountV1,
  type AerodromeRewardAmountV1,
  type AerodromeRewardValueDepsV1,
} from './aerodromeRewards.js';
import type { BaseMcpConsoleNextV1 } from './baseMcpConsole.js';
import {
  UNISWAP_COLLECT_LIMIT_V1,
  UNISWAP_POSITIONS_LIMIT_V1,
  createUniswapFeesReadV1,
  readUniswapFeesPlanV1,
  type UniswapFeePositionV1,
  type UniswapFeesPlanV1,
} from './uniswapFeesReader.js';

// ---------------------------------------------------------------------------
// Found, for Uniswap: the fees this wallet's v3 positions can collect now,
// valued the way Aerodrome's rewards are, by what a sell would fetch in USDC.
// An amount no router prices is named and left out of the dollar figure.
// ---------------------------------------------------------------------------

export interface UniswapFeePositionValuedV1 extends UniswapFeePositionV1 {
  /** The priced part of this position's fees; null when neither side priced. */
  usdcAtomic: string | null;
}

export interface UniswapFeesV1 {
  blockNumber: string;
  positionsHeld: number;
  positionsOpen: number;
  v4PositionsHeld: number;
  unreadable: number;
  /** Positions with fees, the largest dollar value first. */
  positions: UniswapFeePositionValuedV1[];
  /** Fees per token across positions, the largest dollar value first. */
  fees: AerodromeRewardAmountV1[];
  totalUsdcAtomic: string;
  unpriced: number;
}

export type UniswapFeesReadV1 =
  | { ok: true; fees: UniswapFeesV1 }
  | { ok: false; errorCode: string; positionsHeld: number };

export async function valueUniswapFeesV1(plan: UniswapFeesPlanV1, deps: AerodromeRewardValueDepsV1): Promise<UniswapFeesV1> {
  const totals = new Map<string, bigint>();
  for (const position of plan.positions) {
    for (const [token, amount] of [[position.token0, position.amount0], [position.token1, position.amount1]] as const) {
      if (BigInt(amount) > 0n) totals.set(token, (totals.get(token) ?? 0n) + BigInt(amount));
    }
  }
  const fees = await Promise.all([...totals].map(([token, amount]) => valueRewardAmountV1(token, amount, deps)));
  fees.sort(byValueV1);
  const byToken = new Map(fees.map((fee) => [fee.token, fee]));
  // A position's share of a token's value is its share of the token's amount.
  const share = (token: string, amount: string): bigint | null => {
    const fee = byToken.get(token);
    if (!fee || fee.usdcAtomic === null || BigInt(amount) === 0n) return null;
    return BigInt(fee.usdcAtomic) * BigInt(amount) / BigInt(fee.amountAtomic);
  };
  const positions = plan.positions.map((position) => {
    const parts = [share(position.token0, position.amount0), share(position.token1, position.amount1)].filter((part): part is bigint => part !== null);
    return { ...position, usdcAtomic: parts.length ? parts.reduce((sum, part) => sum + part, 0n).toString() : null };
  });
  positions.sort((a, b) => Number(BigInt(b.usdcAtomic ?? '-1') - BigInt(a.usdcAtomic ?? '-1')) || a.tokenId.localeCompare(b.tokenId));
  return {
    blockNumber: plan.blockNumber, positionsHeld: plan.positionsHeld, positionsOpen: plan.positionsOpen,
    v4PositionsHeld: plan.v4PositionsHeld, unreadable: plan.unreadable, positions, fees,
    totalUsdcAtomic: fees.reduce((sum, fee) => sum + BigInt(fee.usdcAtomic ?? '0'), 0n).toString(),
    unpriced: fees.filter((fee) => fee.usdcAtomic === null).length,
  };
}

export const uniswapFeesRuntimeV1 = {
  createReader: createUniswapFeesReadV1,
  readPlan: readUniswapFeesPlanV1,
};

/** One reading: every v3 position of this wallet, valued. */
export async function readUniswapFeesV1(walletAddress: string): Promise<UniswapFeesReadV1> {
  const wallet = walletAddress.toLowerCase();
  let plan: UniswapFeesPlanV1;
  try {
    plan = await uniswapFeesRuntimeV1.readPlan(await uniswapFeesRuntimeV1.createReader(), wallet);
  } catch {
    return { ok: false, errorCode: 'uniswap_read_unavailable', positionsHeld: 0 };
  }
  if (plan.errorCode) return { ok: false, errorCode: plan.errorCode, positionsHeld: plan.positionsHeld };
  const fees = await valueUniswapFeesV1(plan, {
    tokenMeta: aerodromeRewardsRuntimeV1.tokenMeta,
    value: (asset, amountAtomic) => aerodromeRewardsRuntimeV1.value(asset, amountAtomic, wallet),
  });
  return { ok: true, fees };
}

/** The phrases a reader presses next, exactly as the router reads them. */
export const UNISWAP_COLLECT_PROMPT_V1 = { en: 'Collect my Uniswap fees', ru: 'Забери мои комиссии Uniswap' } as const;
export const FOUND_ALERT_PROMPT_V1 = {
  en: 'Notify me when my rewards reach $5',
  ru: 'Сообщи, когда мои награды дойдут до $5',
} as const;

export function uniswapFeesNextV1(read: UniswapFeesReadV1, input: { russian: boolean; collectReleased: boolean }): BaseMcpConsoleNextV1[] {
  if (!read.ok) return [];
  const lang = input.russian ? 'ru' : 'en';
  const alert: BaseMcpConsoleNextV1 = { prompt: FOUND_ALERT_PROMPT_V1[lang], kind: 'alert' };
  return read.fees.positions.length > 0 && input.collectReleased
    ? [{ prompt: UNISWAP_COLLECT_PROMPT_V1[lang], kind: 'claim' }, alert]
    : [alert];
}

/** The console's answer to a reading, in the language it was asked in. */
export function uniswapFeesReplyV1(
  read: UniswapFeesReadV1,
  russian: boolean,
  options: { say?: boolean } = {},
): { reply: string; errorCode: string | null } {
  const say = options.say ?? true;
  if (!read.ok) {
    const reply = read.errorCode === 'uniswap_positions_limit'
      ? russian
        ? `У этого кошелька ${read.positionsHeld.toLocaleString('en-US')} позиций Uniswap v3 — больше, чем Miorail читает за раз (${UNISWAP_POSITIONS_LIMIT_V1}). Ничего не отброшено молча: посмотрите их на app.uniswap.org.`
        : `This wallet holds ${read.positionsHeld.toLocaleString('en-US')} Uniswap v3 positions, more than Miorail reads at once (${UNISWAP_POSITIONS_LIMIT_V1}). None were dropped quietly: see them on app.uniswap.org.`
      : russian
        ? 'Uniswap не удалось прочитать сейчас, поэтому это не «собирать нечего». Попробуйте через минуту.'
        : 'Could not read Uniswap just now, so this is not “nothing to collect”. Try again in a minute.';
    return { reply, errorCode: read.errorCode };
  }
  const fees = read.fees;
  const block = Number(fees.blockNumber).toLocaleString('en-US');
  const scope = [russian
    ? `Прочитаны все позиции Uniswap v3 этого кошелька (${fees.positionsHeld}), блок ${block}.${fees.positionsHeld > fees.positionsOpen ? ` Закрытых, без комиссий: ${fees.positionsHeld - fees.positionsOpen}.` : ''}`
    : `Read every Uniswap v3 position this wallet holds (${fees.positionsHeld}), at block ${block}.${fees.positionsHeld > fees.positionsOpen ? ` ${fees.positionsHeld - fees.positionsOpen} closed ${fees.positionsHeld - fees.positionsOpen === 1 ? 'one pays' : 'ones pay'} nothing.` : ''}`];
  if (fees.unreadable > 0) scope.push(russian
    ? `Позиций, которые не удалось прочитать: ${fees.unreadable}. Они не посчитаны.`
    : `${fees.unreadable} position${fees.unreadable === 1 ? '' : 's'} could not be read and ${fees.unreadable === 1 ? 'is' : 'are'} not counted.`);
  if (fees.v4PositionsHeld > 0) scope.push(russian
    ? `Ещё у кошелька позиций Uniswap v4: ${fees.v4PositionsHeld}. Их комиссии Miorail пока не читает: смотрите app.uniswap.org.`
    : `This wallet also holds ${fees.v4PositionsHeld} Uniswap v4 position${fees.v4PositionsHeld === 1 ? '' : 's'}; Miorail does not read v4 fees yet: see app.uniswap.org.`);
  if (fees.positions.length === 0) {
    return {
      reply: [
        russian ? 'Сейчас этому кошельку на Uniswap собирать нечего.' : 'Nothing to collect on Uniswap for this wallet right now.',
        ...scope,
      ].join('\n'),
      errorCode: null,
    };
  }
  const total = aboutDollarsV1(fees.totalUsdcAtomic, russian);
  const count = fees.positions.length;
  const pricedNothing = fees.totalUsdcAtomic === '0' && fees.unpriced > 0;
  const lines = [pricedNothing
    ? russian
      ? `Найдено на Uniswap: комиссии в позициях (${count}), которые сейчас не оценил ни один роутер.`
      : `Found on Uniswap: fees in ${count} position${count === 1 ? '' : 's'} no router could price right now.`
    : russian
      ? `Найдено на Uniswap: можно собрать ${total} из позиций (${count})${fees.unpriced ? ' — без того, что не удалось оценить' : ''}.`
      : `Found on Uniswap: ${total} you can collect now from ${count} position${count === 1 ? '' : 's'}${fees.unpriced ? ', not counting what could not be priced' : ''}.`];
  const valued = (amount: AerodromeRewardAmountV1) => amount.usdcAtomic === null
    ? `${unitsV1(amount)} (${russian ? 'ни один роутер не оценил' : 'no router priced it'})`
    : `${unitsV1(amount)} (${aboutDollarsV1(amount.usdcAtomic, russian)})`;
  lines.push(`• ${russian ? 'Комиссии' : 'Fees'}: ${fees.fees.map(valued).join(', ')}`);
  lines.push(...scope);
  lines.push(russian ? 'Оценка — сколько дала бы продажа в USDC сейчас. WETH приходит как WETH.' : 'Values are what a sell would fetch in USDC now. WETH arrives as WETH.');
  if (count > UNISWAP_COLLECT_LIMIT_V1) lines.push(russian
    ? `Одно подтверждение собирает ${UNISWAP_COLLECT_LIMIT_V1} самых крупных позиций; остальные — следующим.`
    : `One approval collects the ${UNISWAP_COLLECT_LIMIT_V1} largest positions; the rest take another.`);
  if (say) lines.push(russian
    ? `Скажите «${UNISWAP_COLLECT_PROMPT_V1.ru}», чтобы собрать.`
    : `Say “${UNISWAP_COLLECT_PROMPT_V1.en}” to collect it.`);
  return { reply: lines.join('\n'), errorCode: null };
}
