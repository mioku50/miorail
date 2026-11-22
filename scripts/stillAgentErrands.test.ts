import assert from 'node:assert/strict';
import test, { beforeEach, describe } from 'node:test';

import { createMemoryStillAgentRepositoryV1, type StillAgentRepositoryV1, type StillErrandInputV1 } from '@mioagent/route-storage';
import {
  TelegramBotErrorV1,
  newTelegramLinkCodeV1,
  sealStillAgentBotTokenV1,
  stillAgentBotConfigV1,
  type TelegramBotClientV1,
} from '@mioagent/telegram';

import { runStillAgentErrandsV1, stillErrandMessageV1 } from './stillAgentErrands.js';

const MANAGER = '123456789:AAHfake-manager-token_for_tests_abcdef';
const OWN = '987654321:AAOwn-bot-token_for_tests_only_zyxwvu';
const KEY = Buffer.alloc(32, 5);
const CONFIG = stillAgentBotConfigV1({ STILL_AGENT_BOT_TOKEN: MANAGER, STILL_AGENT_BOT_KEY: KEY.toString('base64') })!;
const A = `0x${'a1'.repeat(20)}`;
const B = `0x${'b2'.repeat(20)}`;
const T0 = new Date('2026-12-01T07:00:00.000Z');
const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const NETFLIX: Omit<StillErrandInputV1, 'walletAddress'> = {
  kind: 'subscription', schedule: { every: 'month', day: 1 }, timeZone: 'Europe/Sofia', country: 'IE',
  productId: 'netflix-eu', productName: 'Netflix EU', packageValue: '15', packageLabel: '15 EUR', funding: { kind: 'usdc' }, recipient: null,
};

let repository: StillAgentRepositoryV1;
let sent: { token: string; chatId: string; html: string; button?: { text: string; url: string } }[];
let refuse: ((token: string) => Error | null);
let lines: string[];

function bot(token: string): TelegramBotClientV1 {
  return {
    getMe: async () => ({ id: 1, username: 'x_bot' }),
    sendMessage: async (message) => {
      const error = refuse(token);
      if (error) throw error;
      sent.push({ token, ...message });
    },
    setWebhook: async () => {},
    deleteWebhook: async () => {},
    getWebhookInfo: async () => ({ url: '', pendingUpdateCount: 0, lastErrorDate: null }),
    getManagedBotToken: async () => OWN,
  };
}

const deps = (now: Date, config: typeof CONFIG | null = CONFIG) => ({ repository, config, bot, now: () => now, log: (line: string) => lines.push(line) });

async function agentWithErrand(wallet: string, errandId: string, input: Partial<StillErrandInputV1> = {}, limit = 1) {
  await repository.saveAgent({ walletAddress: wallet, name: 'Pip', avatar: 'pip', language: 'en', timeZone: 'Europe/Sofia', now: new Date('2026-11-22T00:00:00Z') });
  const added = await repository.addErrand({ ...NETFLIX, ...input, walletAddress: wallet, errandId, nextDueAt: T0, now: new Date('2026-11-22T00:00:00Z'), limit });
  assert.notEqual(typeof added, 'string');
}

async function joinChat(wallet: string, chatId: string) {
  const { hash } = newTelegramLinkCodeV1();
  await repository.issueLinkCode({ codeHash: hash, walletAddress: wallet, now: T0, expiresAt: new Date(T0.getTime() + 600_000) });
  assert.ok(await repository.redeemLinkCode({ codeHash: hash, chatId, now: T0 }));
}

beforeEach(() => {
  repository = createMemoryStillAgentRepositoryV1();
  sent = [];
  refuse = () => null;
  lines = [];
});

