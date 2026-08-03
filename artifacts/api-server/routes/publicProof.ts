import { Router, type Request, type Response } from 'express';
import { logger } from '@mioagent/utils';
import { PublicProofShareResponseV1Schema } from '@mioagent/api-zod';
import type { ProofFamilyV1, PublicProofShareV1 } from '@mioagent/route-domain';
import {
  createDatabaseNftStorageRepository,
  createDatabaseProviderOutcomeRepository,
  createDatabasePublicProofShareRepository,
  createDatabaseRouteStorageRepository,
  proofIsPublishableV1,
  type NftStorageRepository,
  type PublicProofShareRepositoryV1,
  type RouteStorageRepository,
} from '@mioagent/route-storage';
import { client } from '@mioagent/db';
import { getMiorailProductMigrationFlags } from '../lib/productMigrationConfig.js';
import { publicProofProviderV1 } from '../lib/publicProofProvider.js';

/** Just enough of the outcome store to name a provider. Narrow on purpose: this
 * route reads one record and must not be able to reach for more. */
export interface ProviderOutcomeReaderV1 {
  getProviderOutcomeByProofId(input: {
    tenantId: string;
    proofId: string;
  }): Promise<{ providerId: string } | null>;
}
import {
  buildPublicNftProofBundleV1,
  buildPublicRouteProofBundleV1,
  publicProofFilenameV1,
  type PublicProofBundleV1,
} from '../lib/publicProofBundle.js';

// ---------------------------------------------------------------------------
// T67C.2 — public proof links.
//
// Two halves with different rules, deliberately in one file so they cannot
// drift:
//
//   * The OWNER half (share / revoke) is authenticated and tenant-scoped. A
//     proof is never published automatically; publishing is always an explicit
//     act by the person whose wallet is in it.
//   * The PUBLIC half opens without a session, a wallet or SIWE, because a
//     proof nobody but the owner can read is not a proof anybody can check.
//
// Everything a visitor sees is rebuilt from the proof on each request, so a
// revoked link stops working immediately and a bundle can never drift from the
// record it describes. `Cache-Control: no-store` is set for the same reason:
// revocation that takes effect "eventually" is not revocation.
//
// A revoked id and an id that never existed produce the SAME 404. Otherwise
// the difference between them would leak which links used to exist.
// ---------------------------------------------------------------------------

/** Owner-side routes; mounted under /api/route-intelligence. */
export const publicProofOwnerRouter = Router();
/** Visitor-side routes; mounted OUTSIDE the tenant middleware. */
export const publicProofRouter = Router();

export const publicProofRuntime = {
  flags: getMiorailProductMigrationFlags,
  shares: (): PublicProofShareRepositoryV1 => createDatabasePublicProofShareRepository(client),
  routeRepository: (): RouteStorageRepository => createDatabaseRouteStorageRepository(client),
  nftRepository: (): NftStorageRepository => createDatabaseNftStorageRepository(client),
  outcomeRepository: (): ProviderOutcomeReaderV1 => createDatabaseProviderOutcomeRepository(client),
  migrationAvailable: async (): Promise<boolean> => {
    const rows = await client`SELECT to_regclass('public.public_proof_shares') AS shares`;
    const row = rows[0];
    return Boolean(row && row.shares);
  },
  now: () => new Date(),
};

function sessionUser(req: Request) {
  const user = req.session?.user;
  if (
    !user ||
    user.chainId !== 8453 ||
    !/^0x[0-9a-f]{40}$/.test(user.address) ||
    user.id !== `eip155:8453:${user.address}`
  ) return null;
  return user;
}

function flagOff(res: Response): boolean {
  const flags = publicProofRuntime.flags(process.env);
  if (flags.routeIntelligenceV1 && flags.publicProofV1) return false;
  // 404 rather than 403: with the feature off, these paths do not exist.
  res.status(404).json({ error: 'public_proof_disabled', code: 'public_proof_disabled' });
  return true;
}

