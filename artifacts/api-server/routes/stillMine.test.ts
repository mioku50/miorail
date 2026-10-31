import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import express from 'express';
import request from 'supertest';
import { InMemoryRateLimiter } from '@mioagent/utils';
import { computeMirror, type MirrorInput, type MirrorOutcome, type MirrorReadingV1, type MirrorService } from '@mioagent/still-engine';
import type { LlmProvider, LlmRequest } from '@mioagent/llm';

import { EXAMPLE, SATURDAY, calendar, snapshot, universe } from '../../../lib/still-engine/test/fixtures.js';
import { stillAgentLlmRuntimeV1 } from '../lib/stillAgentServer.js';
import { createMemoryStillReadingStoreV1, stillReadingsRuntimeV1 } from '../lib/stillReadings.js';
import { stillMineRouter, stillMineRuntimeV1 } from './stillMine.js';

const original = { ...stillMineRuntimeV1 };
const originalLlm = { ...stillAgentLlmRuntimeV1 };
const originalReadings = { ...stillReadingsRuntimeV1 };
afterEach(() => {
  Object.assign(stillMineRuntimeV1, original, { askLimiter: new InMemoryRateLimiter({ windowMs: 60_000, max: 12 }) });
  Object.assign(stillAgentLlmRuntimeV1, originalLlm);
  Object.assign(stillReadingsRuntimeV1, originalReadings);
});

const WALLET = `0x${'1'.repeat(40)}`;

function inputFor(address: string, timestamp?: bigint): MirrorInput {
  return {
    subject: { address: address as `0x${string}`, name: null, input: address },
    universe: universe(),
    snapshot: snapshot(EXAMPLE, timestamp),
    calendar: calendar(),
    assembledAt: new Date('2026-10-21T15:00:01Z'),
  };
}

const readingFor = (address: string, timestamp?: bigint): MirrorReadingV1 => {
  const input = inputFor(address, timestamp);
  return { outcome: 'report', report: computeMirror(input), input, cached: false };
};

function app(wallet: string | null, answer: (input: string) => Promise<MirrorOutcome>, reading: (address: string) => Promise<MirrorReadingV1> = async (address) => readingFor(address)) {
  const asked: string[] = [];
  const service: MirrorService = {
    check: async (input) => {
      asked.push(input);
      return answer(input);
    },
    reading: async (address) => {
      asked.push(address);
      return reading(address);
    },
    earnings: async () => ({ ok: false }),
  };
  stillMineRuntimeV1.service = () => service;
  stillReadingsRuntimeV1.store = async () => store;
  const server = express();
  server.use((req, _res, next) => {
    Object.assign(req, { session: { user: wallet ? { id: `eip155:8453:${wallet}`, address: wallet, chainId: 8453 } : null } });
    next();
  });
  server.use('/api/still', stillMineRouter);
  return { server, asked };
}

let store = createMemoryStillReadingStoreV1();

/** A model that says one thing, and remembers what it was asked. */
function model(content: string | ((req: LlmRequest) => string)): LlmProvider & { asked: LlmRequest[] } {
  const asked: LlmRequest[] = [];
  return {
    asked,
    generate: async (req: LlmRequest) => {
      asked.push(req);
      return { message: { role: 'assistant', content: typeof content === 'string' ? content : content(req) } };
    },
  } as LlmProvider & { asked: LlmRequest[] };
}
const never = (why: string) => () => ({ generate: async () => assert.fail(why) }) as unknown as LlmProvider;

const report = (address: string) =>
  ({ outcome: 'report', report: { kind: 'still.mirror', subject: { address, name: null, input: address } }, cached: false }) as unknown as MirrorOutcome;

test('the session’s wallet and nobody else’s: no session, the zero address and a named account are refused', async () => {
  for (const wallet of [null, `0x${'0'.repeat(40)}`]) {
    const { server, asked } = app(wallet, async () => assert.fail('not asked'));
    assert.equal((await request(server).get('/api/still/mine')).status, 401);
    assert.deepEqual(asked, []);
  }
  const { server, asked } = app(WALLET, async () => assert.fail('not asked'));
  const named = await request(server).get('/api/still/mine').query({ subject: `0x${'2'.repeat(40)}` });
  assert.equal(named.status, 400);
  assert.deepEqual(asked, []);
});

