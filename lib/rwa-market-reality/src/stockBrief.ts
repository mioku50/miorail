import { z } from 'zod';
import { RwaSignalFeedV1Schema, type RwaSignalFeedV1 } from '@mioagent/rwa-dossier/discover';
import {
  DividendWalletHoldingV1Schema,
  DividendWalletResponseV1Schema,
  type DividendWalletResponseV1,
} from './dividendWallet.js';

const Iso = z.string().datetime({ offset: true });
const Amount = z.string().regex(/^\d+(?:\.\d+)?$/);
const Address = z.string().regex(/^0x[0-9a-f]{40}$/);
export const StockBriefInputV1Schema = z.object({ since: Iso.optional() }).strict();

export const StockBriefV1Schema = z
  .object({
    schemaVersion: z.literal('my-stocks-today/v1'),
    chainId: z.literal(8453),
    generatedAt: Iso,
    since: Iso,
    windowClamped: z.boolean(),
    balanceBlock: z.number().int().positive(),
    balanceReadAt: Iso,
    coverage: z
      .object({
        tokenAddresses: z.array(Address).max(64),
        note: z.string(),
      })
      .strict(),
    holdings: z
      .array(
        DividendWalletHoldingV1Schema.extend({
          reference: z
            .object({ valueUsd: Amount, perTokenUsd: Amount, publishedAt: Iso })
            .strict()
            .nullable(),
          /** Read at balanceBlock; never inferred from the reference price. */
          multiplierWad: z.string().regex(/^\d+$/).nullable(),
          schedule: z
            .object({ multiplierWad: z.string().regex(/^\d+$/), effectiveAt: Iso })
            .strict()
            .nullable(),
          scheduleRead: z.enum(['read', 'unavailable']),
        }).strict(),
      )
      .max(64),
    watchedCount: z.number().int().nonnegative(),
    changes: RwaSignalFeedV1Schema.nullable(),
    changesTruncated: z.boolean(),
    changesUnavailable: z.boolean(),
    dividends: DividendWalletResponseV1Schema,
    miorailSummary: z.object({ summary: z.string() }).strict(),
    caveats: z.array(z.string()),
  })
  .strict();
export type StockBriefV1 = z.infer<typeof StockBriefV1Schema>;

const DAY = 86_400_000;
export function stockBriefWindowV1(now: Date, since?: string) {
  const requested = since === undefined ? now.getTime() - DAY : Date.parse(since);
  if (!Number.isFinite(requested) || requested > now.getTime())
    throw new Error('stock_brief_since_invalid');
  const bounded = Math.max(requested, now.getTime() - 7 * DAY);
  return { since: new Date(bounded).toISOString(), windowClamped: bounded !== requested };
}

/** A reference is a total-return value PER TOKEN. Its multiplier is already
 * in the feed; applying it again here would double-count reinvestment. */
export function stockBriefV1(input: {
  now: Date;
  since?: string;
  balanceReadAt: string;
  generatedAt?: string;
  dividends: DividendWalletResponseV1;
  tokenAddresses: readonly string[];
  references: readonly { tokenAddress: string; price: number; at: string }[];
  controls: ReadonlyMap<
    string,
    {
      multiplierWad: string | null;
      scheduleRead: 'read' | 'unavailable';
      schedule: StockBriefV1['holdings'][number]['schedule'];
    }
  >;
  watchedAddresses: readonly string[];
  changes: RwaSignalFeedV1 | null;
}): StockBriefV1 {
  const window = stockBriefWindowV1(input.now, input.since);
  const now = input.now.getTime();
  const holdings = input.dividends.holdings
    .filter((row) => Number(row.tokens) > 0)
    .map((row) => {
      const price = input.references
        .filter(
          (ref) =>
            ref.tokenAddress === row.tokenAddress &&
            Number.isFinite(ref.price) &&
            ref.price > 0 &&
            Date.parse(ref.at) <= now &&
            Date.parse(ref.at) >= now - 4 * DAY,
        )
        .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0];
      const controls = input.controls.get(row.tokenAddress);
      return {
        ...row,
        reference: price
          ? {
              valueUsd: (Number(row.tokens) * price.price).toFixed(6),
              perTokenUsd: price.price.toFixed(6),
              publishedAt: price.at,
            }
          : null,
        multiplierWad: controls?.multiplierWad ?? null,
        schedule: controls?.schedule ?? null,
        scheduleRead: controls?.scheduleRead ?? ('unavailable' as const),
      };
    });
  const relevant = new Set([...holdings.map((row) => row.tokenAddress), ...input.watchedAddresses]);
  const cards =
    input.changes?.cards.filter(
      (card) =>
        (relevant.has(card.subjectAddress) ||
          (card.officialAddress !== null && relevant.has(card.officialAddress))) &&
        Date.parse(card.occurredAt) >= Date.parse(window.since) &&
        Date.parse(card.occurredAt) <= now,
    ) ?? [];
  const changes = input.changes ? { ...input.changes, cards } : null;
  const changesTruncated = (input.changes?.cards.length ?? 0) >= 200;
  return StockBriefV1Schema.parse({
    schemaVersion: 'my-stocks-today/v1',
    chainId: 8453,
    generatedAt: input.generatedAt ?? input.now.toISOString(),
    ...window,
    balanceBlock: input.dividends.blockNumber,
    balanceReadAt: input.balanceReadAt,
    coverage: {
      tokenAddresses: input.tokenAddresses,
      note: `Balances cover ${input.tokenAddresses.length} Coinbase stock contracts currently in the reviewed Base documentation. Other contracts and issuers are not included in this balance read.`,
    },
    holdings,
    watchedCount: new Set(input.watchedAddresses).size,
    changes,
    changesTruncated,
    changesUnavailable: changes === null,
    dividends: input.dividends,
    miorailSummary: {
      summary: `This wallet holds ${holdings.length} reviewed Coinbase stock${holdings.length === 1 ? '' : 's'}. ${changes === null ? 'Its recorded changes could not be read.' : `${cards.length}${changesTruncated ? ' or more' : ''} relevant recorded changes since ${window.since}; this does not establish that nothing else changed.`} Upcoming dividend figures are estimates unless explicitly scheduled by the issuer. Reference values are not sale proceeds.`,
    },
    caveats: [
      'Relevance uses the stocks held now and the current watchlist; it does not reconstruct every past holding.',
      'Recorded market changes retain their own measured size, provider and policy. They are not quotes for this wallet’s balance.',
      'No executable sale value or profit/loss is computed. Open the stock and prepare a sell at an exact token amount for a fresh review.',
      'A dividend reaches the holder when the multiplier changes; a declared cash dividend is not cash paid to this wallet.',
    ],
  });
}
