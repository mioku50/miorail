/**
 * One project-claim verification pass, for one token.
 *
 * A project claims a token by serving `/.well-known/miorail-b20.json` on a
 * domain it controls. This reads that file, checks the three links Miorail can
 * check, probes only what the file itself declared, and — with `--write` —
 * records the claim and its evidence.
 *
 * The order matters and is enforced by the domain layer rather than by this
 * script: if the identity does not hold, nothing is probed and nothing is
 * attached. A token that merely shares a symbol with a known project therefore
 * cannot inherit its profile, because there is no code path by which it could.
 *
 * Reads only, apart from the two project tables. No signer, no key, no chain
 * write. The RPC URL is read from the environment and never printed.
 *
 *   pnpm b20:verify-project --token 0x… --domain miorail.xyz [--write]
 */
import { client, closeDb } from '@mioagent/db';
import {
  createB20HttpFetchV1,
  verifyB20ProjectV1,
  type B20CollectDepsV1,
} from '@mioagent/b20-projects';
import { b20SenderRelationV1 } from '@mioagent/opportunity-rail';
import {
  createDatabaseB20LaunchDeployerRepository,
  createDatabaseB20ProjectRepository,
  type B20ProjectEvidenceRowV1,
} from '@mioagent/route-storage';

import { loadRootEnvFileV1, reportLoadedEnvFileV1 } from './loadEnvFile.js';

interface ArgsV1 {
  token: string;
  domain: string;
  write: boolean;
}

function parseArgsV1(argv: readonly string[]): ArgsV1 {
  let token = '';
  let domain = '';
  let write = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--token') { token = (argv[++index] ?? '').toLowerCase(); continue; }
    if (arg === '--domain') { domain = (argv[++index] ?? '').toLowerCase(); continue; }
    if (arg === '--write') { write = true; continue; }
  }
  if (!/^0x[0-9a-f]{40}$/.test(token)) {
    throw new Error('--token must be a 20-byte address');
  }
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) {
    throw new Error('--domain must be a bare hostname, with no scheme and no path');
  }
  return { token, domain, write };
}

/**
 * The block's own timestamp, read from the chain.
 *
 * Backfilled launch rows carry no `block_timestamp` — the historical pass read
 * the log, not the block — so a launch time that is missing in storage is still
 * available where it has always been. It is read rather than typed in for the
 * reason that runs through this whole layer: a date somebody could supply is a
 * date somebody could get wrong in their favour, and `project_before_token`
 * compares this one against a repository's creation date.
 *
 * Null on any failure. The comparison then stays `unknown`, which is the
 * correct answer and not a negative one.
 */
async function readBlockTimestampV1(blockNumber: string): Promise<string | null> {
  const rpc = process.env.BASE_MAINNET_RPC_URL?.trim() || 'https://mainnet.base.org';
  try {
    const response = await fetch(rpc, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_getBlockByNumber',
        params: [`0x${BigInt(blockNumber).toString(16)}`, false],
      }),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { result?: { timestamp?: string } };
    const raw = body.result?.timestamp;
    if (typeof raw !== 'string') return null;
    return new Date(Number(BigInt(raw)) * 1000).toISOString();
  } catch {
    // The endpoint is never named in an error. A failed read leaves the launch
    // time unknown, which the projection handles as an absence of evidence.
    return null;
  }
}

/** The launch row this token came from, with the two facts a verification pass
 * needs: who sent the transaction, and when the block was mined. */
async function readLaunchV1(tokenAddress: string): Promise<{
  launchId: string;
  launchedAt: string | null;
} | null> {
  const rows = await client`
    SELECT transaction_hash, log_index, block_number, block_timestamp
      FROM b20_launches
     WHERE token_address = ${tokenAddress} AND canonical
     ORDER BY block_number ASC
     LIMIT 1`;
  const row = rows[0] as Record<string, unknown> | undefined;
  if (!row) return null;
  const stored = row.block_timestamp ? new Date(row.block_timestamp as string).toISOString() : null;
  return {
    launchId: `${String(row.transaction_hash)}:${Number(row.log_index)}`,
    launchedAt: stored ?? (await readBlockTimestampV1(String(row.block_number))),
  };
}

