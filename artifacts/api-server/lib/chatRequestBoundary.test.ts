import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import type { Response } from 'express';
import { ToolAggregator } from '@mioagent/tools';
import { chatRequestBoundaryV1, ChatRequestCancelledV1 } from './chatRequestBoundary.js';

function response() {
  return Object.assign(new EventEmitter(), { writableEnded: false }) as unknown as Response;
}

test('one deadline covers hung setup and closes resources that arrive after it', async (t) => {
  // The response itself normally holds the event loop open; this fixture does not.
  const keepAlive = setTimeout(() => {}, 1000);
  t.after(() => clearTimeout(keepAlive));
  const boundary = chatRequestBoundaryV1(response(), 10);
  t.after(() => boundary.dispose());
  let finish!: (tools: ToolAggregator) => void;
  const pending = boundary.tools(() => new Promise(resolve => { finish = resolve; }));
  await assert.rejects(pending, error => error instanceof ChatRequestCancelledV1 && error.code === 'chat_timeout');
  const tools = new ToolAggregator();
  let closed = 0;
  tools.registerCleanup(() => { closed++; });
  finish(tools);
  await new Promise<void>(resolve => setImmediate(resolve));
  boundary.dispose();
  assert.equal(closed, 1);
});

test('disconnect aborts LLM and tools and prevents the next stage', async (t) => {
  const res = response();
  const boundary = chatRequestBoundaryV1(res);
  t.after(() => boundary.dispose());
  const tools = new ToolAggregator();
  let closed = 0;
  tools.registerCleanup(() => { closed++; });
  await boundary.tools(async () => tools);
  let received: AbortSignal | undefined;
  const llm = boundary.llm({ generate: async request => {
    received = request.signal;
    return new Promise<never>(() => {});
  } });
  const pending = llm.generate({ messages: [] });
  await Promise.resolve();
  res.emit('close');
  await assert.rejects(pending, error => error instanceof ChatRequestCancelledV1 && error.code === 'chat_disconnected');
  assert.equal(received?.aborted, true);
  let nextStage = false;
  await assert.rejects(boundary.wait(() => { nextStage = true; }));
  assert.equal(nextStage, false);
  boundary.dispose();
  assert.equal(closed, 1);
  assert.equal(res.listenerCount('close'), 0);
});

test('normal completion removes the timer and listener without signalling cancellation', async () => {
  const res = response();
  const boundary = chatRequestBoundaryV1(res);
  const tools = new ToolAggregator();
  let closed = 0;
  tools.registerCleanup(() => { closed++; });
  await boundary.tools(async () => tools);
  assert.equal(await boundary.wait(() => 42), 42);
  Object.defineProperty(res, 'writableEnded', { value: true });
  res.emit('close');
  boundary.dispose();
  assert.equal(boundary.signal.aborted, false);
  assert.equal(closed, 1);
  assert.equal(res.listenerCount('close'), 0);
});
