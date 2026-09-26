import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  TELEGRAM_REPLIES_V1,
  TelegramBotErrorV1,
  createTelegramBotClientV1,
  escapeTelegramHtmlV1,
  newTelegramLinkCodeV1,
  telegramCommandV1,
  telegramConfigV1,
  telegramLinkCodeHashV1,
  telegramNoticeHtmlV1,
  telegramStartUrlV1,
  telegramWebhookSecretV1,
  telegramWebhookUrlV1,
} from './index.js';

const TOKEN = '123456789:AAHfake-token_for_tests_only_abcdefgh';

describe('the configuration', () => {
  test('one token turns the bot on, and the webhook secret comes from it', () => {
    const config = telegramConfigV1({ TELEGRAM_BOT_TOKEN: TOKEN });
    assert.ok(config);
    assert.equal(config.origin, 'https://miorail.xyz');
    assert.equal(config.webhookSecret, telegramWebhookSecretV1(TOKEN));
    assert.match(config.webhookSecret, /^[A-Za-z0-9_-]{43}$/);
    assert.notEqual(telegramWebhookSecretV1(`${TOKEN}x`), config.webhookSecret, 'a new token is a new secret');
    assert.ok(!config.webhookSecret.includes(TOKEN.split(':')[1]!));
    assert.equal(telegramWebhookUrlV1(config), 'https://miorail.xyz/api/telegram/webhook');
  });

  test('no token, a malformed one, or the off switch is no bot', () => {
    assert.equal(telegramConfigV1({}), null);
    assert.equal(telegramConfigV1({ TELEGRAM_BOT_TOKEN: '' }), null);
    assert.equal(telegramConfigV1({ TELEGRAM_BOT_TOKEN: 'not a token' }), null);
    assert.equal(telegramConfigV1({ TELEGRAM_BOT_TOKEN: TOKEN, MIORAIL_TELEGRAM_V1: 'off' }), null);
    assert.equal(telegramConfigV1({ TELEGRAM_BOT_TOKEN: TOKEN, MIORAIL_TELEGRAM_ORIGIN: 'http://miorail.xyz' }), null);
    assert.ok(telegramConfigV1({ TELEGRAM_BOT_TOKEN: `"${TOKEN}"` }), 'quotes around the value are tolerated');
  });
});

function fakeFetch(reply: { status: number; body: unknown } | Error) {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> });
    if (reply instanceof Error) throw reply;
    return new Response(JSON.stringify(reply.body), { status: reply.status });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

describe('the Bot API client', () => {
  test('a message is HTML with previews off and one button', async () => {
    const { calls, fetchImpl } = fakeFetch({ status: 200, body: { ok: true, result: { message_id: 1 } } });
    const client = createTelegramBotClientV1({ token: TOKEN, fetchImpl });
    await client.sendMessage({ chatId: '424242', html: '<b>Hi</b>', button: { text: 'Open', url: 'https://miorail.xyz/stocks' } });
    assert.equal(calls[0]?.url, `https://api.telegram.org/bot${TOKEN}/sendMessage`);
    assert.deepEqual(calls[0]?.body, {
      chat_id: 424242,
      text: '<b>Hi</b>',
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      reply_markup: { inline_keyboard: [[{ text: 'Open', url: 'https://miorail.xyz/stocks' }]] },
    });
  });

  test("Telegram's refusals become our codes, and none of them carries the token", async () => {
    const cases: [number, string, string, boolean, boolean][] = [
      [403, 'Forbidden: bot was blocked by the user', 'blocked', false, true],
      [400, 'Bad Request: chat not found', 'chat_not_found', false, true],
      [429, 'Too Many Requests: retry after 7', 'rate_limited', true, false],
      [401, 'Unauthorized', 'unauthorized', false, false],
      [502, 'Bad Gateway', 'unavailable', true, false],
      [400, "Bad Request: can't parse entities", 'bad_request', false, false],
    ];
    for (const [status, description, failure, transient, gone] of cases) {
      const { fetchImpl } = fakeFetch({ status, body: { ok: false, error_code: status, description, parameters: status === 429 ? { retry_after: 7 } : undefined } });
      const client = createTelegramBotClientV1({ token: TOKEN, fetchImpl });
      const error = await client.sendMessage({ chatId: '1', html: 'x' }).then(
        () => null,
        (cause: unknown) => cause,
      );
      assert.ok(error instanceof TelegramBotErrorV1, description);
      assert.equal(error.failure, failure);
      assert.equal(error.transient, transient);
      assert.equal(error.gone, gone);
      assert.equal(error.retryAfterSec, status === 429 ? 7 : null);
      assert.ok(!error.message.includes(TOKEN) && !error.message.includes(description), error.message);
    }
  });

  test('no answer at all is unavailable, and still says nothing about the URL', async () => {
    const { fetchImpl } = fakeFetch(new Error(`connect ECONNREFUSED https://api.telegram.org/bot${TOKEN}/getMe`));
    const error = await createTelegramBotClientV1({ token: TOKEN, fetchImpl })
      .getMe()
      .then(
        () => null,
        (cause: unknown) => cause as TelegramBotErrorV1,
      );
    assert.equal(error?.failure, 'unavailable');
    assert.ok(!String(error?.message).includes(TOKEN));
  });

  test('the webhook takes messages only, with our secret', async () => {
    const { calls, fetchImpl } = fakeFetch({ status: 200, body: { ok: true, result: true } });
    await createTelegramBotClientV1({ token: TOKEN, fetchImpl }).setWebhook({ url: 'https://miorail.xyz/api/telegram/webhook', secretToken: 's3cret' });
    assert.deepEqual(calls[0]?.body, {
      url: 'https://miorail.xyz/api/telegram/webhook',
      secret_token: 's3cret',
      allowed_updates: ['message'],
      max_connections: 5,
    });
  });

  test('a chat id that is not a number is refused before anything is sent', async () => {
    const { calls, fetchImpl } = fakeFetch({ status: 200, body: { ok: true, result: {} } });
    await assert.rejects(createTelegramBotClientV1({ token: TOKEN, fetchImpl }).sendMessage({ chatId: '@everyone', html: 'x' }), TelegramBotErrorV1);
    assert.equal(calls.length, 0);
  });
});