function notFound(res: Response): void {
  res.status(404).json({ error: 'public_proof_not_found', code: 'public_proof_not_found' });
}

/**
 * Rebuilds the bundle for a live share.
 *
 * Returns null when the underlying proof has gone or is not publishable, which
 * the caller renders as the same 404 as an unknown id.
 */
export async function bundleForShareV1(
  deps: {
    route: RouteStorageRepository;
    nft: NftStorageRepository;
    /** T68F §9 — the server's own record of who executed this proof. Optional
     * so a caller without an outcome store still builds a readable bundle. */
    outcomes?: ProviderOutcomeReaderV1;
  },
  share: PublicProofShareV1,
): Promise<PublicProofBundleV1 | null> {
  if (share.proofFamily === 'route') {
    const proof = await deps.route.getProofProjection(share.proofId, share.tenantId);
    if (!proof || !proofIsPublishableV1(proof.finalStatus)) return null;
    const events = await deps.route.listProofEvents(share.proofId, share.tenantId);
    // The provider comes from the DERIVED outcome, keyed by proof id — never
    // from a client, and never from a name that travelled in a request. A proof
    // with no outcome row stays null, which is what a legacy record looks like
    // and must keep looking like.
    const outcome = deps.outcomes
      ? await deps.outcomes
          .getProviderOutcomeByProofId({ tenantId: share.tenantId, proofId: share.proofId })
          .catch(() => null)
      : null;
    return buildPublicRouteProofBundleV1({
      share,
      provider: publicProofProviderV1({ outcome }),
      proof,
      events,
    });
  }
  const record = await deps.nft.getNftProof(share.proofId, share.tenantId);
  if (!record) return null;
  // An NFT proof that is still open has not answered the ownership question,
  // so there is nothing to publish yet.
  if (record.proof.status !== 'finalized') return null;
  const events = await deps.nft.listNftProofEvents(share.proofId, share.tenantId);
  // NFT proofs have no derived provider outcome, so this stays null — an
  // honest "we do not record that for this family" rather than a guess.
  return buildPublicNftProofBundleV1({ share, provider: null, proof: record.proof, events });
}

async function shareRoute(
  req: Request,
  res: Response,
  proofFamily: ProofFamilyV1,
): Promise<void> {
  if (flagOff(res)) return;
  const user = sessionUser(req);
  if (!user) {
    res.status(401).json({ error: 'authentication_required', code: 'authentication_required' });
    return;
  }
  try {
    if (!(await publicProofRuntime.migrationAvailable())) {
      res.status(503).json({ error: 'public_proof_unavailable', code: 'public_proof_unavailable' });
      return;
    }
    const proofId = String(req.params.proofId);
    const deps = {
      route: publicProofRuntime.routeRepository(),
      nft: publicProofRuntime.nftRepository(),
    };

    // Ownership and publishability are checked against the PROOF, not against
    // the share request: the caller names an id and nothing else.
    if (proofFamily === 'route') {
      const proof = await deps.route.getProofProjection(proofId, user.id);
      if (!proof) return notFound(res);
      if (!proofIsPublishableV1(proof.finalStatus)) {
        res.status(409).json({ error: 'proof_not_final', code: 'proof_not_final' });
        return;
      }
    } else {
      const record = await deps.nft.getNftProof(proofId, user.id);
      if (!record) return notFound(res);
      if (record.proof.status !== 'finalized') {
        res.status(409).json({ error: 'proof_not_final', code: 'proof_not_final' });
        return;
      }
    }

    const share = await publicProofRuntime.shares().createShare({
      tenantId: user.id,
      proofFamily,
      proofId,
      now: publicProofRuntime.now(),
    });
    res.json(
      PublicProofShareResponseV1Schema.parse({
        publicId: share.publicId,
        url: `/proof/${share.publicId}`,
        createdAt: share.createdAt,
      }),
    );
  } catch (error) {
    logger.error('Public proof share failed', { name: error instanceof Error ? error.name : 'unknown' });
    res.status(500).json({ error: 'public_proof_failed', code: 'public_proof_failed' });
  }
}

