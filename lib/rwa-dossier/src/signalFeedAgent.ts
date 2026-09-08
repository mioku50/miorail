import { RWA_SIGNAL_KINDS_V1, type RwaSignalKindV1 } from '@mioagent/route-storage';
import { z } from 'zod';

import { assembleRwaSignalFeedV1, type OfficialDiscoverDepsV1 } from './overview.js';

// ---------------------------------------------------------------------------
// What changed across the whole reviewed market, with no subject supplied.
//
// Every other Market Reality tool makes the caller name the asset first:
// `get_market_changes` needs an exact Base address plus an exact size, a
// direction, a destination and a window before it will answer. That is the
// right shape for "how did NVDAc move", and it cannot express the question an
// assistant is actually asked once a day -- "did anything change?" -- because
// answering it would mean guessing which of a hundred and thirty addresses to
// ask about.
//
// So the screen has had a market-wide feed since Phase 2 and the protocol has
// had nothing. This is that same feed. It calls `assembleRwaSignalFeedV1`, the
// builder the /rwa/signals route already calls, for the reason the pooled rows
// were rebuilt around one builder: two surfaces that map the same stored rows
// separately drift, and the one that drifts is always the one nobody is
// looking at.
//
// THREE THINGS THIS PROJECTION CANNOT BE TALKED OUT OF
//
//   * `watching` travels with the rows, always. An empty feed means "nothing
//     changed" only for the kinds that were being watched; for a kind no
//     emitter has ever run, the same empty list means "nobody looked". The
//     screen has said this since it shipped, and a tool that dropped it would
//     let an assistant report quiet where the truth is silence.
//
//   * `notReported` travels with the rows, always. Trades and price moves are
//     deliberately absent, and their absence must not read as calm.
//
//   * A full page is never silence about what lies beyond it. When the read
//     returns exactly `limit` rows the window was cut, and the payload says so
//     rather than letting the oldest row it happened to receive pass for the
//     edge of the record.
// ---------------------------------------------------------------------------

/** How far back a caller may look. Bounded in code rather than taken as a
 * number of hours, for the same reason the history windows are: an unbounded
 * window is a table scan wearing a query string. */
export const RWA_RECORDED_CHANGE_WINDOWS_V1 = {
  '24h': 24 * 60 * 60 * 1_000,
  '7d': 7 * 24 * 60 * 60 * 1_000,
  '30d': 30 * 24 * 60 * 60 * 1_000,
} as const;
export type RwaRecordedChangeWindowV1 = keyof typeof RWA_RECORDED_CHANGE_WINDOWS_V1;

export const RWA_RECORDED_CHANGES_MAX_PAGE_V1 = 100;

const TimestampV1 = z.string().datetime();
const AddressV1 = z.string().regex(/^0x[0-9a-f]{40}$/);

export const RwaRecordedChangesAgentInputV1Schema = z
  .object({
    window: z.enum(['24h', '7d', '30d']).default('24h'),
    kinds: z.array(z.enum(RWA_SIGNAL_KINDS_V1)).min(1).max(RWA_SIGNAL_KINDS_V1.length).optional(),
    /** `summary` returns the tally and the span with no rows at all. A busy day
     * records over a hundred transitions and a caller checking whether anything
     * moved should not have to spend its context finding out. */
    detail: z.enum(['summary', 'rows']).default('summary'),
    limit: z.number().int().min(1).max(RWA_RECORDED_CHANGES_MAX_PAGE_V1).default(25),
  })
  .strict();
export type RwaRecordedChangesAgentInputV1 = z.infer<typeof RwaRecordedChangesAgentInputV1Schema>;

export const RwaRecordedChangeV1Schema = z
  .object({
    signalId: z.string().min(1).max(40),
    kind: z.enum(RWA_SIGNAL_KINDS_V1),
    occurredAt: TimestampV1,
    recordedAt: TimestampV1,
    subjectAddress: AddressV1,
    subjectTicker: z.string().min(1).max(32).nullable(),
    officialAddress: AddressV1.nullable(),
    officialTicker: z.string().min(1).max(32).nullable(),
    /** The stored evidence, unchanged. A cost change carries the size, the
     * destination, both costs and the threshold it had to clear; nothing here
     * is recomputed on the way out. */
    facts: z.record(z.unknown()),
  })
  .strict();

export const RwaRecordedChangesAgentOutputV1Schema = z
  .object({
    schemaVersion: z.literal('miorail-agent-recorded-changes/v1'),
    chain: z.literal('base'),
    chainId: z.literal(8453),
    /** No address was required to ask this. Stated so an assistant knows it may
     * ask again tomorrow without holding a subject. */
    marketWide: z.literal(true),
    window: z.enum(['24h', '7d', '30d']),
    since: TimestampV1,
    observedAt: TimestampV1,
    detail: z.enum(['summary', 'rows']),
    /** What moved, by kind, over the rows this read returned. */
    changeCountsByKind: z.record(z.number().int().min(1)),
    changeCount: z.number().int().min(0),
    /** How many distinct assets moved. Two changes on one asset is a quieter
     * day than two changes on two, and a bare count cannot say which. */
    subjectCount: z.number().int().min(0),
    returnedSince: TimestampV1.nullable(),
    returnedUntil: TimestampV1.nullable(),
    /** True when the read filled its page: older changes exist inside this
     * window and were not returned, so the tally above is a floor. */
    truncated: z.boolean(),
    watching: z
      .array(z.object({ kind: z.enum(RWA_SIGNAL_KINDS_V1), watchingSince: TimestampV1 }).strict())
      .max(16),
    /** Kinds this build can emit that no emitter has ever opened a watch for.
     * Their absence from the feed is a fact about Miorail, not the market. */
    notWatched: z.array(z.enum(RWA_SIGNAL_KINDS_V1)).max(16),
    notReported: z.array(z.string().min(1).max(200)).max(8),
    changes: z.array(RwaRecordedChangeV1Schema).max(RWA_RECORDED_CHANGES_MAX_PAGE_V1),
    miorailSummary: z.object({ summary: z.string().min(1).max(1200) }).strict(),
    assembledAt: TimestampV1,
  })
  .strict();
