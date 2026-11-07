import { useEffect, useRef, useState } from 'react';
import { readBorrowCapacityOnceV1, useBorrowCapacity, useCreateBorrowIntentV1 } from '@mioagent/api-client-react';
import { tokenDecimalV1 } from '../console/stockSellAmount';
import { borrowCollateralTokenV1, borrowCollateralDecimalsV1, parseBorrowDecimalV1, stillBorrowBalanceViewV1, stillBorrowCapacityViewV1 } from './borrowIntent';
import type { StillBorrowAssetV1, StillBorrowModelV1, StillBorrowSpendV1 } from './StillBorrow';
import type { SkyStateV1 } from './skyState';
interface AskedLimitV1 { asset: StillBorrowAssetV1; supplyAtomic: string; wallet: string }
export function useStillBorrowEntryV1(input: {
  sky: SkyStateV1; signedIn: boolean; wallet: string | null | undefined; initialAsset: StillBorrowAssetV1 | null;
  onReviewLink: (href: string) => void;
  /** Still Spend: the Bitrefill invoice the loan pays, as its owner's page read it. */
  spend?: { orderId: string; view: StillBorrowSpendV1 } | null;
}): { model: StillBorrowModelV1 } {
  const {sky,signedIn,wallet}=input;
  const spendView = input.spend?.view ?? null;
  const fixedAmount = spendView?.state === 'ready' ? spendView.priceUsdc : input.spend ? '' : null;
  const [asset, setAsset] = useState<StillBorrowAssetV1 | null>(input.initialAsset);
  const [collateralAmount, setCollateralAmount] = useState('0');
  const [borrowAmount, setBorrowAmount] = useState('');
  const [asked, setAsked] = useState<AskedLimitV1 | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [maxReading, setMaxReading] = useState(false);
  const preparing = useRef(false);
  const mounted = useRef(true);
  const identity = JSON.stringify([signedIn, wallet?.toLowerCase() ?? null, asset, collateralAmount, fixedAmount ?? borrowAmount, input.spend?.orderId ?? null]);
  const assetRef = useRef(asset);
  assetRef.current = asset;
  const currentIdentity = useRef(identity);
  currentIdentity.current = identity;
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const owner = signedIn ? wallet?.toLowerCase() ?? null : null;
  const activeAsked = asked && asked.wallet === owner ? asked : null;
  const parsedSupply = asset ? parseBorrowDecimalV1(collateralAmount, borrowCollateralDecimalsV1(asset), asset !== 'ETH') : { atomic: null, error: null };
  const needsRead = activeAsked === null || activeAsked.asset !== asset || parsedSupply.atomic !== activeAsked.supplyAtomic;
  // This key changes only when the person presses Read borrowing limit.
  // Editing either amount must never start an independent wallet/RPC read.
  const limit = useBorrowCapacity(activeAsked ? borrowCollateralTokenV1(activeAsked.asset) : null, activeAsked?.supplyAtomic ?? null, activeAsked?.asset === 'ETH' ? 'native' : undefined);
  const intent = useCreateBorrowIntentV1();
  const view: ReturnType<typeof stillBorrowCapacityViewV1> = activeAsked && limit.data !== undefined && !limit.error
    ? stillBorrowCapacityViewV1(limit.data, activeAsked.asset, activeAsked.supplyAtomic)
    : { capacity: null, error: null };
  const reading = activeAsked !== null && limit.isFetching;
  const signInHref = `/signin?next=${encodeURIComponent(input.spend ? `/borrow?spend=${input.spend.orderId}` : asset ? `/borrow?asset=${asset}` : '/borrow')}`;

  const onReadLimit = () => {
    if (!signedIn || !owner || preparing.current || limit.isFetching) return;
    if (!asset) { setError('Choose a stock, cbBTC, WETH, native ETH or PAXG first.'); return; }
    const parsed = parseBorrowDecimalV1(collateralAmount, borrowCollateralDecimalsV1(asset), asset !== 'ETH');
    if (parsed.atomic === null) { setError(parsed.error); return; }
    setError(null);
    if (activeAsked?.asset === asset && activeAsked.supplyAtomic === parsed.atomic) {
      // An unchanged key does not trigger useQuery again. This explicit read
      // still asks for a fresh answer, including after an earlier refusal.
      void limit.refetch();
    } else setAsked({ asset, supplyAtomic: parsed.atomic, wallet: owner });
  };

  // Max asks the server for this wallet's balance of the chosen collateral, once,
  // and fills the field with it; the person still reads the limit for it.
  const onMax = async () => {
    if (!signedIn || !owner || !asset || maxReading || preparing.current || limit.isFetching) return;
    const chosen = asset;
    const openedFor = JSON.stringify([owner, chosen]);
    setMaxReading(true);
    setError(null);
    try {
      // Native ETH is read as a pledge of one wei: the server answers with the balance and the fee reserve.
      const payload = await readBorrowCapacityOnceV1(borrowCollateralTokenV1(chosen), chosen === 'ETH' ? '1' : '0', chosen === 'ETH' ? 'native' : undefined);
      if (!mounted.current || JSON.stringify([owner, chosen]) !== openedFor || assetRef.current !== chosen) return;
      const view = stillBorrowBalanceViewV1(payload, chosen);
      if (view.maxAtomic === null) { setError(view.error); return; }
      setCollateralAmount(tokenDecimalV1(view.maxAtomic, borrowCollateralDecimalsV1(chosen)));
    } catch {
      if (mounted.current && assetRef.current === chosen) setError('Your balance could not be read just now. Enter the amount yourself, or press Max again.');
    } finally {
      if (mounted.current) setMaxReading(false);
    }
  };

  const onReview = async () => {
    if (preparing.current || !signedIn || !owner || !asset || needsRead || reading || !view.capacity) return;
    if (input.spend && (fixedAmount === null || fixedAmount === '')) return;
    if (input.spend && asset === 'ETH') { setError('A payment cannot ride on native ETH. Choose WETH, cbBTC, PAXG or a stock.'); return; }
    const supply = parseBorrowDecimalV1(collateralAmount, borrowCollateralDecimalsV1(asset), asset !== 'ETH');
    const borrow = parseBorrowDecimalV1(fixedAmount ?? borrowAmount, 6);
    if (supply.atomic === null || borrow.atomic === null) { setError(supply.error ?? borrow.error); return; }
    const openedFor = identity;
    preparing.current = true;
    setError(null);
    try {
      const result = await intent.mutateAsync({
        collateralTokenAddress: borrowCollateralTokenV1(asset), collateralSupplyAtomic: supply.atomic, borrowAmountAtomic: borrow.atomic,
        ...(asset === 'ETH' ? {nativeFundingAtomic:supply.atomic} : {}),
        ...(input.spend ? { spendOrderId: input.spend.orderId } : {}),
      });
      if (!mounted.current || currentIdentity.current !== openedFor) return;
      if (Date.parse(result.expiresAt) <= Date.now()) {
        setError('This review link expired before it could open. Read the limit again.');
        return;
      }
      // The API hook accepts only a local signed lending/legacy borrow link. This
      // page asks no wallet to open, sign, approve or submit anything.
      input.onReviewLink(result.reviewUrl);
    } catch (failure) {
      if (mounted.current && currentIdentity.current === openedFor) {
        const code = failure instanceof Error ? failure.message.split(':')[0]!.trim() : '';
        setError(code === 'spend_order_not_found' ? 'Still no longer holds this Bitrefill invoice. Open a new one from Spend; nothing was paid.'
          : code === 'spend_order_expiring' ? 'Bitrefill’s price for this invoice ends within a few minutes. Open a new one from Spend; nothing was paid.'
            : code === 'spend_pay_off' ? 'Paying from Still is switched off on this server. Nothing was paid.'
              : 'The loan review could not be prepared. Read your limit again before trying to review it.');
      }
    } finally { preparing.current = false; }
  };

  return {model:{
          sky, signedIn, signInHref, asset,
          onAsset: (next) => { setAsset(next); setError(null); },
          collateralAmount, onCollateralAmount: (next) => { setCollateralAmount(next); setError(null); },
          borrowAmount: fixedAmount ?? borrowAmount, onBorrowAmount: (next) => { if (fixedAmount === null) { setBorrowAmount(next); setError(null); } },
          reading, preparing: intent.isPending, needsRead, onReadLimit, onReview: () => void onReview(),
          maxReading, onMax: () => void onMax(),
          capacity: view.capacity,
          error: error ?? (!needsRead && !reading ? limit.error ? 'Your borrowing limit could not be read. Read it again before continuing.' : view.error : null),
          // Fills the field; the person still presses Read borrowing limit.
          suggestedAmount: !error && !needsRead && !reading && view.suggestedAmount ? view.suggestedAmount : null,
          onSuggestedAmount: (amount: string) => { setCollateralAmount(amount); setError(null); },
          spend: spendView,
  }};
}
