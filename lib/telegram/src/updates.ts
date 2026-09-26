// ---------------------------------------------------------------------------
// What a Telegram update asks for.
//
// The bot answers four things, in a private chat only: /start with the
// one-time code the website handed out, /start without one, /stop and
// /status. Everything else in a private chat gets the same short help.
// Groups, channels, edits and button presses are ignored: this bot writes to
// one person about their own wallets, and a group is not one person.
// ---------------------------------------------------------------------------

export type TelegramCommandV1 =
  /** `code` is null for /start alone, and '' for a code that cannot be one
   * we issued — which is answered exactly like an expired one. */
  | { kind: 'start'; chatId: string; code: string | null }
  | { kind: 'stop'; chatId: string }
  | { kind: 'status'; chatId: string }
  | { kind: 'help'; chatId: string }
  | { kind: 'ignored' };

const CHAT_ID_V1 = /^[1-9][0-9]{0,15}$/;
/** Telegram passes the deep-link parameter through as typed: 1–64 of
 * A–Z, a–z, 0–9, `_` and `-`. Anything else is not a code we issued. */
const START_V1 = /^\/start(?:@[A-Za-z0-9_]{5,32})?(?:\s+(\S+))?\s*$/;
const COMMAND_V1 = /^\/(stop|status)(?:@[A-Za-z0-9_]{5,32})?\s*$/;
const CODE_V1 = /^[A-Za-z0-9_-]{1,64}$/;

export function telegramCommandV1(update: unknown): TelegramCommandV1 {
  const message = (update as { message?: unknown } | null)?.message as
    | { chat?: { id?: unknown; type?: unknown }; text?: unknown }
    | undefined;
  if (!message || message.chat?.type !== 'private') return { kind: 'ignored' };
  const rawId = message.chat.id;
  const chatId = typeof rawId === 'number' && Number.isSafeInteger(rawId) ? String(rawId) : null;
  // A private chat's id is the person's positive user id.
  if (!chatId || !CHAT_ID_V1.test(chatId)) return { kind: 'ignored' };
  if (typeof message.text !== 'string') return { kind: 'help', chatId };
  const text = message.text.trim();
  const start = START_V1.exec(text);
  if (start) {
    const code = start[1] ?? null;
    return { kind: 'start', chatId, code: code !== null && CODE_V1.test(code) ? code : code === null ? null : '' };
  }
  const command = COMMAND_V1.exec(text);
  if (command) return { kind: command[1] as 'stop' | 'status', chatId };
  return { kind: 'help', chatId };
}
