import assert from 'node:assert/strict';
import test from 'node:test';

import { ModelBudgetSpentErrorV1, ModelBudgetV1, modelBudgetClientKeyV1 } from './modelBudget.js';

// Audit MCP-5, 2026-11-14: one address with free wallets could hold the shared model lane.

const spent = (scope: ModelBudgetSpentErrorV1['scope']) => (error: unknown) => error instanceof ModelBudgetSpentErrorV1 && error.scope === scope;

test('one address takes at most 20 model calls a minute, whichever wallets it signs in with', async () => {
  const budget = new ModelBudgetV1();
  for (let i = 0; i < 20; i++) await budget.take('ip:198.51.100.7');
  await assert.rejects(budget.take('ip:198.51.100.7'), spent('client'));
  await budget.take('ip:198.51.100.8');
});

test('the server takes at most 60 a minute, however many addresses ask', async () => {
  const budget = new ModelBudgetV1();
  for (let i = 0; i < 60; i++) await budget.take(`ip:203.0.113.${i % 4}${i}`);
  await assert.rejects(budget.take('ip:192.0.2.9'), spent('minute'));
});

test('and at most its day’s calls, back only when the UTC day moves forwards', async () => {
  let now = Date.parse('2026-11-14T23:59:00Z');
  const budget = new ModelBudgetV1({ perDay: 2, now: () => now });
  await budget.take('ip:a');
  await budget.take('ip:b');
  await assert.rejects(budget.take('ip:c'), spent('day'));
  now = Date.parse('2026-11-14T12:00:00Z');
  await assert.rejects(budget.take('ip:c'), spent('day'));
  now = Date.parse('2026-11-15T00:00:01Z');
  await budget.take('ip:c');
});

test('a request is counted under its address', () => {
  assert.equal(modelBudgetClientKeyV1({ ip: '198.51.100.7' }), 'ip:198.51.100.7');
  assert.equal(modelBudgetClientKeyV1({ socket: { remoteAddress: '::1' } }), 'ip:::1');
  assert.equal(modelBudgetClientKeyV1({}), 'ip:unknown');
});
