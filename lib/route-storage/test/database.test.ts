import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { client, closeDb } from '@mioagent/db';
import {
  AddressV1Schema,
  RouteCandidateV1Schema,
  RouteIntentV1Schema,
} from '@mioagent/route-domain';
import {
  createDatabaseRouteStorageRepository,
  RouteStorageConflictError,
  type SqlTemplateExecutor,
} from '../src/index.js';
import { createRouteStorageFixtureGraph } from './fixture-graph.js';
import {
  assertFixtureGraphRoundTrip,
  duplicateCandidate,
  duplicateRunIntent,
  persistFixtureGraph,
} from './repository-contract.js';

const databaseSuite = process.env.MIOAGENT_TEST_SUITE === 'db';
const sql: SqlTemplateExecutor = (strings, ...values) => client(strings, ...values);

function databaseFixtureContext(): { tenantId: string; fixtureId: (label: string) => string } {
  const runId = process.env.MIOAGENT_TEST_RUN_ID?.trim();
  const tenantId = process.env.MIOAGENT_TEST_TENANT_ID?.trim();
  if (!runId || !tenantId || !tenantId.includes(runId)) {
    throw new Error('Route storage DB fixtures require a run-scoped test tenant');
  }
  return {
    tenantId,
    fixtureId: (label) => `mio-test:${runId}:${label}`,
  };
}

test(
  'database repository matches the in-memory contract and fails closed on invalid JSONB',
  { skip: !databaseSuite },
  async () => {
    const { tenantId, fixtureId } = databaseFixtureContext();
    const prefix = fixtureId('route-storage');
    const walletAddress = AddressV1Schema.parse(process.env.MIOAGENT_TEST_WALLET);
    const graph = createRouteStorageFixtureGraph(tenantId, prefix, walletAddress);
    const preparedTransactionActionId = fixtureId('route-storage-prepared');
    const x402ReceiptId = fixtureId('route-storage-x402');

    await sql`
      INSERT INTO users (id, created_at, updated_at)
      VALUES (${tenantId}, now(), now())
      ON CONFLICT (id) DO NOTHING
    `;
    await sql`
      INSERT INTO prepared_transaction_intents (
        action_id, user_id, wallet_address, normalized_intent_hash,
        prepared_payload_hash, normalized_intent, prepared_payload,
        status, expires_at, created_at, updated_at
      ) VALUES (
        ${preparedTransactionActionId}, ${tenantId}, ${walletAddress},
        ${graph.intent.intentHash}, ${graph.blueprint.callsHash},
        CAST(${JSON.stringify({ fixture: true })} AS jsonb),
        CAST(${JSON.stringify({ fixture: true })} AS jsonb),
        'pending', ${new Date('2026-07-15T10:00:00.000Z')}, now(), now()
      )
    `;
    await sql`
      INSERT INTO spend_permissions (
        id, user_id, chain_id, asset, "limit", spent, whitelist,
        expires_at, is_active, created_at, updated_at
      ) VALUES (
        ${graph.intelligenceCharge.spendPermissionId}, ${tenantId}, 8453, 'USDC',
        1, 0, CAST(${JSON.stringify([])} AS jsonb),
        ${new Date('2026-07-16T09:00:00.000Z')}, true, now(), now()
      )
    `;
    const receiptPayload = { fixture: true, state: 'unchanged' };
    await sql`
      INSERT INTO x402_receipts (id, user_id, receipt, created_at, updated_at)
      VALUES (
        ${x402ReceiptId}, ${tenantId}, CAST(${JSON.stringify(receiptPayload)} AS jsonb),
        now(), now()
      )
    `;

    const repository = createDatabaseRouteStorageRepository(sql);
    const links = { preparedTransactionActionId, x402ReceiptId };
    await persistFixtureGraph(repository, graph, links);
    await assertFixtureGraphRoundTrip(repository, graph, links);

    await repository.insertCandidate(graph.intent.id, graph.uniswapCandidate);
    const conflictingCandidate = RouteCandidateV1Schema.parse(
      duplicateCandidate(graph.uniswapCandidate, `${graph.uniswapCandidate.id}:conflict`),
    );
    await assert.rejects(
      repository.insertCandidate(graph.intent.id, conflictingCandidate),
      RouteStorageConflictError,
    );

    const repeatedIntent = RouteIntentV1Schema.parse(
      duplicateRunIntent(graph.intent, `${graph.intent.id}:repeated`),
    );
    await repository.createRouteRun(repeatedIntent, `${repeatedIntent.id}:idempotency`);
    const repeatedCandidate = RouteCandidateV1Schema.parse(
      duplicateCandidate(graph.uniswapCandidate, `${graph.uniswapCandidate.id}:repeated`),
    );
    await repository.insertCandidate(repeatedIntent.id, repeatedCandidate);
    assert.equal(repeatedIntent.intentHash, graph.intent.intentHash);
    assert.equal(repeatedCandidate.candidateHash, graph.uniswapCandidate.candidateHash);

    await assert.rejects(
      repository.appendProofEvent(graph.completedProof.id, graph.proofEvents[0]!),
      RouteStorageConflictError,
    );

    assert.equal(await repository.getRouteRun(graph.intent.id, 'another-user'), null);
    assert.deepEqual(await repository.listCandidates(graph.intent.id, 'another-user'), []);

    const permissionRows = await sql`
      SELECT spent
      FROM spend_permissions
      WHERE id = ${graph.intelligenceCharge.spendPermissionId}
    `;
    assert.equal(Number(permissionRows[0]?.spent), 0);
    const receiptRows = await sql`
      SELECT receipt
      FROM x402_receipts
      WHERE id = ${x402ReceiptId}
    `;
    assert.deepEqual(receiptRows[0]?.receipt, receiptPayload);

    await sql`
      UPDATE route_candidates
      SET payload = CAST(${JSON.stringify({ schemaVersion: 'route-candidate/v1' })} AS jsonb)
      WHERE id = ${graph.uniswapCandidate.id} AND user_id = ${tenantId}
    `;
    await assert.rejects(repository.listCandidates(graph.intent.id, tenantId));
  },
);

after(async () => {
  if (databaseSuite) await closeDb();
});
