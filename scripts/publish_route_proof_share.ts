import { client, closeDb } from '@mioagent/db';
import {
  createDatabasePublicProofShareRepository,
  createDatabaseRouteStorageRepository,
  proofIsPublishableV1,
} from '@mioagent/route-storage';

import { loadRootEnvFileV1, reportLoadedEnvFileV1 } from './loadEnvFile.js';

// Operator-side equivalent of POST /api/route-intelligence/route-proofs/:id/share.
//
// It exists because that route is session-authenticated as the proof's owner,
// and an operator has no session. It deliberately reuses the SAME repository
// and the SAME publishability rule as the route rather than writing SQL, so a
// share created here is indistinguishable from one created by the owner in the
// product — including the partial unique index that keeps one live link per
// proof, and the idempotent repeat.
//
// Publishing is outward-facing: it puts a Route Proof bundle on a public URL.
// So this refuses to guess. It publishes exactly the proof ids named on the
// command line, after re-reading ownership and finality from storage.
//
//   pnpm proofs:publish-share --dry-run route-proof:9a53fa...
//   pnpm proofs:publish-share route-proof:9a53fa...
//
// Revoking is the owner's DELETE on the same route.

interface ProofOwnerRowV1 {
  id: string;
  user_id: string;
  status: string;
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const proofIds = process.argv.slice(2).filter((argument) => !argument.startsWith('--'));
  if (proofIds.length === 0) {
    console.error('Name at least one route proof id to publish.');
    process.exitCode = 1;
    return;
  }

  reportLoadedEnvFileV1(loadRootEnvFileV1());
  const routes = createDatabaseRouteStorageRepository(client);
  const shares = createDatabasePublicProofShareRepository(client);

  for (const proofId of proofIds) {
    // The owner comes from the stored proof, never from an argument — the
    // caller names an id and nothing else, exactly as the route does.
    const rows = (await client`
      SELECT id, user_id, status FROM route_proofs WHERE id = ${proofId} LIMIT 1
    `) as unknown as ProofOwnerRowV1[];
    const row = rows[0];
    if (!row) {
      console.log(`${proofId}: no such route proof — nothing published`);
      continue;
    }

    // Re-read through the projection rather than trusting the status column,
    // because `finalStatus` is what publishability is defined against.
    const proof = await routes.getProofProjection(proofId, row.user_id);
    if (!proof) {
      console.log(`${proofId}: not readable for its own owner — nothing published`);
      continue;
    }
    if (!proofIsPublishableV1(proof.finalStatus)) {
      console.log(`${proofId}: finalStatus=${proof.finalStatus ?? 'null'} is not publishable — skipped`);
      continue;
    }

    if (dryRun) {
      console.log(`${proofId}: WOULD publish (finalStatus=${proof.finalStatus})`);
      continue;
    }

    const share = await shares.createShare({
      tenantId: row.user_id,
      proofFamily: 'route',
      proofId,
      now: new Date(),
    });
    console.log(`${proofId}: /proof/${share.publicId} (created ${share.createdAt})`);
  }

  if (dryRun) console.log('DRY RUN — nothing was published.');
}

main()
  .catch((error: unknown) => {
    console.error('Publishing a route proof share failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => {
    void closeDb();
  });
