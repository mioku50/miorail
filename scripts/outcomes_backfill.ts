import { client, closeDb } from '@mioagent/db';
import {
  createRouteOutcomeProjectorV1,
  type OutcomeProjectionResultV1,
} from '@mioagent/route-outcomes';
import {
  createDatabaseProviderOutcomeRepository,
  createDatabaseRouteStorageRepository,
} from '@mioagent/route-storage';

import { loadRootEnvFileV1, reportLoadedEnvFileV1 } from './loadEnvFile.js';
import { parseOutcomeCliArgsV1, printOutcomeCliUsageV1 } from './outcomesCli.js';

// ---------------------------------------------------------------------------
// T67C.1 §4 — `pnpm outcomes:backfill [-- --dry-run --provider=uniswap ...]`
//
// Derives the outcome rows that the projector should have written, for proofs
// that are already terminal. It exists because the projector is allowed to fail
// quietly: a statistics table being down must never fail a reconcile, so the
// repair has to be a separate, deliberate act.
//
// What it will NOT do, by construction rather than by intention:
//
//   * touch the chain. It reads proofs the reconciler already verified; if a
//     proof's receipts were never resolved there is nothing here to fix, and
//     re-reading the chain would make this a second reconciler.
//   * modify a Proof, a Route Card or a score snapshot. It only inserts
//     missing outcomes.
//   * overwrite an existing outcome. A disagreement is reported, not repaired.
//
// A second run over the same range changes nothing. That is the property that
// makes it safe to run from cron, and it is asserted by the counts it prints.
// ---------------------------------------------------------------------------

interface BackfillTotalsV1 {
  scanned: number;
  recorded: number;
  alreadyRecorded: number;
  skipped: number;
  conflicts: number;
  failures: number;
}

async function main(): Promise<void> {
  const args = parseOutcomeCliArgsV1(process.argv.slice(2));
  if (args.help) {
    printOutcomeCliUsageV1('outcomes:backfill');
    return;
  }

  console.log('T67C.1 outcome backfill');
  reportLoadedEnvFileV1(loadRootEnvFileV1());
  if (args.dryRun) {
    console.log('   · DRY RUN — nothing will be written');
  }

  const repository = createDatabaseRouteStorageRepository(client);
  const outcomes = createDatabaseProviderOutcomeRepository(client);

  // Terminal proofs only, oldest first, with the run that owns them. The three
  // statuses are the same set the contract accepts — cancelled and every
  // unresolved state are excluded here as well as there, so a backfill can
  // never record something a live projection would have refused.
  // `route_run_id` is the column's real name (migration 0012). Aliased rather
  // than renamed below so the SQL names what Postgres has and the loop names
  // what it means.
  const rows = (await client`
    SELECT p.id AS proof_id, p.route_run_id AS run_id, p.user_id
    FROM route_proofs p
    WHERE p.status IN ('completed', 'partial_failure', 'failed')
      AND (${args.from?.toISOString() ?? null}::timestamptz IS NULL OR p.updated_at >= ${args.from?.toISOString() ?? null})
      AND (${args.to?.toISOString() ?? null}::timestamptz IS NULL OR p.updated_at <= ${args.to?.toISOString() ?? null})
    ORDER BY p.updated_at ASC
    LIMIT ${args.limit ?? 10_000}`) as Array<Record<string, unknown>>;

  const totals: BackfillTotalsV1 = {
    scanned: 0,
    recorded: 0,
    alreadyRecorded: 0,
    skipped: 0,
    conflicts: 0,
    failures: 0,
  };
  const skipReasons = new Map<string, number>();

  const projector = createRouteOutcomeProjectorV1({
    async findCandidateByHash({ tenantId, routeRunId, candidateHash }) {
      const candidates = await repository.listCandidates(routeRunId, tenantId);
      return candidates.find((candidate) => candidate.candidateHash === candidateHash) ?? null;
    },
    getOutcomeByProofId: (query) => outcomes.getProviderOutcomeByProofId(query),
    async insertOutcome(outcome) {
      if (args.dryRun) return;
      const effect = await outcomes.insertProviderOutcome(outcome);
      if (effect.kind === 'conflict') throw new Error(`conflict: ${effect.reason}`);
    },
  });

  for (const row of rows) {
    const tenantId = String(row.user_id);
    const proofId = String(row.proof_id);
    const routeRunId = String(row.run_id);
    totals.scanned += 1;

    const proof = await repository.getProofProjection(proofId, tenantId);
    if (!proof) {
      totals.failures += 1;
      continue;
    }
    const events = await repository.listProofEvents(proofId, tenantId);
    const result: OutcomeProjectionResultV1 = await projector.projectFinalizedProof({
      proof,
      events,
      routeRunId,
      now: new Date(),
    });

    // The provider filter is applied to the DERIVED outcome, not to the query:
    // the provider is a property of the persisted candidate, and reading it
    // from anywhere else would be reading it from a place a client can reach.
    if (
      args.provider &&
      (result.status === 'recorded' || result.status === 'already_recorded') &&
      result.outcome.providerId !== args.provider
    ) {
      totals.scanned -= 1;
      continue;
    }

    switch (result.status) {
      case 'recorded':
        totals.recorded += 1;
        break;
      case 'already_recorded':
        totals.alreadyRecorded += 1;
        break;
      case 'skipped':
        totals.skipped += 1;
        skipReasons.set(result.reason, (skipReasons.get(result.reason) ?? 0) + 1);
        break;
      case 'conflict':
        totals.conflicts += 1;
        console.error(`   ✗ conflict on ${proofId}: ${result.detail}`);
        break;
      default:
        totals.failures += 1;
        console.error(`   ✗ failed on ${proofId}: ${result.detail}`);
    }
  }

  console.log(`\n   scanned:          ${totals.scanned}`);
  console.log(`   recorded:         ${totals.recorded}${args.dryRun ? ' (would record)' : ''}`);
  console.log(`   already recorded: ${totals.alreadyRecorded}`);
  console.log(`   skipped:          ${totals.skipped}`);
  for (const [reason, count] of [...skipReasons].sort()) {
    console.log(`     · ${reason}: ${count}`);
  }
  console.log(`   conflicts:        ${totals.conflicts}`);
  console.log(`   failures:         ${totals.failures}`);

  if (totals.conflicts > 0 || totals.failures > 0) {
    console.error('\nFAILED — some proofs could not be projected. Nothing was overwritten.');
    process.exitCode = 1;
    return;
  }
  console.log('\nOK — a second run over the same range will record nothing further.');
}

main()
  .catch((error: unknown) => {
    console.error('FAILED —', error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(() => closeDb().catch(() => {}));
