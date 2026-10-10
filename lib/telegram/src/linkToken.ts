import { createHash, randomBytes } from 'node:crypto';

// ---------------------------------------------------------------------------
// The one-time code that joins a Telegram chat to a wallet.
//
// The website issues it to a session that already proved the wallet, and it
// travels in a t.me link: `/start <code>`. Only its SHA-256 is stored, so a
// read of the table yields nothing that can be redeemed. It lives ten
// minutes and works once.
// ---------------------------------------------------------------------------

export const TELEGRAM_LINK_TTL_MS_V1 = 10 * 60 * 1000;

const CODE_V1 = /^[A-Za-z0-9_-]{32}$/;
const USERNAME_V1 = /^[A-Za-z0-9_]{5,32}$/;

/** 24 random bytes: 32 url-safe characters, inside Telegram's 64. */
export function newTelegramLinkCodeV1(): { code: string; hash: string } {
  const code = randomBytes(24).toString('base64url');
  return { code, hash: telegramLinkCodeHashV1(code)! };
}

/** Null for anything that cannot be a code we issued. */
export function telegramLinkCodeHashV1(code: string): string | null {
  return CODE_V1.test(code) ? createHash('sha256').update(code).digest('hex') : null;
}

export function telegramStartUrlV1(botUsername: string, code: string): string {
  if (!USERNAME_V1.test(botUsername) || !CODE_V1.test(code)) throw new Error('invalid telegram start link');
  return `https://t.me/${botUsername}?start=${code}`;
}

/**
 * Service alerts use the same kind of code under a prefix the website never
 * issues, so one /start tells the two apart: `ops-` and 32 characters is 36,
 * inside Telegram's 64, and a website code is exactly 32.
 */
export const TELEGRAM_OPS_ALERT_PREFIX_V1 = 'ops-';

/** The inner code of a service-alert /start, or null for anything else. */
export function telegramOpsAlertCodeV1(start: string): string | null {
  if (!start.startsWith(TELEGRAM_OPS_ALERT_PREFIX_V1)) return null;
  const code = start.slice(TELEGRAM_OPS_ALERT_PREFIX_V1.length);
  return CODE_V1.test(code) ? code : null;
}

export function telegramOpsAlertStartUrlV1(botUsername: string, code: string): string {
  if (!USERNAME_V1.test(botUsername) || !CODE_V1.test(code)) throw new Error('invalid telegram start link');
  return `https://t.me/${botUsername}?start=${TELEGRAM_OPS_ALERT_PREFIX_V1}${code}`;
}
