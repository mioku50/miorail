// ---------------------------------------------------------------------------
// The Bot API, four methods of it.
//
// Every request goes to `https://api.telegram.org/bot<token>/<method>`, so the
// URL itself is the secret. Nothing here logs a request, and a failure carries
// our code for Telegram's answer, never its URL and never its body.
// ---------------------------------------------------------------------------

export type TelegramFailureV1 =
  /** The person blocked the bot or deleted their account: stop writing. */
  | 'blocked'
  /** The chat is gone, or never existed. Also: stop writing. */
  | 'chat_not_found'
  /** Too many requests; `retryAfterSec` says how long Telegram asked for. */
  | 'rate_limited'
  /** Our request was malformed. The next attempt would be the same. */
  | 'bad_request'
  /** The token is wrong or revoked. */
  | 'unauthorized'
  /** No answer, a 5xx, or an answer that is not the Bot API's shape. */
  | 'unavailable';

export class TelegramBotErrorV1 extends Error {
  constructor(
    readonly failure: TelegramFailureV1,
    readonly status: number | null,
    readonly retryAfterSec: number | null = null,
  ) {
    super(`telegram_${failure}${status === null ? '' : `_${status}`}`);
    this.name = 'TelegramBotErrorV1';
  }

  /** Worth trying again on a later pass. */
  get transient(): boolean {
    return this.failure === 'rate_limited' || this.failure === 'unavailable';
  }

  /** The chat will never take a message again: its link should go. */
  get gone(): boolean {
    return this.failure === 'blocked' || this.failure === 'chat_not_found';
  }
}

export interface TelegramWebhookInfoV1 {
  url: string;
  pendingUpdateCount: number;
  /** Seconds since the epoch of the last failed delivery, if any. */
  lastErrorDate: number | null;
}

export interface TelegramBotClientV1 {
  getMe(): Promise<{ id: number; username: string }>;
  sendMessage(input: {
    chatId: string;
    /** Telegram HTML: see `escapeTelegramHtmlV1`. */
    html: string;
    button?: { text: string; url: string };
  }): Promise<void>;
  setWebhook(input: { url: string; secretToken: string }): Promise<void>;
  getWebhookInfo(): Promise<TelegramWebhookInfoV1>;
}

const CHAT_ID_V1 = /^-?[1-9][0-9]{0,19}$/;

/** A private chat's id fits a JavaScript number; anything that does not is
 * sent as the string Telegram also accepts. */
function chatIdValueV1(chatId: string): number | string {
  if (!CHAT_ID_V1.test(chatId)) throw new TelegramBotErrorV1('bad_request', null);
  const numeric = Number(chatId);
  return Number.isSafeInteger(numeric) ? numeric : chatId;
}

function failureOfV1(status: number, description: string): TelegramFailureV1 {
  const text = description.toLowerCase();
  if (status === 403) return 'blocked';
  if (status === 400 && text.includes('chat not found')) return 'chat_not_found';
  if (status === 429) return 'rate_limited';
  if (status === 401 || status === 404) return 'unauthorized';
  if (status >= 500) return 'unavailable';
  return 'bad_request';
}

export function createTelegramBotClientV1(input: {
  token: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): TelegramBotClientV1 {
  const fetchImpl = input.fetchImpl ?? fetch;
  const timeoutMs = input.timeoutMs ?? 10_000;

  async function call(method: string, body: Record<string, unknown>): Promise<unknown> {
    let response: Response;
    try {
      response = await fetchImpl(`https://api.telegram.org/bot${input.token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new TelegramBotErrorV1('unavailable', null);
    }
    let payload: { ok?: unknown; result?: unknown; description?: unknown; parameters?: { retry_after?: unknown } };
    try {
      payload = (await response.json()) as typeof payload;
    } catch {
      throw new TelegramBotErrorV1('unavailable', response.status);
    }
    if (payload.ok === true && response.ok) return payload.result;
    const description = typeof payload.description === 'string' ? payload.description : '';
    const retryAfter = payload.parameters?.retry_after;
    throw new TelegramBotErrorV1(
      failureOfV1(response.status, description),
      response.status,
      typeof retryAfter === 'number' && Number.isFinite(retryAfter) ? retryAfter : null,
    );
  }

  return {
    async getMe() {
      const result = (await call('getMe', {})) as { id?: unknown; username?: unknown } | null;
      if (typeof result?.id !== 'number' || typeof result.username !== 'string' || !/^[A-Za-z0-9_]{5,32}$/.test(result.username)) {
        throw new TelegramBotErrorV1('unavailable', null);
      }
      return { id: result.id, username: result.username };
    },

    async sendMessage(message) {
      await call('sendMessage', {
        chat_id: chatIdValueV1(message.chatId),
        text: message.html,
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        ...(message.button ? { reply_markup: { inline_keyboard: [[{ text: message.button.text, url: message.button.url }]] } } : {}),
      });
    },

    async setWebhook(webhook) {
      await call('setWebhook', {
        url: webhook.url,
        secret_token: webhook.secretToken,
        // Messages only: no inline queries, no group events, nothing this bot
        // has an answer for.
        allowed_updates: ['message'],
        max_connections: 5,
      });
    },

    async getWebhookInfo() {
      const result = (await call('getWebhookInfo', {})) as {
        url?: unknown;
        pending_update_count?: unknown;
        last_error_date?: unknown;
      } | null;
      return {
        url: typeof result?.url === 'string' ? result.url : '',
        pendingUpdateCount: typeof result?.pending_update_count === 'number' ? result.pending_update_count : 0,
        lastErrorDate: typeof result?.last_error_date === 'number' ? result.last_error_date : null,
      };
    },
  };
}
