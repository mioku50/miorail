/**
 * Re-read every verified claim whose evidence has aged out.
 *
 * The verified layer shipped with no expiry and no way back: `Product — Live`
 * meant an endpoint answered a real request AT A MOMENT, nothing asked again,
 * and no code path could move a claim out of `verified`. This pass closes both
 * halves of that.
 *
 *   pnpm b20:reverify-projects [--window 24h] [--limit 20] [--write]
 *
 * Read-only against Base and against every third party except the two project
 * tables. No signer, no key, no chain write. It prints hosts and outcomes; it
 * never prints an RPC URL, an API key or a provider message.
 *
 * The distinction that matters is in `b20ReverifyDecisionV1`, not here: a file
 * that is served and no longer names the token ends a claim, and a file Miorail
 * could not fetch changes nothing at all. Refuting a project because their host
 * was slow would take a badge away on the strength of a network error.
 */
import { client, closeDb } from '@mioagent/db';
import {
  createDatabaseB20LaunchDeployerRepository,
  createDatabaseB20ProjectRepository,
  type B20ProjectEvidenceRowV1,
} from '@mioagent/route-storage';
import { B20_FUNDAMENTAL_FRESHNESS_MS_V1, b20SenderRelationV1 } from '@mioagent/opportunity-rail';
import {
  b20ReverifyDecisionV1,
  createB20HttpFetchV1,
  verifyB20ProjectV1,
  type B20CollectDepsV1,
} from '@mioagent/b20-projects';

import { loadRootEnvFileV1, reportLoadedEnvFileV1 } from './loadEnvFile.js';

interface ArgsV1 {
  windowMs: number;
  limit: number;
  write: boolean;
}

function parseDurationMsV1(value: string): number {
  const match = /^(\d+)(ms|s|m|h|d)$/.exec(value.trim());
  if (!match) throw new Error('--window must look like 24h, 90m or 3600s');
  const amount = Number(match[1]);
  const unit = match[2] as 'ms' | 's' | 'm' | 'h' | 'd';
  const scale = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit];
  return amount * scale;
}

function parseArgsV1(argv: readonly string[]): ArgsV1 {
  let windowMs = B20_FUNDAMENTAL_FRESHNESS_MS_V1;
  let limit = 20;
  let write = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--window') { windowMs = parseDurationMsV1(argv[++index] ?? ''); continue; }
    if (arg === '--limit') { limit = Math.max(1, Math.min(200, Number(argv[++index] ?? '20'))); continue; }
    if (arg === '--write') { write = true; continue; }
  }
  return { windowMs, limit, write };
}

async function readLaunchV1(tokenAddress: string): Promise<{ launchId: string; launchedAt: string | null } | null> {
  const rows = await client`
    SELECT id, block_timestamp FROM b20_launches
     WHERE token_address = ${tokenAddress} AND canonical AND chain_id = 8453
     LIMIT 1`;
  const row = (rows as Record<string, unknown>[])[0];
  if (!row) return null;
  return {
    launchId: String(row.id),
    launchedAt: row.block_timestamp === null || row.block_timestamp === undefined
      ? null
      : new Date(row.block_timestamp as string).toISOString(),
  };
}

async function main(): Promise<number> {
  reportLoadedEnvFileV1(loadRootEnvFileV1());
  const args = parseArgsV1(process.argv.slice(2));
  const projects = createDatabaseB20ProjectRepository(client);
  const deployers = createDatabaseB20LaunchDeployerRepository(client);
  const now = new Date();
  const observedBefore = new Date(now.getTime() - args.windowMs).toISOString();

  const due = await projects.claimsDueForReverification({ chainId: 8453, observedBefore, limit: args.limit });
  console.log(`window          ${args.windowMs / 3_600_000}h (evidence older than ${observedBefore})`);
  console.log(`due             ${due.length}`);
  if (due.length === 0) {
    console.log('Nothing has aged out.');
    return 0;
  }

  const deps: B20CollectDepsV1 = { http: createB20HttpFetchV1(), now: () => new Date().toISOString() };
  const counts: Record<string, number> = {};

  for (const entry of due) {
    const launch = await readLaunchV1(entry.tokenAddress);
    const stored = launch ? await deployers.readDeployer(launch.launchId) : null;
    const result = await verifyB20ProjectV1(deps, {
      chainId: 8453,
      tokenAddress: entry.tokenAddress,
      domain: entry.projectDomain,
      launchSender: stored?.deployerAddress ?? null,
      senderRelation: stored?.deployerAddress ? b20SenderRelationV1(stored.transactionTo) : null,
      launchedAt: launch?.launchedAt ?? null,
    });
    const decision = b20ReverifyDecisionV1({ claim: result.claim, refusal: result.refusal });
    counts[decision.outcome] = (counts[decision.outcome] ?? 0) + 1;
    console.log(
      `  ${entry.projectDomain.padEnd(28)} ${decision.outcome.padEnd(11)} ` +
        `was ${entry.oldestObservedAt ?? 'never read'} — ${decision.reason}`,
    );

    if (!args.write || decision.status === null) continue;

    const evidence: B20ProjectEvidenceRowV1[] = decision.writeEvidence && decision.status === 'verified'
      ? result.profile.findings.map((finding) => ({
          chainId: 8453 as const,
          tokenAddress: entry.tokenAddress,
          dimension: finding.dimension,
          state: finding.state,
          provenance: finding.provenance as Exclude<typeof finding.provenance, 'not_collected'>,
          reference: finding.reference,
          observedAt: finding.observedAt ?? new Date().toISOString(),
        }))
      // A claim that is no longer verified permits no findings, and
      // `recordVerification` replaces whatever was stored — so this is how the
      // old rows leave with it.
      : [];

    await projects.recordVerification({
      claim: {
        chainId: 8453,
        tokenAddress: entry.tokenAddress,
        claimantDomain: entry.projectDomain,
        status: decision.status,
        verifiedLinks: decision.status === 'verified' ? [...(result.claim?.verifiedLinks ?? [])] : [],
        refutedLinks: [...(result.claim?.refutedLinks ?? [])],
        lastCheckedAt: result.claim?.lastCheckedAt ?? new Date().toISOString(),
      },
      evidence,
    });
  }

  console.log('');
  console.log(Object.entries(counts).map(([outcome, n]) => `${outcome}: ${n}`).join(', '));
  if (!args.write) console.log('Dry run. Nothing was written — pass --write to record this pass.');
  return 0;
}

main()
  .then(async (code) => {
    await closeDb();
    process.exitCode = code;
  })
  .catch(async (error: unknown) => {
    console.error(`✗ ${error instanceof Error ? error.message : String(error)}`);
    await closeDb();
    process.exitCode = 1;
  });
