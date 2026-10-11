import { Router, type Request, type Response } from 'express';
import { logger } from '@mioagent/utils';

import {
  MINI_APP_NAME_V1,
  MINI_APP_SPLASH_BACKGROUND_V1,
  miniAppIconUrlV1,
  miniAppSplashUrlV1,
} from '../lib/miniApp.js';
import { stockPagesRuntime } from './stockPages.js';

// ---------------------------------------------------------------------------
// /.well-known/farcaster.json: how Farcaster knows miorail.xyz is a mini app.
//
// Until 2026-10-11 this came from the old Next.js shell under /app, with an
// empty account association and every URL under /app. Farcaster could not
// tie the domain to anyone, so searching "miorail" in Farcaster found nothing
// and a link opened in its in-app browser rather than as an app.
//
// The association is a signature from the owner's Farcaster account over the
// domain. Only that account can make it (Farcaster → Developer → manifest
// tool), so it arrives through the environment, never the repository:
// FARCASTER_ACCOUNT_ASSOCIATION = {"header":"…","payload":"…","signature":"…"},
// or the tool's whole output, {"accountAssociation": {…}}.
// One signed for another domain is not served. Farcaster would reject it, and
// serving it would claim an app that is not this one.
//
// Field limits are the spec's (miniapps.farcaster.xyz/docs/specification).
// The description and subtitle carry no emoji or special characters.
// ---------------------------------------------------------------------------

export const farcasterManifestRouter = Router();

export type FarcasterAccountAssociationV1 = { header: string; payload: string; signature: string };

export type FarcasterAssociationReadV1 =
  | { association: FarcasterAccountAssociationV1; problem: null }
  | { association: null; problem: 'missing' | 'malformed' | 'other_domain' };

/** base64url, as the spec writes it; plain base64's two letters are taken too. */
const BASE64_V1 = /^[A-Za-z0-9_+/-]+={0,2}$/;

function decodedJsonV1(part: string): unknown {
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
}

/** The configured association, if it is whole and was signed for `domain`. */
export function farcasterAccountAssociationV1(raw: string | undefined, domain: string): FarcasterAssociationReadV1 {
  if (!raw || !raw.trim()) return { association: null, problem: 'missing' };
  try {
    const outer = JSON.parse(raw) as { accountAssociation?: unknown } | null;
    const parsed = (outer && typeof outer.accountAssociation === 'object' ? outer.accountAssociation : outer) as
      | Partial<Record<keyof FarcasterAccountAssociationV1, unknown>>
      | null;
    const parts = [parsed?.header, parsed?.payload, parsed?.signature];
    if (!parts.every((part): part is string => typeof part === 'string' && BASE64_V1.test(part))) {
      return { association: null, problem: 'malformed' };
    }
    const [header, payload, signature] = parts as [string, string, string];
    // Which key signed (custody, auth, app key) is Farcaster's to check.
    const signedHeader = decodedJsonV1(header) as { fid?: unknown; type?: unknown };
    if (typeof signedHeader?.fid !== 'number' || typeof signedHeader.type !== 'string') {
      return { association: null, problem: 'malformed' };
    }
    const signed = decodedJsonV1(payload) as { domain?: unknown };
    if (signed?.domain !== domain) return { association: null, problem: 'other_domain' };
    return { association: { header, payload, signature }, problem: null };
  } catch {
    return { association: null, problem: 'malformed' };
  }
}

export function farcasterManifestV1(input: {
  origin: string;
  association: FarcasterAccountAssociationV1 | null;
}): Record<string, unknown> {
  const { origin } = input;
  return {
    ...(input.association ? { accountAssociation: input.association } : {}),
    miniapp: {
      version: '1',
      name: MINI_APP_NAME_V1,
      homeUrl: `${origin}/stocks`,
      iconUrl: miniAppIconUrlV1(origin),
      splashImageUrl: miniAppSplashUrlV1(origin),
      splashBackgroundColor: MINI_APP_SPLASH_BACKGROUND_V1,
      subtitle: 'Tokenized stocks, measured',
      description:
        'Coinbase tokenized stocks on Base, measured at an exact size: the price against the real share, the cost to get back out, and a free weekend game.',
      primaryCategory: 'finance',
      tags: ['stocks', 'base', 'tokenized', 'weekend', 'onchain'],
      heroImageUrl: `${origin}/og-stocks.png`,
      tagline: 'Stocks on Base, measured',
      ogTitle: MINI_APP_NAME_V1,
      ogDescription: 'Tokenized stocks on Base: the price against the real share, and what it costs to get out.',
      ogImageUrl: `${origin}/og-stocks.png`,
      requiredChains: ['eip155:8453'],
      canonicalDomain: new URL(origin).host,
    },
  };
}

/** Said once per process and per kind: a misconfiguration, not an event. */
const reportedV1 = new Set<string>();

farcasterManifestRouter.get('/.well-known/farcaster.json', (_req: Request, res: Response) => {
  const origin = stockPagesRuntime.origin();
  const { association, problem } = farcasterAccountAssociationV1(
    process.env.FARCASTER_ACCOUNT_ASSOCIATION,
    new URL(origin).host,
  );
  if (problem && problem !== 'missing' && !reportedV1.has(problem)) {
    reportedV1.add(problem);
    logger.warn('Farcaster account association not served', { problem });
  }
  // Read by Farcaster's servers and by its web client, from its own origin.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.status(200).json(farcasterManifestV1({ origin, association }));
});
