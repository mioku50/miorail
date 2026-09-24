import { useEffect, useMemo, useState } from 'react';
import { useRoute } from 'wouter';
import { giftOfPublicBundleV1, verifyPublicProofBundleV1 } from '@mioagent/proof-verifier';
import { PublicGiftCard, publicGiftPageViewV1, type PublicGiftLabelsV1 } from '@mioagent/ui';

// ---------------------------------------------------------------------------
// Growth plan step 4 — /gift/:publicId.
//
// A gift link is a public proof link, so this page opens with no session, no
// wallet and no SIWE, exactly like /proof/:publicId. It reads the same
// canonical bundle, VERIFIES it here in the reader's browser, and decodes the
// gift from the transfer's own calldata inside it. The server contributes two
// labels (the Basenames, the company) and nothing the page relies on: a label
// that does not arrive leaves an address in its place.
//
// The server already wrote the head for link previews; `noindex` is set here
// too, as the proof page does, for the copy of the head the app replaces.
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

export function PublicGiftPage() {
  const [, params] = useRoute('/gift/:publicId');
  const publicId = params?.publicId ?? '';
  useNoIndex();

  const [bundle, setBundle] = useState<unknown>(null);
  const [labels, setLabels] = useState<PublicGiftLabelsV1 | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'missing' | 'error'>('loading');

  useEffect(() => {
    let cancelled = false;
    if (!/^[0-9a-f]{48,}$/.test(publicId)) {
      setState('missing');
      return;
    }
    const id = encodeURIComponent(publicId);
    void (async () => {
      try {
        const response = await fetch(`/api/public/proofs/${id}`);
        if (cancelled) return;
        if (response.status === 404) {
          // Revoked and never-existed are one answer, as on the proof page.
          setState('missing');
          return;
        }
        if (!response.ok) {
          setState('error');
          return;
        }
        const body = (await response.json()) as { bundle?: unknown };
        if (cancelled) return;
        setBundle(body.bundle ?? null);
        setState('ready');
      } catch {
        if (!cancelled) setState('error');
      }
    })();
    // The labels are optional, so they are fetched beside the bundle and a
    // failure is silent: the page shows addresses instead.
    void (async () => {
      try {
        const response = await fetch(`/api/public/gifts/${id}`);
        if (!response.ok || cancelled) return;
        const body = (await response.json()) as PublicGiftLabelsV1;
        if (!cancelled) setLabels(body);
      } catch {
        // No labels is a page with addresses on it.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [publicId]);

  // Recomputed from the bytes that arrived; nothing in the answer is taken on
  // trust, and the gift is read out of the same bytes.
  const verification = useMemo(() => (bundle ? verifyPublicProofBundleV1(bundle) : null), [bundle]);
  const gift = useMemo(() => (bundle ? giftOfPublicBundleV1(bundle) : null), [bundle]);
  const view = useMemo(
    () =>
      gift
        ? publicGiftPageViewV1({
            publicId,
            origin: window.location.origin,
            gift,
            labels,
            verified: verification?.valid ?? null,
          })
        : null,
    [gift, labels, publicId, verification],
  );

  let body;
  if (state === 'loading') {
    body = (
      <section className="panel">
        <div className="pb">
          <p className="lnote">Loading the gift…</p>
        </div>
      </section>
    );
  } else if (state === 'missing' || (state === 'ready' && !view)) {
    body = (
      <section className="panel">
        <div className="ph">
          <h3>Gift not found</h3>
        </div>
        <div className="pb">
          <p className="lnote">
            {state === 'ready'
              ? 'This link is a proof, but not of a gift.'
              : 'This link is not valid. It may have been revoked by the person who shared it.'}
          </p>
          {state === 'ready' ? (
            <a className="btn sec" href={`/proof/${encodeURIComponent(publicId)}`}>
              Open the proof
            </a>
          ) : null}
        </div>
      </section>
    );
  } else if (state === 'error' || !view) {
    body = (
      <section className="panel">
        <div className="ph">
          <h3>Gift unavailable</h3>
        </div>
        <div className="pb">
          <p className="lnote">The gift could not be loaded. This says nothing about the gift itself.</p>
        </div>
      </section>
    );
  } else {
    body = <PublicGiftCard view={view} />;
  }

  return (
    <main className="mio-console gift-page">
      <div className="gift-page-inner">
        <p className="gift-brand">
          <a href="/stocks">Miorail</a>
        </p>
        {body}
      </div>
    </main>
  );
}
