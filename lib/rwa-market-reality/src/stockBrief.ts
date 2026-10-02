import { z } from 'zod';
import { RwaSignalFeedV1Schema, type RwaSignalFeedV1 } from '@mioagent/rwa-dossier/discover';
import {
  DividendWalletHoldingV1Schema,
  DividendWalletResponseV1Schema,
  type DividendWalletResponseV1,
} from './dividendWallet.js';
import { stockInboxNewsV1 } from './stockInboxNews.js';

const Iso = z.string().datetime({ offset: true });
const Amount = z.string().regex(/^\d+(?:\.\d+)?$/);
const Address = z.string().regex(/^0x[0-9a-f]{40}$/);
export const StockBriefInputV1Schema = z
  .object({
    since: Iso.optional(),
    view: z.enum(['unread', 'history']).optional(),
    cursor: z.string().min(1).max(2048).optional(),
  })
  .strict();
export const StockInboxReadInputV1Schema = z
  .object({ reviewToken: z.string().min(1).max(8192) })
  .strict();
export const StockInboxReadResultV1Schema = z
  .object({ reviewedAt: Iso, markedCount: z.number().int().min(0).max(50) })
  .strict();

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
    inbox: z
      .object({
        windowBasis: z.literal('recorded_at'),
        view: z.enum(['unread', 'history']),
        openedAt: Iso.nullable(),
        reviewedAt: Iso.nullable(),
        snapshotAt: Iso,
        nextCursor: z.string().max(2048).nullable(),
        reviewToken: z.string().max(8192).nullable(),
        heldCount: z.number().int().nonnegative(),
        watchedCount: z.number().int().nonnegative(),
        items: z
          .array(
            z
              .object({
                signalId: z.string().min(1),
                evidenceSignalIds: z.array(z.string().min(1)).min(1).max(50).optional(),
                transactionHash: z
                  .string()
                  .regex(/^0x[0-9a-f]{64}$/)
                  .nullable()
                  .optional(),
                headline: z.string().nullable().optional(),
                summary: z.string().nullable().optional(),
                occurredAt: Iso.optional(),
                recordedAt: Iso.optional(),
                relation: z.enum(['held', 'watched']),
                relatedTokenAddress: Address,
                inspectionHref: z.string().regex(/^\/investigate\?token=0x[0-9a-f]{40}$/),
                relatedInspectionHref: z
                  .string()
                  .regex(/^\/investigate\?token=0x[0-9a-f]{40}$/)
                  .nullable(),
              })
              .strict(),
          )
          .max(200),
      })
      .strict(),
    dividends: DividendWalletResponseV1Schema,
    miorailSummary: z.object({ summary: z.string() }).strict(),
    caveats: z.array(z.string()),
  })
  .strict();
export type StockBriefV1 = z.infer<typeof StockBriefV1Schema>;

const DAY = 86_400_000;
export function stockBriefWindowV1(now: Date, since?: string, preserve = false) {
  const requested = since === undefined ? now.getTime() - DAY : Date.parse(since);
  if (!Number.isFinite(requested) || requested > now.getTime())
    throw new Error('stock_brief_since_invalid');
  const bounded = preserve ? requested : Math.max(requested, now.getTime() - 7 * DAY);
  return { since: new Date(bounded).toISOString(), windowClamped: bounded !== requested };
}

/** A reference is a total-return value PER TOKEN. Its multiplier is already
 * in the feed; applying it again here would double-count reinvestment. */
