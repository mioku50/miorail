import { NOTIFICATION_CHANNELS_V1, type NotificationChannelV1 } from './baseAppNotifications.js';
import { RouteStorageIntegrityError } from './types.js';
import type { SqlTemplateExecutor } from './types.js';

// ---------------------------------------------------------------------------
// Found, inside Wallet MCP: the wallets that asked to hear when the rewards
// they can claim on Aerodrome build up.
//
// A person in the Wallet MCP room says "Notify me when my Aerodrome rewards
// reach $5". The notifier reads that wallet's claimable fees and AERO now and
// then (one reading walks every Aerodrome pool), and tells the wallet once,
// per channel, each time they build up past the amount.
//
// The episode is what "once" counts in. It moves on when a reading falls under
// half the amount after the wallet was told (a claim does that), so the next
// build-up is told again; a new amount starts a new episode too. Stored per
// wallet: the amount, the last reading (dollars, block or the failure's code)
// and which episode each channel last told. Nothing else.
// ---------------------------------------------------------------------------

/** Below a dollar, collecting costs about what it brings. */
export const AERODROME_REWARD_ALERT_MIN_CENTS_V1 = 100;
export const AERODROME_REWARD_ALERT_MAX_CENTS_V1 = 1_000_000;
export const AERODROME_REWARD_ALERT_DEFAULT_CENTS_V1 = 500;

export interface AerodromeRewardAlertV1 {
  walletAddress: string;
  thresholdUsdCents: number;
  episode: number;
  createdAt: string;
  updatedAt: string;
  readAt: string | null;
  readBlock: string | null;
  /** The last good reading in cents; null before one, or when the last failed. */
  readUsdCents: number | null;
  /** Why the last reading failed; null when it did not. */
  readError: string | null;
  /** The episode each channel last told this wallet about. */
  told: Record<NotificationChannelV1, number | null>;
}

export interface AerodromeRewardAlertRepositoryV1 {
  get(walletAddress: string): Promise<AerodromeRewardAlertV1 | null>;
  /** Starts an alert, or moves one to a new amount, which starts a new
   * episode. The same amount again changes nothing. */
  subscribe(input: {
    walletAddress: string;
    thresholdUsdCents: number;
    at: Date;
  }): Promise<{ outcome: 'created' | 'moved' | 'unchanged'; alert: AerodromeRewardAlertV1 }>;
  /** Whether there was an alert to stop. */
  unsubscribe(walletAddress: string): Promise<boolean>;
  /** Wallets to read now, oldest reading first: never read, read before
   * `readBefore`, or failed before `retryBefore`. */
  dueForRead(input: { readBefore: Date; retryBefore: Date; limit: number }): Promise<string[]>;
  /** Keeps a reading, or a failure. A good reading under half the amount,
   * in an episode some channel already told, starts the next episode. */
  recordRead(input: {
    walletAddress: string;
    at: Date;
    block: string | null;
    usdCents: number | null;
    error: string | null;
  }): Promise<void>;
  /** Alerts whose last good reading, taken at or after `freshSince`, reached
   * their amount; each says which episode every channel last told. */
  reached(input: { freshSince: Date }): Promise<AerodromeRewardAlertV1[]>;
  /** This channel told the wallet about this episode. */
  markTold(input: { walletAddress: string; channel: NotificationChannelV1; episode: number }): Promise<void>;
}

const WALLET_V1 = /^0x[0-9a-f]{40}$/;
const ERROR_V1 = /^[a-z0-9_]{1,64}$/;

export function assertAerodromeRewardWalletV1(wallet: string): void {
  if (!WALLET_V1.test(wallet)) throw new RouteStorageIntegrityError('expected a lowercase 20-byte wallet address');
}

export function assertAerodromeRewardThresholdV1(cents: number): void {
  if (!Number.isInteger(cents) || cents < AERODROME_REWARD_ALERT_MIN_CENTS_V1 || cents > AERODROME_REWARD_ALERT_MAX_CENTS_V1) {
    throw new RouteStorageIntegrityError('an alert amount is whole cents from $1 to $10,000');
  }
}

function assertReadingV1(input: { walletAddress: string; block: string | null; usdCents: number | null; error: string | null }): void {
  assertAerodromeRewardWalletV1(input.walletAddress);
  if ((input.usdCents === null) === (input.error === null)) {
    throw new RouteStorageIntegrityError('a reading is a dollar figure or a failure, never both or neither');
  }
  if (input.usdCents !== null && (!Number.isSafeInteger(input.usdCents) || input.usdCents < 0)) {
    throw new RouteStorageIntegrityError('a reading is whole cents, zero or more');
  }
  if (input.error !== null && !ERROR_V1.test(input.error)) throw new RouteStorageIntegrityError('a failure is a short code');
  if (input.block !== null && !/^[1-9][0-9]{0,18}$/.test(input.block)) throw new RouteStorageIntegrityError('a block is a positive number');
}

