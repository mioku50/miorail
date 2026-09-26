import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  InMemoryBaseAppNotificationRepositoryV1,
  InMemoryTelegramLinkRepositoryV1,
  type RwaSignalRowV1,
} from '@mioagent/route-storage';
import { TelegramBotErrorV1, type TelegramBotClientV1 } from '@mioagent/telegram';

import { BaseAppNotifyErrorV1, runBaseAppNotifyV1, type NamesOfV1 } from './baseAppNotify.js';
import { createTelegramNotifyClientV1 } from './telegramNotify.js';

// ---------------------------------------------------------------------------
// Telegram hears what Base App hears, through the same notifier: the wallets
// are the ones a chat connected, and one chat is written to once per notice.
// ---------------------------------------------------------------------------

const GOOGL = '0xb2000000000000000000002d0ba3164cc74f58b7';
const ME = '0x4de27ead5a3c9aeb58c7f812178ddde282670d70';
const BASE_APP = '0x8e525bfce1ef40aa8075ef64e45421b5855c8909';
const YOU = '0x1111111111111111111111111111111111111111';
const CHAT_A = '424242';
const CHAT_B = '777';
const OPENED = new Date('2026-10-02T12:00:00.000Z');
const NOW = new Date('2026-10-02T12:30:00.000Z');

const names: NamesOfV1 = (address) =>
  address === GOOGL ? { symbol: 'GOOGL', representation: 'GOOGLc', issuer: 'coinbase' } : null;

async function linksOf(pairs: [string, string][]): Promise<InMemoryTelegramLinkRepositoryV1> {
  const links = new InMemoryTelegramLinkRepositoryV1();
  let n = 0;
  for (const [chatId, wallet] of pairs) {
    n += 1;
    const codeHash = n.toString(16).padStart(64, '0');
    await links.issueCode({ codeHash, walletAddress: wallet, now: OPENED, expiresAt: new Date(OPENED.getTime() + 600_000) });
    await links.redeemCode({ codeHash, chatId, now: OPENED });
  }
  return links;
}

function fakeBot(refuse: (chatId: string, attempt: number) => Error | null = () => null) {
  const sent: { chatId: string; html: string; button?: { text: string; url: string } }[] = [];
  const attempts = new Map<string, number>();
  const bot: TelegramBotClientV1 = {
    getMe: async () => ({ id: 1, username: 'miorailbot' }),
    sendMessage: async (message) => {
      const attempt = (attempts.get(message.chatId) ?? 0) + 1;
      attempts.set(message.chatId, attempt);
      const error = refuse(message.chatId, attempt);
      if (error) throw error;
      sent.push(message);
    },
    setWebhook: async () => {},
    getWebhookInfo: async () => ({ url: '', pendingUpdateCount: 0, lastErrorDate: null }),
  };
  return { bot, sent };
}

const NOTICE = {
  title: 'GOOGL: dividend in shares',
  message: 'Your <GOOGLc> now track 0.038% more GOOGL shares each.',
  targetPath: '/stocks/googl',
};

describe('the Telegram client', () => {
  test('one message per chat, however many of its wallets the notice is for', async () => {
    const links = await linksOf([
      [CHAT_A, ME],
      [CHAT_A, BASE_APP],
      [CHAT_B, YOU],
    ]);
    const { bot, sent } = fakeBot();
    const client = createTelegramNotifyClientV1({ bot, links, origin: 'https://miorail.xyz', sleep: async () => {} });
    assert.deepEqual([...(await client.enabledWallets())].sort(), [BASE_APP, ME, YOU].sort());
    const result = await client.send({ wallets: [ME, BASE_APP, YOU], ...NOTICE });
    assert.deepEqual(sent.map((message) => message.chatId), [CHAT_A, CHAT_B]);
    assert.deepEqual(result, { sent: [ME, BASE_APP, YOU], failed: { notSaved: 0, disabled: 0, other: 0 } });
    assert.equal(sent[0]!.html, '<b>GOOGL: dividend in shares</b>\nYour &lt;GOOGLc&gt; now track 0.038% more GOOGL shares each.');
    assert.deepEqual(sent[0]!.button, { text: 'Open in Miorail', url: 'https://miorail.xyz/stocks/googl' });
  });

  test('a chat that blocked the bot is disconnected, and the others still hear', async () => {
    const links = await linksOf([
      [CHAT_A, ME],
      [CHAT_B, YOU],
    ]);
    const { bot, sent } = fakeBot((chatId) => (chatId === CHAT_A ? new TelegramBotErrorV1('blocked', 403) : null));
    const result = await createTelegramNotifyClientV1({ bot, links, origin: 'https://miorail.xyz', sleep: async () => {} }).send({
      wallets: [ME, YOU],
      ...NOTICE,
    });
    assert.deepEqual(result, { sent: [YOU], failed: { notSaved: 0, disabled: 1, other: 0 } });
    assert.deepEqual(sent.map((message) => message.chatId), [CHAT_B]);
    assert.deepEqual([...(await links.linkedWallets())], [YOU]);
  });

  test("Telegram's throttling is waited out once; a second refusal stops the pass", async () => {
    const links = await linksOf([[CHAT_A, ME]]);
    const waits: number[] = [];
    const sleep = async (ms: number) => {
      waits.push(ms);
    };
    const once = fakeBot((_chat, attempt) => (attempt === 1 ? new TelegramBotErrorV1('rate_limited', 429, 3) : null));
    const result = await createTelegramNotifyClientV1({ bot: once.bot, links, origin: 'https://miorail.xyz', sleep }).send({ wallets: [ME], ...NOTICE });
    assert.deepEqual(result.sent, [ME]);
    assert.deepEqual(waits, [3000]);

    const down = fakeBot(() => new TelegramBotErrorV1('unavailable', 502));
    const error = await createTelegramNotifyClientV1({ bot: down.bot, links, origin: 'https://miorail.xyz', sleep })
      .send({ wallets: [ME], ...NOTICE })
      .then(
        () => null,
        (cause: unknown) => cause,
      );
    assert.ok(error instanceof BaseAppNotifyErrorV1);
    assert.equal(error.transient, true);
    assert.equal(error.message, 'telegram_unavailable_502');
    assert.deepEqual([...(await links.linkedWallets())], [ME], 'a pass that stopped disconnects nobody');
  });
});

