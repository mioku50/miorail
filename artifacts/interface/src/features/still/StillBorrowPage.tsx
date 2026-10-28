import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'wouter';
import { useBorrowCapacity, useCreateBorrowIntentV1 } from '@mioagent/api-client-react';
import {
  StillBorrow, StillFrame, borrowCollateralTokenV1, parseBorrowDecimalV1, stillBorrowCapacityViewV1,
  type StillBorrowAssetV1,
} from '@mioagent/ui/still';
import { useStillSky, useStillWallet } from './useStillSky';

interface AskedLimitV1 { asset: StillBorrowAssetV1; supplyAtomic: string; wallet: string }

/** Query text may select one supported token, never an address or amount. */
function initialAssetV1(): StillBorrowAssetV1 | null {
  const asset = new URLSearchParams(window.location.search).get('asset');
  return asset === 'cbBTC' || asset === 'WETH' ? asset : null;
}

export function StillBorrowPage() {
  const [, navigate] = useLocation();
  const sky = useStillSky();
  const { signedIn, booting, wallet } = useStillWallet();
  const [asset, setAsset] = useState<StillBorrowAssetV1 | null>(initialAssetV1);
  const [collateralAmount, setCollateralAmount] = useState('0');
  const [borrowAmount, setBorrowAmount] = useState('');
  const [asked, setAsked] = useState<AskedLimitV1 | null>(null);
  const [error, setError] = useState<string | null>(null);
  const preparing = useRef(false);
  const mounted = useRef(true);
  const identity = JSON.stringify([signedIn, wallet?.toLowerCase() ?? null, asset, collateralAmount, borrowAmount]);
  const currentIdentity = useRef(identity);
  currentIdentity.current = identity;
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const owner = signedIn ? wallet?.toLowerCase() ?? null : null;
  const activeAsked = asked && asked.wallet === owner ? asked : null;
  const parsedSupply = asset ? parseBorrowDecimalV1(collateralAmount, asset === 'cbBTC' ? 8 : 18, true) : { atomic: null, error: null };
  const needsRead = activeAsked === null || activeAsked.asset !== asset || parsedSupply.atomic !== activeAsked.supplyAtomic;
  // This key changes only when the person presses Read borrowing limit.
  // Editing either amount must never start an independent wallet/RPC read.
  const limit = useBorrowCapacity(activeAsked ? borrowCollateralTokenV1(activeAsked.asset) : null, activeAsked?.supplyAtomic ?? null);
  const intent = useCreateBorrowIntentV1();
  const view = activeAsked && limit.data !== undefined && !limit.error
    ? stillBorrowCapacityViewV1(limit.data, activeAsked.asset, activeAsked.supplyAtomic)
    : { capacity: null, error: null };
  const reading = activeAsked !== null && limit.isFetching;
  const signInHref = `/signin?next=${encodeURIComponent(asset ? `/borrow?asset=${asset}` : '/borrow')}`;

  const onReadLimit = () => {
    if (!signedIn || !owner || preparing.current || limit.isFetching) return;
    if (!asset) { setError('Choose cbBTC or WETH first.'); return; }
    const parsed = parseBorrowDecimalV1(collateralAmount, asset === 'cbBTC' ? 8 : 18, true);
    if (parsed.atomic === null) { setError(parsed.error); return; }
    setError(null);
    if (activeAsked?.asset === asset && activeAsked.supplyAtomic === parsed.atomic) {
      // An unchanged key does not trigger useQuery again. This explicit read
      // still asks for a fresh answer, including after an earlier refusal.
      void limit.refetch();
    } else setAsked({ asset, supplyAtomic: parsed.atomic, wallet: owner });
  };

  const onReview = async () => {
    if (preparing.current || !signedIn || !owner || !asset || needsRead || reading || !view.capacity) return;
    const supply = parseBorrowDecimalV1(collateralAmount, asset === 'cbBTC' ? 8 : 18, true);
    const borrow = parseBorrowDecimalV1(borrowAmount, 6);
    if (supply.atomic === null || borrow.atomic === null) { setError(supply.error ?? borrow.error); return; }
    const openedFor = identity;
    preparing.current = true;
    setError(null);
    try {
      const result = await intent.mutateAsync({
        collateralTokenAddress: borrowCollateralTokenV1(asset), collateralSupplyAtomic: supply.atomic, borrowAmountAtomic: borrow.atomic,
      });
      if (!mounted.current || currentIdentity.current !== openedFor) return;
      if (Date.parse(result.expiresAt) <= Date.now()) {
        setError('This review link expired before it could open. Read the limit again.');
        return;
      }
      // The API hook accepts only a local /borrow/<signed-draft> link. This
      // page asks no wallet to open, sign, approve or submit anything.
      navigate(result.reviewUrl);
    } catch {
      if (mounted.current && currentIdentity.current === openedFor) {
        setError('The loan review could not be prepared. Read your limit again before trying to review it.');
      }
    } finally { preparing.current = false; }
  };

  return (
    <StillFrame tab="assets" sky={sky}>
      {booting ? <p className="still-section still-note" role="status">Checking your sign-in…</p> : (
        <StillBorrow model={{
          sky, signedIn, signInHref, asset,
          onAsset: (next) => { setAsset(next); setError(null); },
          collateralAmount, onCollateralAmount: (next) => { setCollateralAmount(next); setError(null); },
          borrowAmount, onBorrowAmount: (next) => { setBorrowAmount(next); setError(null); },
          reading, preparing: intent.isPending, needsRead, onReadLimit, onReview: () => void onReview(),
          capacity: view.capacity,
          error: error ?? (!needsRead && !reading ? limit.error ? 'Your borrowing limit could not be read. Read it again before continuing.' : view.error : null),
        }} />
      )}
    </StillFrame>
  );
}
