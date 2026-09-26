// ---------------------------------------------------------------------------
// Telegram HTML, and the few sentences the bot says on its own.
//
// Everything interpolated into a message is escaped: a token name is chosen by
// whoever deployed the token, and `<a href=...>` in one would otherwise become
// a link in our voice.
// ---------------------------------------------------------------------------

export function escapeTelegramHtmlV1(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** `0x8e52…8909`: enough to recognise a wallet, not enough to copy it. */
export function shortWalletV1(wallet: string): string {
  return /^0x[0-9a-fA-F]{40}$/.test(wallet) ? `${wallet.slice(0, 6)}…${wallet.slice(-4)}` : 'a wallet';
}

/** A notification: the title in bold, then the sentence. */
export function telegramNoticeHtmlV1(notice: { title: string; message: string }): string {
  return `<b>${escapeTelegramHtmlV1(notice.title)}</b>\n${escapeTelegramHtmlV1(notice.message)}`;
}

const NEVER_SIGN_V1 = 'Miorail never asks you to sign anything here, and never for a recovery phrase.';

export const TELEGRAM_REPLIES_V1 = {
  connected: (wallets: readonly string[]) =>
    `Connected: ${wallets.map(shortWalletV1).join(', ')}.\n\n` +
    'You will get here what Miorail knows about your stocks: a dividend paid in shares on a stock you hold, ' +
    'an issuer changing or scheduling a multiplier, a move in the cost of exiting a stock you watch, your Radar ' +
    'alerts, and the week on Base every Friday evening.\n\n' +
    `${NEVER_SIGN_V1} /stop disconnects.`,
  alreadyConnected: (wallet: string) => `${shortWalletV1(wallet)} is already connected here. /status shows everything connected.`,
  expired:
    'This link has expired or was already used. Open Miorail, sign in with your wallet and press Connect Telegram again: ' +
    'the button brings you back here with a new one-time code.',
  howToConnect:
    'To connect a wallet, open Miorail, sign in with it and press Connect Telegram. ' +
    `The button brings you back here with a one-time code. ${NEVER_SIGN_V1}`,
  stopped: 'Disconnected. Nothing more will be sent here. /start connects again.',
  disconnectedOnWebsite: (wallet: string) =>
    `${shortWalletV1(wallet)} was disconnected on the Miorail website. Nothing more about it will be sent here.`,
  nothingToStop: 'Nothing is connected here.',
  status: (wallets: readonly string[]) =>
    wallets.length === 0
      ? 'Nothing is connected here yet. Open Miorail and press Connect Telegram.'
      : `Connected: ${wallets.map(shortWalletV1).join(', ')}. /stop disconnects.`,
  help: `This bot only sends Miorail alerts. /status shows what is connected, /stop disconnects. ${NEVER_SIGN_V1}`,
  unavailable: 'Something went wrong on our side. Please try again in a minute.',
} as const;
