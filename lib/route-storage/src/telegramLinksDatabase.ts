import {
  assertTelegramChatIdV1,
  assertTelegramCodeHashV1,
  assertTelegramCodeWindowV1,
  assertTelegramWalletV1,
  type TelegramLinkRepositoryV1,
} from './telegramLinks.js';
import type { SqlTemplateExecutor } from './types.js';

/**
 * Redeeming is one statement: the code is spent and the link written together,
 * so two /start messages racing with one code cannot both succeed, and a code
 * is never spent without its link.
 */
export function createDatabaseTelegramLinkRepositoryV1(sql: SqlTemplateExecutor): TelegramLinkRepositoryV1 {
  return {
    async issueCode(input) {
      assertTelegramCodeHashV1(input.codeHash);
      assertTelegramWalletV1(input.walletAddress);
      assertTelegramCodeWindowV1(input);
      await sql`
        INSERT INTO telegram_link_codes (code_hash, wallet_address, created_at, expires_at)
        VALUES (${input.codeHash}, ${input.walletAddress}, ${input.now.toISOString()}::timestamptz,
                ${input.expiresAt.toISOString()}::timestamptz)`;
    },

    async redeemCode(input) {
      if (!/^[0-9a-f]{64}$/.test(input.codeHash)) return null;
      assertTelegramChatIdV1(input.chatId);
      const now = input.now.toISOString();
      const rows = (await sql`
        WITH spent AS (
          UPDATE telegram_link_codes
             SET used_at = ${now}::timestamptz
           WHERE code_hash = ${input.codeHash}
             AND used_at IS NULL
             AND expires_at > ${now}::timestamptz
          RETURNING wallet_address
        ), linked AS (
          INSERT INTO telegram_links (chat_id, wallet_address, linked_at)
          SELECT ${input.chatId}::bigint, wallet_address, ${now}::timestamptz FROM spent
          ON CONFLICT (chat_id, wallet_address) DO NOTHING
          RETURNING wallet_address
        )
        SELECT spent.wallet_address, EXISTS (SELECT 1 FROM linked) AS linked_now FROM spent`) as Record<
        string,
        unknown
      >[];
      const row = rows[0];
      return row ? { walletAddress: String(row.wallet_address), linkedNow: row.linked_now === true } : null;
    },

    async walletsOfChat(chatId) {
      assertTelegramChatIdV1(chatId);
      const rows = (await sql`
        SELECT wallet_address FROM telegram_links
         WHERE chat_id = ${chatId}::bigint
         ORDER BY linked_at, wallet_address`) as Record<string, unknown>[];
      return rows.map((row) => String(row.wallet_address));
    },

    async linkedWallets() {
      const rows = (await sql`SELECT DISTINCT wallet_address FROM telegram_links`) as Record<string, unknown>[];
      return new Set(rows.map((row) => String(row.wallet_address)));
    },

    async chatsOf(wallets) {
      const chats = new Map<string, string[]>();
      const unique = [...new Set(wallets)];
      unique.forEach(assertTelegramWalletV1);
      if (unique.length === 0) return chats;
      const rows = (await sql`
        SELECT wallet_address, chat_id::text AS chat_id FROM telegram_links
         WHERE wallet_address = ANY(${unique})
         ORDER BY wallet_address, linked_at, chat_id`) as Record<string, unknown>[];
      for (const row of rows) {
        const wallet = String(row.wallet_address);
        chats.set(wallet, [...(chats.get(wallet) ?? []), String(row.chat_id)]);
      }
      return chats;
    },

    async unlinkChat(chatId) {
      assertTelegramChatIdV1(chatId);
      const rows = (await sql`
        DELETE FROM telegram_links WHERE chat_id = ${chatId}::bigint RETURNING 1`) as Record<string, unknown>[];
      return rows.length;
    },

    async unlinkWallet(walletAddress) {
      assertTelegramWalletV1(walletAddress);
      const rows = (await sql`
        DELETE FROM telegram_links WHERE wallet_address = ${walletAddress}
        RETURNING chat_id::text AS chat_id`) as Record<string, unknown>[];
      return rows.map((row) => String(row.chat_id));
    },

    async pruneCodes(input) {
      const rows = (await sql`
        DELETE FROM telegram_link_codes WHERE expires_at < ${input.before.toISOString()}::timestamptz
        RETURNING 1`) as Record<string, unknown>[];
      return rows.length;
    },
  };
}
