import { client, closeDb } from '@mioagent/db';
import { createRouteProofReconciler } from '@mioagent/route-proof';
import { createDatabaseRouteStorageRepository } from '@mioagent/route-storage';

import { createViemBaseReceiptReader } from '../artifacts/api-server/lib/baseReceiptReader.js';
import { loadRootEnvFileV1, reportLoadedEnvFileV1 } from './loadEnvFile.js';

// Repairs only the narrow historical gap where successful Base native-ETH
// routes stopped at manual review because the old reconciler did not understand
// canonical WETH9 Deposit/Withdrawal logs. Read-only onchain; writes only the
// same append-only Proof events/projection as the normal reconciliation route.
// It never signs, broadcasts, pays, or changes an approved call.

interface NativeProofRowV1 {
  proof_id: string;
  route_run_id: string;
  user_id: string;
  wallet_address: string;
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  reportLoadedEnvFileV1(loadRootEnvFileV1());
  const rows = (await client`
    SELECT
      p.id AS proof_id,
      p.route_run_id,
      r.user_id,
      r.wallet_address
    FROM route_proofs p
    JOIN route_runs r ON r.id = p.route_run_id
    WHERE p.status = 'reconciliation_required'
      AND p.payload->>'reconciliationState' = 'manual_review'
      AND EXISTS (
        SELECT 1
        FROM jsonb_array_elements(p.payload->'expectedResult'->'assetChanges') AS change
        WHERE change->'asset'->>'kind' = 'native'
      )
    ORDER BY p.updated_at ASC
  `) as unknown as NativeProofRowV1[];

  console.log(`Native Route Proof reconciliation candidates: ${rows.length}`);
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
      counts.set(result.outcome, (counts.get(result.outcome) ?? 0) + 1);
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