function assertChannelV1(channel: string): void {
  if (!(NOTIFICATION_CHANNELS_V1 as readonly string[]).includes(channel)) {
    throw new RouteStorageIntegrityError(`unknown notification channel: ${channel}`);
  }
}

/** The episode after this reading. */
function nextEpisodeV1(alert: AerodromeRewardAlertV1, usdCents: number | null): number {
  if (usdCents === null || usdCents * 2 >= alert.thresholdUsdCents) return alert.episode;
  return Object.values(alert.told).includes(alert.episode) ? alert.episode + 1 : alert.episode;
}

/** The in-memory store: refuses what the table refuses, and moves episodes
 * the way the SQL does. */
export class InMemoryAerodromeRewardAlertRepositoryV1 implements AerodromeRewardAlertRepositoryV1 {
  private readonly alerts = new Map<string, AerodromeRewardAlertV1>();

  async get(walletAddress: string): Promise<AerodromeRewardAlertV1 | null> {
    assertAerodromeRewardWalletV1(walletAddress);
    const alert = this.alerts.get(walletAddress);
    return alert ? structuredClone(alert) : null;
  }

  async subscribe(input: { walletAddress: string; thresholdUsdCents: number; at: Date }) {
    assertAerodromeRewardWalletV1(input.walletAddress);
    assertAerodromeRewardThresholdV1(input.thresholdUsdCents);
    const at = input.at.toISOString();
    const existing = this.alerts.get(input.walletAddress);
    if (!existing) {
      const alert: AerodromeRewardAlertV1 = {
        walletAddress: input.walletAddress, thresholdUsdCents: input.thresholdUsdCents, episode: 0,
        createdAt: at, updatedAt: at, readAt: null, readBlock: null, readUsdCents: null, readError: null,
        told: { base_app: null, telegram: null },
      };
      this.alerts.set(input.walletAddress, alert);
      return { outcome: 'created' as const, alert: structuredClone(alert) };
    }
    if (existing.thresholdUsdCents === input.thresholdUsdCents) {
      return { outcome: 'unchanged' as const, alert: structuredClone(existing) };
    }
    Object.assign(existing, { thresholdUsdCents: input.thresholdUsdCents, episode: existing.episode + 1, updatedAt: at });
    return { outcome: 'moved' as const, alert: structuredClone(existing) };
  }

  async unsubscribe(walletAddress: string): Promise<boolean> {
    assertAerodromeRewardWalletV1(walletAddress);
    return this.alerts.delete(walletAddress);
  }

  async dueForRead(input: { readBefore: Date; retryBefore: Date; limit: number }): Promise<string[]> {
    const due = [...this.alerts.values()].filter((alert) =>
      alert.readAt === null
      || Date.parse(alert.readAt) < input.readBefore.getTime()
      || (alert.readError !== null && Date.parse(alert.readAt) < input.retryBefore.getTime()));
    return due
      .sort((a, b) => (a.readAt === null ? -1 : b.readAt === null ? 1 : Date.parse(a.readAt) - Date.parse(b.readAt))
        || a.walletAddress.localeCompare(b.walletAddress))
      .slice(0, input.limit)
      .map((alert) => alert.walletAddress);
  }

  async recordRead(input: { walletAddress: string; at: Date; block: string | null; usdCents: number | null; error: string | null }) {
    assertReadingV1(input);
    const alert = this.alerts.get(input.walletAddress);
    if (!alert) return;
    Object.assign(alert, {
      episode: nextEpisodeV1(alert, input.usdCents),
      readAt: input.at.toISOString(), readBlock: input.block, readUsdCents: input.usdCents, readError: input.error,
    });
  }

  async reached(input: { freshSince: Date }): Promise<AerodromeRewardAlertV1[]> {
    return [...this.alerts.values()]
      .filter((alert) => alert.readError === null && alert.readUsdCents !== null && alert.readAt !== null
        && alert.readUsdCents >= alert.thresholdUsdCents && Date.parse(alert.readAt) >= input.freshSince.getTime())
      .sort((a, b) => a.walletAddress.localeCompare(b.walletAddress))
      .map((alert) => structuredClone(alert));
  }

  async markTold(input: { walletAddress: string; channel: NotificationChannelV1; episode: number }) {
    assertAerodromeRewardWalletV1(input.walletAddress);
    assertChannelV1(input.channel);
    const alert = this.alerts.get(input.walletAddress);
    if (!alert || input.episode !== alert.episode) return;
    alert.told[input.channel] = input.episode;
  }
}

function alertOfRowV1(row: Record<string, unknown>): AerodromeRewardAlertV1 {
  const at = (value: unknown) => (value === null || value === undefined ? null : new Date(value as string | Date).toISOString());
  const int = (value: unknown) => (value === null || value === undefined ? null : Number(value));
  return {
    walletAddress: String(row.wallet_address),
    thresholdUsdCents: Number(row.threshold_usd_cents),
    episode: Number(row.episode),
    createdAt: at(row.created_at)!,
    updatedAt: at(row.updated_at)!,
    readAt: at(row.read_at),
    readBlock: row.read_block === null || row.read_block === undefined ? null : String(row.read_block),
    readUsdCents: int(row.read_usd_cents),
    readError: row.read_error === null || row.read_error === undefined ? null : String(row.read_error),
    told: { base_app: int(row.told_base_app), telegram: int(row.told_telegram) },
  };
}

