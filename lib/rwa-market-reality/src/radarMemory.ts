import { RouteStorageConflictError } from '@mioagent/route-storage';

import {
  MARKET_REALITY_RADAR_CAPACITY_V1,
  MarketRealityRadarEventV1Schema,
  MarketRealityRadarPointV1Schema,
  MarketRealityRadarWatchInputV1Schema,
  MarketRealityRadarWatchV1Schema,
  marketRealityRadarPointBelongsToWatchV1,
  marketRealityRadarWatchIdV1,
  type MarketRealityRadarEventV1,
  type MarketRealityRadarPointV1,
  type MarketRealityRadarRepositoryV1,
  type MarketRealityRadarWatchV1,
} from './radar.js';

export class InMemoryMarketRealityRadarRepositoryV1
  implements MarketRealityRadarRepositoryV1
{
  private readonly watches = new Map<string, MarketRealityRadarWatchV1>();
  private readonly points = new Map<string, MarketRealityRadarPointV1>();
  private readonly events = new Map<string, MarketRealityRadarEventV1>();

  async addWatch(
    input: Parameters<MarketRealityRadarRepositoryV1['addWatch']>[0],
  ): Promise<MarketRealityRadarWatchV1> {
    const question = MarketRealityRadarWatchInputV1Schema.parse({
      ...input.question,
      approvedSources: [...input.question.approvedSources].sort(),
    });
    const watchId = marketRealityRadarWatchIdV1(input.userId, question);
    const existing = this.watches.get(watchId);
    if (existing) return structuredClone(existing);
    const owned = [...this.watches.values()].filter((row) => row.userId === input.userId);
    if (owned.length >= MARKET_REALITY_RADAR_CAPACITY_V1) {
      throw new RouteStorageConflictError(
        `Radar holds at most ${MARKET_REALITY_RADAR_CAPACITY_V1} exact market watches. Remove one to add another.`,
      );
    }
    const row = MarketRealityRadarWatchV1Schema.parse({
      ...question,
      watchId,
      userId: input.userId,
      chainId: 8453,
      issuerId: input.issuerId,
      representationKind: input.representationKind,
      createdAt: input.now,
      lastEvaluatedAt: null,
      lastComparableAt: null,
      lastEvaluationOutcome: null,
    });
    this.watches.set(watchId, row);
    return structuredClone(row);
  }

  async removeWatch(input: { userId: string; watchId: string }): Promise<boolean> {
    const row = this.watches.get(input.watchId);
    if (!row || row.userId !== input.userId) return false;
    this.watches.delete(input.watchId);
    this.points.delete(input.watchId);
    for (const [eventId, event] of this.events) {
      if (event.watchId === input.watchId) this.events.delete(eventId);
    }
    return true;
  }

  async watchesForUser(input: { userId: string }): Promise<MarketRealityRadarWatchV1[]> {
    return [...this.watches.values()]
      .filter((row) => row.userId === input.userId)
      .sort((left, right) =>
        left.createdAt === right.createdAt
          ? left.watchId.localeCompare(right.watchId)
          : left.createdAt.localeCompare(right.createdAt),
      )
      .map((row) => structuredClone(row));
  }

  async watchesForToken(input: {
    chainId: 8453;
    tokenAddress: string;
  }): Promise<MarketRealityRadarWatchV1[]> {
    return [...this.watches.values()]
      .filter(
        (row) =>
          row.chainId === input.chainId &&
          row.tokenAddress === input.tokenAddress.toLowerCase(),
      )
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map((row) => structuredClone(row));
  }

  async distinctWatchedAddresses(input: { chainId: 8453; limit: number }): Promise<string[]> {
    return [...new Set(
      [...this.watches.values()]
        .filter((row) => row.chainId === input.chainId)
        .map((row) => row.tokenAddress),
    )]
      .sort()
      .slice(0, Math.max(1, Math.min(1_000, input.limit)));
  }

  async pointForWatch(input: { watchId: string }): Promise<MarketRealityRadarPointV1 | null> {
    const point = this.points.get(input.watchId);
    return point ? structuredClone(point) : null;
  }

  async recordEvaluation(
    input: Parameters<MarketRealityRadarRepositoryV1['recordEvaluation']>[0],
  ): Promise<{ recorded: string[]; alreadyRecorded: string[] }> {
    const watch = this.watches.get(input.watch.watchId);
    if (!watch) throw new Error('Radar watch does not exist');
    const outcome = { recorded: [] as string[], alreadyRecorded: [] as string[] };
    const point = input.point ? MarketRealityRadarPointV1Schema.parse(input.point) : null;
    const comparableOutcome = input.outcome === 'baseline' || input.outcome === 'compared';
    if (point && !marketRealityRadarPointBelongsToWatchV1(point, watch)) {
      throw new Error('Radar point does not belong to the evaluated watch');
    }
    if ((point !== null) !== comparableOutcome || (input.events.length > 0 && input.outcome !== 'compared')) {
      throw new Error('Radar evaluation outcome does not match its comparable evidence');
    }
    for (const value of input.events) {
      const event = MarketRealityRadarEventV1Schema.parse(value);
      if (
        event.watchId !== watch.watchId ||
        event.chainId !== watch.chainId ||
        event.tokenAddress !== watch.tokenAddress ||
        event.snapshotHash !== point?.snapshotHash ||
        event.occurredAt !== point?.observedAt ||
        [...event.approvedSources].sort().join('\u0000') !==
          [...watch.approvedSources].sort().join('\u0000')
      ) {
        throw new Error('Radar event does not belong to the evaluated watch');
      }
      if (this.events.has(event.eventId)) outcome.alreadyRecorded.push(event.eventId);
      else {
        this.events.set(event.eventId, event);
        outcome.recorded.push(event.eventId);
      }
    }
    const current = this.points.get(watch.watchId);
    if (!current || (point && Date.parse(point.observedAt) > Date.parse(current.observedAt))) {
      if (point) this.points.set(watch.watchId, point);
    }
    this.watches.set(
      watch.watchId,
      MarketRealityRadarWatchV1Schema.parse({
        ...watch,
        lastEvaluatedAt: input.at,
        lastComparableAt: point?.observedAt ?? watch.lastComparableAt,
        lastEvaluationOutcome: input.outcome,
      }),
    );
    return outcome;
  }

  async eventsForUser(input: { userId: string; limit: number }): Promise<MarketRealityRadarEventV1[]> {
    const watchIds = new Set(
      [...this.watches.values()].filter((row) => row.userId === input.userId).map((row) => row.watchId),
    );
    return [...this.events.values()]
      .filter((event) => watchIds.has(event.watchId))
      .sort((left, right) =>
        left.occurredAt === right.occurredAt
          ? right.eventId.localeCompare(left.eventId)
          : right.occurredAt.localeCompare(left.occurredAt),
      )
      .slice(0, Math.max(1, Math.min(250, input.limit)))
      .map((row) => structuredClone(row));
  }
}
