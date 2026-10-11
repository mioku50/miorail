import { createPublicClient, formatUnits, http, parseAbi, type Address } from 'viem';
import { base } from 'viem/chains';
import { assetIdV1, type AssetRefV1 } from '@mioagent/route-domain';

import {
  AERODROME_AERO_V1,
  createAerodromeClaimReadV1,
  readAerodromeClaimPlanV1,
  type AerodromeClaimPlanV1,
} from './aerodromeClaimReader.js';
import type { BaseMcpConsoleNextV1 } from './baseMcpConsole.js';
import { valueStockInUsdcV1 } from './giftSendValuation.js';
import { CANONICAL_BASE_USDC_V1 } from './stockGift.js';

// ---------------------------------------------------------------------------
// Found, inside Wallet MCP: what a wallet can claim on Aerodrome now, and an
// alert when it builds up.
//
// Measured before it was built (2026-10-11): of 800 Farcaster accounts, under
// 1% had $1 to claim in their main wallet and 3-5% across all their wallets.
// So it is a tool for people who provide liquidity, kept beside the claim,
// not a door for everyone.
//
// It reads with the claim's own reader: "nothing to claim" means every pool
// was read, and a reading with a pool unread is never reported as nothing.
// Each amount is valued the way the gift is, by what a sell would fetch in
// USDC from the routers trades already ask; an amount no router prices is
// named and left out of the dollar figure, never counted as zero.
// ---------------------------------------------------------------------------

export interface AerodromeRewardAmountV1 {
  token: string;
  symbol: string;
  decimals: number;
  amountAtomic: string;
  /** What a sell would fetch, in USDC atoms; null when no router priced it. */
  usdcAtomic: string | null;
}

export interface AerodromeRewardsV1 {
  blockNumber: string;
  poolsRead: number;
  /** NFTs the wallet holds in a reviewed position manager. */
  clPositionsHeld: number;
  positionsFound: number;
  /** Positions a vault or a locker manages: claimed there, not here. */
  managedSkipped: number;
  claims: number;
  aero: AerodromeRewardAmountV1 | null;
  /** Pool fees per token, the largest dollar value first. */
  fees: AerodromeRewardAmountV1[];
  /** The priced part, in USDC atoms. */
  totalUsdcAtomic: string;
  unpriced: number;
}

export type AerodromeRewardsReadV1 =
  | { ok: true; rewards: AerodromeRewardsV1 }
  | { ok: false; errorCode: string; poolsRead: number; poolsTotal: number };

/** What the plan collects: AERO once, fees per token. A position with fees
 * AND a stake gives two items carrying the same amounts, and each item
 * claims only its own part. */
export function aerodromeRewardTotalsV1(plan: Pick<AerodromeClaimPlanV1, 'calls'>): { aeroAtomic: bigint; fees: Map<string, bigint> } {
  let aeroAtomic = 0n;
  const fees = new Map<string, bigint>();
  for (const item of plan.calls) {
    if (item.kind.endsWith('_aero')) aeroAtomic += BigInt(item.aero);
    if (!item.kind.endsWith('_fees')) continue;
    for (const [token, amount] of [[item.token0, item.amount0], [item.token1, item.amount1]] as const) {
      if (BigInt(amount) > 0n) fees.set(token, (fees.get(token) ?? 0n) + BigInt(amount));
    }
  }
  return { aeroAtomic, fees };
}

export interface AerodromeRewardValueDepsV1 {
  tokenMeta(token: string): Promise<{ symbol: string; decimals: number }>;
  /** USDC atoms a sell of this amount would fetch now, or null. */
  value(asset: AssetRefV1, amountAtomic: string): Promise<string | null>;
}

/** One amount of one token, valued by what a sell would fetch in USDC. USDC
 * is itself; AERO's metadata is known; anything else is read from Base. Used
 * by every reading Found makes, Aerodrome's and Uniswap's alike. */
export async function valueRewardAmountV1(token: string, amount: bigint, deps: AerodromeRewardValueDepsV1): Promise<AerodromeRewardAmountV1> {
  const meta = token === AERODROME_AERO_V1 ? { symbol: 'AERO', decimals: 18 }
    : token === CANONICAL_BASE_USDC_V1 ? { symbol: 'USDC', decimals: 6 } : await deps.tokenMeta(token);
  let usdcAtomic: string | null;
  if (token === CANONICAL_BASE_USDC_V1) usdcAtomic = amount.toString();
  else {
    const asset: AssetRefV1 = {
      assetId: assetIdV1({ chainId: 8453, kind: 'erc20', address: token as `0x${string}` }),
      chainId: 8453, kind: 'erc20', address: token as `0x${string}`,
      symbol: meta.symbol.slice(0, 32) || 'TOKEN', decimals: meta.decimals,
    };
    usdcAtomic = await deps.value(asset, amount.toString()).catch(() => null);
  }
  return { token, ...meta, amountAtomic: amount.toString(), usdcAtomic };
}

