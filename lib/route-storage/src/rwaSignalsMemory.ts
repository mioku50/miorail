import {
  assertRwaSignalV1,
  assertSignalIsWatchedV1,
  type RwaSignalKindV1,
  type RwaSignalOutcomeV1,
  type RwaSignalRepositoryV1,
  type RwaSignalRowV1,
} from './rwaSignals.js';

/**
 * The in-memory twin.
 *
 * It refuses what Postgres refuses: an unwatched kind, a signal dated before
 * its watch opened, a dedupe key already on file. A fake that accepted any of
 * those would let a test pass on a feed the database could never produce --
 * which is the exact gap that put three bugs into production in T65.
 */
export function createMemoryRwaSignalRepository(): RwaSignalRepositoryV1 {
  const watch = new Map<string, { chainId: number; kind: RwaSignalKindV1; watchingSince: string }>();
  const signals: RwaSignalRowV1[] = [];
  const keys = new Set<string>();
  let nextId = 1;
  const watchKey = (chainId: number, kind: RwaSignalKindV1) => `${chainId}:${kind}`;

  return {
    async openSignalWatch(input) {
      return input.kinds.map((kind) => {
        const key = watchKey(input.chainId, kind);
        const existing = watch.get(key);
        if (existing) {
          return { ...existing, openedNow: false };
        }
        const row = { chainId: input.chainId, kind, watchingSince: input.at };
        watch.set(key, row);
        return { ...row, openedNow: true };
      });
    },

    async signalWatch(input) {
      return [...watch.values()]
        .filter((row) => row.chainId === input.chainId)
        .sort((left, right) => left.kind.localeCompare(right.kind))
        .map((row) => ({ ...row }));
    },

    async recordSignals(input) {
      const parsed = input.signals.map((signal) => assertRwaSignalV1(signal, 'write'));
      const outcome: RwaSignalOutcomeV1 = { recorded: [], alreadyRecorded: [] };
      if (parsed.length === 0) return outcome;

      const open = new Map<RwaSignalKindV1, string>(
        [...watch.values()]
          .filter((row) => row.chainId === input.chainId)
          .map((row) => [row.kind, row.watchingSince]),
      );
      for (const signal of parsed) assertSignalIsWatchedV1(signal, open);

      for (const signal of parsed) {
        const key = `${input.chainId}:${signal.dedupeKey}`;
        if (keys.has(key)) {
          outcome.alreadyRecorded.push(signal.dedupeKey);
          continue;
        }
        keys.add(key);
        signals.push({
          signalId: String(nextId++),
          kind: signal.kind,
          chainId: signal.chainId,
          subjectAddress: signal.subjectAddress,
          officialAddress: signal.officialAddress,
          occurredAt: signal.occurredAt,
          recordedAt: input.recordedAt,
          facts: { ...signal.facts },
        });
        outcome.recorded.push(signal.dedupeKey);
      }
      return outcome;
    },

    async recentSignals(input) {
      const limit = Math.max(1, Math.min(200, input.limit));
      const kinds = input.kinds && input.kinds.length > 0 ? new Set(input.kinds) : null;
      // Inclusive on the lower edge, matching `occurred_at >= since` in SQL.
      const since = input.since === undefined ? null : Date.parse(input.since);
      return signals
        .filter(
          (row) =>
            row.chainId === input.chainId &&
            (kinds === null || kinds.has(row.kind)) &&
            (since === null || Date.parse(row.occurredAt) >= since),
        )
        // The same total order the database produces: newest occurrence first,
        // then newest insertion, so two transitions stamped alike stay stable.
        .sort(
          (left, right) =>
            Date.parse(right.occurredAt) - Date.parse(left.occurredAt) ||
            Number(right.signalId) - Number(left.signalId),
        )
        .slice(0, limit)
        .map((row) => ({ ...row, facts: { ...row.facts } }));
    },

    async signalsForSubject(input) {
      const limit = Math.max(1, Math.min(200, input.limit));
      const subject = input.subjectAddress.toLowerCase();
      return signals
        .filter((row) => row.chainId === input.chainId && row.subjectAddress === subject)
        .sort(
          (left, right) =>
            Date.parse(right.occurredAt) - Date.parse(left.occurredAt) ||
            Number(right.signalId) - Number(left.signalId),
        )
        .slice(0, limit)
        .map((row) => ({ ...row, facts: { ...row.facts } }));
    },
  };
}
