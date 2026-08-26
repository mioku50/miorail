/**
 * Ask each issuer's own root about each candidate address.
 *
 * Phase 9B.1. This is a verify-a-candidate registry, not a trust-a-list one,
 * for a measured reason: `getDShares()` reverts on BOTH live Dinari factories
 * on Base although both published ABIs declare it, so there is no enumerable
 * membership list anywhere. Every row exists because the root was asked about
 * that exact address and answered.
 *
 * What a pass produces:
 *
 *   established   the root said yes. Miorail may say Dinari issued this
 *                 address — and nothing else. Which security it stands for is
 *                 a separate axis with a separate source, and that source is
 *                 behind organization-only credentials.
 *   refuted       the root said no. A real answer, stored, and the reason the
 *                 wrappers are in the candidate list at all.
 *   unread        we could not ask. Stores nothing and moves nothing. An
 *                 endpoint that would not answer has never been evidence
 *                 about a token in this codebase.
 *
 * Read-only: no signer, no key, no wallet, no transaction, no allowance.
 *
 *   pnpm rwa:verify-issuer --dry
 *   pnpm rwa:verify-issuer
 *   pnpm rwa:verify-issuer --gap-ms 2000
 */
import { createB20ReaderV1 } from '@mioagent/b20-control';
import { client, closeDb } from '@mioagent/db';
import { createDatabaseIssuerRepresentationRepository } from '@mioagent/route-storage';
import {
  DINARI_BASE_ROOT_V1,
  dinariCandidateAddressesV1,
  readDinariMembershipV1,
} from '@mioagent/rwa-issuer';

import { loadRootEnvFileV1, reportLoadedEnvFileV1 } from './loadEnvFile.js';

const CHAIN_ID_V1 = 8453 as const;
/** One read per candidate against an endpoint the measurement workers share. */
const DEFAULT_GAP_MS_V1 = 1_200;

function numericArgV1(flag: string, fallback: number): number {
  const index = process.argv.indexOf(flag);
  if (index < 0) return fallback;
  const value = Number.parseInt(String(process.argv[index + 1] ?? ''), 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  const dry = process.argv.includes('--dry');
  const gapMs = numericArgV1('--gap-ms', DEFAULT_GAP_MS_V1);
  reportLoadedEnvFileV1(loadRootEnvFileV1());

  const rpcUrl = (process.env.BASE_MAINNET_RPC_URL || process.env.BASE_RPC_URL || '').trim();
  if (!rpcUrl) throw new Error('BASE_MAINNET_RPC_URL is required to ask an issuer root');

  const representations = createDatabaseIssuerRepresentationRepository(client);
  const reader = createB20ReaderV1({ rpcUrl });
  const root = DINARI_BASE_ROOT_V1;
  const candidates = dinariCandidateAddressesV1();

  console.log(
    `${candidates.length} candidate(s) against ${root.rootKey}` +
      ` (${root.provenance.path}, ${root.provenance.environment}.${root.provenance.chainKey})`,
  );

  const anchorRead = await reader.readBlockAnchor();
  if (!anchorRead.ok) {
    // Every answer in one pass is pinned to one block, so the set describes a
    // single moment. Without an anchor there is nothing to pin them to, and
    // the failed check is recorded as a failed check rather than as silence.
    console.log(`  no block anchor (${anchorRead.reason}) — nothing asked, nothing stored`);
    if (!dry) {
      await representations.recordCheck({
        issuerId: root.issuerId,
        rootKey: root.rootKey,
        chainId: CHAIN_ID_V1,
        rootAddress: root.rootAddress,
        predicateSelector: root.predicateSelector,
        status: 'endpoint_unavailable',
        blockNumber: null,
        blockHash: null,
        candidates: candidates.length,
        established: 0,
        refuted: 0,
        unread: candidates.length,
        observedAt: new Date().toISOString(),
        detail: `no block anchor (${anchorRead.reason})`,
      });
    }
    return;
  }
  const anchor = anchorRead.value;
  console.log(`  anchored at block ${anchor.blockNumber}`);

  if (dry) {
    console.log('  --dry: nothing asked, nothing stored');
    return;
  }

  const observedAt = new Date().toISOString();
  let established = 0;
  let refuted = 0;
  let unread = 0;
  const firstSeen: string[] = [];
  const changed: string[] = [];

  for (const tokenAddress of candidates) {
    const read = await readDinariMembershipV1(reader, { tokenAddress, anchor }, root);
    if (read.outcome === 'unread') {
      unread += 1;
      console.log(`  ${tokenAddress}  unread (${read.reason})`);
      await sleep(gapMs);
      continue;
    }
    if (read.outcome === 'established') established += 1;
    else refuted += 1;

    const written = await representations.recordMembership({
      chainId: CHAIN_ID_V1,
      tokenAddress: read.tokenAddress,
      issuerId: root.issuerId,
      rootKey: read.rootKey,
      rootAddress: read.rootAddress,
      membership: read.outcome,
      blockNumber: read.blockNumber,
      blockHash: read.blockHash,
      evidenceHash: read.evidenceHash,
      observedAt,
    });
    if (written.outcome === 'first_observation') firstSeen.push(tokenAddress);
    if (written.outcome === 'changed') changed.push(tokenAddress);
    console.log(`  ${tokenAddress}  ${read.outcome}  ${written.outcome}`);
    await sleep(gapMs);
  }

  // Recorded whatever happened. A pass where the endpoint refused half the
  // calls is `ok` with a high `unread` — the root answered when it was
  // reachable — and that is a different sentence from a root we never reached.
  await representations.recordCheck({
    issuerId: root.issuerId,
    rootKey: root.rootKey,
    chainId: CHAIN_ID_V1,
    rootAddress: root.rootAddress,
    predicateSelector: root.predicateSelector,
    status: established + refuted > 0 ? 'ok' : 'endpoint_unavailable',
    blockNumber: established + refuted > 0 ? anchor.blockNumber : null,
    blockHash: established + refuted > 0 ? anchor.blockHash : null,
    candidates: candidates.length,
    established,
    refuted,
    unread,
    observedAt,
    detail: unread > 0 ? `${unread} candidate(s) went unanswered in this pass` : null,
  });

  console.log(
    `established ${established}, refuted ${refuted}, unread ${unread}` +
      ` · ${firstSeen.length} first observation(s), ${changed.length} change(s)`,
  );
  // The first pass announces nothing. A cold start that reported fifty issuer
  // events would be reporting our own arrival as the issuer's activity.
  if (changed.length > 0) console.log(`  CHANGED: ${changed.join(', ')}`);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(() => closeDb());