/** The largest dollar value first; unpriced last, by address. */
export function byValueV1(a: AerodromeRewardAmountV1, b: AerodromeRewardAmountV1): number {
  return Number(BigInt(b.usdcAtomic ?? '0') - BigInt(a.usdcAtomic ?? '0')) || a.token.localeCompare(b.token);
}

export async function valueAerodromeRewardsV1(plan: AerodromeClaimPlanV1, deps: AerodromeRewardValueDepsV1): Promise<AerodromeRewardsV1> {
  const totals = aerodromeRewardTotalsV1(plan);
  const priced = (token: string, amount: bigint) => valueRewardAmountV1(token, amount, deps);
  // Every amount is priced at once: a router is waited for up to 8 s.
  const [aero, fees] = await Promise.all([
    totals.aeroAtomic > 0n ? priced(AERODROME_AERO_V1, totals.aeroAtomic) : Promise.resolve(null),
    Promise.all([...totals.fees].map(([token, amount]) => priced(token, amount))),
  ]);
  fees.sort(byValueV1);
  const all = [...(aero ? [aero] : []), ...fees];
  return {
    blockNumber: plan.blockNumber, poolsRead: plan.poolsRead, clPositionsHeld: plan.clPositionsTotal,
    positionsFound: plan.positionsFound, managedSkipped: plan.managedSkipped, claims: plan.calls.length,
    aero, fees,
    totalUsdcAtomic: all.reduce((sum, amount) => sum + BigInt(amount.usdcAtomic ?? '0'), 0n).toString(),
    unpriced: all.filter((amount) => amount.usdcAtomic === null).length,
  };
}

function readRpcUrlV1(): string {
  return process.env.BASE_MAINNET_RPC_URL || process.env.BASE_RPC_URL || 'https://mainnet.base.org';
}

const TOKEN_META_ABI_V1 = parseAbi(['function symbol() view returns (string)', 'function decimals() view returns (uint8)']);

/** A token's symbol and decimals, read from Base. A symbol that is not a
 * string (a few old tokens) is shown as the address, shortened. */
async function readTokenMetaV1(token: string): Promise<{ symbol: string; decimals: number }> {
  const client = createPublicClient({ chain: base, transport: http(readRpcUrlV1(), { timeout: 6_000, retryCount: 1 }) });
  const decimals = Number(await client.readContract({ address: token as Address, abi: TOKEN_META_ABI_V1, functionName: 'decimals' }));
  let symbol: string;
  try {
    symbol = String(await client.readContract({ address: token as Address, abi: TOKEN_META_ABI_V1, functionName: 'symbol' }));
  } catch {
    symbol = '';
  }
  symbol = symbol.replace(/[^\p{L}\p{N}._-]/gu, '').slice(0, 16);
  return { symbol: symbol || `${token.slice(0, 6)}…${token.slice(-4)}`, decimals };
}

export const aerodromeRewardsRuntimeV1 = {
  createReader: createAerodromeClaimReadV1,
  readPlan: readAerodromeClaimPlanV1,
  tokenMeta: readTokenMetaV1,
  value: async (asset: AssetRefV1, amountAtomic: string, walletAddress: string): Promise<string | null> =>
    (await valueStockInUsdcV1({ token: asset, amountAtomic, walletAddress: walletAddress as `0x${string}`, now: new Date() }))
      ?.usdcAtomic ?? null,
};

/** One reading: the claim's plan for this wallet, valued. */
export async function readAerodromeRewardsV1(walletAddress: string): Promise<AerodromeRewardsReadV1> {
  const wallet = walletAddress.toLowerCase();
  let plan: AerodromeClaimPlanV1;
  try {
    plan = await aerodromeRewardsRuntimeV1.readPlan(await aerodromeRewardsRuntimeV1.createReader(), wallet);
  } catch {
    return { ok: false, errorCode: 'aerodrome_read_unavailable', poolsRead: 0, poolsTotal: 0 };
  }
  if (plan.errorCode) return { ok: false, errorCode: plan.errorCode, poolsRead: plan.poolsRead, poolsTotal: plan.poolsTotal };
  const rewards = await valueAerodromeRewardsV1(plan, {
    tokenMeta: aerodromeRewardsRuntimeV1.tokenMeta,
    value: (asset, amountAtomic) => aerodromeRewardsRuntimeV1.value(asset, amountAtomic, wallet),
  });
  return { ok: true, rewards };
}