async function revokeRoute(req: Request, res: Response, proofFamily: ProofFamilyV1): Promise<void> {
  if (flagOff(res)) return;
  const user = sessionUser(req);
  if (!user) {
    res.status(401).json({ error: 'authentication_required', code: 'authentication_required' });
    return;
  }
  try {
    if (!(await publicProofRuntime.migrationAvailable())) {
      res.status(503).json({ error: 'public_proof_unavailable', code: 'public_proof_unavailable' });
      return;
    }
    // Idempotent: revoking twice is a success, because the caller's intent —
    // "this link must not work" — is satisfied either way.
    const revoked = await publicProofRuntime
      .shares()
      .revokeShare(user.id, proofFamily, String(req.params.proofId), publicProofRuntime.now());
    res.json({ revoked });
  } catch (error) {
    logger.error('Public proof revoke failed', { name: error instanceof Error ? error.name : 'unknown' });
    res.status(500).json({ error: 'public_proof_failed', code: 'public_proof_failed' });
  }
}

publicProofOwnerRouter.post('/route-proofs/:proofId/share', (req, res) => void shareRoute(req, res, 'route'));
publicProofOwnerRouter.delete('/route-proofs/:proofId/share', (req, res) => void revokeRoute(req, res, 'route'));
publicProofOwnerRouter.post('/nft/proofs/:proofId/share', (req, res) => void shareRoute(req, res, 'nft'));
publicProofOwnerRouter.delete('/nft/proofs/:proofId/share', (req, res) => void revokeRoute(req, res, 'nft'));

// --- the public half --------------------------------------------------------

async function loadPublicBundleV1(publicId: string): Promise<PublicProofBundleV1 | null> {
  const share = await publicProofRuntime.shares().getLiveShare(publicId);
  if (!share) return null;
  return bundleForShareV1(
    {
      route: publicProofRuntime.routeRepository(),
      nft: publicProofRuntime.nftRepository(),
      outcomes: publicProofRuntime.outcomeRepository(),
    },
    share,
  );
}

publicProofRouter.get('/proofs/:publicId', async (req: Request, res: Response) => {
  if (flagOff(res)) return;
  try {
    if (!(await publicProofRuntime.migrationAvailable())) {
      res.status(503).json({ error: 'public_proof_unavailable', code: 'public_proof_unavailable' });
      return;
    }
    const bundle = await loadPublicBundleV1(String(req.params.publicId));
    if (!bundle) return notFound(res);
    // Revocation must bite immediately, so nothing here may be cached.
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    res.json({ bundle });
  } catch (error) {
    logger.error('Public proof read failed', { name: error instanceof Error ? error.name : 'unknown' });
    res.status(500).json({ error: 'public_proof_failed', code: 'public_proof_failed' });
  }
});

publicProofRouter.get('/proofs/:publicId/bundle', async (req: Request, res: Response) => {
  if (flagOff(res)) return;
  try {
    if (!(await publicProofRuntime.migrationAvailable())) {
      res.status(503).json({ error: 'public_proof_unavailable', code: 'public_proof_unavailable' });
      return;
    }
    const publicId = String(req.params.publicId);
    const bundle = await loadPublicBundleV1(publicId);
    if (!bundle) return notFound(res);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${publicProofFilenameV1(publicId)}"`);
    // The canonical document itself, not wrapped in an envelope: what is
    // downloaded is exactly what a verifier is asked to check.
    res.send(JSON.stringify(bundle));
  } catch (error) {
    logger.error('Public proof bundle failed', { name: error instanceof Error ? error.name : 'unknown' });
    res.status(500).json({ error: 'public_proof_failed', code: 'public_proof_failed' });
  }
});
