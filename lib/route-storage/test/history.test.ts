import assert from 'node:assert/strict';
import test from 'node:test';
import {
  RouteIntentV1Schema,
  ZERO_HASH_V1,
  hashRouteIntentV1,
  type AssetRefV1,
  type RouteIntentV1,
} from '@mioagent/route-domain';
import {
  InMemoryRouteStorageRepository,
  RouteStorageIntegrityError,
  decodeRouteHistoryCursorV1,
  encodeRouteHistoryCursorV1,
  summarizeRouteIntentV1,
} from '../src/index.js';

const TENANT = 'tenant-history';
const OTHER_TENANT = 'tenant-other';
const WALLET = '0x1111111111111111111111111111111111111111';

const USDC: AssetRefV1 = {
  assetId: 'eip155:8453/erc20:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
  chainId: 8453,
  kind: 'erc20',
  address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
  symbol: 'USDC',
  decimals: 6,
};
const WETH: AssetRefV1 = {
  assetId: 'eip155:8453/erc20:0x4200000000000000000000000000000000000006',
  chainId: 8453,
  kind: 'erc20',
  address: '0x4200000000000000000000000000000000000006',
  symbol: 'WETH',
  decimals: 18,
};

function intentAt(id: string, createdAt: string, tenantId = TENANT): RouteIntentV1 {
  const draft: RouteIntentV1 = {
    schemaVersion: 'route-intent/v1',
    id,
    tenantId,
    walletAddress: WALLET,
    chainId: 8453,
    createdAt,
    updatedAt: createdAt,
    status: 'ready',
    intentHash: ZERO_HASH_V1,
    goal: 'swap',
    fromAsset: USDC,
    toAsset: WETH,
    amount: { asset: USDC, amountAtomic: '100000000', amountDecimal: '100' },
    optimizationMode: 'best_net_result',
    verificationDepth: 'standard',
    protocolConstraint: { mode: 'any', protocols: [] },
    slippageConstraint: { maxBps: 50, source: 'user' },
    executionRequested: false,
  };
  return RouteIntentV1Schema.parse({ ...draft, intentHash: hashRouteIntentV1(draft) });
}

async function seededHistoryRepository(): Promise<InMemoryRouteStorageRepository> {
  const repository = new InMemoryRouteStorageRepository();
  // Five runs for TENANT (2026-07-10 .. 2026-07-14) and one for OTHER_TENANT.
  for (let day = 10; day <= 14; day += 1) {
    const intent = intentAt(`run-${day}`, `2026-07-${day}T09:00:00.000Z`);
    await repository.createRouteRun(intent, `run-${day}:idempotency`);
  }
  await repository.createRouteRun(
    intentAt('run-other', '2026-07-13T10:00:00.000Z', OTHER_TENANT),
    'run-other:idempotency',
  );
  return repository;
}

test('history: newest-first order and keyset pagination with a stable opaque cursor', async () => {
  const repository = await seededHistoryRepository();

  const first = await repository.listRouteRunHistory(TENANT, { limit: 2 });
  assert.deepEqual(first.items.map((item) => item.routeRunId), ['run-14', 'run-13']);
  assert.ok(first.nextCursor);

  const second = await repository.listRouteRunHistory(TENANT, { limit: 2, cursor: first.nextCursor });
  assert.deepEqual(second.items.map((item) => item.routeRunId), ['run-12', 'run-11']);
  assert.ok(second.nextCursor);

  const third = await repository.listRouteRunHistory(TENANT, { limit: 2, cursor: second.nextCursor });
  assert.deepEqual(third.items.map((item) => item.routeRunId), ['run-10']);
  assert.equal(third.nextCursor, null);
});

test('history: an exact-limit last page returns nextCursor null', async () => {
  const repository = await seededHistoryRepository();
  const page = await repository.listRouteRunHistory(TENANT, { limit: 5 });
  assert.equal(page.items.length, 5);
  assert.equal(page.nextCursor, null);
});

test('history: tenant isolation — one tenant never sees another tenant\'s runs', async () => {
  const repository = await seededHistoryRepository();
  const mine = await repository.listRouteRunHistory(TENANT, { limit: 50 });
  assert.equal(mine.items.length, 5);
  assert.ok(mine.items.every((item) => item.routeRunId !== 'run-other'));

  const theirs = await repository.listRouteRunHistory(OTHER_TENANT, { limit: 50 });
  assert.deepEqual(theirs.items.map((item) => item.routeRunId), ['run-other']);
});

test('history: an invalid cursor fails closed with a typed integrity error', async () => {
  const repository = await seededHistoryRepository();
  await assert.rejects(
    () => repository.listRouteRunHistory(TENANT, { limit: 5, cursor: 'not-a-cursor!!' }),
    RouteStorageIntegrityError,
  );
  await assert.rejects(
    () =>
      repository.listRouteRunHistory(TENANT, {
        limit: 5,
        cursor: Buffer.from(JSON.stringify({ createdAt: 'not-a-date', id: 42 }), 'utf8').toString('base64url'),
      }),
    RouteStorageIntegrityError,
  );
});

test('history: cursor round-trips and item carries an intent summary with null blueprint/proof fields', async () => {
  const repository = await seededHistoryRepository();
  const page = await repository.listRouteRunHistory(TENANT, { limit: 1 });
  const item = page.items[0]!;
  assert.equal(item.routeRunId, 'run-14');
  assert.equal(item.runStatus, 'ready');
  assert.equal(item.intentSummary, 'swap 100 USDC -> WETH');
  assert.equal(item.blueprintId, null);
  assert.equal(item.blueprintStatus, null);
  assert.equal(item.proofId, null);
  assert.equal(item.proofFinalStatus, null);
  assert.equal(item.reconciliationState, null);

  const decoded = decodeRouteHistoryCursorV1(page.nextCursor!);
  assert.equal(decoded.id, 'run-14');
  assert.equal(encodeRouteHistoryCursorV1(decoded), page.nextCursor);
});

test('history: items are enriched with the run blueprint and proof when present', async () => {
  const { createRouteStorageFixtureGraph } = await import('./fixture-graph.js');
  const { persistFixtureGraph } = await import('./repository-contract.js');
  const repository = new InMemoryRouteStorageRepository();
  const graph = createRouteStorageFixtureGraph();
  await persistFixtureGraph(repository, graph, {});

  const page = await repository.listRouteRunHistory(graph.intent.tenantId, { limit: 10 });
  const item = page.items.find((entry) => entry.routeRunId === graph.intent.id);
  assert.ok(item);
  assert.equal(item!.blueprintId, graph.blueprint.id);
  assert.equal(item!.blueprintStatus, graph.blueprint.status);
  assert.ok(item!.proofId);
  assert.ok(item!.proofFinalStatus);
  assert.ok(item!.reconciliationState);
});

test('history: summarizeRouteIntentV1 falls back to intentHash without a full intent', () => {
  assert.equal(
    summarizeRouteIntentV1({ goal: null, fromAsset: null, toAsset: null, amount: null, intentHash: '0xabc' }),
    '0xabc',
  );
});
