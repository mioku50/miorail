import { useLocation } from 'wouter';
import { StillBorrow, StillFrame, borrowAssetFromQueryV1, useStillBorrowEntryV1 } from '@mioagent/ui/still';
import { useStillSky, useStillWallet } from './useStillSky';
export function StillBorrowPage() {
  const [, navigate] = useLocation();
  const sky = useStillSky(), {signedIn,booting,wallet}=useStillWallet();
  const entry=useStillBorrowEntryV1({sky,signedIn,wallet,initialAsset:borrowAssetFromQueryV1(new URLSearchParams(window.location.search).get('asset')),onReviewLink:navigate});
  return <StillFrame tab="assets" sky={sky}>
    {booting ? <p className="still-section still-note" role="status">Checking your sign-in…</p> : <StillBorrow model={entry.model} />}
  </StillFrame>;
}