test('answers the wallet’s report, never cached by anyone in between', async () => {
  const { server, asked } = app(WALLET, async (input) => report(input));
  const res = await request(server).get('/api/still/mine');
  assert.equal(res.status, 200);
  assert.equal(res.headers['cache-control'], 'private, no-store');
  assert.equal(res.body.report.subject.address, WALLET);
  assert.deepEqual(asked, [WALLET]);
});

test('a report about another address is our failure and is never shown', async () => {
  const { server } = app(WALLET, async () => report(`0x${'2'.repeat(40)}`));
  const res = await request(server).get('/api/still/mine');
  assert.equal(res.status, 500);
  assert.deepEqual(res.body, { outcome: 'internal_error' });
});

test('an unreadable chain is 503 and names no provider address', async () => {
  const { server } = app(WALLET, async () => ({ outcome: 'chain_unavailable', attempts: [{ provider: 'base-public', kind: 'throttled' }] }));
  const res = await request(server).get('/api/still/mine');
  assert.equal(res.status, 503);
  assert.doesNotMatch(res.text, /https?:/);
  const failing = app(WALLET, async () => {
    throw new Error('https://base-mainnet.example/v3/SECRET failed');
  });
  const failed = await request(failing.server).get('/api/still/mine');
  assert.equal(failed.status, 500);
  assert.doesNotMatch(failed.text, /SECRET|https?:/);
});

const ask = (server: express.Express, question: string, stream = false) => {
  const call = request(server).post('/api/still/agent/ask').send({ question });
  return stream ? call.set('Accept', 'application/x-ndjson') : call;
};

test('the Agent reads the session wallet itself and computes with the Mirror engine', async () => {
  store = createMemoryStillReadingStoreV1();
  stillAgentLlmRuntimeV1.planner = never('the rules read this question');
  stillAgentLlmRuntimeV1.narrator = () => null;
  const unsigned = app(null, async () => assert.fail('not asked'));
  assert.equal((await ask(unsigned.server, 'Что будет при падении NVDA на 30%?')).status, 401);

  const own = app(WALLET, async () => assert.fail('the Agent reads, it does not check'));
  // Whatever the page posts besides the question is not read.
  const res = await request(own.server).post('/api/still/agent/ask').send({ question: 'Что будет при падении NVDA на 30%?', report: { venues: [] } });
  assert.equal(res.status, 200);
  assert.deepEqual(own.asked, [WALLET]);
  const answer = res.body.answer;
  assert.equal(answer.mode, 'analysis');
  assert.equal(answer.understoodBy, 'rules');
  // 3.4 × $148.3349 × 70% / $240.17: the engine's own arithmetic, not a second copy.
  assert.match(answer.text, /^Если NVIDIA подешевеет на 30% \(до \$148\.33\), займ \$240\.17 на Aave V4 не доходит до ликвидации: health factor 2\.09 → 1\.46/);
  assert.ok(answer.steps.some((step: string) => /Цена NVIDIA: \$211\.90 → \$148\.33 \(−30%\)/.test(step)));
  assert.equal(answer.calculatedAt.block, '53000000');
  assert.ok(answer.bounds.some((bound: string) => /Остальные цены — как на блоке 53,000,000/.test(bound)));
  // The reading the person was answered about is kept for a later comparison.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(store.rows.length, 1);
});

test('the answer streams the stages of the work as they happen', async () => {
  store = createMemoryStillReadingStoreV1();
  stillAgentLlmRuntimeV1.planner = never('the rules read this question');
  stillAgentLlmRuntimeV1.narrator = () =>
    model('Если NVIDIA подешевеет на 30% (до $148.33), health factor займа $240.17 на Aave V4 снизится с 2.09 до 1.46, и до ликвидации цены могут вместе упасть ещё на 31%.');
  const { server } = app(WALLET, async () => assert.fail('not checked'));
  const res = await ask(server, 'Что будет при падении NVDA на 30%?', true);
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /application\/x-ndjson/);
  assert.equal(res.headers['x-accel-buffering'], 'no');
  const lines = res.text.trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(
    lines.map((line) => line.stage ?? line.type),
    ['reading', 'read', 'understood', 'computing', 'computed', 'wording', 'checked', 'answer'],
  );
  assert.equal(lines[1].block, '53000000');
  assert.equal(lines[2].summary, 'NVIDIA −30%');
  assert.equal(lines[6].verified, true);
  const answer = lines.at(-1).answer;
  assert.match(answer.text, /снизится с 2\.09 до 1\.46/);
  assert.ok(answer.sources.some((source: string) => /каждое число сверено с расчётом/.test(source)));
});

