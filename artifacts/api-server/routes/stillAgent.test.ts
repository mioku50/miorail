import assert from 'node:assert/strict';
import test, { afterEach, beforeEach, describe } from 'node:test';
import express from 'express';
import request from 'supertest';

import type { SpendProductV1 } from '@mioagent/commerce-engine';
import { InMemoryRateLimiter } from '@mioagent/utils';
import { createMemoryStillAgentRepositoryV1, type StillAgentRepositoryV1 } from '@mioagent/route-storage';
import { openStillAgentBotTokenV1, stillAgentBotConfigV1, stillAgentOwnBotWebhookV1, type TelegramBotClientV1 } from '@mioagent/telegram';

import { SpendReadFailedV1 } from './stillPublic.js';
import { resetStillAgentBotUsernameV1, stillAgentRouter, stillAgentRuntimeV1, stillAgentTelegramRouter } from './stillAgent.js';

const MANAGER = '123456789:AAHfake-manager-token_for_tests_abcdef';
const OWN = '987654321:AAOwn-bot-token_for_tests_only_zyxwvu';
const KEY = Buffer.alloc(32, 9).toString('base64');
const CONFIG = stillAgentBotConfigV1({ STILL_AGENT_BOT_TOKEN: MANAGER, STILL_AGENT_BOT_KEY: KEY })!;
const WALLET = `0x${'ab'.repeat(20)}`;
const OTHER = `0x${'cd'.repeat(20)}`;
const CHAT = 777001;
const NOW = new Date('2026-11-22T10:00:00.000Z');
const ERRAND_ID = '11111111-2222-4333-8444-555555555555';

const NETFLIX: SpendProductV1 = {
  id: 'netflix-eu', name: 'Netflix EU', country: 'IE', inStock: true, recipientType: 'none', url: null,
  packages: [{ value: '15', faceCurrency: 'EUR', priceUsdc: '16.52' }, { value: '250', faceCurrency: 'EUR', priceUsdc: '275.40' }],
};

function app(wallet: string | null = WALLET) {
  const server = express();
  server.use(express.json());
  server.use((req, _res, next) => {
    (req as unknown as { session: unknown }).session = wallet ? { user: { id: `eip155:8453:${wallet}`, address: wallet, chainId: 8453 } } : {};
    next();
  });
  server.use('/telegram', stillAgentTelegramRouter);
  server.use('/still/agent', stillAgentRouter);
  return server;
}

interface SentV1 { token: string; chatId: string; html: string; button?: { text: string; url: string } }

const original = { ...stillAgentRuntimeV1 };
let repository: StillAgentRepositoryV1;
let sent: SentV1[];
let hooks: { token: string; url: string; secretToken: string; allowedUpdates?: readonly string[] }[];
let gate: { ok: true } | { ok: false; refusal: 'region_restricted'; detail: string };
let enabled: boolean;
let config: typeof CONFIG | null;
let ids: number;

function fakeBot(token: string): TelegramBotClientV1 {
  return {
    getMe: async () => ({ id: Number(token.split(':')[0]), username: token === MANAGER ? 'StillAgentsBot' : 'Pip_still_bot' }),
    sendMessage: async (message) => {
      sent.push({ token, ...message });
    },
    setWebhook: async (hook) => {
      hooks.push({ token, ...hook });
    },
    deleteWebhook: async () => {
      hooks.push({ token, url: '', secretToken: '' });
    },
    getWebhookInfo: async () => ({ url: '', pendingUpdateCount: 0, lastErrorDate: null }),
    getManagedBotToken: async (botId) => {
      assert.equal(token, MANAGER, 'only the agents bot asks for a managed token');
      assert.equal(botId, '987654321');
      return OWN;
    },
  };
}