/** Every change is one statement, so the notifier's reading and a person
 * moving their amount cannot interleave into an episode neither meant. */
export function createDatabaseAerodromeRewardAlertRepositoryV1(sql: SqlTemplateExecutor): AerodromeRewardAlertRepositoryV1 {
  return {
    async get(walletAddress) {
      assertAerodromeRewardWalletV1(walletAddress);
      const rows = (await sql`
        SELECT * FROM aerodrome_reward_alerts WHERE wallet_address = ${walletAddress}`) as Record<string, unknown>[];
      return rows[0] ? alertOfRowV1(rows[0]) : null;
    },

    async subscribe(input) {
      assertAerodromeRewardWalletV1(input.walletAddress);
      assertAerodromeRewardThresholdV1(input.thresholdUsdCents);
      const at = input.at.toISOString();
      // xmax = 0 on the row an INSERT wrote; anything else is the UPDATE.
      const rows = (await sql`
        INSERT INTO aerodrome_reward_alerts AS a (wallet_address, threshold_usd_cents, episode, created_at, updated_at)
        VALUES (${input.walletAddress}, ${input.thresholdUsdCents}, 0, ${at}::timestamptz, ${at}::timestamptz)
        ON CONFLICT (wallet_address) DO UPDATE
           SET threshold_usd_cents = EXCLUDED.threshold_usd_cents,
               episode = a.episode + 1,
               updated_at = EXCLUDED.updated_at
         WHERE a.threshold_usd_cents <> EXCLUDED.threshold_usd_cents
        RETURNING *, (xmax = 0) AS inserted`) as Record<string, unknown>[];
      if (rows[0]) return { outcome: rows[0].inserted === true ? 'created' : 'moved', alert: alertOfRowV1(rows[0]) };
      const same = (await sql`
        SELECT * FROM aerodrome_reward_alerts WHERE wallet_address = ${input.walletAddress}`) as Record<string, unknown>[];
      if (!same[0]) throw new RouteStorageIntegrityError('the alert vanished while it was being kept');
      return { outcome: 'unchanged', alert: alertOfRowV1(same[0]) };
    },

    async unsubscribe(walletAddress) {
      assertAerodromeRewardWalletV1(walletAddress);
      const rows = (await sql`
        DELETE FROM aerodrome_reward_alerts WHERE wallet_address = ${walletAddress} RETURNING 1`) as Record<string, unknown>[];
      return rows.length > 0;
    },

    async dueForRead(input) {
      const rows = (await sql`
        SELECT wallet_address FROM aerodrome_reward_alerts
         WHERE read_at IS NULL
            OR read_at < ${input.readBefore.toISOString()}::timestamptz
            OR (read_error IS NOT NULL AND read_at < ${input.retryBefore.toISOString()}::timestamptz)
         ORDER BY read_at ASC NULLS FIRST, wallet_address
         LIMIT ${input.limit}`) as Record<string, unknown>[];
      return rows.map((row) => String(row.wallet_address));
    },

    async recordRead(input) {
      assertReadingV1(input);
      await sql`
        UPDATE aerodrome_reward_alerts
           SET episode = episode + CASE
                 WHEN ${input.usdCents}::bigint * 2 < threshold_usd_cents
                  AND (told_base_app = episode OR told_telegram = episode) THEN 1 ELSE 0 END,
               read_at = ${input.at.toISOString()}::timestamptz,
               read_block = ${input.block}::bigint,
               read_usd_cents = ${input.usdCents}::bigint,
               read_error = ${input.error}
         WHERE wallet_address = ${input.walletAddress}`;
    },

    async reached(input) {
      const rows = (await sql`
        SELECT * FROM aerodrome_reward_alerts
         WHERE read_error IS NULL
           AND read_usd_cents >= threshold_usd_cents
           AND read_at >= ${input.freshSince.toISOString()}::timestamptz
         ORDER BY wallet_address`) as Record<string, unknown>[];
      return rows.map(alertOfRowV1);
    },

    async markTold(input) {
      assertAerodromeRewardWalletV1(input.walletAddress);
      assertChannelV1(input.channel);
      // The column is named by the channel, never by the caller's text.
      if (input.channel === 'base_app') {
        await sql`
          UPDATE aerodrome_reward_alerts SET told_base_app = ${input.episode}
           WHERE wallet_address = ${input.walletAddress} AND episode = ${input.episode}`;
      } else {
        await sql`
          UPDATE aerodrome_reward_alerts SET told_telegram = ${input.episode}
           WHERE wallet_address = ${input.walletAddress} AND episode = ${input.episode}`;
      }
    },
  };
}
