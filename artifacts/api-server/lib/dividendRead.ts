import { b20MultiplierStandingV1, type B20MultiplierEventV1 } from '@mioagent/b20-control';
import { client } from '@mioagent/db';
import {
  createDatabaseB20CorporateActionRepository,
  createDatabaseDividendRecordSupplyRepositoryV1,
  createDatabaseOfficialAssetRepository,
  createDatabaseRepresentationRatioRepository,
  createDatabaseUnderlyingAssetRepository,
  dividendSupplyDecimalV1,
  readPublicLadderMidsV1,
} from '@mioagent/route-storage';
import {
  DIVIDEND_DECLARATIONS_V1,
  dividendCalendarV1,
  type DividendCalendarResponseV1,
  type DividendMultiplierChangeV1,
  type DividendTokenV1,
} from '@mioagent/rwa-market-reality/dividends';

// ---------------------------------------------------------------------------
// The dividend calendar's read: Coinbase's documented tokenized stocks, what
// each token's multiplier did, and what it was worth when it did it.
//
// A past change comes from the ratio reader's transitions: a reading of the
// token saw the value move, so the change is confirmed by construction. When
// the chain logged it, the log's time replaces the reader's, because the
// reader looks every six hours and the price that matters is the one at the
// moment the token changed. A change the issuer published ahead and that has
// not been read in force yet comes from the multiplier lifecycle.
//
// Only reads. The calendar is computed in `dividendCalendarV1`.
// ---------------------------------------------------------------------------

const CHAIN_ID_V1 = 8453 as const;
const WAD_V1 = 10n ** 18n;

export interface DividendTokenIdentityV1 {
  tokenAddress: string;
  tokenSymbol: string;
  underlyingKey: string;
  symbol: string;
  company: string | null;
}

export interface DividendReadDepsV1 {
  tokens(): Promise<DividendTokenIdentityV1[]>;
  readings(tokens: readonly string[]): Promise<Array<{ tokenAddress: string; rawValue: string; scale: string; blockNumber: number; readAt: string }>>;
  transitions(tokens: readonly string[]): Promise<Array<{ tokenAddress: string; fromRawValue: string; toRawValue: string; scale: string; observedAt: string }>>;
  multiplierEvents(tokenAddress: string): Promise<B20MultiplierEventV1[]>;
  supplies(tokens: readonly string[]): Promise<Array<{ tokenAddress: string; recordDate: string; supply: string }>>;
  /** Reference prices per share, as the feed published them in a window. */
  references(tokens: readonly string[], window: { since: Date; until: Date }): Promise<Array<{ tokenAddress: string; at: string; price: number }>>;
}

/** A raw value at any scale, as WAD. The B20 scale is read, never assumed. */
function toWadV1(raw: string, scale: string): string | null {
  try {
    const value = BigInt(raw);
    const unit = BigInt(scale);
    if (unit <= 0n) return null;
    return ((value * WAD_V1) / unit).toString();
  } catch {
    return null;
  }
}

/** At a change: the feed publishes through every weekday session, so a print
 * older than a day is no price for that moment. */
const PRICE_AT_MAX_AGE_MS_V1 = 86_400_000;
/** Now: the feed stops from Friday evening to Sunday evening, and for a
 * holiday, so its latest print can be two to three days old. Four days covers
 * a long weekend and no more. */
const PRICE_NOW_MAX_AGE_MS_V1 = 4 * 86_400_000;

/** The last price the feed had published at an instant, within `maxAgeMs`. */
function priceAtV1(rows: readonly { at: string; price: number }[], instant: number, maxAgeMs: number): number | null {
  let best: { at: number; price: number } | null = null;
  for (const row of rows) {
    const at = Date.parse(row.at);
    if (!Number.isFinite(at) || at > instant || at < instant - maxAgeMs) continue;
    if (!best || at > best.at) best = { at, price: row.price };
  }
  return best?.price ?? null;
}

