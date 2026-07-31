import { client, closeDb } from '@mioagent/db';
import {
  aggregationVersionV1,
  buildReliabilitySnapshotV1,
  orderOutcomesV1,
  selectWindowOutcomesV1,
  type OutcomeProviderIdV1,
  type ReliabilityThresholdsV1,
  type RouteProviderOutcomeV1,
} from '@mioagent/route-outcomes';
import { createDatabaseProviderOutcomeRepository } from '@mioagent/route-storage';

import { loadRootEnvFileV1, reportLoadedEnvFileV1 } from './loadEnvFile.js';
import { parseOutcomeCliArgsV1, printOutcomeCliUsageV1 } from './outcomesCli.js';

// ---------------------------------------------------------------------------
// T67C.1 §4 — `pnpm reliability:rebuild [-- --dry-run --provider=uniswap ...]`
//
// Seals new snapshots from the outcomes recorded so far. Old snapshots are
// never overwritten: a snapshot is a statement about a moment, and rewriting it
// would retroactively change what a past Route Card was calibrated against.
//
// The cutoff is NOW, once, for the whole run. Taking a fresh clock per group
// would mean two groups in the same rebuild describe slightly different pasts.
//
// A repeated rebuild over unchanged outcomes writes nothing: the snapshot id
// and hash are derived from the member set, so an identical rebuild collides
// with itself and is reported as already present.
// ---------------------------------------------------------------------------

function thresholdsFromEnvV1(): ReliabilityThresholdsV1 {
  const read = (name: string, fallback: number): number => {
    const raw = process.env[name]?.trim();
    const parsed = raw ? Number(raw) : Number.NaN;
    // Same rule as the server: a malformed threshold falls back to the default
    // rather than to zero, which would make every provider instantly eligible.
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
  };
  return {
    windowDays: read('MIORAIL_RELIABILITY_WINDOW_DAYS', 90),
    personalMinSamples: read('MIORAIL_RELIABILITY_PERSONAL_MIN_SAMPLES', 10),
    networkMinSamples: read('MIORAIL_RELIABILITY_NETWORK_MIN_SAMPLES', 30),
    networkMinWallets: read('MIORAIL_RELIABILITY_NETWORK_MIN_WALLETS', 3),
  };
}

interface GroupKeyV1 {
  providerId: OutcomeProviderIdV1;
  fromAsset: string;
  toAsset: string;
  tenantId?: string;
  walletAddress?: string;
}

function groupKeyString(scope: string, key: GroupKeyV1): string {
  return [scope, key.tenantId ?? '', key.walletAddress ?? '', key.providerId, key.fromAsset, key.toAsset].join('|');
}

async function main(): Promise<void> {
  const args = parseOutcomeCliArgsV1(process.argv.slice(2));
  if (args.help) {
    printOutcomeCliUsageV1('reliability:rebuild');
    return;
  }

  console.log('T67C.1 reliability rebuild');
  reportLoadedEnvFileV1(loadRootEnvFileV1());
  if (args.dryRun) console.log('   · DRY RUN — nothing will be written');

  const thresholds = thresholdsFromEnvV1();
  const outcomes = createDatabaseProviderOutcomeRepository(client);
  // One clock for the whole run.
  const cutoffAt = args.to ?? new Date();
  const floor = new Date(cutoffAt.getTime() - thresholds.windowDays * 24 * 60 * 60 * 1_000);

  console.log(`   · aggregation: ${aggregationVersionV1(thresholds)}`);
  console.log(`   · window: ${floor.toISOString()} .. ${cutoffAt.toISOString()}`);

  const all = await outcomes.listProviderOutcomes({
    providerId: args.provider ?? undefined,
    from: args.from ?? floor,
    to: cutoffAt,
    limit: args.limit ?? undefined,
  });
  console.log(`   · ${all.length} outcome(s) in window`);

  // Group first, so each snapshot is built from a set this process can name.
  const personalGroups = new Map<string, { key: GroupKeyV1; rows: RouteProviderOutcomeV1[] }>();
  const networkGroups = new Map<string, { key: GroupKeyV1; rows: RouteProviderOutcomeV1[] }>();
  for (const outcome of all) {
    const base: GroupKeyV1 = {
      providerId: outcome.providerId,
      fromAsset: outcome.fromAsset,
      toAsset: outcome.toAsset,
    };
    const personalKey: GroupKeyV1 = {
      ...base,
      tenantId: outcome.tenantId,
      walletAddress: outcome.walletAddress,
    };
    for (const [map, key, scope] of [
      [personalGroups, personalKey, 'personal'],
      [networkGroups, base, 'network'],
    ] as const) {
      const id = groupKeyString(scope, key);
      const entry = map.get(id) ?? { key, rows: [] };
      entry.rows.push(outcome);
      map.set(id, entry);
    }
  }

  let sealed = 0;
  let unchanged = 0;
  let tooSmall = 0;

  for (const [scope, groups] of [
    ['personal', personalGroups],
    ['network', networkGroups],
  ] as const) {
    for (const { key, rows } of groups.values()) {
      const windowed = selectWindowOutcomesV1({
        outcomes: rows,
        key: { providerId: key.providerId, fromAsset: key.fromAsset, toAsset: key.toAsset },
        cutoffAt,
        windowDays: thresholds.windowDays,
        tenantId: key.tenantId,
        walletAddress: key.walletAddress,
      });
      // A snapshot is sealed whenever there is anything to describe; whether it
      // is ELIGIBLE to calibrate anything is a separate decision made at read
      // time. Sealing only eligible ones would hide the "8 of 10" the UI needs
      // in order to say how far off calibration is.
      const built = buildReliabilitySnapshotV1({
        scope,
        key: { providerId: key.providerId, fromAsset: key.fromAsset, toAsset: key.toAsset },
        outcomes: windowed,
        cutoffAt,
        createdAt: cutoffAt,
        thresholds,
      });
      if (!built) {
        tooSmall += 1;
        continue;
      }
      if (args.dryRun) {
        sealed += 1;
        continue;
      }
      const effect = await outcomes.insertReliabilitySnapshot(
        built.snapshot,
        orderOutcomesV1(built.members).map((member) => member.id),
      );
      if (effect.kind === 'insert') sealed += 1;
      else if (effect.kind === 'return_existing') unchanged += 1;
      else {
        console.error(`   ✗ ${scope} ${key.providerId}: ${effect.reason}`);
        process.exitCode = 1;
      }
    }
  }

  console.log(`\n   sealed:    ${sealed}${args.dryRun ? ' (would seal)' : ''}`);
  console.log(`   unchanged: ${unchanged}`);
  console.log(`   empty:     ${tooSmall}`);
  if (process.exitCode === 1) {
    console.error('\nFAILED — some snapshots could not be sealed. Nothing was overwritten.');
    return;
  }
  console.log('\nOK — existing snapshots were left untouched.');
}

main()
  .catch((error: unknown) => {
    console.error('FAILED —', error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(() => closeDb().catch(() => {}));
