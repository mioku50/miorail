import { useState } from 'react';
import { useLocation } from 'wouter';
import { RepayEntryScreen, repayInitialAssetV1, useRepayEntryConsoleV1 } from '@mioagent/ui';
import { StillFrame } from '@mioagent/ui/still';
import { useStillSky, useStillWallet } from './useStillSky';

export function StillRepayPage() {
  const [, navigate] = useLocation();
  const sky = useStillSky(), session = useStillWallet();
  const [initialAsset] = useState(() => repayInitialAssetV1(window.location.search));
  const entry = useRepayEntryConsoleV1({ signedIn: session.signedIn, walletIdentity: session.wallet, initialAsset,
    signInHref: `/signin?next=${encodeURIComponent(`/repay${window.location.search}`)}`, onReview: navigate });
  return <StillFrame tab="assets" sky={sky}>{session.booting
    ? <p className="still-section still-note" role="status">Checking your sign-in…</p>
    : <RepayEntryScreen model={entry.model} />}</StillFrame>;
}
