import {
  assertRwaSignalV1,
  assertSignalIsWatchedV1,
  RWA_SIGNAL_KINDS_V1,
  type RwaSignalKindV1,
  type RwaSignalOutcomeV1,
  type RwaSignalRepositoryV1,
  type RwaSignalRowV1,
} from './rwaSignals.js';
import type { SqlTemplateExecutor } from './types.js';

function rowToSignalV1(row: Record<string, unknown>): RwaSignalRowV1 {
  const kind = String(row.kind) as RwaSignalKindV1;
  if (!RWA_SIGNAL_KINDS_V1.includes(kind)) {
    // The CHECK constraint already refuses this on write. Reaching it on read
    // means the row predates a kind this build knows, and rendering it as an
    // unknown event would be a guess about what happened.
    throw new Error(`stored rwa signal has an unknown kind: ${kind}`);
  }
  return {
    signalId: String(row.id),
    kind,
    chainId: Number(row.chain_id),
    subjectAddress: String(row.subject_address),
    officialAddress: row.official_address === null ? null : String(row.official_address),
    occurredAt: new Date(row.occurred_at as string).toISOString(),
    recordedAt: new Date(row.recorded_at as string).toISOString(),
    facts: (row.facts ?? {}) as Record<string, unknown>,
  };
}

export function createDatabaseRwaSignalRepository(sql: SqlTemplateExecutor): RwaSignalRepositoryV1 {
  return {
    async openSignalWatch(input) {
      if (input.kinds.length === 0) return [];
      const opened: string[] = [];
      for (const kind of input.kinds) {
        // xmax = 0 identifies the row this statement inserted rather than one
        // an earlier pass left behind, which is exactly the distinction the
        // emitter needs: only the pass that opened a watch must stay silent.
        const rows = (await sql`
          INSERT INTO rwa_signal_watch (chain_id, kind, watching_since)
          VALUES (${input.chainId}, ${kind}, ${input.at}::timestamptz)
          ON CONFLICT (chain_id, kind) DO NOTHING
          RETURNING kind`) as Record<string, unknown>[];
        if (rows.length > 0) opened.push(kind);
      }
      const stored = (await sql`
        SELECT chain_id, kind, watching_since
          FROM rwa_signal_watch
         WHERE chain_id = ${input.chainId} AND kind = ANY(${[...input.kinds]})
         ORDER BY kind`) as Record<string, unknown>[];
      return stored.map((row) => ({
        chainId: Number(row.chain_id),
        kind: String(row.kind) as RwaSignalKindV1,
        watchingSince: new Date(row.watching_since as string).toISOString(),
        openedNow: opened.includes(String(row.kind)),
      }));
    },

    async signalWatch(input) {
      const rows = (await sql`
        SELECT chain_id, kind, watching_since
          FROM rwa_signal_watch
         WHERE chain_id = ${input.chainId}
         ORDER BY kind`) as Record<string, unknown>[];
      return rows.map((row) => ({
        chainId: Number(row.chain_id),
        kind: String(row.kind) as RwaSignalKindV1,
        watchingSince: new Date(row.watching_since as string).toISOString(),
      }));
    },

    async recordSignals(input) {
      const parsed = input.signals.map((signal) => assertRwaSignalV1(signal, 'write'));
      const outcome: RwaSignalOutcomeV1 = { recorded: [], alreadyRecorded: [] };
      if (parsed.length === 0) return outcome;

      const watchRows = (await sql`
        SELECT kind, watching_since FROM rwa_signal_watch WHERE chain_id = ${input.chainId}`) as Record<
        string,
        unknown
      >[];
      const watch = new Map<RwaSignalKindV1, string>(
        watchRows.map((row) => [
          String(row.kind) as RwaSignalKindV1,
          new Date(row.watching_since as string).toISOString(),
        ]),
      );
      // Every signal is checked before any is written. A pass that would be
      // refused halfway leaves a feed holding half a story.
      for (const signal of parsed) assertSignalIsWatchedV1(signal, watch);

      for (const signal of parsed) {
        const rows = (await sql`
          INSERT INTO rwa_signals (
            chain_id, kind, subject_address, official_address,
            occurred_at, recorded_at, dedupe_key, facts
          ) VALUES (
            ${signal.chainId}, ${signal.kind}, ${signal.subjectAddress}, ${signal.officialAddress},
            ${signal.occurredAt}::timestamptz, ${input.recordedAt}::timestamptz, ${signal.dedupeKey},
            ${JSON.stringify(signal.facts)}::text::jsonb
          )
          ON CONFLICT (chain_id, dedupe_key) DO NOTHING
          RETURNING id`) as Record<string, unknown>[];
        (rows.length > 0 ? outcome.recorded : outcome.alreadyRecorded).push(signal.dedupeKey);
      }
      return outcome;
    },

    async recentSignals(input) {
      const limit = Math.max(1, Math.min(200, input.limit));
      const kinds = input.kinds && input.kinds.length > 0 ? [...input.kinds] : null;
      const since = input.since ?? null;
      const rows = (await sql`
        SELECT id, chain_id, kind, subject_address, official_address, occurred_at, recorded_at, facts
          FROM rwa_signals
         WHERE chain_id = ${input.chainId}
           AND (${kinds}::text[] IS NULL OR kind = ANY(${kinds}::text[]))
           -- Inclusive on the lower edge, and on occurred_at rather than
           -- recorded_at: the caller is asking when the market moved, not
           -- when a pass got around to noticing it.
           AND (${since}::timestamptz IS NULL OR occurred_at >= ${since}::timestamptz)
         ORDER BY occurred_at DESC, id DESC
         LIMIT ${limit}`) as Record<string, unknown>[];
      return rows.map(rowToSignalV1);
    },

    async signalsForSubject(input) {
      const limit = Math.max(1, Math.min(200, input.limit));
      const rows = (await sql`
        SELECT id, chain_id, kind, subject_address, official_address, occurred_at, recorded_at, facts
          FROM rwa_signals
         WHERE chain_id = ${input.chainId}
           AND subject_address = ${input.subjectAddress.toLowerCase()}
         ORDER BY occurred_at DESC, id DESC
         LIMIT ${limit}`) as Record<string, unknown>[];
      return rows.map(rowToSignalV1);
    },
  };
}