export function stockBriefV1(input: {
  now: Date;
  since?: string;
  preserveWindow?: boolean;
  inboxState?: Pick<
    StockBriefV1['inbox'],
    'view' | 'openedAt' | 'reviewedAt' | 'snapshotAt' | 'nextCursor' | 'reviewToken'
  >;
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
  const window = stockBriefWindowV1(input.now, input.since, input.preserveWindow);
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
    input.changes?.cards
      .filter(
        (card) =>
          (relevant.has(card.subjectAddress) ||
            (card.officialAddress !== null && relevant.has(card.officialAddress))) &&
          Date.parse(card.recordedAt) >= Date.parse(window.since) &&
          Date.parse(card.recordedAt) <=
            Date.parse(input.inboxState?.snapshotAt ?? input.now.toISOString()) &&
          Date.parse(card.occurredAt) <= now,
      )
      .sort((a, b) => Date.parse(b.recordedAt) - Date.parse(a.recordedAt)) ?? [];
  const changes = input.changes ? { ...input.changes, cards } : null;
  const changesTruncated = input.inboxState ? false : (input.changes?.cards.length ?? 0) >= 200;
  const held = new Set(holdings.map((row) => row.tokenAddress));
  const items = stockInboxNewsV1(cards, new Set(input.tokenAddresses)).map((news) => {
    const card = news.primary;
    const relatedTokenAddress = held.has(card.subjectAddress)
      ? card.subjectAddress
      : card.officialAddress && held.has(card.officialAddress)
        ? card.officialAddress
        : relevant.has(card.subjectAddress)
          ? card.subjectAddress
          : card.officialAddress!;
    return {
      signalId: card.signalId,
      evidenceSignalIds: news.evidenceSignalIds,
      transactionHash: news.transactionHash,
      headline: news.headline,
      summary: news.summary,
      occurredAt: news.occurredAt,
      recordedAt: news.recordedAt,
      relation: held.has(relatedTokenAddress) ? ('held' as const) : ('watched' as const),
      relatedTokenAddress,
      inspectionHref: `/investigate?token=${card.subjectAddress}`,
      relatedInspectionHref:
        relatedTokenAddress === card.subjectAddress
          ? null
          : `/investigate?token=${relatedTokenAddress}`,
    };
  });
  const heldCount = items.filter((row) => row.relation === 'held').length;
  const changeSummary = input.inboxState
    ? `This ${input.inboxState.view} page contains ${heldCount} updates related to current holdings and ${items.length - heldCount} to watched contracts, recorded from ${window.since} through ${input.inboxState.snapshotAt}.${input.inboxState.nextCursor ? ' More entries are available on older pages.' : ''}`
    : `${heldCount} changes related to current holdings and ${items.length - heldCount} to watched contracts were recorded since ${window.since}${changesTruncated ? '; the page is full and older entries may be missing' : ''}.`;
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
    inbox: {
      windowBasis: 'recorded_at',
      heldCount,
      watchedCount: items.length - heldCount,
      items,
      view: 'unread',
      openedAt: null,
      reviewedAt: null,
      snapshotAt: input.now.toISOString(),
      nextCursor: null,
      reviewToken: null,
      ...input.inboxState,
    },
    dividends: input.dividends,
    miorailSummary: {
      summary: `This wallet holds ${holdings.length} reviewed Coinbase stock${holdings.length === 1 ? '' : 's'}. ${changes === null ? 'Its recorded changes could not be read.' : `${changeSummary} Occurrence dates remain separate; this does not establish that nothing else changed.`} Upcoming dividend figures are estimates unless explicitly scheduled by the issuer. Reference values are not sale proceeds.`,
    },
    caveats: [
      'Relevance uses the stocks held now and the current watchlist; it does not reconstruct every past holding.',
      'This personal inbox uses when Miorail recorded each change, so delayed observations can appear on a later visit. Occurrence and recording dates remain separate.',
      'Inbox items are the personal news units. Issuer logs for the same exact contract and transaction are grouped; changes.cards retains their individual evidence. Do not report those raw cards as additional personal updates.',
      'Recorded market changes retain their own measured size, provider and policy. They are not quotes for this wallet’s balance.',
      'No executable sale value or profit/loss is computed. Open the stock and prepare a sell at an exact token amount for a fresh review.',
      'A dividend reaches the holder when the multiplier changes; a declared cash dividend is not cash paid to this wallet.',
    ],
  });
}
