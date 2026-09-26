import { RouteStorageIntegrityError } from './types.js';

// ---------------------------------------------------------------------------
// Which Telegram chats hear about which wallets.
//
// A link is made one way only: the website hands a session that already proved
// its wallet a one-time code, and the person brings that code to the bot in
// /start. So a chat can only ever be joined to a wallet whose owner asked for
// it. Stored are the chat's numeric id and the wallet — no username, no name,
// nothing Telegram tells us about the person — and a code only as its hash.
//
// The pair (chat, wallet) is the key: one person may connect their web wallet
// and their Base App wallet to one chat, and one wallet may be heard in two
// chats. /stop removes the chat from everything, "Disconnect" on the website
// removes the wallet from every chat.
// ---------------------------------------------------------------------------

export interface TelegramLinkRepositoryV1 {
  /** Keeps a code's hash for this wallet until `expiresAt`. */
  issueCode(input: { codeHash: string; walletAddress: string; now: Date; expiresAt: Date }): Promise<void>;
  /**
   * Uses the code once and joins the chat to its wallet. Null when the code is
   * unknown, already used or expired. `linkedNow` is false when the chat
   * already had that wallet.
   */
  redeemCode(input: {
    codeHash: string;
    chatId: string;
    now: Date;
  }): Promise<{ walletAddress: string; linkedNow: boolean } | null>;
  /** The wallets this chat hears about, oldest link first. */
  walletsOfChat(chatId: string): Promise<string[]>;
  /** Every wallet at least one chat hears about. */
  linkedWallets(): Promise<Set<string>>;
  /** The chats of each of these wallets; a wallet with none is absent. */
  chatsOf(wallets: readonly string[]): Promise<Map<string, string[]>>;
  /** Removes every wallet from this chat; returns how many links went. */
  unlinkChat(chatId: string): Promise<number>;
  /** Removes this wallet from every chat; returns the chats it was in. */
  unlinkWallet(walletAddress: string): Promise<string[]>;
  /** Deletes codes that expired before `before`; returns how many went. */
  pruneCodes(input: { before: Date }): Promise<number>;
}

const WALLET_V1 = /^0x[0-9a-f]{40}$/;
const HASH_V1 = /^[0-9a-f]{64}$/;
/** A private chat's id is the person's user id: positive, and under 2^53. */
const CHAT_V1 = /^[1-9][0-9]{0,15}$/;

export function assertTelegramWalletV1(wallet: string): void {
  if (!WALLET_V1.test(wallet)) throw new RouteStorageIntegrityError('expected a lowercase 20-byte wallet address');
}

export function assertTelegramChatIdV1(chatId: string): void {
  if (!CHAT_V1.test(chatId)) throw new RouteStorageIntegrityError('expected a private Telegram chat id');
}

export function assertTelegramCodeHashV1(hash: string): void {
  if (!HASH_V1.test(hash)) throw new RouteStorageIntegrityError('expected a SHA-256 hex digest');
}

export function assertTelegramCodeWindowV1(input: { now: Date; expiresAt: Date }): void {
  if (!(input.expiresAt.getTime() > input.now.getTime())) {
    throw new RouteStorageIntegrityError('a link code must expire after it is issued');
  }
}
