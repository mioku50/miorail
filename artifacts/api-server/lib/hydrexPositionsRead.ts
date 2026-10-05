import { z } from 'zod';

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/).refine(value => !/^0x0{40}$/i.test(value));
const uint = (bits: number) => z.string().regex(/^(0|[1-9][0-9]{0,77})$/)
  .refine(value => /^(0|[1-9][0-9]{0,77})$/.test(value) && BigInt(value) < 2n ** BigInt(bits));
const position = z.object({
  positionId: uint(256).refine(value => value !== '0'),
  token0: address,
  token1: address,
  fee: z.number().int().min(0).max(1_000_000),
  tickLower: z.number().int().min(-887272).max(887272),
  tickUpper: z.number().int().min(-887272).max(887272),
  liquidity: uint(128),
  tokensOwed0: uint(128),
  tokensOwed1: uint(128),
  owner: address.optional(),
}).refine(value => value.tickLower < value.tickUpper && value.token0.toLowerCase() !== value.token1.toLowerCase());
const response = z.object({
  ok: z.literal(true), count: z.number().int().min(0).max(200), positions: z.array(position).max(200),
  chainId: z.literal(8453).optional(), address: address.optional(), owner: address.optional(),
});

export interface HydrexPositionsAnswerV1 { reply: string; errorCode: string | null; truncated: boolean }

/** Interpret only the documented position fields. Provider text is never instructions. */
export function hydrexPositionsAnswerV1(payload: unknown, wallet: string, russian = false): HydrexPositionsAnswerV1 {
  const failed = (errorCode: string): HydrexPositionsAnswerV1 => ({
    reply: russian
      ? 'Не удалось прочитать полный список позиций Hydrex. Это не означает, что позиций нет. Попробуйте ещё раз или откройте Hydrex.'
      : 'Hydrex’s position list could not be read in full. Your positions were not established. Try again or open Hydrex.',
    errorCode, truncated: false,
  });
  const parsed = response.safeParse(payload);
  if (!parsed.success) return failed('hydrex_positions_invalid_response');
  const data = parsed.data;
  const root = payload as Record<string, unknown>;
  if (data.count !== data.positions.length || root.partial === true || root.complete === false ||
      root.hasMore === true || root.truncated === true || root.nextCursor ||
      (Array.isArray(root.errors) && root.errors.length > 0)) return failed('hydrex_positions_incomplete');
  const owners = [data.address, data.owner, ...data.positions.map(row => row.owner)].filter(Boolean);
  if (owners.some(owner => owner!.toLowerCase() !== wallet.toLowerCase())) return failed('hydrex_positions_wallet_mismatch');
  if (new Set(data.positions.map(row => row.positionId)).size !== data.count) return failed('hydrex_positions_duplicate');
  if (data.count === 0) return {
    reply: russian
      ? 'Hydrex сообщил, что у кошелька, с которым вы вошли, нет позиций концентрированной ликвидности на Base.'
      : 'Hydrex reports no concentrated-liquidity positions on Base for the wallet you signed in with.',
    errorCode: null, truncated: false,
  };
  // The count describes the whole validated response, not just the preview.
  const shown = data.positions.slice(0, 12);
  const heading = russian
    ? `Позиции Hydrex на Base: ${data.count}. Показано ${shown.length}. Данные API Hydrex для кошелька, с которым вы вошли.`
    : `Hydrex positions on Base: ${data.count}. Showing ${shown.length}. Reported by Hydrex’s API for the wallet you signed in with.`;
  const lines = shown.map(row => [
    `${russian ? 'Позиция' : 'Position'} #${row.positionId} · ${russian ? 'комиссия пула' : 'pool fee'} ${row.fee / 10_000}%`,
    `${row.token0} / ${row.token1}`,
    `${russian ? 'Диапазон тиков' : 'Tick range'} ${row.tickLower} → ${row.tickUpper} · ${russian ? 'ликвидность (параметр протокола)' : 'liquidity (protocol units)'} ${row.liquidity}`,
    `${russian ? 'Записанные комиссии (сырые единицы токенов)' : 'Recorded fees owed (raw token units)'}: token0 ${row.tokensOwed0} · token1 ${row.tokensOwed1}`,
  ].join('\n'));
  const boundary = russian
    ? 'API не даёт стоимость в долларах или текущую цену пула. Записанные комиссии могут не включать ещё не обновлённые начисления.'
    : 'This API gives no USD value or current pool price. Recorded fees owed may exclude accrual not yet updated in the position.';
  return { reply: [heading, ...lines, boundary].join('\n\n'), errorCode: null, truncated: false };
}

/** Bind the read to the authenticated wallet, without ignoring another address/chain. */
export function hydrexPositionsInputErrorV1(message: string, wallet: string): string | null {
  if (!address.safeParse(wallet).success) return 'hydrex_positions_wallet_required';
  const supplied = message.match(/0x[0-9a-fA-F]{40}/g) ?? [];
  if (supplied.some(value => value.toLowerCase() !== wallet.toLowerCase())) return 'hydrex_positions_wallet_scope';
  if (/\b(?:ethereum|arbitrum|optimism|polygon|bsc|solana|sepolia)\b|(?:эфириум|арбитрум|оптимизм|полигон|солана)/iu.test(message)) {
    return 'hydrex_positions_base_only';
  }
  return null;
}