beforeEach(() => {
  repository = createMemoryStillAgentRepositoryV1();
  sent = [];
  hooks = [];
  gate = { ok: true };
  enabled = true;
  config = CONFIG;
  ids = 0;
  resetStillAgentBotUsernameV1();
  Object.assign(stillAgentRuntimeV1, {
    enabled: () => enabled,
    passOffered: () => false,
    repository: () => repository,
    product: async (id: string) => {
      if (id === 'netflix-eu') return { outcome: 'product' as const, product: NETFLIX, readAt: NOW.toISOString() };
      if (id === 'down') throw new SpendReadFailedV1('bitrefill_unreachable');
      throw new SpendReadFailedV1('bitrefill_product_not_found');
    },
    entryGate: async () => gate,
    botConfig: () => config,
    bot: fakeBot,
    now: () => NOW,
    newId: () => (ids += 1) === 1 ? ERRAND_ID : `11111111-2222-4333-8444-${String(ids).padStart(12, '0')}`,
    writeLimiter: new InMemoryRateLimiter({ windowMs: 60_000, max: 1000 }),
    linkLimiter: new InMemoryRateLimiter({ windowMs: 60_000, max: 1000 }),
  });
});

afterEach(() => {
  Object.assign(stillAgentRuntimeV1, original);
  resetStillAgentBotUsernameV1();
});

const makeAgent = (wallet = WALLET) =>
  request(app(wallet)).put('/still/agent').send({ name: 'Pip', avatar: 'pip', language: 'en', timeZone: 'Europe/Sofia' });
const addErrand = (body: Record<string, unknown> = {}) => request(app()).post('/still/agent/errands').send({
  kind: 'subscription', schedule: { every: 'month', day: 1 }, country: 'IE', productId: 'netflix-eu', packageValue: '15', funding: { kind: 'usdc' }, ...body,
});
const managerUpdate = (body: unknown, secret = CONFIG.webhookSecret) =>
  request(app(null)).post('/telegram/agent/webhook').set('X-Telegram-Bot-Api-Secret-Token', secret).send(body as object);
const message = (text: string, chat = CHAT) => ({ update_id: 1, message: { message_id: 1, chat: { id: chat, type: 'private' }, from: { id: chat }, text } });

describe('Still Agent is closed until its switch is on', () => {
  test('every route and webhook answers as if it were not there', async () => {
    enabled = false;
    assert.equal((await request(app()).get('/still/agent')).body.code, 'agent_off');
    assert.equal((await makeAgent()).status, 404);
    assert.equal((await managerUpdate(message('/start'))).status, 404);
    assert.equal(sent.length, 0);
  });

  test('only the session’s own wallet, never one a request names', async () => {
    assert.equal((await request(app(null)).get('/still/agent')).status, 401);
    await makeAgent(OTHER);
    const page = await request(app()).get('/still/agent');
    assert.equal(page.body.agent, null, 'another wallet’s agent is not this one');
  });
});