export type RwaRecordedChangesAgentOutputV1 = z.infer<typeof RwaRecordedChangesAgentOutputV1Schema>;

const KIND_PHRASE_V1: Readonly<Record<RwaSignalKindV1, string>> = {
  official_source_added_asset: 'newly listed by a source',
  official_source_removed_asset: 'dropped by a source',
  official_asset_lookalike_created: 'lookalike launched',
  official_asset_market_became_active: 'market opened',
  official_asset_market_became_unreachable: 'market closed',
  official_asset_cash_exit_changed: 'exit cost moved',
};

/** The sentence an assistant reads first.
 *
 * It has to survive being quoted on its own, so it never says "nothing
 * changed" when the reason for an empty feed is that nothing was watched. */
function recordedChangesSummaryV1(input: {
  window: RwaRecordedChangeWindowV1;
  changeCount: number;
  subjectCount: number;
  countsByKind: Readonly<Record<string, number>>;
  notWatched: readonly RwaSignalKindV1[];
  truncated: boolean;
  watchingCount: number;
}): string {
  const span = input.window === '24h' ? 'the last 24 hours' : `the last ${input.window}`;
  const sentences: string[] = [];

  if (input.watchingCount === 0) {
    sentences.push(
      `No emitter has ever opened a watch, so Miorail has recorded nothing over ${span}. This is a statement about Miorail, not about the market.`,
    );
  } else if (input.changeCount === 0) {
    sentences.push(
      `Nothing Miorail watches changed over ${span} across the reviewed tokenized-stock universe on Base.`,
    );
  } else {
    const tally = Object.entries(input.countsByKind)
      .sort((left, right) => right[1] - left[1])
      .map(([kind, count]) => `${count} ${KIND_PHRASE_V1[kind as RwaSignalKindV1] ?? kind}`)
      .join(', ');
    sentences.push(
      `${input.changeCount} recorded change${input.changeCount === 1 ? '' : 's'} over ${span} across ${input.subjectCount} asset${
        input.subjectCount === 1 ? '' : 's'
      }: ${tally}.`,
    );
  }

  if (input.truncated) {
    sentences.push(
      'This page was full, so older changes inside the same window were not returned and these counts are a floor.',
    );
  }
  if (input.notWatched.length > 0) {
    sentences.push(
      `Never watched, so their absence means nobody looked: ${input.notWatched.join(', ')}.`,
    );
  }
  sentences.push(
    'Each row is a stored transition between two comparable measurements, not a quote and not a trade.',
  );
  return sentences.join(' ');
}

export async function rwaRecordedChangesForAgentV1(
  deps: OfficialDiscoverDepsV1,
  input: RwaRecordedChangesAgentInputV1,
): Promise<RwaRecordedChangesAgentOutputV1> {
  const now = deps.now();
  const since = new Date(now.getTime() - RWA_RECORDED_CHANGE_WINDOWS_V1[input.window]);

  const feed = await assembleRwaSignalFeedV1(deps, {
    limit: input.limit,
    since: since.toISOString(),
    ...(input.kinds ? { kinds: input.kinds } : {}),
  });

  const countsByKind: Record<string, number> = {};
  for (const card of feed.cards) countsByKind[card.kind] = (countsByKind[card.kind] ?? 0) + 1;

  const watchedKinds = new Set(feed.watching.map((row) => row.kind));
  // Only kinds the caller actually asked about can be reported as unwatched --
  // otherwise narrowing to one kind would print five irrelevant caveats.
  const asked: readonly RwaSignalKindV1[] = input.kinds ?? RWA_SIGNAL_KINDS_V1;
  const notWatched = asked.filter((kind) => !watchedKinds.has(kind));

  const truncated = feed.cards.length >= input.limit;
  const subjectCount = new Set(feed.cards.map((card) => card.subjectAddress)).size;

  return RwaRecordedChangesAgentOutputV1Schema.parse({
    schemaVersion: 'miorail-agent-recorded-changes/v1',
    chain: 'base',
    chainId: 8453,
    marketWide: true,
    window: input.window,
    since: since.toISOString(),
    observedAt: feed.observedAt,
    detail: input.detail,
    changeCountsByKind: countsByKind,
    changeCount: feed.cards.length,
    subjectCount,
    // Newest first, so the span runs from the last row back to the first.
    returnedSince: feed.cards.at(-1)?.occurredAt ?? null,
    returnedUntil: feed.cards.at(0)?.occurredAt ?? null,
    truncated,
    watching: feed.watching,
    notWatched,
    notReported: feed.notReported,
    changes:
      input.detail === 'summary'
        ? []
        : feed.cards.map((card) => ({
            signalId: card.signalId,
            kind: card.kind,
            occurredAt: card.occurredAt,
            recordedAt: card.recordedAt,
            subjectAddress: card.subjectAddress,
            subjectTicker: card.subjectTicker,
            officialAddress: card.officialAddress,
            officialTicker: card.officialTicker,
            facts: card.facts,
          })),
    miorailSummary: {
      summary: recordedChangesSummaryV1({
        window: input.window,
        changeCount: feed.cards.length,
        subjectCount,
        countsByKind,
        notWatched,
        truncated,
        watchingCount: feed.watching.length,
      }),
    },
    assembledAt: now.toISOString(),
  });
}
