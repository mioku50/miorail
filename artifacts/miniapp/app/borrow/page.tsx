"use client";
import { Suspense } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useSession } from '@mioagent/api-client-react';
import { StillBorrow, borrowAssetFromQueryV1, useStillBorrowEntryV1, useStillSkyV1, useStillClientPaletteV1 } from '@mioagent/ui/still';
import { WalletConnect } from '../components/WalletConnect';
import '@mioagent/ui/still.css';

function BaseBorrowEntry() {
  const router=useRouter(), params=useSearchParams(), session=useSession({retry:false,staleTime:0});
  const sky=useStillSkyV1(), palette=useStillClientPaletteV1(sky);
  const entry=useStillBorrowEntryV1({sky,signedIn:Boolean(session.data?.user),wallet:session.data?.user?.address,
    initialAsset:borrowAssetFromQueryV1(params.get('asset')),onReviewLink:href=>router.push(href)});
  const signInHref=`/signin?next=${encodeURIComponent('/app/borrow'+(params.toString()?'?'+params.toString():''))}`;
  return <main className="still" data-sky={palette} style={{minHeight:'100dvh',padding:'16px 0 32px'}}>
    <div style={{maxWidth:1100,margin:'0 auto'}}>
      <header className="still-section" style={{display:'flex',alignItems:'center',justifyContent:'space-between',gap:12}}>
        <Link href="/">Back to Miorail</Link><WalletConnect />
      </header>
      {session.isPending ? <p className="still-section still-note" role="status">Checking your sign-in…</p> : <StillBorrow model={{...entry.model,signInHref}} />}
    </div>
  </main>;
}
export default function BaseBorrowPage() {
  return <Suspense fallback={<p role="status">Opening borrowing…</p>}><BaseBorrowEntry /></Suspense>;
}