describe('the agent and its errands', () => {
  test('a named agent is numbered once; a bad name, avatar, language or zone is refused', async () => {
    const empty = await request(app()).get('/still/agent');
    assert.deepEqual(empty.body, {
      outcome: 'agent', agent: null, errands: [], limit: { active: 0, max: 1 },
      telegram: { available: true, linked: false, ownBotAvailable: true, ownBot: null },
      pass: { offered: false, active: null, introUsed: false },
    });
    assert.equal(empty.headers['cache-control'], 'private, no-store');
    for (const bad of [{ name: '<b>' }, { avatar: 'dragon' }, { language: 'de' }, { timeZone: 'Mars/Base' }]) {
      const response = await request(app()).put('/still/agent').send({ name: 'Pip', avatar: 'pip', language: 'en', timeZone: 'Europe/Sofia', ...bad });
      assert.equal(response.status, 400, JSON.stringify(bad));
    }
    const made = await makeAgent();
    assert.equal(made.status, 200);
    assert.deepEqual(made.body.agent, { agentNo: 1, name: 'Pip', avatar: 'pip', language: 'en', timeZone: 'Europe/Sofia' });
    const renamed = await request(app()).put('/still/agent').send({ name: 'Пип', avatar: 'star', language: 'ru', timeZone: 'Europe/Dublin' });
    assert.equal(renamed.body.agent.agentNo, 1);
    assert.equal(renamed.body.agent.name, 'Пип');
  });

  test('an errand is a card Still can pay, due at 09:00 where the agent is, one for free', async () => {
    assert.equal((await addErrand()).body.code, 'agent_required');
    await makeAgent();
    const added = await addErrand();
    assert.equal(added.status, 201);
    assert.deepEqual(added.body.errands, [{
      errandId: ERRAND_ID, kind: 'subscription', schedule: { every: 'month', day: 1 }, timeZone: 'Europe/Sofia', country: 'IE',
      productId: 'netflix-eu', productName: 'Netflix EU', packageValue: '15', packageLabel: '15 EUR', funding: { kind: 'usdc' }, recipient: null,
      // 09:00 in Sofia is 07:00 UTC in December.
      nextDueAt: '2026-12-01T07:00:00.000Z', ready: null, paused: false,
    }]);
    assert.deepEqual(added.body.limit, { active: 1, max: 1 });
    assert.equal((await addErrand()).body.code, 'errand_limit');
    // Removed by its owner, it frees the slot.
    assert.equal((await request(app()).delete(`/still/agent/errands/${ERRAND_ID}`)).status, 200);
    assert.equal((await request(app()).delete(`/still/agent/errands/${ERRAND_ID}`)).status, 404);
    assert.equal((await request(app()).delete('/still/agent/errands/not-an-id')).status, 404);
    assert.equal((await addErrand({ kind: 'gift', schedule: { every: 'year', month: 3, day: 14 }, recipient: 'Маша', funding: { kind: 'loan', collateral: 'AAPLc' } })).status, 201);
  });

  test('refuses what the day could not pay: a bad shape, a card over the cap, an unknown product, the region', async () => {
    await makeAgent();
    for (const bad of [
      { kind: 'gift' }, // a gift comes on a date, not monthly
      { schedule: { every: 'month', day: 31 } },
      { funding: { kind: 'loan', collateral: 'DOGE' } },
      { funding: { kind: 'usdc', collateral: 'AAPLc' } },
      { recipient: 'Маша' }, // a subscription is for oneself
      { country: 'ie' },
      { productId: '../x' },
    ]) {
      assert.equal((await addErrand(bad)).body.code, 'errand_invalid', JSON.stringify(bad));
    }
    assert.equal((await addErrand({ packageValue: '250' })).body.code, 'errand_package_over_cap');
    assert.equal((await addErrand({ packageValue: '16' })).body.code, 'errand_package_unknown');
    assert.equal((await addErrand({ productId: 'gone' })).status, 404);
    assert.equal((await addErrand({ productId: 'down' })).status, 503);
    gate = { ok: false, refusal: 'region_restricted', detail: 'Not offered in the United States.' };
    const refused = await addErrand();
    assert.equal(refused.status, 403);
    assert.equal(refused.body.code, 'region_restricted');
    assert.deepEqual((await request(app()).get('/still/agent')).body.errands, []);
  });
});

describe('a person’s pace', () => {
  test('writes past thirty a minute are refused, per wallet', async () => {
    stillAgentRuntimeV1.writeLimiter = new InMemoryRateLimiter({ windowMs: 60_000, max: 2 });
    assert.equal((await makeAgent()).status, 200);
    assert.equal((await makeAgent()).status, 200);
    assert.equal((await makeAgent()).body.code, 'agent_rate_limited');
    assert.equal((await makeAgent(OTHER)).status, 200, 'another wallet has its own count');
  });
});

