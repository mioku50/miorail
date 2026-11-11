import assert from 'node:assert/strict';
import { test } from 'node:test';

// Audit SPEND-2 (2026-11-10). The order's query is run here as a page runs it, by the query library
// itself. That library polls only where there is a window, and decides so when it is first loaded, so
// this file names one before loading it; every other test of this package runs without.
(globalThis as { window?: unknown }).window ??= { addEventListener() {}, removeEventListener() {} };

test('a Still Spend order is asked for on its interval until the server says settled, and then no more', async (t) => {
  const { QueryClient, QueryObserver } = await import('@tanstack/react-query');
  const { stillSpendOrderQueryV1 } = await import('./index.js');
  const answer = { status: 'pending', settled: false };
  let reads = 0;
  const realFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = realFetch; });
  globalThis.fetch = (async () => {
    reads++;
    return new Response(JSON.stringify({ order: { orderId: 'o' }, status: { status: answer.status }, statusError: null, settled: answer.settled }),
      { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  // Nothing is kept after its last reader leaves, so no timer outlives this test.
  const client = new QueryClient({ defaultOptions: { queries: { gcTime: 0 } } });
  const settle = (ms: number) => new Promise((done) => setTimeout(done, ms));

  const observer = new QueryObserver(client, stillSpendOrderQueryV1('6654a2ea-0df7-4f44-bc72-c1c6ad8b7b34', { refetchInterval: 20 }));
  const leave = observer.subscribe(() => undefined);
  await settle(200);
  assert.ok(reads >= 3, `asked ${reads} times while the invoice could still move`);
  Object.assign(answer, { status: 'denied', settled: true });
  await settle(120);
  const after = reads;
  await settle(250);
  assert.equal(reads, after, 'a settled invoice is not asked about again');
  assert.equal((observer.getCurrentResult().data as { settled: boolean }).settled, true);

  // A page that names no interval reads once.
  reads = 0;
  const quiet = new QueryObserver(client, stillSpendOrderQueryV1('11111111-2222-4333-8444-555555555555'));
  const leaveQuiet = quiet.subscribe(() => undefined);
  await settle(150);
  assert.equal(reads, 1);
  leave();
  leaveQuiet();
  client.clear();
});