describe('what an update asks for', () => {
  const update = (text: unknown, chat: Record<string, unknown> = { id: 424242, type: 'private' }) => ({
    update_id: 1,
    message: { message_id: 2, chat, text },
  });

  test('the four commands, in a private chat', () => {
    const code = 'A'.repeat(32);
    assert.deepEqual(telegramCommandV1(update(`/start ${code}`)), { kind: 'start', chatId: '424242', code });
    assert.deepEqual(telegramCommandV1(update('/start')), { kind: 'start', chatId: '424242', code: null });
    assert.deepEqual(telegramCommandV1(update('/start@miorailbot')), { kind: 'start', chatId: '424242', code: null });
    assert.deepEqual(telegramCommandV1(update('/stop')), { kind: 'stop', chatId: '424242' });
    assert.deepEqual(telegramCommandV1(update('/status')), { kind: 'status', chatId: '424242' });
    assert.deepEqual(telegramCommandV1(update('hello')), { kind: 'help', chatId: '424242' });
    assert.deepEqual(telegramCommandV1(update(undefined)), { kind: 'help', chatId: '424242' });
  });

  test('a code that cannot be ours is answered like an expired one', () => {
    assert.deepEqual(telegramCommandV1(update('/start <script>')), { kind: 'start', chatId: '424242', code: '' });
  });

  test('groups, channels and anything that is not a message are ignored', () => {
    assert.deepEqual(telegramCommandV1(update('/stop', { id: -100123, type: 'supergroup' })), { kind: 'ignored' });
    assert.deepEqual(telegramCommandV1(update('/stop', { id: '424242', type: 'private' })), { kind: 'ignored' });
    assert.deepEqual(telegramCommandV1({ update_id: 1, edited_message: { chat: { id: 1, type: 'private' }, text: '/stop' } }), { kind: 'ignored' });
    assert.deepEqual(telegramCommandV1(null), { kind: 'ignored' });
  });
});

describe('what the bot writes', () => {
  test('a token name cannot become markup', () => {
    assert.equal(escapeTelegramHtmlV1('<a href="x">NVDA</a> & co'), '&lt;a href=&quot;x&quot;&gt;NVDA&lt;/a&gt; &amp; co');
    assert.equal(
      telegramNoticeHtmlV1({ title: 'GOOGL: dividend in shares', message: 'Your <GOOGLc> now track 0.038% more.' }),
      '<b>GOOGL: dividend in shares</b>\nYour &lt;GOOGLc&gt; now track 0.038% more.',
    );
  });

  test('every reply says the bot never asks for a signature or a recovery phrase where it matters', () => {
    for (const text of [TELEGRAM_REPLIES_V1.connected(['0x8e525bfce1ef40aa8075ef64e45421b5855c8909']), TELEGRAM_REPLIES_V1.howToConnect, TELEGRAM_REPLIES_V1.help]) {
      assert.match(text, /never asks you to sign anything here, and never for a recovery phrase/);
    }
    assert.match(TELEGRAM_REPLIES_V1.connected(['0x8e525bfce1ef40aa8075ef64e45421b5855c8909']), /^Connected: 0x8e52…8909\./);
  });
});

describe('the one-time code', () => {
  test('32 url-safe characters, stored only as a hash, in a t.me link', () => {
    const { code, hash } = newTelegramLinkCodeV1();
    assert.match(code, /^[A-Za-z0-9_-]{32}$/);
    assert.match(hash, /^[0-9a-f]{64}$/);
    assert.equal(telegramLinkCodeHashV1(code), hash);
    assert.notEqual(newTelegramLinkCodeV1().code, code);
    assert.equal(telegramStartUrlV1('miorailbot', code), `https://t.me/miorailbot?start=${code}`);
  });

  test('anything else hashes to nothing', () => {
    assert.equal(telegramLinkCodeHashV1(''), null);
    assert.equal(telegramLinkCodeHashV1('short'), null);
    assert.equal(telegramLinkCodeHashV1(`${'A'.repeat(31)}!`), null);
    assert.throws(() => telegramStartUrlV1('bad name!', 'A'.repeat(32)));
  });
});