test('a re-wording is shown only if every figure is the calculation’s, the result stays and nothing advises', async () => {
  store = createMemoryStillReadingStoreV1();
  stillAgentLlmRuntimeV1.planner = never('the rules read this question');
  const { server } = app(WALLET, async () => assert.fail('not checked'));
  for (const content of [
    // A figure the calculation does not have.
    'Если NVIDIA подешевеет на 30%, health factor займа $240.17 снизится с 2.09 до 1.31.',
    // Advice.
    'Если NVIDIA подешевеет на 30%, health factor снизится с 2.09 до 1.46; рекомендую погасить часть займа $240.17.',
    // The decisive figure is gone and the outcome is flipped.
    'Если NVIDIA подешевеет на 30% (до $148.33), займ $240.17 может быть ликвидирован ниже $100.92.',
    'Если NVIDIA подешевеет на 30% (до $148.33), health factor снизится с 2.09 до 1.46, и займ может быть ликвидирован.',
    // A claim to have acted.
    'Я уже погасил часть долга: health factor 2.09 → 1.46 при падении NVIDIA на 30%.',
  ]) {
    stillAgentLlmRuntimeV1.narrator = () => model(content);
    const res = await ask(server, 'Что будет при падении NVDA на 30%?');
    assert.equal(res.status, 200);
    assert.match(res.body.answer.text, /^Если NVIDIA подешевеет на 30% \(до \$148\.33\), займ \$240\.17 на Aave V4 не доходит до ликвидации/);
    assert.ok(!res.body.answer.sources.some((source: string) => /^ИИ/.test(source)), content);
  }
});

test('a model reads what the rules do not, and every number it gives must be in the question', async () => {
  store = createMemoryStillReadingStoreV1();
  stillAgentLlmRuntimeV1.narrator = () => null;
  const planner = model('{"task":"interest","days":90}');
  stillAgentLlmRuntimeV1.planner = () => planner;
  const { server } = app(WALLET, async () => assert.fail('not checked'));
  const heard = await ask(server, 'What will this loan cost me over 90 days?');
  assert.equal(heard.body.answer.understoodBy, 'model');
  // $240.17 × 3.66% (the rate as read, rounded up) × 90 / 365, rounded up against the borrower.
  assert.match(heard.body.answer.text, /about \$2\.17 in interest over 90 days/);
  // The model saw the question, the held assets and the loans: no amount, no address.
  const prompt = planner.asked[0]!.messages.map((m) => m.content).join('\n');
  assert.match(prompt, /The wallet holds: AAPLc, NVDAc, TSLAc, cbBTC\. Its loans: aave\./);
  assert.doesNotMatch(prompt, /\$\d|0x1111/);
  assert.equal(planner.asked[0]!.reasoningEffort, 'none');

  // A number the question never gave is refused, and the person is asked for it.
  stillAgentLlmRuntimeV1.planner = () => model('{"task":"scenario","price":[{"asset":"NVDA","changePct":12}]}');
  const invented = await ask(server, 'How would a rough patch for NVIDIA treat my position?');
  assert.equal(invented.body.answer.mode, 'refused');
  assert.match(invented.body.answer.text, /Name the move as a percentage/);
  // So is an asset the question does not name.
  stillAgentLlmRuntimeV1.planner = () => model('{"task":"scenario","price":[{"asset":"TSLA","changePct":12}]}');
  const elsewhere = await ask(server, 'How would 12 rough days for NVIDIA treat my position?');
  assert.equal(elsewhere.body.answer.mode, 'refused');
  assert.match(elsewhere.body.answer.text, /Name the asset/);
  // A greeting goes to the planner, which may only call it a greeting: the list, no figures.
  stillAgentLlmRuntimeV1.planner = () => model('{"task":"chat"}');
  const hello = await ask(server, 'привет');
  assert.equal(hello.body.answer.topic, null);
  assert.doesNotMatch(hello.body.answer.text, /\$\d/);
  // A model that does not keep the contract twice is a question not understood.
  stillAgentLlmRuntimeV1.planner = () => model('Sure! NVIDIA would fall.');
  const garbled = await ask(server, 'How would a rough patch for NVIDIA treat my position?');
  assert.match(garbled.body.answer.text, /^I could not read that question as a calculation/);
});

