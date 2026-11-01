import { useEffect, useMemo, useState } from 'react';
import { useRoute } from 'wouter';
import { concat, type Hex } from 'viem';
import { useAccount, useConfig, useSendCalls } from 'wagmi';
import { sendTransaction, waitForTransactionReceipt } from 'wagmi/actions';
import { LendingReviewScreen, useLendingReviewConsoleV1, useTelegramAlertsV1, type LendingStepsWalletV1 } from '@mioagent/ui';
import { useStillSpendOrderV1 } from '@mioagent/api-client-react';
import { StillFrame, StillLoanAlertsOffer, StillSpendPaid, spendOrderViewV1 } from '@mioagent/ui/still';
import { builderCodeForSurfaceV1, builderCodeToDataSuffix, useWalletBatchSupportV1 } from '@mioagent/wallet-actions';
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
  const steps = useMemo<LendingStepsWalletV1 | null>(() => batches.blocker && address ? {
    send: async call => sendTransaction(config, { account: address, chainId: 8453, to: call.to as Hex, value: BigInt(call.value),
      data: LENDING_BUILDER_SUFFIX_V1 ? concat([call.data as Hex, LENDING_BUILDER_SUFFIX_V1 as Hex]) : call.data as Hex }),
    receipt: async hash => (await waitForTransactionReceipt(config, { hash: hash as Hex, chainId: 8453, timeout: 180_000 }).catch(() => null))?.status ?? null,
  } : null, [batches.blocker, address, config]);
  const review = useLendingReviewConsoleV1({ draft: params?.draft ?? legacyParams?.draft ?? null,
    sessionWalletAddress: session.signedIn ? session.wallet : null, walletAddress: address ?? null,
    walletBlocker: steps ? null : batches.blocker, walletName: batches.walletName, onWalletRefusal: batches.remember, steps,
    sendCalls: async ({ calls }) => {
      const result = await sendCalls.mutateAsync({ chainId: 8453, forceAtomic: true,
        calls: calls.map(call => ({ to: call.to as `0x${string}`, data: call.data as `0x${string}`, value: BigInt(call.value) })),
        capabilities: LENDING_BUILDER_SUFFIX_V1 ? { dataSuffix: { value: LENDING_BUILDER_SUFFIX_V1, optional: true } } : undefined,
      });
      return typeof result === 'string' ? result : ((result as { id?: string })?.id ?? null);
    },
  });
  // Offered once the loan is confirmed onchain: a repayment needs no alert.
  const telegram = useTelegramAlertsV1({ enabled: session.signedIn });
  const confirmedLoan = review.model.execution?.state === 'confirmed' && review.model.body?.facts?.operation === 'borrow';
  // Still Spend: the loan paid a Bitrefill invoice; Bitrefill says where the order stands.
  const paidOrder = confirmedLoan ? review.model.body?.facts?.payment?.orderId ?? null : null;
  const [delivered, setDelivered] = useState(false);
  const order = useStillSpendOrderV1(paidOrder, { refetchInterval: delivered ? false : 15_000 });
  const orderView = order.data !== undefined ? spendOrderViewV1(order.data) : null;
  useEffect(() => { if (orderView?.delivered) setDelivered(true); }, [orderView?.delivered]);
  return <StillFrame tab="assets" sky={sky}>{session.booting
    ? <p className="still-section still-note" role="status">Checking your sign-in…</p>
    : <>
      <LendingReviewScreen model={review.model} />
      {paidOrder ? <StillSpendPaid order={orderView} reading={order.isFetching} /> : null}
      {confirmedLoan ? <StillLoanAlertsOffer telegram={telegram} /> : null}
    </>}</StillFrame>;
}