describe('the notifier, with Telegram as its channel', () => {
  test('the first pass announces nothing; a dividend then reaches the holder in their own words, once', async () => {
    const repository = new InMemoryBaseAppNotificationRepositoryV1();
    const links = await linksOf([
      [CHAT_A, ME],
      [CHAT_B, YOU],
    ]);
    const { bot, sent } = fakeBot();
    const client = createTelegramNotifyClientV1({ bot, links, origin: 'https://miorail.xyz', sleep: async () => {} });
    const deps = {
      repository,
      client,
      names: async () => names,
      holdings: async () => new Map([[ME, new Set([GOOGL])]]),
      previousMultipliers: async () => () => '1000000000000000000',
    };

    const opened = await runBaseAppNotifyV1({ ...deps, now: () => OPENED });
    assert.equal(opened.outcome, 'opened');

    const dividend: RwaSignalRowV1 = {
      signalId: '9001',
      kind: 'official_asset_multiplier_changed',
      chainId: 8453,
      subjectAddress: GOOGL,
      officialAddress: null,
      occurredAt: '2026-10-02T12:10:00.000Z',
      recordedAt: '2026-10-02T12:11:00.000Z',
      facts: {
        event: 'multiplier_updated',
        multiplierWad: '1000377118676784179',
        payloadState: 'decoded',
        transactionHash: `0x${'ab'.repeat(32)}`,
        blockNumber: '51900000',
      },
    };
    repository.seedSignal(dividend);
    const delivered = await runBaseAppNotifyV1({ ...deps, now: () => NOW });
    assert.equal(delivered.outcome, 'delivered');
    assert.deepEqual(
      sent.map((message) => [message.chatId, message.html.split('\n')[0]]).sort(),
      [
        [CHAT_B, '<b>GOOGL: multiplier changed</b>'],
        [CHAT_A, '<b>GOOGL: dividend in shares</b>'],
      ].sort(),
    );

    const again = await runBaseAppNotifyV1({ ...deps, now: () => new Date(NOW.getTime() + 5 * 60_000) });
    assert.equal(again.outcome, 'idle');
    assert.equal(sent.length, 2);
  });
});

test('the deploy points the webhook here and prints a verdict, never the token', async () => {
  const { readFileSync } = await import('node:fs');
  const path = await import('node:path');
  const cwd = process.cwd();
  const root = cwd.endsWith(`${path.sep}scripts`) ? path.join(cwd, '..') : cwd;
  const read = (file: string) => readFileSync(path.join(root, file), 'utf8');
  const deploy = read('ops/deploy.sh');
  const script = read('scripts/telegram_webhook.ts');
  assert.match(deploy, /as_service_user npx tsx scripts\/telegram_webhook\.ts/);
  assert.doesNotMatch(deploy, /(echo|cut|printf)[^\n]*TELEGRAM_BOT_TOKEN/);
  // The token travels only inside the client; nothing prints it or a URL built from it.
  assert.doesNotMatch(script, /console\.[a-z]+\([^;]*(config\.token|api\.telegram\.org)/);
  assert.match(script, /setWebhook\(\{ url: telegramWebhookUrlV1\(config\), secretToken: config\.webhookSecret \}\)/);
});