/** Whole cents of a USDC amount, rounded down. */
export function usdcAtomicToCentsV1(usdcAtomic: string): number {
  return Number(BigInt(usdcAtomic) / 10_000n);
}

/** "about $12.38", or "under $0.01" for less than a cent: an estimate
 * that small is not "about" anything. */
export function aboutDollarsV1(usdcAtomic: string, russian: boolean): string {
  const cents = usdcAtomicToCentsV1(usdcAtomic);
  if (cents < 1) return russian ? 'меньше $0.01' : 'under $0.01';
  const dollars = `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return russian ? `около ${dollars}` : `about ${dollars}`;
}

export function unitsV1(amount: AerodromeRewardAmountV1): string {
  const exact = formatUnits(BigInt(amount.amountAtomic), amount.decimals);
  const [whole, fraction = ''] = exact.split('.');
  // Four significant digits after the point are enough to recognise an amount.
  const kept = whole === '0' ? fraction.replace(/^(0*\d{0,4}).*$/u, '$1') : fraction.slice(0, 4);
  const trimmed = kept.replace(/0+$/u, '');
  return `${Number(whole).toLocaleString('en-US')}${trimmed ? `.${trimmed}` : ''} ${amount.symbol}`;
}

/** The phrases a reader presses next, exactly as the router reads them. */
export const AERODROME_CLAIM_PROMPT_V1 = { en: 'Claim my Aerodrome fees', ru: 'Забери мои комиссии Aerodrome' } as const;
export const AERODROME_ALERT_PROMPT_V1 = {
  en: 'Notify me when my Aerodrome rewards reach $5',
  ru: 'Сообщи, когда награды Aerodrome дойдут до $5',
} as const;
const ALERT_PROMPT_V1 = { en: `“${AERODROME_ALERT_PROMPT_V1.en}”`, ru: `«${AERODROME_ALERT_PROMPT_V1.ru}»` };
const CLAIM_PROMPT_V1 = { en: `“${AERODROME_CLAIM_PROMPT_V1.en}”`, ru: `«${AERODROME_CLAIM_PROMPT_V1.ru}»` };

/**
 * The buttons under a reading. The claim is offered only when this reading
 * found something and the deployment can prepare a claim; the alert whenever
 * every pool was read. A reading that failed offers nothing to act on.
 */
export function aerodromeRewardsNextV1(
  read: AerodromeRewardsReadV1,
  input: { russian: boolean; claimReleased: boolean },
): BaseMcpConsoleNextV1[] {
  if (!read.ok) return [];
  const lang = input.russian ? 'ru' : 'en';
  const alert: BaseMcpConsoleNextV1 = { prompt: AERODROME_ALERT_PROMPT_V1[lang], kind: 'alert' };
  return read.rewards.claims > 0 && input.claimReleased
    ? [{ prompt: AERODROME_CLAIM_PROMPT_V1[lang], kind: 'claim' }, alert]
    : [alert];
}

/** The console's answer to a reading, in the language it was asked in. */
export function aerodromeRewardsReplyV1(
  read: AerodromeRewardsReadV1,
  russian: boolean,
  options: { say?: boolean } = {},
): { reply: string; errorCode: string | null } {
  const say = options.say ?? true;
  if (!read.ok) {
    const partial = read.poolsTotal > 0 && read.poolsRead < read.poolsTotal;
    const reply = read.errorCode === 'aerodrome_positions_limit'
      ? russian
        ? 'У этого кошелька больше позиций Aerodrome, чем Miorail читает за раз (200). Ничего не отброшено молча: посмотрите их на aerodrome.finance.'
        : 'This wallet holds more Aerodrome positions than Miorail reads at once (200). None were dropped quietly: see them on aerodrome.finance.'
      : read.errorCode === 'aerodrome_incomplete_coverage' || read.errorCode === 'aerodrome_read_deadline'
        || read.errorCode === 'aerodrome_read_unavailable'
        ? russian
          ? `Aerodrome не удалось прочитать целиком${partial ? ` (${read.poolsRead.toLocaleString('en-US')} из ${read.poolsTotal.toLocaleString('en-US')} пулов)` : ''}, поэтому это не «забирать нечего». Попробуйте через минуту.`
          : `Could not read all of Aerodrome just now${partial ? ` (${read.poolsRead.toLocaleString('en-US')} of ${read.poolsTotal.toLocaleString('en-US')} pools)` : ''}, so this is not “nothing to claim”. Try again in a minute.`
        : russian
          ? `Miorail нашёл позицию Aerodrome, которую не может проверить (${read.errorCode}), и не показывает неполный ответ.`
          : `Miorail found an Aerodrome position it cannot verify (${read.errorCode}), so it shows no partial answer.`;
    return { reply, errorCode: read.errorCode };
  }
  const rewards = read.rewards;
  const scope = russian
    ? `Прочитаны все пулы (${rewards.poolsRead.toLocaleString('en-US')})${rewards.clPositionsHeld ? ` и NFT позиций в кошельке (${rewards.clPositionsHeld})` : ''}, блок ${Number(rewards.blockNumber).toLocaleString('en-US')}.`
    : `Read every pool (${rewards.poolsRead.toLocaleString('en-US')})${rewards.clPositionsHeld ? ` and the ${rewards.clPositionsHeld} position NFT${rewards.clPositionsHeld === 1 ? '' : 's'} this wallet holds` : ''}, at block ${Number(rewards.blockNumber).toLocaleString('en-US')}.`;
  const managed = rewards.managedSkipped === 0 ? [] : [russian
    ? `Позиций под управлением хранилища или локера: ${rewards.managedSkipped}. Их награды забираются там, не здесь.`
    : `${rewards.managedSkipped} position${rewards.managedSkipped === 1 ? ' sits' : 's sit'} in a vault or a locker: their rewards are claimed there, not here.`];
  if (rewards.claims === 0) {
    return {
      reply: [
        russian ? 'Сейчас этому кошельку на Aerodrome забирать нечего: ни комиссий, ни AERO.' : 'Nothing to claim on Aerodrome for this wallet right now: no fees and no AERO.',
        scope, ...managed,
        ...(say ? [russian ? `Скажите ${ALERT_PROMPT_V1.ru}, чтобы узнать, когда появится.` : `Say ${ALERT_PROMPT_V1.en} to hear when there is.`] : []),
      ].join('\n'),
      errorCode: null,
    };
  }
  const lines: string[] = [];
  const total = aboutDollarsV1(rewards.totalUsdcAtomic, russian);
  const pricedNothing = rewards.totalUsdcAtomic === '0' && rewards.unpriced > 0;
  lines.push(pricedNothing
    ? russian ? 'Найдено на Aerodrome: награды, которые сейчас не оценил ни один роутер.' : 'Found on Aerodrome: rewards no router could price right now.'
    : russian
      ? `Найдено на Aerodrome: можно забрать ${total}${rewards.unpriced ? ' (без того, что не удалось оценить)' : ''}.`
      : `Found on Aerodrome: ${total} you can claim now${rewards.unpriced ? ', not counting what could not be priced' : ''}.`);
  const valued = (amount: AerodromeRewardAmountV1) => amount.usdcAtomic === null
    ? `${unitsV1(amount)} (${russian ? 'ни один роутер не оценил' : 'no router priced it'})`
    : `${unitsV1(amount)} (${aboutDollarsV1(amount.usdcAtomic, russian)})`;
  if (rewards.aero) lines.push(`• ${valued(rewards.aero)} ${russian ? 'за застейканные позиции' : 'from staked positions'}`);
  if (rewards.fees.length) lines.push(`• ${russian ? 'Комиссии пулов' : 'Pool fees'}: ${rewards.fees.map(valued).join(', ')}`);
  lines.push(scope, ...managed);
  lines.push(russian ? 'Оценка — сколько дала бы продажа в USDC сейчас.' : 'Values are what a sell would fetch in USDC now.');
  if (say) lines.push(russian
    ? `Скажите ${CLAIM_PROMPT_V1.ru}, чтобы забрать, или ${ALERT_PROMPT_V1.ru}, чтобы узнать, когда накопится.`
    : `Say ${CLAIM_PROMPT_V1.en} to collect it, or ${ALERT_PROMPT_V1.en} to hear when it builds up.`);
  return { reply: lines.join('\n'), errorCode: null };
}