describe('the errands pass', () => {
  test('reminds once on the day, from the agents bot, with the link that opens Spend on the errand', async () => {
    await agentWithErrand(A, ID(1));
    await joinChat(A, '777');
    assert.deepEqual(await runStillAgentErrandsV1(deps(new Date(T0.getTime() - 1)), { dry: false }), {
      due: 0, claimed: 0, ownBot: 0, agentsBot: 0, siteOnly: 0, paused: 0, late: 0, failed: 0,
    });
    const result = await runStillAgentErrandsV1(deps(new Date(T0.getTime() + 60_000)), { dry: false });
    assert.equal(result.agentsBot, 1);
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.token, MANAGER);
    assert.equal(sent[0]!.chatId, '777');
    assert.equal(sent[0]!.html, "<b>Pip · Still Agent</b>\nIt's the 1st: your Netflix EU (15 EUR) card is ready to review.\n"
      + 'You chose to pay from your USDC.\nNothing has been signed: you see the price on Still and sign in your own wallet.');
    assert.deepEqual(sent[0]!.button, { text: 'Review on Still', url: `https://miorail.xyz/spend?errand=${ID(1)}` });
    const [errand] = await repository.errandsOf(A);
    assert.equal(errand!.nextDueAt, '2027-01-01T07:00:00.000Z', 'the next 1st, 09:00 in Sofia');
    assert.equal(errand!.lastRun?.told, 'agents_bot');
    // The same day is never reminded twice, by this pass or a second one.
    await runStillAgentErrandsV1(deps(new Date(T0.getTime() + 120_000)), { dry: false });
    assert.equal(sent.length, 1);
  });

  test('two passes at once claim the day once', async () => {
    await agentWithErrand(A, ID(1));
    await joinChat(A, '777');
    await Promise.all([
      runStillAgentErrandsV1(deps(new Date(T0.getTime() + 1000)), { dry: false }),
      runStillAgentErrandsV1(deps(new Date(T0.getTime() + 1000)), { dry: false }),
    ]);
    assert.equal(sent.length, 1);
  });

  test('from the person’s own bot once they started it, and on the site alone without Telegram', async () => {
    await agentWithErrand(A, ID(1));
    await joinChat(A, '777');
    await repository.requestBot({ walletAddress: A, now: T0 });
    await repository.claimBot({ chatId: '777', botId: '987654321', username: 'Pip_still_bot', tokenEnc: sealStillAgentBotTokenV1(KEY, OWN), now: T0 });
    await repository.setBotChat({ botId: '987654321', chatId: '777' });
    await agentWithErrand(B, ID(2));
    const result = await runStillAgentErrandsV1(deps(new Date(T0.getTime() + 1000)), { dry: false });
    assert.equal(result.ownBot, 1);
    assert.equal(result.siteOnly, 1);
    assert.deepEqual(sent.map((row) => [row.token, row.chatId]), [[OWN, '777']]);
    assert.equal((await repository.errandsOf(A))[0]!.lastRun?.told, 'own_bot');
    assert.equal((await repository.errandsOf(B))[0]!.lastRun?.told, 'site');
  });

  test('an errand over the free one is paused while no pass runs, and a day missed by days is not reminded late', async () => {
    await agentWithErrand(A, ID(1), {}, 10);
    await repository.addErrand({ ...NETFLIX, walletAddress: A, errandId: ID(2), nextDueAt: T0, now: new Date('2026-11-23T00:00:00Z'), limit: 10 });
    await joinChat(A, '777');
    const result = await runStillAgentErrandsV1(deps(new Date(T0.getTime() + 1000)), { dry: false });
    assert.deepEqual([result.agentsBot, result.paused], [1, 1]);
    assert.equal(sent.length, 1);
    const errands = await repository.errandsOf(A);
    assert.deepEqual(errands.map((errand) => errand.lastRun?.told), ['agents_bot', 'paused']);
    // The pass was down for three days: the day is claimed for the site, and the next one is after now.
    await agentWithErrand(B, ID(3));
    await joinChat(B, '888');
    const late = new Date(T0.getTime() + 3 * 24 * 60 * 60 * 1000);
    const lateResult = await runStillAgentErrandsV1(deps(late), { dry: false });
    assert.equal(lateResult.late, 1);
    assert.equal(sent.length, 1);
    assert.equal((await repository.errandsOf(B))[0]!.nextDueAt, '2027-01-01T07:00:00.000Z');
  });

  test('a dry pass claims nothing; a failed send stays on the site; a blocked chat is let go', async () => {
    await agentWithErrand(A, ID(1));
    await joinChat(A, '777');
    const dry = await runStillAgentErrandsV1(deps(new Date(T0.getTime() + 1000)), { dry: true });
    assert.equal(dry.claimed, 0);
    assert.equal((await repository.errandsOf(A))[0]!.nextDueAt, T0.toISOString());
    refuse = () => new TelegramBotErrorV1('blocked', 403);
    const failed = await runStillAgentErrandsV1(deps(new Date(T0.getTime() + 1000)), { dry: false });
    assert.equal(failed.failed, 1);
    assert.equal((await repository.errandsOf(A))[0]!.lastRun?.told, 'site');
    assert.equal((await repository.agentOf(A))!.telegram, null);
    assert.ok(lines.some((line) => /not sent via=agents_bot telegram_blocked_403/.test(line)));
    assert.ok(!lines.some((line) => line.includes(A) || line.includes('777')), 'no wallet and no chat in the log');
  });

  test('says a gift, a loan and its risk in the agent’s language, and escapes what a person typed', async () => {
    await repository.saveAgent({ walletAddress: A, name: 'Пип', avatar: 'pip', language: 'ru', timeZone: 'Europe/Sofia', now: T0 });
    const agent = (await repository.agentOf(A))!;
    const message = stillErrandMessageV1(agent, {
      ...NETFLIX, walletAddress: A, errandId: ID(9), kind: 'gift', schedule: { every: 'year', month: 3, day: 14 }, recipient: 'Маша <3',
      productName: 'Apple Ireland', packageLabel: '20 EUR', funding: { kind: 'loan', collateral: 'AAPLc' },
      active: true, nextDueAt: T0.toISOString(), createdAt: T0.toISOString(), updatedAt: T0.toISOString(), lastRun: null,
    }, 'https://miorail.xyz');
    assert.equal(message.html, '<b>Пип · Still Agent</b>\nПодарок для: Маша &lt;3. Карта Apple Ireland (20 EUR) готова к проверке.\n'
      + 'Вы выбрали займ под AAPLc. Займ — это долг, а залог могут ликвидировать.\nНичего не подписано: цену вы увидите в Still и подпишете в своём кошельке.');
    assert.equal(message.button.text, 'Проверить в Still');
  });
});
