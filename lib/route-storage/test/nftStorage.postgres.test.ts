import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test, { after, before, describe } from 'node:test';

import postgres from 'postgres';
import { buildNftProofEventV1 } from '@mioagent/nft-engine';

import { nftIdempotencyKeyV1 } from '../src/nft.js';
import { createDatabaseNftStorageRepository } from '../src/nftDatabase.js';
import type { SqlTemplateExecutor } from '../src/types.js';
import {
  NFT_BUYER,
  NFT_COLLECTION,
  NFT_NOW,
  NFT_TENANT,
  NFT_TOKEN_ID,
  nftFixtureGraph,
  nftProofFixture,
} from './nft-fixture.js';

// ---------------------------------------------------------------------------
// The NFT repository against real Postgres, through the driver production
// uses. The in-memory twin is tested beside the other NFT invariants; what
// only a database shows is here.
//
//   MIOAGENT_MIGRATION_TEST_URL=postgres://postgres:x@127.0.0.1:55437/t \
//     npx tsx --test lib/route-storage/test/nftStorage.postgres.test.ts
// ---------------------------------------------------------------------------

const url = process.env.MIOAGENT_MIGRATION_TEST_URL?.trim();
const throwaway = Boolean(url && /(localhost|127\.0\.0\.1)/.test(url) && !/neon|amazonaws/i.test(url));

let sql: ReturnType<typeof postgres> | null = null;

function drizzleDir(): string {
  const cwd = process.cwd();
  if (cwd.endsWith('lib/db')) return resolve(cwd, 'drizzle');
  if (cwd.endsWith('lib/route-storage')) return resolve(cwd, '..', 'db', 'drizzle');
  return resolve(cwd, 'lib', 'db', 'drizzle');
}

before(async () => {
  if (!throwaway) return;
  // Unprepared, as production's shared client is (lib/db).
  sql = postgres(url!, { max: 1, prepare: false, onnotice: () => {} });
  await sql.unsafe(`
    DROP TABLE IF EXISTS nft_proof_events, nft_proofs, nft_purchase_blueprints, nft_route_cards,
      nft_evidence, nft_candidates, route_runs, users CASCADE;
    CREATE TABLE users (
      id text PRIMARY KEY NOT NULL,
      created_at timestamp DEFAULT now() NOT NULL,
      updated_at timestamp DEFAULT now() NOT NULL
    );
    -- The columns of 0012_t51_route_storage.sql with the goal 0014 added; 0017
    -- below rewrites the goal check itself.
    CREATE TABLE route_runs (
      id text PRIMARY KEY NOT NULL,
      user_id text NOT NULL,
      wallet_address text NOT NULL,
      chain_id integer NOT NULL,
      goal text DEFAULT 'swap' NOT NULL,
      schema_version text NOT NULL,
      status text NOT NULL,
      intent_hash text NOT NULL,
      intent_payload jsonb NOT NULL,
      idempotency_key text NOT NULL,
      created_at timestamp with time zone DEFAULT now() NOT NULL,
      updated_at timestamp with time zone DEFAULT now() NOT NULL,
      completed_at timestamp with time zone
    );
    CREATE UNIQUE INDEX route_runs_user_idempotency_unique ON route_runs (user_id, idempotency_key);
  `);
  for (const file of ['0017_t65_nft_storage.sql', '0018_t65_nft_submission.sql', '0019_t65_nft_submission_states.sql']) {
    const migration = await readFile(resolve(drizzleDir(), file), 'utf8');
    await sql.unsafe(migration.replaceAll('--> statement-breakpoint', ''));
  }
});

after(async () => {
  await sql?.end({ timeout: 5 });
});

if (!throwaway) {
  describe('postgres NFT storage', () => {
    test('skipped: set MIOAGENT_MIGRATION_TEST_URL to a throwaway local database', () => {});
  });
} else {
  // What lib/db's client does: postgres-js is handed ISO strings, never a Date.
  const asExecutor = (run: unknown): SqlTemplateExecutor => (strings, ...values) =>
    (run as (strings: TemplateStringsArray, ...values: unknown[]) => Promise<Record<string, unknown>[]>)(
      strings,
      ...values.map((value) => (value instanceof Date ? value.toISOString() : value)),
    );

  /** One purchase as far as its pending proof, written through the repository. */
  async function prepared() {
    await sql!.unsafe(
      'TRUNCATE nft_proof_events, nft_proofs, nft_purchase_blueprints, nft_route_cards, nft_evidence, nft_candidates, route_runs, users CASCADE',
    );
    await sql!`INSERT INTO users (id) VALUES (${NFT_TENANT})`;
    const repository = createDatabaseNftStorageRepository(asExecutor(sql));
    const graph = nftFixtureGraph();
    const key = nftIdempotencyKeyV1({
      tenantId: NFT_TENANT,
      walletAddress: NFT_BUYER,
      contractAddress: NFT_COLLECTION,
      tokenId: NFT_TOKEN_ID,
      maxSpendWei: '10000000000000000',
      requestId: 'req-1',
    });
    await repository.createNftRouteRun(graph.intent, key);
    await repository.insertNftCandidate(graph.intent.id, graph.candidate);
    for (const record of graph.evidence) await repository.insertNftEvidence(graph.intent.id, record);
    await repository.insertNftRouteCard(graph.intent.id, graph.card);
    const reserved = await repository.reserveNftPurchaseBlueprint({
      routeRunId: graph.intent.id,
      routeCardId: graph.card.id,
      userId: NFT_TENANT,
      blueprint: graph.blueprint,
    });
    const pending = nftProofFixture(graph.blueprint, 'submitted');
    const record = await repository.upsertNftProof({
      routeRunId: graph.intent.id,
      blueprintId: reserved.record.id,
      userId: NFT_TENANT,
      proof: pending,
    });
    return { repository, graph, record, blueprintId: reserved.record.id };
  }

  describe('postgres NFT storage', () => {
    test('what the repository writes it reads back, on the driver production uses', async () => {
      // postgres-js stores a JSON text under `CAST(… AS jsonb)` as a string
      // scalar and hands it back as a string; read raw, the run failed its
      // contract before anything else could be written.
      const { repository, graph, record, blueprintId } = await prepared();
      assert.equal((await repository.getNftRouteRun(graph.intent.id, NFT_TENANT))!.intentHash, graph.intent.intentHash);
      assert.equal((await repository.listNftCandidates(graph.intent.id, NFT_TENANT)).length, 1);
      assert.equal((await repository.listNftEvidence(graph.intent.id, NFT_TENANT)).length, graph.evidence.length);
      assert.equal((await repository.listNftRouteCards(graph.intent.id, NFT_TENANT)).length, 1);
      assert.equal((await repository.getNftPurchaseBlueprint(blueprintId, NFT_TENANT))!.blueprint.blueprintHash, graph.blueprint.blueprintHash);
      assert.equal((await repository.getNftProof(record.id, NFT_TENANT))!.proof.finalStatus, 'pending');
      const event = buildNftProofEventV1({ proof: record.proof, sequence: 0, eventKind: 'submission_recorded', detail: null, now: NFT_NOW });
      await repository.appendNftProofEvent(record.id, NFT_TENANT, event);
      assert.deepEqual((await repository.listNftProofEvents(record.id, NFT_TENANT)).map((row) => row.eventHash), [event.eventHash]);
    });
  });
}
