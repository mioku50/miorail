import { useMemo } from 'react';
import { useLocation } from 'wouter';
import { useStillSpendOrderV1 } from '@mioagent/api-client-react';
import { StillBorrow, StillFrame, borrowAssetFromQueryV1, spendOrderViewV1, useStillBorrowEntryV1, type StillBorrowSpendV1 } from '@mioagent/ui/still';
import { useWalletBatchSupportV1 } from '@mioagent/wallet-actions';
import { useStillSky, useStillWallet } from './useStillSky';
export function StillBorrowPage() {
  const [, navigate] = useLocation();
  const sky = useStillSky(), {signedIn,booting,wallet}=useStillWallet();
  // Asks the wallet what it can send, nothing more: a loan goes only as one
  // batch, and a wallet without batches (Rabby) hears so before the review.
  const batches = useWalletBatchSupportV1();
  const params = new URLSearchParams(window.location.search);
  // Still Spend: /borrow?spend=<invoice> borrows exactly that invoice's price and pays it.
  const spendId = /^[0-9a-f-]{36}$/.test(params.get('spend') ?? '') ? params.get('spend') : null;
  const order = useStillSpendOrderV1(signedIn ? spendId : null);
  const spend = useMemo<{ orderId: string; view: StillBorrowSpendV1 } | null>(() => {
    if (!spendId) return null;
    const view = order.data !== undefined ? spendOrderViewV1(order.data) : null;
    return { orderId: spendId, view: view ? { state: 'ready', productName: view.productName, packageValue: view.packageValue, priceUsdc: view.priceUsdc, expiresAt: view.expiresAt }
      : order.isPending && signedIn ? { state: 'reading' } : { state: 'gone' } };
  }, [spendId, order.data, order.isPending, signedIn]);
  const entry=useStillBorrowEntryV1({sky,signedIn,wallet,initialAsset:borrowAssetFromQueryV1(params.get('asset')),onReviewLink:navigate,walletBlocker:batches.blocker,spend});
  return <StillFrame tab="assets" sky={sky}>
    {booting ? <p className="still-section still-note" role="status">Checking your sign-in…</p> : <StillBorrow model={entry.model} />}
  </StillFrame>;
}