export async function readDividendCalendarV1(now: Date, deps: DividendReadDepsV1): Promise<DividendCalendarResponseV1> {
  const identities = await deps.tokens();
  const addresses = identities.map((token) => token.tokenAddress);
  const [readings, transitions, supplies] = await Promise.all([
    deps.readings(addresses),
    deps.transitions(addresses),
    deps.supplies(addresses),
  ]);

  const tokens: DividendTokenV1[] = [];
  const changeTimes: number[] = [];
  const perToken = await Promise.all(
    identities.map(async (identity) => {
      const readingRow = readings.find((row) => row.tokenAddress === identity.tokenAddress);
      const readingWad = readingRow ? toWadV1(readingRow.rawValue, readingRow.scale) : null;
      const reading = readingRow && readingWad ? { multiplierWad: readingWad, readAt: readingRow.readAt } : null;
      const events = await deps.multiplierEvents(identity.tokenAddress);
      const standing = b20MultiplierStandingV1({
        events,
        reading: reading && readingRow ? { multiplierWad: reading.multiplierWad, blockNumber: readingRow.blockNumber, blockTime: reading.readAt } : null,
        now,
      });
      const changes = transitions
        .filter((row) => row.tokenAddress === identity.tokenAddress)
        .sort((a, b) => a.observedAt.localeCompare(b.observedAt))
        .flatMap((row): Array<Omit<DividendMultiplierChangeV1, 'priceAt'>> => {
          const fromWad = toWadV1(row.fromRawValue, row.scale);
          const toWad = toWadV1(row.toRawValue, row.scale);
          if (!fromWad || !toWad) return [];
          // The newest log that set this value, at or before the reading that saw it.
          const logged = events
            .filter(
              (event) =>
                event.event !== 'ui_multiplier_update_cancelled' &&
                event.multiplierWad === toWad &&
                Date.parse(event.effectiveAt ?? event.blockTime) <= Date.parse(row.observedAt),
            )
            .sort((a, b) => b.blockNumber - a.blockNumber || b.logIndex - a.logIndex)[0];
          const at = logged ? (logged.effectiveAt ?? logged.blockTime) : row.observedAt;
          return [{ fromWad, toWad, at: new Date(at).toISOString(), confirmed: true }];
        });
      for (const change of changes) changeTimes.push(Date.parse(change.at));
      // Published ahead and not yet read in force: pending plans, and plans
      // whose date has passed with no reading since.
      const planned = standing.history
        .filter(
          (change) =>
            change.route === 'scheduled_setter' &&
            change.effectiveAt !== null &&
            (change.state === 'scheduled' || change.state === 'awaiting_confirmation') &&
            !changes.some((seen) => seen.toWad === change.multiplierWad),
        )
        .map((change) => ({ multiplierWad: change.multiplierWad, effectiveAt: change.effectiveAt! }));
      return { identity, reading, changes, planned };
    }),
  );

  // Two small windows of prices rather than a fortnight of them: the moment
  // each change happened, and the last few hours.
  const windows = [
    ...changeTimes.map((at) => ({ since: new Date(at - 6 * 3_600_000), until: new Date(at + 3_600_000) })),
    { since: new Date(now.getTime() - 12 * 3_600_000), until: now },
  ];
  const references = (await Promise.all(windows.map((window) => deps.references(addresses, window)))).flat();

  for (const { identity, reading, changes, planned } of perToken) {
    const prices = references.filter((row) => row.tokenAddress === identity.tokenAddress);
    const declared = DIVIDEND_DECLARATIONS_V1.find((row) => row.underlyingKey === identity.underlyingKey);
    tokens.push({
      tokenAddress: identity.tokenAddress,
      tokenSymbol: identity.tokenSymbol,
      underlyingKey: identity.underlyingKey,
      symbol: identity.symbol,
      company: declared?.company ?? identity.company ?? identity.symbol,
      reading,
      changes: changes.map((change) => ({ ...change, priceAt: priceAtV1(prices, Date.parse(change.at), PRICE_AT_MAX_AGE_MS_V1) })),
      scheduled: planned,
      supplyAtRecord: Object.fromEntries(
        supplies.filter((row) => row.tokenAddress === identity.tokenAddress).map((row) => [row.recordDate, row.supply]),
      ),
      priceNow: priceAtV1(prices, now.getTime(), PRICE_NOW_MAX_AGE_MS_V1),
    });
  }
  return dividendCalendarV1({ now, tokens });
}

