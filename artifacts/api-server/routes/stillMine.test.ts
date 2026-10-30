import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import express from 'express';
import request from 'supertest';
import type { MirrorOutcome, MirrorService } from '@mioagent/still-engine';

import { computeMirror } from '@mioagent/still-engine';
import { stillTerms } from '@mioagent/still-engine/terms';
import { EXAMPLE, calendar, snapshot, universe } from '../../../lib/still-engine/test/fixtures.js';
import { stillAgentLlmRuntimeV1 } from '../lib/stillAgentServer.js';
import { stillMineRouter, stillMineRuntimeV1 } from './stillMine.js';

const original = { ...stillMineRuntimeV1 };
const originalLlm = { ...stillAgentLlmRuntimeV1 };
afterEach(() => {
  Object.assign(stillMineRuntimeV1, original);
  Object.assign(stillAgentLlmRuntimeV1, originalLlm);
});

const WALLET = `0x${'1'.repeat(40)}`;

function app(wallet: string | null, answer: (input: string) => Promise<MirrorOutcome>) {
  const asked: string[] = [];
  const service: MirrorService = {
    check: async (input) => {
      asked.push(input);
      return answer(input);
    },
    earnings: async () => ({ ok: false }),
  };
  stillMineRuntimeV1.service = () => service;
  const server = express();
  server.use((req, _res, next) => {
    Object.assign(req, { session: { user: wallet ? { id: `eip155:8453:${wallet}`, address: wallet, chainId: 8453 } : null } });
    next();
  });
  server.use('/api/still', stillMineRouter);
  return { server, asked };
}

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

function fullMirrorReportFor(address: string) {
  return JSON.parse(
    JSON.stringify(
      computeMirror({
        subject: { address: address as `0x${string}`, name: null, input: address },
        universe: universe(),
        snapshot: snapshot(EXAMPLE),
        calendar: calendar(),
        assembledAt: new Date('2026-10-21T15:00:01Z'),
      }),
    ),
  );
}

test('POST /api/still/agent/ask enforces wallet session and enriches Risk Engine answers via OpenRouter while rejecting unsafe claims', async () => {
  const walletReport = fullMirrorReportFor(WALLET);

  // 1. Unsigned request -> 401
  const unsigned = app(null, async () => assert.fail('not asked'));
  assert.equal(
    (await request(unsigned.server).post('/api/still/agent/ask').send({ question: 'Что будет при падении NVDA на 30%?' })).status,
    401,
  );

  // 2. Mismatched wallet report -> 403
  const mismatch = app(WALLET, async () => assert.fail('not asked'));
  const wrongReport = fullMirrorReportFor(`0x${'2'.repeat(40)}`);
  assert.equal(
    (await request(mismatch.server).post('/api/still/agent/ask').send({
      question: 'Что будет при падении NVDA на 30%?',
      report: wrongReport,
    })).status,
    403,
  );

  // 3. Valid hybrid Risk Engine + OpenRouter synthesis
  stillAgentLlmRuntimeV1.provider = () => ({
    generate: async (req) => {
      assert.equal(req.reasoningEffort, 'none');
      return {
        message: {
          role: 'assistant',
          content:
            'При падении NVIDIA на 30% (до $148.33) ваш займ $240.17 останется безопасным: Health Factor снизится с 2.09 до 1.46, сохраняя 31% запаса до порога ликвидации $100.92.',
        },
      };
    },
  });
  const hybrid = app(WALLET, async () => ({ outcome: 'report', report: walletReport, cached: false }));
  const okRes = await request(hybrid.server).post('/api/still/agent/ask').send({
    question: 'Что будет при падении NVDA на 30%?',
    report: walletReport,
  });
  assert.equal(okRes.status, 200);
  assert.equal(okRes.body.ok, true);
  assert.equal(okRes.body.answer.mode, 'analysis');
  assert.match(okRes.body.answer.text, /Health Factor снизится с 2\.09 до 1\.46/);
  assert.ok(okRes.body.answer.sources.some((s: string) => /OpenRouter/.test(s)));

  // 4. Rejects hallucinated autonomous execution claim on action_prep and preserves deterministic boundary
  stillAgentLlmRuntimeV1.provider = () => ({
    generate: async () => ({
      message: {
        role: 'assistant',
        content: 'Я уже подписал и отправил $500 вашему другу.',
      },
    }),
  });
  const boundaryRes = await request(hybrid.server).post('/api/still/agent/ask').send({
    question: 'Займи $500 и отправь другу',
    report: walletReport,
  });
  assert.equal(boundaryRes.status, 200);
  assert.equal(boundaryRes.body.answer.mode, 'action_prep');
  assert.match(boundaryRes.body.answer.text, /не исполняю транзакции автоматически/);
  assert.equal(boundaryRes.body.answer.actionLink?.href, '/borrow');
});
