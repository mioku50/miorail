import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { StillAgentRepositoryV1, StillErrandInputV1 } from '../src/stillAgent.js';

// ---------------------------------------------------------------------------
// What Still Agent's storage promises, run against memory and Postgres alike.
// ---------------------------------------------------------------------------

const A = `0x${'a'.repeat(40)}`;
const B = `0x${'b'.repeat(40)}`;
const T0 = new Date('2026-11-22T10:00:00.000Z');
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);
const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const NETFLIX: Omit<StillErrandInputV1, 'walletAddress'> = {
  kind: 'subscription', schedule: { every: 'month', day: 1 }, timeZone: 'Europe/Sofia', country: 'IE',
  productId: 'netflix-eu', productName: 'Netflix EU', packageValue: '15', packageLabel: '15 EUR', funding: { kind: 'usdc' }, recipient: null,
};
const GIFT: Omit<StillErrandInputV1, 'walletAddress'> = {
  kind: 'gift', schedule: { every: 'year', month: 3, day: 14 }, timeZone: 'Europe/Dublin', country: 'IE',
  productId: 'apple-ireland', productName: 'Apple Ireland', packageValue: '20', packageLabel: '20 EUR',
  funding: { kind: 'loan', collateral: 'AAPLc' }, recipient: 'Маша',
};

