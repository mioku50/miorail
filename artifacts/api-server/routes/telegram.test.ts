import assert from 'node:assert/strict';
import test, { afterEach, beforeEach, describe } from 'node:test';
import express from 'express';
import request from 'supertest';

import { InMemoryTelegramLinkRepositoryV1 } from '@mioagent/route-storage';
import { TelegramBotErrorV1, telegramConfigV1, type TelegramBotClientV1 } from '@mioagent/telegram';

import { resetTelegramBotUsernameV1, telegramLinkRouter, telegramRuntime, telegramWebhookRouter } from './telegram.js';

const TOKEN = '123456789:AAHfake-token_for_tests_only_abcdefgh';
const CONFIG = telegramConfigV1({ TELEGRAM_BOT_TOKEN: TOKEN })!;
const WALLET = '0x8e525bfce1ef40aa8075ef64e45421b5855c8909';
const CHAT = 424242;
const NOW = new Date('2026-09-26T10:00:00.000Z');

function app(user: unknown = { id: `eip155:8453:${WALLET}`, address: WALLET, chainId: 8453 }) {
  const server = express();
  server.use(express.json());
  server.use((req, _res, next) => {
    (req as unknown as { session: unknown }).session = user ? { user } : {};
    next();
  });
  server.use('/telegram', telegramWebhookRouter);
  server.use('/telegram', telegramLinkRouter);
  return server;
}

const original = { ...telegramRuntime };
let links: InMemoryTelegramLinkRepositoryV1;
let sent: { chatId: string; html: string; button?: { text: string; url: string } }[];
let getMeCalls: number;
let bot: TelegramBotClientV1;

beforeEach(() => {
  links = new InMemoryTelegramLinkRepositoryV1();
  sent = [];
  getMeCalls = 0;
  bot = {
    getMe: async () => {
      getMeCalls += 1;
      return { id: 1, username: 'miorailbot' };
    },
    sendMessage: async (message) => {
      sent.push(message);
    },
    setWebhook: async () => {},
    getWebhookInfo: async () => ({ url: '', pendingUpdateCount: 0, lastErrorDate: null }),
  };
  resetTelegramBotUsernameV1();
  Object.assign(telegramRuntime, {
    config: () => CONFIG,
    links: () => links,
    bot: () => bot,
    now: () => NOW,
  });
});

afterEach(() => {
  Object.assign(telegramRuntime, original);
  resetTelegramBotUsernameV1();
});

const update = (text: string, chat: Record<string, unknown> = { id: CHAT, type: 'private' }) => ({
  update_id: 1,
  message: { message_id: 1, chat, from: { id: CHAT, username: 'someone', first_name: 'Some' }, text },
});
const fromTelegram = (body: unknown, secret = CONFIG.webhookSecret) =>
  request(app(null)).post('/telegram/webhook').set('X-Telegram-Bot-Api-Secret-Token', secret).send(body as object);

async function connect(): Promise<string> {
  const response = await request(app()).post('/telegram/link').send({});
  assert.equal(response.status, 201);
  return new URL(response.body.url as string).searchParams.get('start')!;
}

describe('the webhook answers Telegram, and only Telegram', () => {
  test('no bot, no secret or the wrong secret: nothing is read or sent', async () => {
    telegramRuntime.config = () => null;
    assert.equal((await fromTelegram(update('/status'))).status, 404);
    telegramRuntime.config = () => CONFIG;
    assert.equal((await request(app(null)).post('/telegram/webhook').send(update('/status'))).status, 401);
    assert.equal((await fromTelegram(update('/status'), `${CONFIG.webhookSecret.slice(0, -1)}x`)).status, 401);
    assert.equal(sent.length, 0);
  });

  test('a group, a channel or an edit is acknowledged and ignored', async () => {
    const response = await fromTelegram(update('/stop', { id: -100123, type: 'supergroup' }));
    assert.equal(response.status, 200);
    assert.equal(sent.length, 0);
  });
});

