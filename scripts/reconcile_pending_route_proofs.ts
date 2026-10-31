import { client, closeDb } from '@mioagent/db';
import { createRouteProofReconciler } from '@mioagent/route-proof';
import { createDatabaseRouteStorageRepository } from '@mioagent/route-storage';

import { createViemBaseReceiptReader } from '../artifacts/api-server/lib/baseReceiptReader.js';
import { loadRootEnvFileV1, reportLoadedEnvFileV1 } from './loadEnvFile.js';

// Settles Route Proofs that recorded transactions and were never reconciled.
// Only the page reconciles a proof, once per proof, and on 2026-10-31 a first
// press the wallet refused spent that reconcile, so both of the operator's step
// swaps stayed `pending` after they had landed. Read-only onchain; writes only
// the same append-only Proof events/projection as the normal reconciliation
// route. It never signs, broadcasts, pays, or changes an approved call.

interface PendingProofRowV1 {
  proof_id: string;
  route_run_id: string;
  user_id: string;
  wallet_address: string;
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  reportLoadedEnvFileV1(loadRootEnvFileV1());
  // Ten minutes untouched, so a page still reconciling its own proof is left alone.
  const rows = (await client`
    SELECT
      p.id AS proof_id,
      p.route_run_id,
      r.user_id,
      r.wallet_address
    FROM route_proofs p
    JOIN route_runs r ON r.id = p.route_run_id
    WHERE p.status = 'pending'
      AND jsonb_array_length(COALESCE(p.payload->'transactionHashes', '[]'::jsonb)) > 0
      AND p.updated_at < now() - interval '10 minutes'
      AND p.created_at > now() - interval '30 days'
    ORDER BY p.updated_at ASC
    LIMIT 50
  `) as unknown as PendingProofRowV1[];

  console.log(`Pending Route Proofs with transactions: ${rows.length}`);
  if (dryRun || rows.length === 0) {
    if (dryRun) console.log('DRY RUN — no proof was changed and no receipt was read.');
    return;
  }

  const reconciler = createRouteProofReconciler({
    repository: createDatabaseRouteStorageRepository(client),
    receiptReader: createViemBaseReceiptReader(),
  });
  const counts = new Map<string, number>();
  let failures = 0;
  for (const row of rows) {
    if (!/^0x[0-9a-f]{40}$/.test(row.wallet_address)) {
      failures += 1;
      console.error(`Proof ${row.proof_id} failed: stored wallet address is not canonical`);
      continue;
    }
    try {
      const result = await reconciler.reconcile({
        tenantId: row.user_id,
        walletAddress: row.wallet_address as `0x${string}`,
        routeRunId: row.route_run_id,
        routeProofId: row.proof_id,
        now: new Date(),
      });
      counts.set(`${result.outcome}/${result.proof.finalStatus}`, (counts.get(`${result.outcome}/${result.proof.finalStatus}`) ?? 0) + 1);
    } catch (error) {
      failures += 1;
      console.error(`Proof ${row.proof_id} failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
  }
  for (const [outcome, count] of [...counts].sort()) console.log(`${outcome}: ${count}`);
  console.log(`failures: ${failures}`);
  if (failures > 0) process.exitCode = 1;
}

main()
  .catch((error: unknown) => {
    console.error('FAILED —', error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(() => closeDb().catch(() => {}));