export function stillAgentContractV1(name: string, make: () => Promise<StillAgentRepositoryV1>): void {
  describe(`${name} Still Agent storage`, () => {
    test('numbers agents in the order they were made, and a rename keeps the number', async () => {
      const repo = await make();
      assert.equal(await repo.agentOf(A), null);
      const first = await repo.saveAgent({ walletAddress: A, name: 'Pip', avatar: 'pip', language: 'en', timeZone: 'Europe/Dublin', now: T0 });
      const second = await repo.saveAgent({ walletAddress: B, name: 'Орбита', avatar: 'orbit', language: 'ru', timeZone: 'Europe/Sofia', now: at(1) });
      assert.equal(first.agentNo + 1, second.agentNo);
      const renamed = await repo.saveAgent({ walletAddress: A, name: 'Pippa', avatar: 'star', language: 'ru', timeZone: 'Europe/Sofia', now: at(2) });
      assert.equal(renamed.agentNo, first.agentNo);
      assert.deepEqual([renamed.name, renamed.avatar, renamed.language, renamed.timeZone], ['Pippa', 'star', 'ru', 'Europe/Sofia']);
      assert.equal(renamed.createdAt, T0.toISOString());
      assert.equal(renamed.telegram, null);
      assert.equal(renamed.bot, null);
      assert.equal(renamed.errandsActive, 0);
    });

    test('keeps errands to the limit, counts a removed one out, and refuses a wallet without an agent', async () => {
      const repo = await make();
      assert.equal(await repo.addErrand({ ...NETFLIX, walletAddress: A, errandId: ID(1), nextDueAt: at(60), now: T0, limit: 1 }), 'no_agent');
      await repo.saveAgent({ walletAddress: A, name: 'Pip', avatar: 'pip', language: 'en', timeZone: 'Europe/Dublin', now: T0 });
      const added = await repo.addErrand({ ...NETFLIX, walletAddress: A, errandId: ID(1), nextDueAt: at(60), now: T0, limit: 1 });
      assert.notEqual(typeof added, 'string');
      if (typeof added === 'string') return;
      assert.deepEqual({ ...added, createdAt: undefined, updatedAt: undefined }, {
        ...NETFLIX, walletAddress: A, errandId: ID(1), active: true, nextDueAt: at(60).toISOString(), lastRun: null, createdAt: undefined, updatedAt: undefined,
      });
      assert.equal(await repo.addErrand({ ...GIFT, walletAddress: A, errandId: ID(2), nextDueAt: at(90), now: at(1), limit: 1 }), 'limit');
      const gift = await repo.addErrand({ ...GIFT, walletAddress: A, errandId: ID(2), nextDueAt: at(90), now: at(1), limit: 10 });
      assert.equal(typeof gift === 'string' ? gift : gift.recipient, 'Маша');
      assert.deepEqual((await repo.errandsOf(A)).map((errand) => errand.errandId), [ID(1), ID(2)]);
      assert.equal((await repo.agentOf(A))!.errandsActive, 2);
      // Only its owner removes it, once.
      assert.equal(await repo.removeErrand({ walletAddress: B, errandId: ID(1), now: at(2) }), false);
      assert.equal(await repo.removeErrand({ walletAddress: A, errandId: ID(1), now: at(2) }), true);
      assert.equal(await repo.removeErrand({ walletAddress: A, errandId: ID(1), now: at(3) }), false);
      assert.deepEqual((await repo.errandsOf(A)).map((errand) => errand.errandId), [ID(2)]);
      assert.equal((await repo.agentOf(A))!.errandsActive, 1);
      // Two adds at once against a limit of two: one more fits, never two.
      const both = await Promise.all([
        repo.addErrand({ ...NETFLIX, walletAddress: A, errandId: ID(3), nextDueAt: at(60), now: at(4), limit: 2 }),
        repo.addErrand({ ...NETFLIX, walletAddress: A, errandId: ID(4), nextDueAt: at(60), now: at(4), limit: 2 }),
      ]);
      assert.equal(both.filter((row) => row === 'limit').length, 1);
      assert.equal((await repo.agentOf(A))!.errandsActive, 2);
    });

    test('hands each due day to one pass only, moves the errand on, and says where its reminder went', async () => {
      const repo = await make();
      await repo.saveAgent({ walletAddress: A, name: 'Pip', avatar: 'pip', language: 'en', timeZone: 'Europe/Dublin', now: T0 });
      await repo.addErrand({ ...NETFLIX, walletAddress: A, errandId: ID(1), nextDueAt: at(10), now: T0, limit: 1 });
      assert.deepEqual(await repo.dueErrands({ now: at(9), limit: 10 }), []);
      const due = await repo.dueErrands({ now: at(10), limit: 10 });
      assert.deepEqual(due.map((row) => [row.errand.errandId, row.agent.name]), [[ID(1), 'Pip']]);
      const claims = await Promise.all([
        repo.claimRun({ errandId: ID(1), dueAt: at(10), nextDueAt: at(1000), told: 'site', now: at(11) }),
        repo.claimRun({ errandId: ID(1), dueAt: at(10), nextDueAt: at(1000), told: 'site', now: at(11) }),
      ]);
      assert.deepEqual(claims.sort(), [false, true]);
      assert.deepEqual(await repo.dueErrands({ now: at(11), limit: 10 }), []);
      await repo.markRunTold({ errandId: ID(1), dueAt: at(10), told: 'agents_bot', now: at(12) });
      const [errand] = await repo.errandsOf(A);
      assert.equal(errand!.nextDueAt, at(1000).toISOString());
      assert.deepEqual(errand!.lastRun, { dueAt: at(10).toISOString(), told: 'agents_bot', toldAt: at(12).toISOString() });
      // A day already claimed, or one the errand is not due on, is not claimed again.
      assert.equal(await repo.claimRun({ errandId: ID(1), dueAt: at(10), nextDueAt: at(2000), told: 'site', now: at(13) }), false);
      // A removed errand is never due.
      await repo.removeErrand({ walletAddress: A, errandId: ID(1), now: at(14) });
      assert.deepEqual(await repo.dueErrands({ now: at(5000), limit: 10 }), []);
    });

    test('joins a Telegram chat with a one-time code, and lets it go from either side', async () => {
      const repo = await make();
      await repo.saveAgent({ walletAddress: A, name: 'Pip', avatar: 'pip', language: 'en', timeZone: 'Europe/Dublin', now: T0 });
      await repo.saveAgent({ walletAddress: B, name: 'Orbit', avatar: 'orbit', language: 'en', timeZone: 'Europe/Dublin', now: T0 });
      const hash = (n: number) => String(n).repeat(64).slice(0, 64);
      await repo.issueLinkCode({ codeHash: hash(1), walletAddress: A, now: T0, expiresAt: at(10) });
      await repo.issueLinkCode({ codeHash: hash(2), walletAddress: B, now: T0, expiresAt: at(10) });
      await repo.issueLinkCode({ codeHash: hash(3), walletAddress: A, now: T0, expiresAt: at(10) });
      assert.equal(await repo.redeemLinkCode({ codeHash: hash(9), chatId: '777', now: at(1) }), null);
      assert.deepEqual(await repo.redeemLinkCode({ codeHash: hash(1), chatId: '777', now: at(1) }), { walletAddress: A, linkedNow: true });
      assert.equal(await repo.redeemLinkCode({ codeHash: hash(1), chatId: '777', now: at(2) }), null, 'once');
      assert.deepEqual(await repo.redeemLinkCode({ codeHash: hash(3), chatId: '777', now: at(2) }), { walletAddress: A, linkedNow: false });
      assert.equal(await repo.redeemLinkCode({ codeHash: hash(2), chatId: '777', now: at(11) }), null, 'expired');
      assert.deepEqual((await repo.agentsOfChat('777')).map((agent) => agent.walletAddress), [A]);
      assert.equal((await repo.agentOf(A))!.telegram!.chatId, '777');
      assert.equal(await repo.unlinkWallet(B), null);
      assert.equal(await repo.unlinkWallet(A), '777');
      assert.deepEqual(await repo.agentsOfChat('777'), []);
      await repo.issueLinkCode({ codeHash: hash(4), walletAddress: B, now: at(3), expiresAt: at(13) });
      await repo.redeemLinkCode({ codeHash: hash(4), chatId: '888', now: at(4) });
      assert.deepEqual(await repo.unlinkChat('888'), [B]);
      await repo.pruneLinkCodes({ before: at(100) });
    });

    test('gives a new bot to the agent of the chat that asked for it last, within the hour, and keeps its token apart', async () => {
      const repo = await make();
      await repo.saveAgent({ walletAddress: A, name: 'Pip', avatar: 'pip', language: 'en', timeZone: 'Europe/Dublin', now: T0 });
      await repo.saveAgent({ walletAddress: B, name: 'Orbit', avatar: 'orbit', language: 'en', timeZone: 'Europe/Dublin', now: T0 });
      assert.equal(await repo.requestBot({ walletAddress: A, now: T0 }), false, 'no chat joined yet');
      const hash = (n: number) => String(n).repeat(64).slice(0, 64);
      await repo.issueLinkCode({ codeHash: hash(1), walletAddress: A, now: T0, expiresAt: at(10) });
      await repo.issueLinkCode({ codeHash: hash(2), walletAddress: B, now: T0, expiresAt: at(10) });
      await repo.redeemLinkCode({ codeHash: hash(1), chatId: '777', now: at(1) });
      await repo.redeemLinkCode({ codeHash: hash(2), chatId: '777', now: at(1) });
      assert.equal(await repo.claimBot({ chatId: '777', botId: '5001', username: 'Pip_still_bot', tokenEnc: 'v1.'.padEnd(40, 'x'), now: at(2) }), null, 'nobody asked');
      assert.equal(await repo.requestBot({ walletAddress: A, now: at(2) }), true);
      assert.equal(await repo.requestBot({ walletAddress: B, now: at(3) }), true);
      const claimed = await repo.claimBot({ chatId: '777', botId: '5001', username: 'Orbit_still_bot', tokenEnc: 'v1.'.padEnd(40, 'x'), now: at(4) });
      assert.equal(claimed?.walletAddress, B, 'the latest ask');
      assert.deepEqual(claimed?.bot, { botId: '5001', username: 'Orbit_still_bot', chatId: null, createdAt: at(4).toISOString() });
      assert.equal(claimed?.botRequestedAt, null);
      assert.equal(await repo.claimBot({ chatId: '777', botId: '5001', username: 'Orbit_still_bot', tokenEnc: 'v1.'.padEnd(40, 'x'), now: at(5) }), null, 'a bot once');
      assert.equal(await repo.claimBot({ chatId: '777', botId: '5002', username: 'Pip_still_bot', tokenEnc: 'v1.'.padEnd(40, 'y'), now: at(70) }), null, 'an ask expires');
      assert.equal(await repo.requestBot({ walletAddress: A, now: at(71) }), true);
      assert.equal((await repo.claimBot({ chatId: '777', botId: '5002', username: 'Pip_still_bot', tokenEnc: 'v1.'.padEnd(40, 'y'), now: at(72) }))?.walletAddress, A);
      const found = await repo.botOf('5001');
      assert.equal(found?.agent.walletAddress, B);
      assert.equal(found?.tokenEnc, 'v1.'.padEnd(40, 'x'));
      assert.equal(JSON.stringify(found?.agent).includes('v1.xxx'), false, 'the agent never carries the token');
      await repo.setBotChat({ botId: '5001', chatId: '777' });
      await repo.setBotToken({ botId: '5001', tokenEnc: 'v1.'.padEnd(40, 'z') });
      assert.equal((await repo.botOf('5001'))?.agent.bot?.chatId, '777');
      assert.equal((await repo.botOf('5001'))?.tokenEnc, 'v1.'.padEnd(40, 'z'));
      assert.deepEqual(await repo.detachBot(B), { botId: '5001', tokenEnc: 'v1.'.padEnd(40, 'z') });
      assert.equal(await repo.botOf('5001'), null);
      assert.equal(await repo.detachBot(B), null);
    });

    test('counts each pass transfer once, and a first-month price once per wallet', async () => {
      const repo = await make();
      const tx = (n: number) => `0x${String(n).repeat(64).slice(0, 64)}`;
      const pass = (n: number, plan: 'intro' | 'month' | 'year', startsAt: Date, endsAt: Date) => ({
        txHash: tx(n), walletAddress: A, plan, amountAtomic: plan === 'intro' ? '1000000' : '3000000', blockNumber: '38000000',
        startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString(), now: T0,
      });
      assert.equal(await repo.recordPass(pass(1, 'intro', T0, at(30 * 1440))), 'recorded');
      assert.equal(await repo.recordPass(pass(1, 'intro', T0, at(30 * 1440))), 'duplicate');
      assert.equal(await repo.recordPass(pass(2, 'intro', T0, at(30 * 1440))), 'intro_used');
      assert.equal(await repo.recordPass(pass(3, 'month', at(30 * 1440), at(60 * 1440))), 'recorded');
      assert.deepEqual((await repo.passesOf(A)).map((row) => [row.txHash, row.plan, row.endsAt]), [
        [tx(3), 'month', at(60 * 1440).toISOString()], [tx(1), 'intro', at(30 * 1440).toISOString()],
      ]);
      assert.deepEqual(await repo.passesOf(B), []);
    });
  });
}
