import {
  assertTelegramChatIdV1,
  assertTelegramCodeHashV1,
  assertTelegramCodeWindowV1,
  assertTelegramWalletV1,
  type TelegramLinkRepositoryV1,
} from './telegramLinks.js';
import { RouteStorageIntegrityError } from './types.js';

/** The in-memory store: refuses what the tables refuse, and spends a code the
 * way the SQL does — once, and only before it expires. */
export class InMemoryTelegramLinkRepositoryV1 implements TelegramLinkRepositoryV1 {
  private readonly codes = new Map<string, { walletAddress: string; expiresAt: number; usedAt: number | null }>();
  private readonly links: { chatId: string; walletAddress: string; linkedAt: number }[] = [];

  async issueCode(input: { codeHash: string; walletAddress: string; now: Date; expiresAt: Date }): Promise<void> {
    assertTelegramCodeHashV1(input.codeHash);
    assertTelegramWalletV1(input.walletAddress);
    assertTelegramCodeWindowV1(input);
    if (this.codes.has(input.codeHash)) throw new RouteStorageIntegrityError('duplicate link code');
    this.codes.set(input.codeHash, { walletAddress: input.walletAddress, expiresAt: input.expiresAt.getTime(), usedAt: null });
  }

  async redeemCode(input: { codeHash: string; chatId: string; now: Date }) {
    if (!/^[0-9a-f]{64}$/.test(input.codeHash)) return null;
    assertTelegramChatIdV1(input.chatId);
    const code = this.codes.get(input.codeHash);
    const now = input.now.getTime();
    if (!code || code.usedAt !== null || code.expiresAt <= now) return null;
    code.usedAt = now;
    const exists = this.links.some((link) => link.chatId === input.chatId && link.walletAddress === code.walletAddress);
    if (!exists) this.links.push({ chatId: input.chatId, walletAddress: code.walletAddress, linkedAt: now });
    return { walletAddress: code.walletAddress, linkedNow: !exists };
  }

  async walletsOfChat(chatId: string): Promise<string[]> {
    assertTelegramChatIdV1(chatId);
    return this.links
      .filter((link) => link.chatId === chatId)
      .sort((a, b) => a.linkedAt - b.linkedAt || a.walletAddress.localeCompare(b.walletAddress))
      .map((link) => link.walletAddress);
  }

  async linkedWallets(): Promise<Set<string>> {
    return new Set(this.links.map((link) => link.walletAddress));
  }

  async chatsOf(wallets: readonly string[]): Promise<Map<string, string[]>> {
    const unique = [...new Set(wallets)];
    unique.forEach(assertTelegramWalletV1);
    const chats = new Map<string, string[]>();
    for (const link of [...this.links].sort((a, b) => a.linkedAt - b.linkedAt || a.chatId.localeCompare(b.chatId))) {
      if (!unique.includes(link.walletAddress)) continue;
      chats.set(link.walletAddress, [...(chats.get(link.walletAddress) ?? []), link.chatId]);
    }
    return chats;
  }

  async unlinkChat(chatId: string): Promise<number> {
    assertTelegramChatIdV1(chatId);
    const before = this.links.length;
    this.remove((link) => link.chatId === chatId);
    return before - this.links.length;
  }

  async unlinkWallet(walletAddress: string): Promise<string[]> {
    assertTelegramWalletV1(walletAddress);
    const chats = this.links.filter((link) => link.walletAddress === walletAddress).map((link) => link.chatId);
    this.remove((link) => link.walletAddress === walletAddress);
    return chats;
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

  private remove(predicate: (link: { chatId: string; walletAddress: string }) => boolean): void {
    for (let index = this.links.length - 1; index >= 0; index -= 1) {
      if (predicate(this.links[index]!)) this.links.splice(index, 1);
    }
  }
}
