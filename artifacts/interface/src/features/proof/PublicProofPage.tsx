import { useEffect, useMemo, useState } from 'react';
import { useRoute } from 'wouter';
import { verifyPublicProofBundleV1 } from '@mioagent/proof-verifier';
import {
  PublicProofHeaderPanel,
  PublicProofReceiptsPanel,
  PublicProofResultPanel,
  PublicProofVerificationPanel,
  type PublicProofCheckLikeV1,
  type PublicProofViewV1,
} from '@mioagent/ui';

// ---------------------------------------------------------------------------
// T67C.2 — /proof/:publicId.
//
// The only page in this app that renders without a session, a wallet or SIWE.
// It has to: a proof that only its owner can open is not a proof anyone else
// can check. It therefore does its own bare fetch rather than going through
// the authenticated client.
//
// `noindex, nofollow` is set on mount. A public link is unguessable, not
// secret, and the difference is that a search engine must never turn one into
// a discoverable page.
// ---------------------------------------------------------------------------

function useNoIndex(): void {
  useEffect(() => {
    const meta = document.createElement('meta');
    meta.name = 'robots';
    meta.content = 'noindex,nofollow';
    document.head.appendChild(meta);
    return () => {
      meta.remove();
    };
  }, []);
}

interface BundleShapeV1 {
  schemaVersion: string;
  publicProofId: string;
  proofFamily: 'route' | 'nft';
  issuedAt: string;
  bundleHash: string;
  provider: { providerName: string | null } | null;
  proof: Record<string, unknown>;
  events: unknown[];
}

/** Projects a bundle onto what the page shows. Anything the bundle does not
 * carry stays null and is rendered as "not recorded" — never as a zero. */
export function publicProofViewV1(bundle: BundleShapeV1): PublicProofViewV1 {
  const proof = bundle.proof;
  // Read structurally rather than through the domain types: this page renders
  // whatever a bundle carries, including a family whose fields it does not
  // know, and an unreadable field becomes null instead of a crash.
  const expected = proof.expectedResult as
    | { outputAmountAtomic?: string | null; assetChanges?: Array<{ direction: string; minimumAmountAtomic?: string | null }> }
    | null
    | undefined;
  const actual = proof.actualResult as { outputAmountAtomic?: string | null } | null | undefined;
  const minimum =
    expected?.assetChanges?.find((change) => change.direction === 'credit')?.minimumAmountAtomic ?? null;
  return {
    publicProofId: bundle.publicProofId,
    proofFamily: bundle.proofFamily,
    issuedAt: bundle.issuedAt,
    bundleHash: bundle.bundleHash,
    proofHash: String(proof.proofHash ?? ''),
    approvedCallsHash: String(proof.approvedCallsHash ?? ''),
    finalStatus: String(proof.finalStatus ?? 'unknown'),
    schemaVersion: bundle.schemaVersion,
    provider: bundle.provider?.providerName ?? null,
    expectedOutput: expected?.outputAmountAtomic ?? null,
    actualOutput: actual?.outputAmountAtomic ?? null,
    minimumOutput: minimum ?? null,
    deviationBps: (proof.deviation as { outputBps?: number | null } | undefined)?.outputBps ?? null,
    estimatedGas: (proof.estimatedGas as { gasUnits?: string } | undefined)?.gasUnits ?? null,
    actualGas: (proof.actualGas as { gasUnits?: string } | null | undefined)?.gasUnits ?? null,
    receipts: Array.isArray(proof.receipts) ? proof.receipts : [],
    eventCount: bundle.events.length,
  };
}

export function PublicProofPage() {
  const [, params] = useRoute('/proof/:publicId');
  const publicId = params?.publicId ?? '';
  useNoIndex();

  const [bundle, setBundle] = useState<BundleShapeV1 | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'missing' | 'error'>('loading');

  useEffect(() => {
    let cancelled = false;
    if (!publicId) {
      setState('missing');
      return;
    }
    void (async () => {
      try {
        const response = await fetch(`/api/public/proofs/${encodeURIComponent(publicId)}`);
        if (cancelled) return;
        if (response.status === 404) {
          // A revoked link and one that never existed are the same answer, on
          // purpose: the difference would leak which links used to exist.
          setState('missing');
          return;
        }
        if (!response.ok) {
          setState('error');
          return;
        }
        const body = (await response.json()) as { bundle: BundleShapeV1 };
        if (cancelled) return;
        setBundle(body.bundle);
        setState('ready');
      } catch {
        if (!cancelled) setState('error');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [publicId]);

  const view = useMemo(() => (bundle ? publicProofViewV1(bundle) : null), [bundle]);
  // The hashes are recomputed HERE, in the reader's browser, from the bytes
  // that arrived. Nothing about the server's answer is taken on trust — a
  // `valid` flag in the response would prove nothing and is not read.
  const verification = useMemo(() => (bundle ? verifyPublicProofBundleV1(bundle) : null), [bundle]);
  const checks: PublicProofCheckLikeV1[] = verification?.checks ?? [];

  if (state === 'loading') {
    return (
      <main className="console">
        <section className="panel">
          <p className="note">Loading proof…</p>
        </section>
      </main>
    );
  }
  if (state === 'missing') {
    return (
      <main className="console">
        <section className="panel">
          <h3>Proof not found</h3>
          <p className="note">This link is not valid. It may have been revoked by its owner.</p>
        </section>
      </main>
    );
  }
  if (state === 'error' || !view) {
    return (
      <main className="console">
        <section className="panel">
          <h3>Proof unavailable</h3>
          <p className="note">The proof could not be loaded. This says nothing about the proof itself.</p>
        </section>
      </main>
    );
  }

  return (
    <main className="console">
      <PublicProofHeaderPanel view={view} />
      <PublicProofResultPanel view={view} />
      <PublicProofReceiptsPanel view={view} />
      <PublicProofVerificationPanel view={view} checks={checks} valid={verification?.valid ?? null} />
      <section className="panel">
        <a className="mono" href={`/api/public/proofs/${encodeURIComponent(publicId)}/bundle`}>
          Download the canonical bundle
        </a>
      </section>
    </main>
  );
}