// ---------------------------------------------------------------------------
// Over the production database.
// ---------------------------------------------------------------------------

export const databaseDividendReadDepsV1: DividendReadDepsV1 = {
  async tokens() {
    const official = createDatabaseOfficialAssetRepository(client);
    const underlyings = createDatabaseUnderlyingAssetRepository(client);
    const assets = await official.officialAssets({ chainId: CHAIN_ID_V1, limit: 500, sourceKind: 'base_docs_technical' });
    const rows = await Promise.all(
      assets.map(async (asset): Promise<DividendTokenIdentityV1 | null> => {
        const found = await underlyings.underlyingOf({ chainId: CHAIN_ID_V1, tokenAddress: asset.tokenAddress });
        if (!found || found.underlying.assetClass !== 'equity') return null;
        const listing = asset.listings.find((row) => row.sourceKind === 'base_docs_technical') ?? asset.listings[0];
        const symbol = found.underlying.displaySymbol ?? found.underlying.canonicalName;
        return {
          tokenAddress: asset.tokenAddress,
          tokenSymbol: listing?.ticker ?? symbol,
          underlyingKey: found.underlying.underlyingKey,
          symbol,
          company: found.underlying.canonicalName === symbol ? null : found.underlying.canonicalName,
        };
      }),
    );
    return rows.filter((row): row is DividendTokenIdentityV1 => row !== null);
  },

  async readings(tokens) {
    const rows = await createDatabaseRepresentationRatioRepository(client).readRatios({ chainId: CHAIN_ID_V1, tokenAddresses: tokens });
    return rows
      .filter((row) => row.ratioKind === 'b20_multiplier')
      .map((row) => ({
        tokenAddress: row.tokenAddress,
        rawValue: row.rawValue,
        scale: row.scale,
        blockNumber: Number(row.blockNumber),
        readAt: row.lastCheckedAt,
      }));
  },

  async transitions(tokens) {
    const wanted = new Set(tokens);
    const rows = await createDatabaseRepresentationRatioRepository(client).recentChanges({ chainId: CHAIN_ID_V1, limit: 500 });
    return rows
      .filter((row) => row.ratioKind === 'b20_multiplier' && wanted.has(row.tokenAddress))
      .map((row) => ({
        tokenAddress: row.tokenAddress,
        fromRawValue: row.fromRawValue,
        toRawValue: row.toRawValue,
        scale: row.scale,
        observedAt: row.observedAt,
      }));
  },

  async multiplierEvents(tokenAddress) {
    const rows = await createDatabaseB20CorporateActionRepository(client).actionsFor({ chainId: CHAIN_ID_V1, tokenAddress, limit: 200 });
    return rows.flatMap((row): B20MultiplierEventV1[] => {
      if (row.event !== 'multiplier_updated' && row.event !== 'ui_multiplier_updated' && row.event !== 'ui_multiplier_update_cancelled') {
        return [];
      }
      if (row.payloadState !== 'decoded' || row.multiplierWad === null) return [];
      return [
        {
          event: row.event,
          multiplierWad: row.multiplierWad,
          effectiveAt: row.effectiveAt,
          blockTime: row.blockTime,
          blockNumber: row.blockNumber,
          transactionHash: row.transactionHash,
          logIndex: row.logIndex,
        },
      ];
    });
  },

  async supplies(tokens) {
    const rows = await createDatabaseDividendRecordSupplyRepositoryV1(client).supplies({ chainId: CHAIN_ID_V1, tokenAddresses: tokens });
    return rows.map((row) => ({ tokenAddress: row.tokenAddress, recordDate: row.recordDate, supply: dividendSupplyDecimalV1(row) }));
  },

  async references(tokens, window) {
    const wanted = new Set(tokens);
    const rows = await readPublicLadderMidsV1(client, window);
    return rows
      .filter((row) => wanted.has(row.token) && Number.isFinite(row.reference) && row.reference > 0)
      .map((row) => ({ tokenAddress: row.token, at: row.referenceUpdatedAt, price: row.reference }));
  },
};
