import { createHmac } from 'node:crypto';

// ---------------------------------------------------------------------------
// The bot's configuration: one secret, one line in .env.
//
// `TELEGRAM_BOT_TOKEN` is the whole credential. With it anybody can write to
// every person who connected, in Miorail's name, so it is read here and used
// in exactly two places — the Bot API path and the webhook secret derived from
// it — and never logged, returned or put into an error.
//
// The webhook secret is derived rather than configured. Telegram sends it back
// in `X-Telegram-Bot-Api-Secret-Token` on every update, and it is what tells a
// real update from a request somebody else aimed at the public URL. Deriving
// it means the operator adds no second secret, and a token revoked in
// BotFather rotates the secret with it.
// ---------------------------------------------------------------------------

export interface TelegramConfigV1 {
  token: string;
  webhookSecret: string;
  /** Where the bot's buttons point and where the webhook lives. */
  origin: string;
}

/** BotFather's shape: a numeric bot id, a colon, 35 url-safe characters. */
const TOKEN_V1 = /^[0-9]{5,16}:[A-Za-z0-9_-]{30,64}$/;
const ORIGIN_V1 = /^https:\/\/[a-z0-9.-]+$/;

/** Null means: the bot is off. `MIORAIL_TELEGRAM_V1=off` stops it without
 * removing the token. */
export function telegramConfigV1(env: NodeJS.ProcessEnv): TelegramConfigV1 | null {
  if ((env.MIORAIL_TELEGRAM_V1 ?? '').trim().toLowerCase() === 'off') return null;
  const token = (env.TELEGRAM_BOT_TOKEN ?? '')
    .trim()
    .replace(/^"(.*)"$/, '$1')
    .replace(/^'(.*)'$/, '$1');
  if (!TOKEN_V1.test(token)) return null;
  const origin = (env.MIORAIL_TELEGRAM_ORIGIN ?? 'https://miorail.xyz').trim().replace(/\/+$/, '');
  if (!ORIGIN_V1.test(origin)) return null;
  return { token, webhookSecret: telegramWebhookSecretV1(token), origin };
}

/** 43 url-safe characters: inside what Telegram allows for a secret token
 * (1–256 of A–Z, a–z, 0–9, `_` and `-`). */
export function telegramWebhookSecretV1(token: string): string {
  return createHmac('sha256', token).update('miorail-telegram-webhook-v1').digest('base64url');
}

export function telegramWebhookUrlV1(config: Pick<TelegramConfigV1, 'origin'>): string {
  return `${config.origin}/api/telegram/webhook`;
}
