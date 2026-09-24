import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import {
  ExecutionBlueprintV1Schema,
  RouteIntentV1Schema,
  ZERO_HASH_V1,
  hashApprovedCallsV1,
  hashExecutionBlueprintV1,
  hashRouteIntentV1,
  type AssetRefV1,
  type ExecutionBlueprintV1,
  type ExecutionCallV1,
  type RouteIntentV1,
} from '@mioagent/route-domain';

import { InMemoryRouteStorageRepository } from '../src/index.js';

// ---------------------------------------------------------------------------
// A gift from holdings is a run with goal 'send' and one Blueprint, stored in
// the tables every route family shares. Only its own methods write one, and
// the reads that serve a swap serve it too — as Postgres does.
// ---------------------------------------------------------------------------

const WALLET = '0x4de27ead5a3c9aeb58c7f812178ddde282670d70' as const;
const TENANT = `eip155:8453:${WALLET}`;
const FRIEND = '0x8e525bfce1c0ffee00000000000000000000beef' as const;
const NOW = '2026-09-24T12:00:00.000Z';
const NVDA: AssetRefV1 = {
  assetId: 'eip155:8453/erc20:0xb20000000000000000000078ee7ce2fe4908108c',
  chainId: 8453,
  kind: 'erc20',
  address: '0xb20000000000000000000078ee7ce2fe4908108c',
  symbol: 'NVDAc',
  decimals: 8,
};

function sendIntent(id = 'gift-send:one'): RouteIntentV1 {
  const draft: RouteIntentV1 = {
    schemaVersion: 'route-intent/v1',
    id,
    tenantId: TENANT,
    walletAddress: WALLET,
    chainId: 8453,
    createdAt: NOW,
    updatedAt: NOW,
    status: 'ready',
    intentHash: ZERO_HASH_V1,
    goal: 'send',
    fromAsset: NVDA,
    toAsset: null,
    amount: { asset: NVDA, amountAtomic: '44227', amountDecimal: '0.00044227' },
    optimizationMode: 'simplest_route',
    verificationDepth: 'enhanced',
    protocolConstraint: { mode: 'any', protocols: [] },
    slippageConstraint: { maxBps: 0, source: 'policy' },
    executionRequested: true,
  };
  return RouteIntentV1Schema.parse({ ...draft, intentHash: hashRouteIntentV1(draft) });
}

function sendBlueprint(intent: RouteIntentV1, goal: 'send' | 'swap' = 'send'): ExecutionBlueprintV1 {
  const word = (value: string) => value.replace(/^0x/, '').padStart(64, '0');
  const calls: ExecutionCallV1[] = [
    {
      index: 0,
      callType: 'transfer',
      to: NVDA.address as `0x${string}`,
      valueWei: '0',
      data: `0xa9059cbb${word(FRIEND)}${word((44227).toString(16))}` as `0x${string}`,
      asset: NVDA,
      amountAtomic: '44227',
      recipient: FRIEND,
      spender: null,
    },
  ];
  const draft: ExecutionBlueprintV1 = {
    schemaVersion: 'execution-blueprint/v1',
    goal,
    id: `blueprint:${intent.id}`,
    tenantId: TENANT,
    walletAddress: WALLET,
    chainId: 8453,
    createdAt: NOW,
    updatedAt: NOW,
    status: 'ready_for_review',
    intentHash: intent.intentHash,
    selectedCandidateHash: `0x${'5'.repeat(64)}`,
    evidenceSetHash: `0x${'6'.repeat(64)}`,
    blueprintHash: ZERO_HASH_V1,
    callsHash: hashApprovedCallsV1(calls),
    approvedCallsHash: null,
    quoteExpiry: '2026-09-24T12:05:00.000Z',
    calls,
    expectedAssetChanges: [
      { asset: NVDA, direction: 'debit', amountAtomic: '44227', minimumAmountAtomic: '44227', maximumAmountAtomic: '44227' },
    ],
    requiredApprovals: [],
    simulationState: {
      status: 'passed',
      observedAt: NOW,
      blockNumber: '51700000',
      requestHash: `0x${'7'.repeat(64)}`,
      responseHash: `0x${'8'.repeat(64)}`,
      errorCode: null,
    },
    atomicRequired: true,
  };
  return ExecutionBlueprintV1Schema.parse({ ...draft, blueprintHash: hashExecutionBlueprintV1(draft) });
}

describe('send runs', () => {
  test('only the send path writes a send, and it writes nothing else', async () => {
    const repo = new InMemoryRouteStorageRepository();
    const intent = sendIntent();
    await assert.rejects(repo.createRouteRun(intent, 'k-1'), /createSendRouteRun/);
    const run = await repo.createSendRouteRun(intent, intent.id);
    assert.equal(run.goal, 'send');
    assert.equal(run.intent.goal, 'send');
    // Idempotent on the same content; a different payload under the same id is a conflict.
    assert.equal((await repo.createSendRouteRun(intent, intent.id)).id, run.id);
    await assert.rejects(
      repo.createSendRouteRun({ ...intent, amount: { ...intent.amount, amountAtomic: '1' } } as RouteIntentV1, intent.id),
    );
  });

  test('the send getter finds only sends; the shared getter serves it as Postgres does', async () => {
    const repo = new InMemoryRouteStorageRepository();
    const intent = sendIntent();
    await repo.createSendRouteRun(intent, intent.id);
    assert.equal((await repo.getSendRouteRun(intent.id, TENANT))?.intent.goal, 'send');
    assert.equal((await repo.getRouteRun(intent.id, TENANT))?.goal, 'send');
    assert.equal(await repo.getSendRouteRun(intent.id, 'eip155:8453:0x1111111111111111111111111111111111111111'), null);
  });

  test('a send Blueprint is stored on a send run only, and only with goal send', async () => {
    const repo = new InMemoryRouteStorageRepository();
    const intent = sendIntent();
    await repo.createSendRouteRun(intent, intent.id);
    await assert.rejects(repo.insertSendBlueprint(intent.id, sendBlueprint(intent, 'swap')), /send-goal Blueprint/);
    const blueprint = sendBlueprint(intent);
    await repo.insertSendBlueprint(intent.id, blueprint);
    await repo.insertSendBlueprint(intent.id, blueprint);
    assert.deepEqual((await repo.listBlueprints(intent.id, TENANT)).map((entry) => entry.blueprint.id), [blueprint.id]);
    await assert.rejects(repo.insertSendBlueprint('gift-send:missing', blueprint));
  });

  test('history lists a send in words, beside swaps', async () => {
    const repo = new InMemoryRouteStorageRepository();
    const intent = sendIntent();
    await repo.createSendRouteRun(intent, intent.id);
    const page = await repo.listRouteRunHistory(TENANT, { limit: 5 });
    assert.deepEqual(page.items.map((item) => item.intentSummary), ['send 0.00044227 NVDAc']);
  });
});
