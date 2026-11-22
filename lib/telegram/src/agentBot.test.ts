import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test, { describe } from 'node:test';

import {
  STILL_AGENT_REPLIES_V1,
  createTelegramBotClientV1,
  openStillAgentBotTokenV1,
  sealStillAgentBotTokenV1,
  stillAgentBotConfigV1,
  stillAgentNewBotUrlV1,
  stillAgentOwnBotWebhookV1,
  stillAgentUpdateShapeV1,
  stillAgentUpdateV1,
  stillAgentWebhookUrlV1,
} from './index.js';

const TOKEN = '123456789:AAHfake-token_for_tests_only_abcdefgh';
const OWN = '987654321:AAOwn-bot-token_for_tests_only_zyxwvu';
const KEY = Buffer.alloc(32, 7);

describe('the agents bot', () => {
  test('is its own token, its own webhook and its own secret, apart from the alerts bot', () => {
    assert.equal(stillAgentBotConfigV1({}), null);
    assert.equal(stillAgentBotConfigV1({ TELEGRAM_BOT_TOKEN: TOKEN }), null, 'the alerts bot token does not turn it on');
    const config = stillAgentBotConfigV1({ STILL_AGENT_BOT_TOKEN: TOKEN });
    assert.ok(config);
    assert.equal(config.key, null, 'no key, no personal bots');
    assert.match(config.webhookSecret, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(stillAgentWebhookUrlV1(config), 'https://miorail.xyz/api/telegram/agent/webhook');
    const keyed = stillAgentBotConfigV1({ STILL_AGENT_BOT_TOKEN: TOKEN, STILL_AGENT_BOT_KEY: KEY.toString('base64') });
    assert.deepEqual(keyed?.key, KEY);
    assert.equal(stillAgentBotConfigV1({ STILL_AGENT_BOT_TOKEN: TOKEN, STILL_AGENT_BOT_KEY: 'short' })?.key, null);
  });

  test('seals a personal bot token so only the key opens it, and nothing else passes for one', () => {
    const sealed = sealStillAgentBotTokenV1(KEY, OWN);
    assert.match(sealed, /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    assert.ok(!sealed.includes(OWN.split(':')[1]!));
    assert.notEqual(sealStillAgentBotTokenV1(KEY, OWN), sealed, 'a fresh nonce each time');
    assert.equal(openStillAgentBotTokenV1(KEY, sealed), OWN);
    assert.equal(openStillAgentBotTokenV1(randomBytes(32), sealed), null);
    const [v, iv, body, tag] = sealed.split('.');
    assert.equal(openStillAgentBotTokenV1(KEY, [v, iv, body!.replace(/^./, (c) => (c === 'A' ? 'B' : 'A')), tag].join('.')), null);
    assert.equal(openStillAgentBotTokenV1(KEY, 'v2.a.b.c'), null);
  });

  test('gives each personal bot its own webhook path and secret', () => {
    const config = { origin: 'https://miorail.xyz', key: KEY };
    const hook = stillAgentOwnBotWebhookV1(config, '5001');
    assert.equal(hook?.url, 'https://miorail.xyz/api/telegram/agent/bot/5001');
    assert.match(hook!.secretToken, /^[A-Za-z0-9_-]{43}$/);
    assert.notEqual(stillAgentOwnBotWebhookV1(config, '5002')?.secretToken, hook!.secretToken);
    assert.equal(stillAgentOwnBotWebhookV1({ origin: 'https://miorail.xyz', key: null }, '5001'), null);
    assert.equal(stillAgentOwnBotWebhookV1(config, '../x'), null);
  });

  test('asks Telegram for a bot with the agent’s names filled in, in Telegram’s own username rules', () => {
    assert.equal(stillAgentNewBotUrlV1({ managerUsername: 'StillAgentsBot', agentName: 'Pip' }),
      'https://t.me/newbot/StillAgentsBot/Pip_still_bot?name=Pip%20%C2%B7%20Still%20Agent');
    assert.match(stillAgentNewBotUrlV1({ managerUsername: 'StillAgentsBot', agentName: 'Мистер Пип' }), /\/My_still_bot\?name=/);
    assert.match(stillAgentNewBotUrlV1({ managerUsername: 'StillAgentsBot', agentName: "O'Neil 2" }), /\/O_Neil_2_still_bot\?/);
    assert.match(stillAgentNewBotUrlV1({ managerUsername: 'StillAgentsBot', agentName: '7 Seas' }), /\/A7_Seas_still_bot\?/);
    assert.throws(() => stillAgentNewBotUrlV1({ managerUsername: 'x/y', agentName: 'Pip' }));
  });

  test('reads commands in a private chat, and a managed bot made for a user', () => {
    const message = (text: unknown, type = 'private', id: unknown = 777) => ({ message: { chat: { id, type }, text } });
    assert.deepEqual(stillAgentUpdateV1(message('/start abcDEF_123-x')), { kind: 'start', chatId: '777', code: 'abcDEF_123-x' });
    assert.deepEqual(stillAgentUpdateV1(message('/start')), { kind: 'start', chatId: '777', code: null });
    assert.deepEqual(stillAgentUpdateV1(message('/start <b>')), { kind: 'start', chatId: '777', code: '' });
    assert.deepEqual(stillAgentUpdateV1(message('/stop')), { kind: 'stop', chatId: '777' });
    assert.deepEqual(stillAgentUpdateV1(message('/status@StillAgentsBot')), { kind: 'status', chatId: '777' });
    assert.deepEqual(stillAgentUpdateV1(message('find me netflix')), { kind: 'help', chatId: '777' });
    assert.deepEqual(stillAgentUpdateV1(message('/start x', 'group')), { kind: 'ignored' });
    assert.deepEqual(stillAgentUpdateV1(message('/start x', 'private', -5)), { kind: 'ignored' });
    const made = { managed_bot: { user: { id: 777, first_name: 'M' }, bot: { id: 5001, is_bot: true, username: 'Pip_still_bot' } } };
    assert.deepEqual(stillAgentUpdateV1(made), { kind: 'managed_bot', creatorId: '777', botId: '5001', botUsername: 'Pip_still_bot' });
    assert.deepEqual(stillAgentUpdateV1({ managed_bot: { user: { id: 777 }, bot: { id: 5001 } } }), { kind: 'ignored' });
    assert.deepEqual(stillAgentUpdateShapeV1(made), ['bot', 'user']);
    assert.deepEqual(stillAgentUpdateShapeV1(message('/stop')), []);
  });

  test('never names a price or a payment, and always says it never asks to sign', () => {
    const words = [
      STILL_AGENT_REPLIES_V1.connected(['Pip'], false), STILL_AGENT_REPLIES_V1.connected(['Pip'], true), STILL_AGENT_REPLIES_V1.howToConnect,
      STILL_AGENT_REPLIES_V1.help, STILL_AGENT_REPLIES_V1.ownBotHello('Pip', false), STILL_AGENT_REPLIES_V1.ownBotHello('Pip', true),
      STILL_AGENT_REPLIES_V1.ownBotHelp('Pip', false), STILL_AGENT_REPLIES_V1.ownBotReady('Pip_still_bot', false),
    ];
    for (const text of words) assert.doesNotMatch(text, /USDC|\$|price of|pass|subscribe|buy|оплат|пасс/i, text);
    assert.match(STILL_AGENT_REPLIES_V1.connected(['<Pip>'], false), /&lt;Pip&gt;/);
  });
});

describe('the Bot API client, for managed bots', () => {
  test('asks for a managed bot’s token by its user id, and refuses anything that is not a token', async () => {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    let result: unknown = OWN;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> });
      return new Response(JSON.stringify({ ok: true, result }), { status: 200 });
    }) as unknown as typeof fetch;
    const client = createTelegramBotClientV1({ token: TOKEN, fetchImpl });
    assert.equal(await client.getManagedBotToken('5001'), OWN);
    assert.deepEqual(calls[0], { url: `https://api.telegram.org/bot${TOKEN}/getManagedBotToken`, body: { user_id: 5001 } });
    result = 'nope';
    await assert.rejects(client.getManagedBotToken('5001'), /telegram_unavailable/);
    await assert.rejects(client.getManagedBotToken('x'), /telegram_bad_request/);
    await client.setWebhook({ url: 'https://miorail.xyz/api/telegram/agent/webhook', secretToken: 's', allowedUpdates: ['message', 'managed_bot'] });
    assert.deepEqual(calls.at(-1)?.body.allowed_updates, ['message', 'managed_bot']);
    await client.deleteWebhook();
    assert.deepEqual(calls.at(-1), { url: `https://api.telegram.org/bot${TOKEN}/deleteWebhook`, body: { drop_pending_updates: true } });
  });
});
