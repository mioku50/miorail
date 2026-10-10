import {
  assertTelegramChatIdV1,
  assertTelegramCodeHashV1,
  assertTelegramCodeWindowV1,
} from './telegramLinks.js';
import { RouteStorageIntegrityError } from './types.js';
import type { SqlTemplateExecutor } from './types.js';

// ---------------------------------------------------------------------------
// Which Telegram chats hear that a Miorail service failed.
//
// Not a wallet's alerts: these are about the deployment itself, so a chat is
// listed only with a one-time code the operator issues on the server
// (`scripts/ops_alert_link.ts`) and brings to the bot in /start. Stored are the
// chat's numeric id and when it subscribed; a code only as its hash, for ten
// minutes, spent once. /stop removes the chat.
// ---------------------------------------------------------------------------

export interface OpsAlertChatRepositoryV1 {
  /** Keeps a code's hash until `expiresAt`. */
  issueCode(input: { codeHash: string; now: Date; expiresAt: Date }): Promise<void>;
  /** Spends the code once and subscribes the chat. Null when the code is
   * unknown, already used or expired; `subscribedNow` is false when the chat
   * was subscribed already. */
  redeemCode(input: { codeHash: string; chatId: string; now: Date }): Promise<{ subscribedNow: boolean } | null>;
  /** Every subscribed chat, oldest first. */
  chats(): Promise<string[]>;
  isSubscribed(chatId: string): Promise<boolean>;
  /** Whether the chat was subscribed. */
  unsubscribe(chatId: string): Promise<boolean>;
  /** Deletes codes that expired before `before`; returns how many went. */
  pruneCodes(input: { before: Date }): Promise<number>;
}

/** The in-memory store: refuses what the tables refuse, and spends a code the
 * way the SQL does — once, and only before it expires. */
export class InMemoryOpsAlertChatRepositoryV1 implements OpsAlertChatRepositoryV1 {
  private readonly codes = new Map<string, { expiresAt: number; usedAt: number | null }>();
  private readonly subscribed = new Map<string, number>();

  async issueCode(input: { codeHash: string; now: Date; expiresAt: Date }): Promise<void> {
    assertTelegramCodeHashV1(input.codeHash);
    assertTelegramCodeWindowV1(input);
    if (this.codes.has(input.codeHash)) throw new RouteStorageIntegrityError('duplicate alert code');
    this.codes.set(input.codeHash, { expiresAt: input.expiresAt.getTime(), usedAt: null });
  }

  async redeemCode(input: { codeHash: string; chatId: string; now: Date }) {
    if (!/^[0-9a-f]{64}$/.test(input.codeHash)) return null;
    assertTelegramChatIdV1(input.chatId);
    const code = this.codes.get(input.codeHash);
    const now = input.now.getTime();
    if (!code || code.usedAt !== null || code.expiresAt <= now) return null;
    code.usedAt = now;
    const subscribedNow = !this.subscribed.has(input.chatId);
    if (subscribedNow) this.subscribed.set(input.chatId, now);
    return { subscribedNow };
  }

  async chats(): Promise<string[]> {
    return [...this.subscribed].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0])).map(([chatId]) => chatId);
  }

  async isSubscribed(chatId: string): Promise<boolean> {
    assertTelegramChatIdV1(chatId);
    return this.subscribed.has(chatId);
  }

  async unsubscribe(chatId: string): Promise<boolean> {
    assertTelegramChatIdV1(chatId);
    return this.subscribed.delete(chatId);
  }

  async pruneCodes(input: { before: Date }): Promise<number> {
    let removed = 0;
    for (const [hash, code] of this.codes) {
      if (code.expiresAt < input.before.getTime()) {
        this.codes.delete(hash);
        removed += 1;
      }
    }
    return removed;
  }
}

/** Redeeming is one statement: the code is spent and the chat subscribed
 * together, so two /start messages racing with one code cannot both win. */
export function createDatabaseOpsAlertChatRepositoryV1(sql: SqlTemplateExecutor): OpsAlertChatRepositoryV1 {
  return {
    async issueCode(input) {
      assertTelegramCodeHashV1(input.codeHash);
      assertTelegramCodeWindowV1(input);
      await sql`
        INSERT INTO ops_alert_codes (code_hash, created_at, expires_at)
        VALUES (${input.codeHash}, ${input.now.toISOString()}::timestamptz, ${input.expiresAt.toISOString()}::timestamptz)`;
    },

    async redeemCode(input) {
      if (!/^[0-9a-f]{64}$/.test(input.codeHash)) return null;
      assertTelegramChatIdV1(input.chatId);
      const now = input.now.toISOString();
      const rows = (await sql`
        WITH spent AS (
          UPDATE ops_alert_codes
             SET used_at = ${now}::timestamptz
           WHERE code_hash = ${input.codeHash}
             AND used_at IS NULL
             AND expires_at > ${now}::timestamptz
          RETURNING code_hash
        ), subscribed AS (
          INSERT INTO ops_alert_chats (chat_id, subscribed_at)
          SELECT ${input.chatId}::bigint, ${now}::timestamptz FROM spent
          ON CONFLICT (chat_id) DO NOTHING
          RETURNING chat_id
        )
        SELECT EXISTS (SELECT 1 FROM subscribed) AS subscribed_now FROM spent`) as Record<string, unknown>[];
      const row = rows[0];
      return row ? { subscribedNow: row.subscribed_now === true } : null;
    },

    async chats() {
      const rows = (await sql`
        SELECT chat_id::text AS chat_id FROM ops_alert_chats ORDER BY subscribed_at, chat_id`) as Record<string, unknown>[];
      return rows.map((row) => String(row.chat_id));
    },

    async isSubscribed(chatId) {
      assertTelegramChatIdV1(chatId);
      const rows = (await sql`
        SELECT 1 FROM ops_alert_chats WHERE chat_id = ${chatId}::bigint`) as Record<string, unknown>[];
      return rows.length > 0;
    },

    async unsubscribe(chatId) {
      assertTelegramChatIdV1(chatId);
      const rows = (await sql`
        DELETE FROM ops_alert_chats WHERE chat_id = ${chatId}::bigint RETURNING 1`) as Record<string, unknown>[];
      return rows.length > 0;
    },

    async pruneCodes(input) {
      const rows = (await sql`
        DELETE FROM ops_alert_codes WHERE expires_at < ${input.before.toISOString()}::timestamptz
        RETURNING 1`) as Record<string, unknown>[];
      return rows.length;
    },
  };
}