describe('Telegram: the agents bot and a bot of one’s own', () => {
  test('a one-time code joins a chat; /status names the agent; /stop lets it go', async () => {
    assert.equal((await request(app()).post('/still/agent/telegram')).body.code, 'agent_required');
    await makeAgent();
    const link = await request(app()).post('/still/agent/telegram');
    assert.equal(link.status, 201);
    const url = new URL(link.body.url as string);
    assert.equal(url.origin + url.pathname, 'https://t.me/StillAgentsBot');
    const code = url.searchParams.get('start')!;
    assert.equal((await managerUpdate(message(`/start ${code}`), 'wrong')).status, 401);
    assert.equal((await managerUpdate(message(`/start ${code}`))).status, 200);
    assert.match(sent.at(-1)!.html, /^Done: Pip will write here on the days of your errands\./);
    assert.equal(sent.at(-1)!.token, MANAGER);
    assert.equal((await request(app()).get('/still/agent')).body.telegram.linked, true);
    await managerUpdate(message(`/start ${code}`));
    assert.match(sent.at(-1)!.html, /expired or was already used/);
    await managerUpdate(message('/status'));
    assert.equal(sent.at(-1)!.html, 'Connected: Pip. /stop disconnects.');
    await managerUpdate(message('/stop'));
    assert.match(sent.at(-1)!.html, /^Disconnected\./);
    assert.equal((await request(app()).get('/still/agent')).body.telegram.linked, false);
  });

  test('a bot of one’s own: asked on the site, made in Telegram, its token sealed, and it answers its owner only', async () => {
    await makeAgent();
    assert.equal((await request(app()).post('/still/agent/bot')).body.code, 'agent_telegram_required');
    const code = new URL((await request(app()).post('/still/agent/telegram')).body.url as string).searchParams.get('start')!;
    await managerUpdate(message(`/start ${code}`));
    const asked = await request(app()).post('/still/agent/bot');
    assert.equal(asked.status, 201);
    assert.equal(asked.body.url, 'https://t.me/newbot/StillAgentsBot/Pip_still_bot?name=Pip%20%C2%B7%20Still%20Agent');
    // Telegram: the person confirmed, and a bot was made for them.
    const made = await managerUpdate({ update_id: 2, managed_bot: { user: { id: CHAT }, bot: { id: 987654321, is_bot: true, username: 'Pip_still_bot' } } });
    assert.equal(made.status, 200);
    const hook = stillAgentOwnBotWebhookV1(CONFIG, '987654321')!;
    assert.deepEqual(hooks.at(-1), { token: OWN, url: hook.url, secretToken: hook.secretToken });
    assert.equal(sent.at(-1)!.chatId, String(CHAT));
    assert.match(sent.at(-1)!.html, /Your agent is ready: @Pip_still_bot\./);
    const stored = await repository.botOf('987654321');
    assert.equal(openStillAgentBotTokenV1(CONFIG.key!, stored!.tokenEnc), OWN);
    assert.ok(!stored!.tokenEnc.includes(OWN.split(':')[1]!), 'never stored in the clear');
    assert.deepEqual((await request(app()).get('/still/agent')).body.telegram.ownBot, { username: 'Pip_still_bot', started: false });
    // The owner presses Start in their bot; a stranger gets nothing.
    const ownUpdate = (body: unknown, secret = hook.secretToken) =>
      request(app(null)).post('/telegram/agent/bot/987654321').set('X-Telegram-Bot-Api-Secret-Token', secret).send(body as object);
    assert.equal((await ownUpdate(message('/start'), stillAgentOwnBotWebhookV1(CONFIG, '5')!.secretToken)).status, 401);
    const before = sent.length;
    await ownUpdate(message('/start', 424242));
    assert.equal(sent.length, before, 'a stranger is not answered');
    await ownUpdate(message('/start'));
    assert.equal(sent.at(-1)!.token, OWN);
    assert.match(sent.at(-1)!.html, /^Hi, I'm Pip, your Still Agent\./);
    assert.deepEqual((await request(app()).get('/still/agent')).body.telegram.ownBot, { username: 'Pip_still_bot', started: true });
    // A second bot for the same agent is not made; letting the bot go stops its webhook.
    assert.equal((await request(app()).post('/still/agent/bot')).body.code, 'agent_own_bot_exists');
    assert.equal((await request(app()).delete('/still/agent/bot')).status, 200);
    assert.deepEqual(hooks.at(-1), { token: OWN, url: '', secretToken: '' });
    assert.equal(await repository.botOf('987654321'), null);
  });

  test('a bot nobody asked for is not taken, and without the key no bot is made at all', async () => {
    await managerUpdate({ update_id: 3, managed_bot: { user: { id: CHAT }, bot: { id: 987654321, username: 'Pip_still_bot' } } });
    assert.equal(await repository.botOf('987654321'), null);
    assert.equal(sent.length, 0);
    config = stillAgentBotConfigV1({ STILL_AGENT_BOT_TOKEN: MANAGER });
    await makeAgent();
    assert.equal((await request(app()).post('/still/agent/bot')).body.code, 'agent_own_bot_unavailable');
    assert.equal((await request(app()).get('/still/agent')).body.telegram.ownBotAvailable, false);
  });
});
