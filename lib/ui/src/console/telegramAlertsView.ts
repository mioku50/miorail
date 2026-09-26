// ---------------------------------------------------------------------------
// "Alerts in Telegram" on the Stocks board, for a signed-in reader.
//
// Three states. Not connected: what the bot would send, and a button. A link
// issued: a plain link the reader taps — Telegram is opened by their own tap,
// so no browser and no Base App webview blocks it as a popup — and the panel
// turns to "on" by itself once they press Start. Connected: what arrives, and
// how to stop it.
//
// Nothing here names a chat. The website knows only whether this wallet is
// heard somewhere.
// ---------------------------------------------------------------------------

export interface TelegramAlertsStatusV1 {
  available: boolean;
  linked: boolean;
}

export interface TelegramAlertsViewV1 {
  state: 'connect' | 'open' | 'linked';
  title: string;
  body: string;
  /** Null while a link is waiting to be opened. */
  action: { kind: 'connect' | 'disconnect'; label: string; busy: boolean } | null;
  link: { href: string; label: string } | null;
  error: string | null;
}

const WHAT_ARRIVES_V1 =
  'a dividend paid in shares on a stock you hold, an issuer changing or scheduling a multiplier, ' +
  'a move in the cost of exiting a stock you watch, your Radar alerts, and the week on Base every Friday evening';

const START_URL_V1 = /^https:\/\/t\.me\/([A-Za-z0-9_]{5,32})\?start=[A-Za-z0-9_-]{32}$/;

export function telegramAlertsViewV1(input: {
  status: TelegramAlertsStatusV1 | null | undefined;
  pending: { url: string; expiresAt: string } | null;
  busy: 'connect' | 'disconnect' | null;
  failed: 'connect' | 'disconnect' | null;
  now: Date;
}): TelegramAlertsViewV1 | null {
  if (!input.status?.available) return null;
  const error =
    input.failed === 'connect'
      ? 'Telegram did not answer. Try again in a minute.'
      : input.failed === 'disconnect'
        ? 'Could not disconnect. Try again in a minute.'
        : null;

  if (input.status.linked) {
    return {
      state: 'linked',
      title: 'Telegram alerts are on',
      body: `This wallet is connected to a Telegram chat. It hears ${WHAT_ARRIVES_V1}. /stop in the chat, or Disconnect here, turns it off.`,
      action: { kind: 'disconnect', label: 'Disconnect', busy: input.busy === 'disconnect' },
      link: null,
      error,
    };
  }

  const bot = input.pending ? START_URL_V1.exec(input.pending.url)?.[1] ?? null : null;
  const live = input.pending !== null && bot !== null && Date.parse(input.pending.expiresAt) > input.now.getTime();
  if (live) {
    return {
      state: 'open',
      title: 'Alerts in Telegram',
      body: 'Open the bot and press Start. The link works once, for ten minutes, and connects this wallet only.',
      action: null,
      link: { href: input.pending!.url, label: `Open @${bot} in Telegram` },
      error,
    };
  }

  return {
    state: 'connect',
    title: 'Alerts in Telegram',
    body: `Get what Miorail knows about your stocks in Telegram: ${WHAT_ARRIVES_V1}. The bot never asks you to sign anything.`,
    action: { kind: 'connect', label: 'Connect Telegram', busy: input.busy === 'connect' },
    link: null,
    error,
  };
}
