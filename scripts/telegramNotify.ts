/**
 * Telegram as a second place a notice is delivered.
 *
 * The notifier in ./baseAppNotify.ts decides what is said and to which
 * wallets: issuer events to everyone, a dividend in shares to its holders,
 * market transitions to a token's watchers, Radar events to the watch's owner,
 * the weekly summary on Friday evening. It asks its client two things — which
 * wallets can hear, and "say this to these wallets" — and this client answers
 * them for Telegram: the wallets are the ones a chat connected with a code
 * from the website, and a wallet is said something by writing to its chats.
 *
 * One chat is written to once per notice, however many of its wallets the
 * notice is for. A chat that blocked the bot is disconnected on the spot. A
 * refusal that a later pass could get past — Telegram throttling, or not
 * answering — is waited out once, then stops the pass, which advances
 * nothing.
 */
import type { TelegramLinkRepositoryV1 } from '@mioagent/route-storage';
import { TelegramBotErrorV1, telegramNoticeHtmlV1, type TelegramBotClientV1 } from '@mioagent/telegram';

import { BaseAppNotifyErrorV1, type BaseAppNotifyClientV1, type BaseAppNotifySendResultV1 } from './baseAppNotify.js';

/** Longest wait Telegram may ask for before this pass gives up on it. */
const RETRY_AFTER_MAX_MS_V1 = 30_000;

export function createTelegramNotifyClientV1(input: {
  bot: TelegramBotClientV1;
  links: TelegramLinkRepositoryV1;
  /** https://miorail.xyz — the button opens `${origin}${targetPath}`. */
  origin: string;
  sleep?: (ms: number) => Promise<void>;
  /** Between two messages. Telegram allows ~30 a second across chats. */
  gapMs?: number;
}): BaseAppNotifyClientV1 {
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const gapMs = input.gapMs ?? 50;

  async function deliver(message: Parameters<TelegramBotClientV1['sendMessage']>[0]): Promise<void> {
    try {
      await input.bot.sendMessage(message);
    } catch (cause) {
      if (!(cause instanceof TelegramBotErrorV1) || !cause.transient) throw cause;
      const wait = Math.min(RETRY_AFTER_MAX_MS_V1, (cause.retryAfterSec ?? 2) * 1000);
      await sleep(wait);
      await input.bot.sendMessage(message);
    }
  }

  return {
    enabledWallets: () => input.links.linkedWallets(),

    async send(notice): Promise<BaseAppNotifySendResultV1> {
      const result: BaseAppNotifySendResultV1 = { sent: [], failed: { notSaved: 0, disabled: 0, other: 0 } };
      const chatsOf = await input.links.chatsOf(notice.wallets);
      const walletsOfChat = new Map<string, string[]>();
      for (const wallet of notice.wallets) {
        const chats = chatsOf.get(wallet) ?? [];
        // Disconnected between the plan and the send.
        if (chats.length === 0) result.failed.notSaved += 1;
        for (const chat of chats) walletsOfChat.set(chat, [...(walletsOfChat.get(chat) ?? []), wallet]);
      }
      const html = telegramNoticeHtmlV1(notice);
      const button = { text: 'Open in Miorail', url: `${input.origin}${notice.targetPath}` };
      const delivered = new Set<string>();
      let first = true;
      for (const [chatId, wallets] of walletsOfChat) {
        if (!first) await sleep(gapMs);
        first = false;
        try {
          await deliver({ chatId, html, button });
          for (const wallet of wallets) delivered.add(wallet);
        } catch (cause) {
          const error = cause instanceof TelegramBotErrorV1 ? cause : null;
          if (error?.gone) {
            // Blocked, or the account is gone: nothing here will ever arrive.
            await input.links.unlinkChat(chatId);
            result.failed.disabled += 1;
            continue;
          }
          if (error?.failure === 'bad_request') {
            // Our message, refused: the next pass would build the same one.
            result.failed.other += 1;
            continue;
          }
          throw new BaseAppNotifyErrorV1(error?.status ?? null, error?.transient ?? true, error ? error.message : 'telegram_error');
        }
      }
      result.sent = notice.wallets.filter((wallet) => delivered.has(wallet));
      return result;
    },
  };
}
