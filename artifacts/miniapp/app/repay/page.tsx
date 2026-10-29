"use client";
import { Suspense } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useSession } from '@mioagent/api-client-react';
import { RepayEntryScreen, repayInitialAssetV1, useRepayEntryConsoleV1 } from '@mioagent/ui';
import { useStillSkyV1 } from '@mioagent/ui/still';
import { WalletConnect } from '../components/WalletConnect';
import '@mioagent/ui/still.css';

function BaseAppRepayEntry() {
  const params = useSearchParams(), router = useRouter();
  const session = useSession({ retry: false, staleTime: 0 }), sky = useStillSkyV1();
  const search = params.toString(), initialAsset = repayInitialAssetV1(search);
  const entry = useRepayEntryConsoleV1({ signedIn: Boolean(session.data?.user), walletIdentity: session.data?.user?.address ?? null, initialAsset,
    signInHref: `/signin?next=${encodeURIComponent(`/app/repay${search ? `?${search}` : ''}`)}`, onReview: href => router.push(href) });
  return <main className="still" data-sky={sky.phase} style={{ minHeight: '100dvh', padding: '16px 0 32px' }}>
    <div style={{ maxWidth: 1100, margin: '0 auto' }}>
      <header className="still-section" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}><Link href="/">Back to Miorail</Link><WalletConnect /></header>
      {session.isPending ? <p className="still-section still-note" role="status">Checking your sign-in…</p> : <RepayEntryScreen model={entry.model} />}
    </div>
  </main>;
}
export default function BaseAppRepayPage() {
  return <Suspense fallback={<p role="status">Opening repayment…</p>}><BaseAppRepayEntry /></Suspense>;
}