describe('connecting a wallet takes a code its owner asked for', () => {
  test('the website hands a signed-in wallet a ten-minute t.me link, and stores only its hash', async () => {
    const response = await request(app()).post('/telegram/link').send({ walletAddress: '0x1111111111111111111111111111111111111111' });
    assert.equal(response.status, 201);
    const url = new URL(response.body.url as string);
    assert.equal(url.origin + url.pathname, 'https://t.me/miorailbot');
    const code = url.searchParams.get('start')!;
    assert.match(code, /^[A-Za-z0-9_-]{32}$/);
    assert.equal(response.body.expiresAt, '2026-09-26T10:10:00.000Z');

    // The code joins the chat to the SESSION's wallet — the body named another
    // wallet and was ignored.
    const start = await fromTelegram(update(`/start ${code}`));
    assert.equal(start.status, 200);
    assert.deepEqual(await links.walletsOfChat(String(CHAT)), [WALLET]);
    assert.match(sent[0]!.html, /^Connected: 0x8e52…8909\./);
    assert.match(sent[0]!.html, /never asks you to sign anything here/);
    assert.deepEqual(sent[0]!.button, { text: 'Open Miorail', url: 'https://miorail.xyz/stocks' });
  });

  test('a code works once; a second /start with it, or one that was never ours, is told it expired', async () => {
    const code = await connect();
    await fromTelegram(update(`/start ${code}`));
    await fromTelegram(update(`/start ${code}`));
    await fromTelegram(update('/start AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'));
    await fromTelegram(update('/start <b>'));
    assert.deepEqual(sent.slice(1).map((message) => message.html.slice(0, 32)), [
      'This link has expired or was alr',
      'This link has expired or was alr',
      'This link has expired or was alr',
    ]);
  });

  test('a code that has lapsed links nothing', async () => {
    const code = await connect();
    telegramRuntime.now = () => new Date(NOW.getTime() + 10 * 60 * 1000);
    await fromTelegram(update(`/start ${code}`));
    assert.deepEqual(await links.walletsOfChat(String(CHAT)), []);
    assert.match(sent[0]!.html, /expired/);
  });

  test('/start alone explains how to connect, with a button to Miorail', async () => {
    await fromTelegram(update('/start'));
    assert.match(sent[0]!.html, /^To connect a wallet, open Miorail/);
    assert.deepEqual(sent[0]!.button, { text: 'Open Miorail', url: 'https://miorail.xyz/stocks' });
  });

  test('/status and /stop', async () => {
    await fromTelegram(update(`/start ${await connect()}`));
    await fromTelegram(update('/status'));
    await fromTelegram(update('/stop'));
    await fromTelegram(update('/stop'));
    await fromTelegram(update('what is NVDA doing'));
    assert.deepEqual(sent.slice(1).map((message) => message.html.split('.')[0]), [
      'Connected: 0x8e52…8909',
      'Disconnected',
      'Nothing is connected here',
      'This bot only sends Miorail alerts',
    ]);
    assert.deepEqual(await links.walletsOfChat(String(CHAT)), []);
  });

  test('a storage failure is our apology in the chat, and still a 200 to Telegram', async () => {
    telegramRuntime.links = () => {
      throw new Error('database down');
    };
    const response = await fromTelegram(update('/status'));
    assert.equal(response.status, 200);
    assert.match(sent[0]!.html, /Something went wrong on our side/);
  });
});

describe('the website reads and ends the connection', () => {
  test('signed out is refused; no bot reads as unavailable', async () => {
    assert.equal((await request(app(null)).get('/telegram/link')).status, 401);
    assert.equal((await request(app(null)).post('/telegram/link')).status, 401);
    telegramRuntime.config = () => null;
    assert.deepEqual((await request(app()).get('/telegram/link')).body, { available: false, linked: false });
    assert.equal((await request(app()).post('/telegram/link')).status, 404);
  });

  test('linked after /start, and not after Disconnect, which tells the chat', async () => {
    assert.deepEqual((await request(app()).get('/telegram/link')).body, { available: true, linked: false });
    await fromTelegram(update(`/start ${await connect()}`));
    assert.deepEqual((await request(app()).get('/telegram/link')).body, { available: true, linked: true });
    const disconnect = await request(app()).delete('/telegram/link');
    assert.deepEqual(disconnect.body, { available: true, linked: false });
    assert.deepEqual((await request(app()).get('/telegram/link')).body, { available: true, linked: false });
    assert.equal(sent.at(-1)!.chatId, String(CHAT));
    assert.match(sent.at(-1)!.html, /^0x8e52…8909 was disconnected on the Miorail website/);
  });

  test("the bot's @username is asked once, and an unreachable bot is a 503", async () => {
    await connect();
    await connect();
    assert.equal(getMeCalls, 1);
    resetTelegramBotUsernameV1();
    bot.getMe = async () => {
      throw new TelegramBotErrorV1('unavailable', 502);
    };
    const response = await request(app()).post('/telegram/link');
    assert.equal(response.status, 503);
    assert.equal(response.body.code, 'telegram_unavailable');
  });
});
