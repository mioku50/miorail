import { useEffect, useMemo, useState } from 'react';
import { useRoute } from 'wouter';
import { concat, type Hex } from 'viem';
import { useAccount, useConfig, useSendCalls } from 'wagmi';
import { sendTransaction, waitForTransactionReceipt } from 'wagmi/actions';
import { LendingReviewScreen, STILL_PUBLIC_ORIGIN_V1, lendingFeeNoteV1, useLendingReviewConsoleV1, useTelegramAlertsV1, type LendingStepsWalletV1 } from '@mioagent/ui';
import { useSponsoredGasStatus, useStillEligibilityV1, useStillSpendOrderV1 } from '@mioagent/api-client-react';
import { StillFrame, StillLoanAlertsOffer, StillLoanShare, StillSpendPaid, loanShareTextV1, spendOrderViewV1, spendSharePathV1, spendShareTextV1, stillEligibilityViewV1 } from '@mioagent/ui/still';
import { builderCodeForSurfaceV1, builderCodeToDataSuffix, attributedCallsV1, isWalletRejectionError, paymasterServiceSupportV1, requireLiveWalletAccountV1, sendCallsCapabilitiesV1,
  sponsoredGasPlanV1, useWalletBatchSupportV1 } from '@mioagent/wallet-actions';
import { useStillSky, useStillWallet } from '../still/useStillSky';

const LENDING_BUILDER_SUFFIX_V1 = builderCodeToDataSuffix(builderCodeForSurfaceV1({
  VITE_BASE_BUILDER_CODE: import.meta.env?.VITE_BASE_BUILDER_CODE as string | undefined,
  VITE_BUILDER_CODE: import.meta.env?.VITE_BUILDER_CODE as string | undefined,
}));

/** The host supplies the wallet; the shared controller owns fresh review,
 * changed-terms confirmation, submission locking and status reading. */
