import { useLocation } from 'wouter';
import { StillBorrow, StillFrame, borrowAssetFromQueryV1, useStillBorrowEntryV1 } from '@mioagent/ui/still';
import { useWalletBatchSupportV1 } from '@mioagent/wallet-actions';
import { useStillSky, useStillWallet } from './useStillSky';
export function StillBorrowPage() {
  const [, navigate] = useLocation();
  const sky = useStillSky(), {signedIn,booting,wallet}=useStillWallet();
  // Asks the wallet what it can send, nothing more: a loan goes only as one
  // batch, and a wallet without batches (Rabby) hears so before the review.
  const batches = useWalletBatchSupportV1();
  const entry=useStillBorrowEntryV1({sky,signedIn,wallet,initialAsset:borrowAssetFromQueryV1(new URLSearchParams(window.location.search).get('asset')),onReviewLink:navigate,walletBlocker:batches.blocker});
  return <StillFrame tab="assets" sky={sky}>
    {booting ? <p className="still-section still-note" role="status">Checking your sign-in…</p> : <StillBorrow model={entry.model} />}
  </StillFrame>;
}
