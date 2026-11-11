import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { test, mock } from 'node:test';
import {
  baseMcpClientPoolV1,
  type BaseMcpClientLeaseV1,
  type BaseMcpLeaseInputV1,
  type BaseMcpOAuthProvider,
} from '@mioagent/mcp';
import { createToolAggregatorForUser, settingsAPI } from '../src/factory.js';

function options(signal: AbortSignal) {
  return {
    signal,
    baseMcpEnabled: true,
    baseMcpServerUrl: 'https://wallet-mcp.example',
    baseMcpOAuthProvider: {} as BaseMcpOAuthProvider,
    baseMcpOnly: true,
  };
}

test('cancelled factory creation never reads settings or obtains a lease', async () => {
  const controller = new AbortController();
  const reason = new Error('caller_disconnected');
  controller.abort(reason);
  const settings = mock.method(settingsAPI, 'getUserSettings', async () => null);
  const lease = mock.method(baseMcpClientPoolV1(), 'lease', async () => {
    throw new Error('unexpected_lease');
  });
  try {
    await assert.rejects(
      createToolAggregatorForUser('cancelled-before-start', 'test-secret', options(controller.signal)),
      (error: unknown) => error === reason,
    );
    assert.equal(settings.mock.callCount(), 0);
    assert.equal(lease.mock.callCount(), 0);
  } finally {
    settings.mock.restore();
    lease.mock.restore();
  }
});

test('factory cancellation stops waiting for settings and removes its listener', async () => {
  const controller = new AbortController();
  const reason = new Error('caller_disconnected');
  let started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  const settings = mock.method(settingsAPI, 'getUserSettings', () => {
    started();
    return new Promise<never>(() => undefined);
  });
  try {
    const creating = createToolAggregatorForUser('cancelled-settings', 'test-secret', options(controller.signal));
    const rejected = assert.rejects(creating, (error: unknown) => error === reason);
    await ready;
    controller.abort(reason);
    await rejected;
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  } finally {
    settings.mock.restore();
  }
});

test('a lease arriving after cancellation is returned without discovering tools', async () => {
  const controller = new AbortController();
  const reason = new Error('caller_disconnected');
  let started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  let deliver!: (lease: BaseMcpClientLeaseV1) => void;
  let returned = 0;
  let listed = 0;
  const lateLease: BaseMcpClientLeaseV1 = {
    async close() { returned += 1; },
    getClient: () => ({
      callTool: async () => ({ content: [] }),
      listTools: async () => { listed += 1; return { tools: [] }; },
    }),
  };
  const settings = mock.method(settingsAPI, 'getUserSettings', async () => ({ protocolToggles: {} }));
  const lease = mock.method(baseMcpClientPoolV1(), 'lease', (input: BaseMcpLeaseInputV1) => {
    assert.equal(input.signal, controller.signal);
    started();
    return new Promise<BaseMcpClientLeaseV1>((resolve) => { deliver = resolve; });
  });
  try {
    const creating = createToolAggregatorForUser('cancelled-late-lease', 'test-secret', options(controller.signal));
    const rejected = assert.rejects(creating, (error: unknown) => error === reason);
    await ready;
    controller.abort(reason);
    await rejected;
    deliver(lateLease);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(returned, 1);
    assert.equal(listed, 0);
  } finally {
    settings.mock.restore();
    lease.mock.restore();
  }
});

test('cancellation during discovery promptly returns only the request lease', async () => {
  const controller = new AbortController();
  const reason = new Error('caller_disconnected');
  let listing!: () => void;
  const ready = new Promise<void>((resolve) => { listing = resolve; });
  let returned = 0;
  let observedSignal: AbortSignal | undefined;
  const requestLease: BaseMcpClientLeaseV1 = {
    async close() { returned += 1; },
    getClient: () => ({
      callTool: async () => ({ content: [] }),
      listTools: (_params, requestOptions) => {
        observedSignal = requestOptions?.signal;
        listing();
        return new Promise<never>(() => undefined);
      },
    }),
  };
  const settings = mock.method(settingsAPI, 'getUserSettings', async () => ({ protocolToggles: {} }));
  const lease = mock.method(baseMcpClientPoolV1(), 'lease', async () => requestLease);
  try {
    const creating = createToolAggregatorForUser('cancelled-discovery', 'test-secret', options(controller.signal));
    const rejected = assert.rejects(creating, (error: unknown) => error === reason);
    await ready;
    controller.abort(reason);
    await rejected;
    assert.equal(observedSignal, controller.signal);
    assert.equal(returned, 1);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  } finally {
    settings.mock.restore();
    lease.mock.restore();
  }
});

test('normal aggregator close returns its lease once and removes cancellation listeners', async () => {
  const controller = new AbortController();
  let returned = 0;
  const requestLease: BaseMcpClientLeaseV1 = {
    async close() { returned += 1; },
    getClient: () => ({
      callTool: async () => ({ content: [] }),
      listTools: async () => ({ tools: [] }),
    }),
  };
  const settings = mock.method(settingsAPI, 'getUserSettings', async () => ({ protocolToggles: {} }));
  const lease = mock.method(baseMcpClientPoolV1(), 'lease', async () => requestLease);
  try {
    const aggregator = await createToolAggregatorForUser('normal-close', 'test-secret', options(controller.signal));
    assert.equal(getEventListeners(controller.signal, 'abort').length, 1);
    await aggregator.close();
    await aggregator.close();
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    controller.abort(new Error('later'));
    assert.equal(returned, 1);
  } finally {
    settings.mock.restore();
    lease.mock.restore();
  }
});