export function LendingReviewPage() {
  const [, params] = useRoute('/lending/:draft');
  const [, legacyParams] = useRoute('/borrow/:draft');
  const sky = useStillSky(), session = useStillWallet();
  const { address } = useAccount(), sendCalls = useSendCalls(), config = useConfig();
  // Rabby has no wallet_sendCalls, and Coinbase Wallet with an imported key
  // refuses one. Such a wallet asks the server for the review in steps: an
  // Aave V4 loan or repayment then goes one transaction at a time, each with
  // Still's builder code in its own calldata. Anything else stays one batch,
  // and the server says so.
  const batches = useWalletBatchSupportV1();
  // The review is the signed-in wallet's: every send names it, so a wallet that now answers as another
  // account is refused before it is asked (audit WAL-1, 2026-11-10).
  const owner = session.signedIn ? session.wallet as Hex : null;
  const steps = useMemo<LendingStepsWalletV1 | null>(() => batches.blocker && address && owner ? {
    send: async call => {
      // A restored connection is brought back before the wallet is asked (2026-11-09).
      await requireLiveWalletAccountV1(config, owner);
      return sendTransaction(config, { account: owner, chainId: 8453, to: call.to as Hex, value: BigInt(call.value),
        data: LENDING_BUILDER_SUFFIX_V1 ? concat([call.data as Hex, LENDING_BUILDER_SUFFIX_V1 as Hex]) : call.data as Hex });
    },
    receipt: async hash => (await waitForTransactionReceipt(config, { hash: hash as Hex, chainId: 8453, timeout: 180_000 }).catch(() => null))?.status ?? null,
  } : null, [batches.blocker, address, owner, config]);
  // Still pays a batch's network fee when the arm offers it and the wallet takes a fee sponsor
  // (2026-11-08). After the wallet failed with the sponsor, the next press goes without one.
  const sponsoredGas = useSponsoredGasStatus({ enabled: session.signedIn });
  const [sponsorDeclined, setSponsorDeclined] = useState(false);
  // A new loan's review waits for this sign-in's confirmation that it is not a US person, given in the
  // line at the top of the page; once it lands, the refused review is read again, once (2026-11-10).
  const eligibility = useStillEligibilityV1(session.signedIn ? session.wallet : null, { enabled: session.signedIn });
  const eligibilityClear = eligibility.data !== undefined && stillEligibilityViewV1(eligibility.data)?.kind === 'clear';
  const [reread, setReread] = useState(0);
  const feeNote = lendingFeeNoteV1({
    loansSponsored: sponsoredGas.data?.sponsoredGas === 'on' && sponsoredGas.data.scope === 'reviewed_stock_swaps_and_still_loans',
    walletTakesSponsor: steps || sponsorDeclined ? false : paymasterServiceSupportV1(batches.capabilities),
    dailyLimitPerWallet: sponsoredGas.data?.dailyLimitPerWallet ?? null,
  });
  const review = useLendingReviewConsoleV1({ draft: params?.draft ?? legacyParams?.draft ?? null,
    sessionWalletAddress: session.signedIn ? session.wallet : null, walletAddress: address ?? null,
    walletBlocker: steps ? null : batches.blocker, walletName: batches.walletName, onWalletRefusal: batches.remember, steps, feeNote, rereadKey: reread,
    sendCalls: async ({ calls, sponsorship }) => {
      // A restored connection is brought back before the wallet is asked, and outside the try below:
      // a connection that was not ready is not the sponsor's failure (2026-11-09).
      if (!owner) throw new Error('lending_identity_changed');
      await requireLiveWalletAccountV1(config, owner);
      const gas = sponsoredGasPlanV1({ offer: sponsorship ?? null, capabilities: batches.capabilities, declinedBefore: sponsorDeclined });
      try {
        const result = await sendCalls.mutateAsync({ account: owner, chainId: 8453, forceAtomic: true,
          // A wallet that drops `dataSuffix` (MetaMask) gets the code in each call's own data.
          calls: attributedCallsV1({ calls: calls.map(call => ({ to: call.to as `0x${string}`, data: call.data as `0x${string}`, value: BigInt(call.value) })),
            suffix: LENDING_BUILDER_SUFFIX_V1, capabilities: batches.capabilities, sponsored: gas.state === 'sponsored' }),
          capabilities: sendCallsCapabilitiesV1({ suffix: LENDING_BUILDER_SUFFIX_V1, sponsor: gas.capability }),
        });
        return typeof result === 'string' ? result : ((result as { id?: string })?.id ?? null);
      } catch (error) {
        // Whatever else failed, the next press must not depend on the sponsor; the person's own No is not the sponsor's.
        if (gas.capability && !isWalletRejectionError(error)) setSponsorDeclined(true);
        throw error;
      }
    },
  });
  const waitingForConfirmation = review.model.body?.state === 'refused' && review.model.body.refusal === 'eligibility_required';
  useEffect(() => { if (eligibilityClear && waitingForConfirmation && reread === 0) setReread(1); }, [eligibilityClear, waitingForConfirmation, reread]);
  // Offered once the loan is confirmed onchain: a repayment needs no alert.
  const telegram = useTelegramAlertsV1({ enabled: session.signedIn });
  const confirmedLoan = review.model.execution?.state === 'confirmed' && review.model.body?.facts?.operation === 'borrow';
  // Still Spend: the loan paid a Bitrefill invoice; Bitrefill says where the order stands.
  const paidOrder = confirmedLoan ? review.model.body?.facts?.payment?.orderId ?? null : null;
  // Asked again every fifteen seconds until Bitrefill settles it; the server says when that is.
  const order = useStillSpendOrderV1(paidOrder, { refetchInterval: 15_000 });
  const orderView = order.data !== undefined ? spendOrderViewV1(order.data) : null;
  // The card the server signed once it confirmed the loan; its link names the purchase, never the wallet.
  const sharePath = paidOrder ? spendSharePathV1(review.model.execution?.share?.path) : null;
  const facts = review.model.body?.facts;
  const share = sharePath && facts?.payment ? { url: `${STILL_PUBLIC_ORIGIN_V1}${sharePath}`,
    text: spendShareTextV1({ productName: facts.payment.productName, collateralSymbol: facts.collateralSymbol }) } : null;
  // A plain loan's card: how much, against what, through which protocol; never the wallet.
  const loanPath = confirmedLoan && !paidOrder ? spendSharePathV1(review.model.execution?.share?.path) : null;
  const loanShare = loanPath && facts ? { url: `${STILL_PUBLIC_ORIGIN_V1}${loanPath}`, text: loanShareTextV1({ collateralSymbol: facts.collateralSymbol }) } : null;
  return <StillFrame tab="assets" sky={sky}>{session.booting
    ? <p className="still-section still-note" role="status">Checking your sign-in…</p>
    : <>
      <LendingReviewScreen model={review.model} />
      {paidOrder ? <StillSpendPaid order={orderView} reading={order.isFetching} share={share} /> : null}
      {loanShare && loanPath ? <StillLoanShare share={loanShare} cardUrl={`/api/public/still/spend-card.png?t=${encodeURIComponent(loanPath.slice('/spend/p/'.length))}`} /> : null}
      {confirmedLoan ? <StillLoanAlertsOffer telegram={telegram} /> : null}
    </>}</StillFrame>;
}
