import assert from 'node:assert/strict';
import test from 'node:test';
import { createStillCardStoreV1, type StillCardHostV1 } from './stillCardStore';

// The card against a host that answers from a script: no chat, no network.
const REVIEW_ID = '0b8f4a51-5d0a-4c55-9d4e-0a6a3f3e2c11';
const URL = 'https://stills.lat/lending/miorail-lending-v1.eyJhIjoxfQ.c2lnbmF0dXJl';
const LOAN = { reviewUrl: URL, reviewId: REVIEW_ID, expiresAt: '2026-11-02T15:05:00.000Z', venue: 'aave-v4', collateral: 'NVDAc', addCollateral: '0', borrowUsdc: '100' };
const tick = () => new Promise((resolve) => setImmediate(resolve));

function host(states: string[], options: { refuseLink?: boolean } = {}) {
  const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [], opened: string[] = [];
  const fake: StillCardHostV1 = {
    ontoolresult: undefined,
    onhostcontextchanged: undefined,
    connect: async () => {},
    getHostContext: () => ({ theme: 'dark' }),
    callServerTool: async (params) => {
      calls.push(params);
      return { structuredContent: { reviewId: REVIEW_ID, state: states.shift() ?? 'confirmed' } };
    },
    openLink: async ({ url }) => { if (options.refuseLink) throw new Error('Link opening denied by user'); opened.push(url); return {}; },
  };
  return { fake, calls, opened };
}

test('the card reads once when it appears, and polls nothing until the person opens the review', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { fake, calls } = host(['not_opened']);
  const store = createStillCardStoreV1(fake, { now: () => new Date('2026-11-02T15:00:00.000Z') });
  assert.equal(store.get().dark, true);
  fake.ontoolresult!({ structuredContent: LOAN });
  await tick();
  assert.equal(store.get().status?.phase, 'waiting');
  assert.deepEqual(calls.map((call) => call.arguments), [{ reviewId: REVIEW_ID }]);
  t.mock.timers.tick(60_000);
  await tick();
  assert.equal(calls.length, 1, 'an unopened review is not polled');
});

test('opening the review follows it to the chain, then stops', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { fake, calls, opened } = host(['not_opened', 'ready', 'submitted', 'confirmed']);
  const store = createStillCardStoreV1(fake, { now: () => new Date('2026-11-02T15:00:00.000Z') });
  fake.ontoolresult!({ structuredContent: LOAN });
  await tick();
  await store.openReview();
  await tick();
  assert.deepEqual(opened, [URL]);
  assert.equal(store.get().status?.phase, 'open');
  for (const phase of ['sent', 'confirmed']) {
    t.mock.timers.tick(6_000);
    await tick(); await tick();
    assert.equal(store.get().status?.phase, phase);
  }
  assert.equal(store.get().following, false);
  t.mock.timers.tick(60_000);
  await tick();
  assert.equal(calls.length, 4, 'a confirmed loan is read no more');
});

test('a refused link is said, the tool’s own refusal is shown in its words, and an unread status is our failure', async () => {
  const { fake } = host(['not_opened'], { refuseLink: true });
  const store = createStillCardStoreV1(fake);
  fake.ontoolresult!({ isError: true, content: [{ type: 'text', text: 'spend_over_cap: One purchase is at most 100 USDC for now. Nothing was opened.' }] });
  assert.equal(store.get().refusal, 'One purchase is at most 100 USDC for now. Nothing was opened.');
  fake.ontoolresult!({ structuredContent: LOAN });
  await tick();
  await store.openReview();
  assert.equal(store.get().linkRefused, true);
  fake.callServerTool = async () => { throw new Error('host refused'); };
  store.checkAgain();
  await tick();
  assert.equal(store.get().statusUnread, true);
});
