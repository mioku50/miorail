import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { LlmChainExhaustedError, LlmHttpError } from '@mioagent/llm';

import { isPlannerFaultV1, routePlanFaultV1 } from './routePlanFault.js';

const CODES = { planner: 'route_planner_unavailable', server: 'route_plan_evaluation_failed' };

describe('whose failure it was — ours or the market’s', () => {
  // 2026-09-06: api.mistral.ai answered every request 429 with
  // `x-ratelimit-limit-req-minute: 0`, the structured lane had no spare, and
  // every comparison returned one code that the console draws as a market
  // with no route.
  test('a language-model failure is named as ours, and asks to be retried', () => {
    for (const error of [
      new LlmHttpError(429, 'Rate limit exceeded'),
      new LlmChainExhaustedError([{ label: 'mistral', error: new LlmHttpError(429, 'x') }]),
    ]) {
      assert.equal(isPlannerFaultV1(error), true, error.name);
      const fault = routePlanFaultV1(error, CODES);
      assert.equal(fault.code, 'route_planner_unavailable');
      assert.equal(fault.status, 503, 'a lane that is away asks to be tried again');
      assert.equal(fault.stage, 'planner');
    }
  });

  test('everything else keeps the code and the status it had', () => {
    const fault = routePlanFaultV1(new Error('storage unavailable'), CODES);
    assert.equal(fault.code, 'route_plan_evaluation_failed');
    assert.equal(fault.status, 500);
    assert.equal(fault.stage, 'server');
  });

  test('neither detail is a finding about the market', () => {
    for (const error of [new LlmHttpError(429, 'Rate limit exceeded'), new Error('boom')]) {
      const fault = routePlanFaultV1(error, CODES);
      assert.match(fault.detail, /othing here is a finding about this pair/);
      assert.match(fault.detail, /Nothing was signed or spent\./);
    }
  });

  // The detail crosses the wire to a browser. A provider's own message can
  // carry a host, a model name or an upstream body, and none of that is the
  // reader's business or safe to publish.
  test('no provider message reaches the detail', () => {
    const fault = routePlanFaultV1(new LlmHttpError(401, 'invalid api key sk-secret at api.example'), CODES);
    assert.doesNotMatch(fault.detail, /sk-|api\.example|invalid api key/);
  });

  // Matched by name because the error crosses a package boundary: a second
  // copy of @mioagent/llm would make `instanceof` quietly false, which is the
  // exact class of silent failure this module exists to remove.
  test('a same-named error from another realm is still ours', () => {
    const foreign = new Error('OpenAI API error (429): Rate limit exceeded');
    foreign.name = 'LlmHttpError';
    assert.equal(isPlannerFaultV1(foreign), true);
    assert.equal(isPlannerFaultV1('not an error'), false);
    assert.equal(isPlannerFaultV1(null), false);
  });
});
