import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test, { describe } from 'node:test';

import { InMemoryTelegramLinkRepositoryV1 } from '../src/telegramLinksMemory.js';

const ME = '0x4de27ead5a3c9aeb58c7f812178ddde282670d70';
const BASE_APP = '0x8e525bfce1ef40aa8075ef64e45421b5855c8909';
const CHAT = '424242';
const OTHER_CHAT = '777';
const hash = (n: number) => n.toString(16).padStart(64, '0');
const at = (minute: number) => new Date(Date.UTC(2026, 8, 26, 10, minute));

describe('a chat hears about a wallet only through a code its owner asked for', () => {
  test('a code joins the chat to the wallet once, and never again', async () => {
    const links = new InMemoryTelegramLinkRepositoryV1();
    await links.issueCode({ codeHash: hash(1), walletAddress: ME, now: at(0), expiresAt: at(10) });
    assert.deepEqual(await links.redeemCode({ codeHash: hash(1), chatId: CHAT, now: at(1) }), { walletAddress: ME, linkedNow: true });
    assert.equal(await links.redeemCode({ codeHash: hash(1), chatId: OTHER_CHAT, now: at(2) }), null, 'spent');
    assert.deepEqual(await links.walletsOfChat(CHAT), [ME]);
    assert.deepEqual(await links.walletsOfChat(OTHER_CHAT), []);
  });

  test('an expired or unknown code links nothing', async () => {
    const links = new InMemoryTelegramLinkRepositoryV1();
    await links.issueCode({ codeHash: hash(2), walletAddress: ME, now: at(0), expiresAt: at(10) });
    assert.equal(await links.redeemCode({ codeHash: hash(2), chatId: CHAT, now: at(10) }), null, 'expires at the minute, not after');
    assert.equal(await links.redeemCode({ codeHash: hash(3), chatId: CHAT, now: at(1) }), null);
    assert.equal(await links.redeemCode({ codeHash: 'not a hash', chatId: CHAT, now: at(1) }), null);
    assert.deepEqual([...(await links.linkedWallets())], []);
  });

  test('a second code for a wallet the chat already has spends the code and says so', async () => {
    const links = new InMemoryTelegramLinkRepositoryV1();
    await links.issueCode({ codeHash: hash(4), walletAddress: ME, now: at(0), expiresAt: at(10) });
    await links.issueCode({ codeHash: hash(5), walletAddress: ME, now: at(0), expiresAt: at(10) });
    await links.redeemCode({ codeHash: hash(4), chatId: CHAT, now: at(1) });
    assert.deepEqual(await links.redeemCode({ codeHash: hash(5), chatId: CHAT, now: at(2) }), { walletAddress: ME, linkedNow: false });
    assert.deepEqual(await links.walletsOfChat(CHAT), [ME]);
  });

  test('one chat may hear about two wallets, and one wallet may be heard in two chats', async () => {
    const links = new InMemoryTelegramLinkRepositoryV1();
    await links.issueCode({ codeHash: hash(6), walletAddress: ME, now: at(0), expiresAt: at(10) });
    await links.issueCode({ codeHash: hash(7), walletAddress: BASE_APP, now: at(0), expiresAt: at(10) });
    await links.issueCode({ codeHash: hash(8), walletAddress: ME, now: at(0), expiresAt: at(10) });
    await links.redeemCode({ codeHash: hash(6), chatId: CHAT, now: at(1) });
    await links.redeemCode({ codeHash: hash(7), chatId: CHAT, now: at(2) });
    await links.redeemCode({ codeHash: hash(8), chatId: OTHER_CHAT, now: at(3) });
    assert.deepEqual(await links.walletsOfChat(CHAT), [ME, BASE_APP]);
    assert.deepEqual([...(await links.linkedWallets())].sort(), [BASE_APP, ME].sort());
    assert.deepEqual(await links.chatsOf([ME, BASE_APP, '0x1111111111111111111111111111111111111111']), new Map([
      [ME, [CHAT, OTHER_CHAT]],
      [BASE_APP, [CHAT]],
    ]));

    // /stop: the chat leaves everything. Disconnect on the website: the wallet
    // leaves every chat.
    assert.equal(await links.unlinkChat(CHAT), 2);
    assert.deepEqual(await links.walletsOfChat(CHAT), []);
    assert.deepEqual(await links.unlinkWallet(ME), [OTHER_CHAT]);
    assert.deepEqual([...(await links.linkedWallets())], []);
  });

  test('old codes are pruned; the fake refuses what the tables refuse', async () => {
    const links = new InMemoryTelegramLinkRepositoryV1();
    await links.issueCode({ codeHash: hash(9), walletAddress: ME, now: at(0), expiresAt: at(10) });
    assert.equal(await links.pruneCodes({ before: at(11) }), 1);
    await assert.rejects(links.issueCode({ codeHash: hash(10), walletAddress: '0xABC', now: at(0), expiresAt: at(10) }), /wallet/);
    await assert.rejects(links.issueCode({ codeHash: 'x', walletAddress: ME, now: at(0), expiresAt: at(10) }), /SHA-256/);
    await assert.rejects(links.issueCode({ codeHash: hash(11), walletAddress: ME, now: at(10), expiresAt: at(10) }), /expire after/);
    await assert.rejects(links.walletsOfChat('-100123'), /private Telegram chat id/);
  });
});

test('the database spends the code and writes the link in one statement', () => {
  const cwd = process.cwd();
  const source = readFileSync(resolve(cwd, cwd.endsWith('route-storage') ? 'src' : 'lib/route-storage/src', 'telegramLinksDatabase.ts'), 'utf8');
  // Unused, unexpired, then the link from what was spent: two /start messages
  // racing with one code cannot both succeed.
  assert.match(source, /WITH spent AS \(\s*UPDATE telegram_link_codes[\s\S]*used_at IS NULL[\s\S]*expires_at > \$\{now\}::timestamptz[\s\S]*RETURNING wallet_address/);
  assert.match(source, /INSERT INTO telegram_links \(chat_id, wallet_address, linked_at\)\s*SELECT[\s\S]*FROM spent\s*ON CONFLICT \(chat_id, wallet_address\) DO NOTHING/);
});