async function main(): Promise<number> {
  const loaded = loadRootEnvFileV1();
  reportLoadedEnvFileV1(loaded);
  const args = parseArgsV1(process.argv.slice(2));

  const launch = await readLaunchV1(args.token);
  if (!launch) {
    console.error(`✗ ${args.token} is not a canonical launch in this index.`);
    console.error('  Fundamentals hang off a launch Miorail has stored. Ingest it first.');
    return 1;
  }

  const deployers = createDatabaseB20LaunchDeployerRepository(client);
  const stored = await deployers.readDeployer(launch.launchId);
  const launchSender = stored?.deployerAddress ?? null;
  const senderRelation = stored?.deployerAddress
    ? b20SenderRelationV1(stored.transactionTo)
    : null;

  const deps: B20CollectDepsV1 = {
    http: createB20HttpFetchV1(),
    now: () => new Date().toISOString(),
  };

  const result = await verifyB20ProjectV1(deps, {
    chainId: 8453,
    tokenAddress: args.token,
    domain: args.domain,
    launchSender,
    senderRelation,
    launchedAt: launch.launchedAt,
  });

  console.log(`token   ${args.token}`);
  console.log(`domain  ${args.domain}`);
  console.log(`sender  ${launchSender ?? 'not read'} (${senderRelation ?? 'unknown relation'})`);
  console.log(`launch  ${launch.launchedAt ?? 'block timestamp unknown'}`);
  console.log('');
  console.log(`claim    ${result.claim?.status ?? 'none'}${result.refusal ? ` — ${result.refusal}` : ''}`);
  if (result.claim) {
    console.log(`  verified ${result.claim.verifiedLinks.join(', ') || '(none)'}`);
    if (result.claim.refutedLinks.length > 0) {
      console.log(`  REFUTED  ${result.claim.refutedLinks.join(', ')}`);
    }
  }
  console.log(`standing ${result.profile.standing}`);
  for (const finding of result.profile.findings) {
    console.log(
      `  ${finding.dimension.padEnd(22)} ${finding.state.padEnd(10)} ${finding.provenance.padEnd(20)} ${finding.reference ?? ''}`,
    );
  }
  if (result.profile.missing.length > 0) {
    console.log(`  not established: ${result.profile.missing.join(', ')}`);
  }
  for (const refused of result.refusedUrls) {
    console.log(`  refused url: ${refused.url} (${refused.refusal})`);
  }

  if (!args.write) {
    console.log('');
    console.log('Dry run. Nothing was written — pass --write to record this pass.');
    return 0;
  }
  if (!result.claim) {
    console.log('');
    console.log('Nothing to record: no claim was established.');
    return 1;
  }

  const evidence: B20ProjectEvidenceRowV1[] = result.profile.findings.map((finding) => ({
    chainId: 8453 as const,
    tokenAddress: args.token,
    dimension: finding.dimension,
    state: finding.state,
    // `not_collected` is the absence of a row, and the projection never emits
    // it on a finding — the assert would refuse it if it did.
    provenance: finding.provenance as Exclude<typeof finding.provenance, 'not_collected'>,
    reference: finding.reference,
    observedAt: finding.observedAt ?? new Date().toISOString(),
  }));

  const projects = createDatabaseB20ProjectRepository(client);
  const written = await projects.recordVerification({
    claim: {
      chainId: 8453,
      tokenAddress: args.token,
      claimantDomain: args.domain,
      status: result.claim.status,
      verifiedLinks: [...result.claim.verifiedLinks],
      refutedLinks: [...result.claim.refutedLinks],
      lastCheckedAt: result.claim.lastCheckedAt ?? new Date().toISOString(),
    },
    evidence,
  });
  console.log('');
  console.log(`Recorded: claim ${written.claim.status}, ${written.evidence.length} evidence rows.`);
  return 0;
}

const invokedDirectlyV1 =
  process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;

if (invokedDirectlyV1) {
  void main()
    .then(async (code) => {
      await closeDb();
      process.exitCode = code;
    })
    .catch(async (error: unknown) => {
      console.error(`✗ ${error instanceof Error ? error.message : String(error)}`);
      await closeDb();
      process.exitCode = 1;
    });
}

export { parseArgsV1 };