test('a request to act is the page’s boundary: no model, nothing signed, a review link', async () => {
  store = createMemoryStillReadingStoreV1();
  stillAgentLlmRuntimeV1.planner = never('an action is not planned by a model');
  stillAgentLlmRuntimeV1.narrator = never('an action is not re-worded by a model');
  const { server } = app(WALLET, async () => assert.fail('not checked'));
  const res = await ask(server, 'Займи $500 и отправь другу');
  assert.equal(res.body.answer.mode, 'action_prep');
  assert.match(res.body.answer.text, /не исполняю транзакции автоматически/);
  assert.equal(res.body.answer.actionLink.href, '/borrow');
});

test('a repayment is described option by option, without advice', async () => {
  store = createMemoryStillReadingStoreV1();
  stillAgentLlmRuntimeV1.planner = never('the rules read this question');
  stillAgentLlmRuntimeV1.narrator = () => null;
  const { server } = app(WALLET, async () => assert.fail('not checked'));
  const res = await ask(server, 'Как безопаснее уменьшить долг на $100?');
  const answer = res.body.answer;
  assert.equal(answer.mode, 'analysis');
  assert.match(answer.steps[0], /Вариант 1 · Погасить \$100\.00 на Aave V4: долг \$240\.17 → \$140\.17, health factor 2\.09 → 3\.59, цена ликвидации NVIDIA: \$100\.92 → \$58\.90/);
  assert.match(answer.steps[1], /Вариант 2 · Погасить весь долг \(\$240\.17\) на Aave V4/);
  for (const line of [answer.text, ...answer.steps]) assert.doesNotMatch(line, /рекоменд|лучше|безопаснее всего/i);
  assert.equal(answer.actionLink.href, '/repay');
});

test('why the room changed: compared with the reading the person was shown before', async () => {
  store = createMemoryStillReadingStoreV1();
  stillAgentLlmRuntimeV1.planner = never('the rules read this question');
  stillAgentLlmRuntimeV1.narrator = () => null;
  // Seen on Wednesday, asked on Saturday.
  const weekday = app(WALLET, async (address) => ({ outcome: 'report', report: computeMirror(inputFor(address)), cached: false }));
  assert.equal((await request(weekday.server).get('/api/still/mine')).status, 200);
  await new Promise((resolve) => setImmediate(resolve));
  const { server } = app(WALLET, async () => assert.fail('not checked'), async (address) => readingFor(address, SATURDAY));
  const answer = (await ask(server, 'Почему моя сумма займа уменьшилась?')).body.answer;
  assert.match(answer.text, /Сейчас запас для займа — \$662\.53\. На чтении Wed Oct 21 11:00 AM по Нью-Йорку: было \$784\.62, стало \$662\.53/);
  // The causes add up to the change: NVIDIA, Apple and Tesla each counted at 40% of the factor.
  assert.ok(answer.steps.some((step: string) => /Рынок США закрылся, NVIDIA считается по 28\.00% вместо 35\.00%: −\$62\.30/.test(step)));
  assert.equal(answer.steps.filter((step: string) => /Рынок США закрылся/.test(step)).length, 3);
});

test('a script asking hundreds of questions is slowed down', async () => {
  store = createMemoryStillReadingStoreV1();
  stillAgentLlmRuntimeV1.planner = never('the rules read this question');
  stillAgentLlmRuntimeV1.narrator = () => null;
  stillMineRuntimeV1.askLimiter = new InMemoryRateLimiter({ windowMs: 60_000, max: 2 });
  const { server } = app(WALLET, async () => assert.fail('not checked'));
  assert.equal((await ask(server, 'How much interest do I pay a month?')).status, 200);
  assert.equal((await ask(server, 'How much interest do I pay a month?')).status, 200);
  const third = await ask(server, 'How much interest do I pay a month?');
  assert.equal(third.status, 429);
  assert.equal(third.body.outcome, 'rate_limited');
});

test('a reading about another address is our failure and is never answered', async () => {
  store = createMemoryStillReadingStoreV1();
  stillAgentLlmRuntimeV1.planner = () => null;
  stillAgentLlmRuntimeV1.narrator = () => null;
  const { server } = app(WALLET, async () => assert.fail('not checked'), async () => readingFor(`0x${'2'.repeat(40)}`));
  const res = await ask(server, 'Что будет при падении NVDA на 30%?');
  assert.equal(res.status, 500);
  assert.deepEqual(res.body, { ok: false, outcome: 'internal_error' });
});
