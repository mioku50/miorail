import { useEffect, useState } from 'react';
import { useRoute } from 'wouter';
import { concat, type Hex } from 'viem';
import { useAccount, useConfig, useSendCalls } from 'wagmi';
import { getCallsStatus, sendTransaction } from 'wagmi/actions';
import { useStillSpendOrderV1 } from '@mioagent/api-client-react';
import { walletRefusedBatchesV1 } from '@mioagent/ui';
import { StillFrame, StillSpendWalletPay, spendOrderViewV1, useSpendWalletPaymentV1 } from '@mioagent/ui/still';
import { attributedCallsV1, builderCodeForSurfaceV1, builderCodeToDataSuffix, requireLiveWalletConnectionV1, useWalletBatchSupportV1 } from '@mioagent/wallet-actions';
import { useStillSky, useStillWallet } from './useStillSky';

const SPEND_BUILDER_SUFFIX_V1 = builderCodeToDataSuffix(builderCodeForSurfaceV1({
  VITE_BASE_BUILDER_CODE: import.meta.env?.VITE_BASE_BUILDER_CODE as string | undefined,
  VITE_BUILDER_CODE: import.meta.env?.VITE_BUILDER_CODE as string | undefined,
}));

/** A Bitrefill invoice paid from the wallet's own USDC. The host supplies the
 * wallet: one call, as a batch of one where the wallet sends batches and as one
 * transaction where it cannot, each with Still's builder code. A wallet that
 * refuses a batch for what it is (Coinbase Wallet with an imported key) sent
 * nothing, so the same call goes as one transaction on the same press. Both
 * name the signed-in wallet that read the payment: another account picked in
 * the wallet meanwhile is refused by wagmi, not asked (re-audit R2,
 * 2026-11-04). A batch id only that wallet knows is asked of it (R5). */
export function StillSpendWalletPage() {
  const [, params] = useRoute('/spend/pay/:id');
  const sky = useStillSky(), session = useStillWallet();
  const { address } = useAccount(), sendCalls = useSendCalls(), config = useConfig();
  const batches = useWalletBatchSupportV1();
  const orderId = params?.id && /^[0-9a-f-]{36}$/.test(params.id) ? params.id : null;
  const payment = useSpendWalletPaymentV1({
    orderId, sessionWalletAddress: session.signedIn ? session.wallet : null, walletAddress: address ?? null, walletName: batches.walletName,
    send: async (call) => {
      // A restored connection is brought back before the wallet is asked (2026-11-09).
      await requireLiveWalletConnectionV1(config);
      const owner = session.wallet as Hex;
      const asOne = async () => ({ transactionHash: (await sendTransaction(config, { account: owner, chainId: 8453, to: call.to as Hex, value: BigInt(call.value),
        data: SPEND_BUILDER_SUFFIX_V1 ? concat([call.data as Hex, SPEND_BUILDER_SUFFIX_V1 as Hex]) : call.data as Hex })).toLowerCase() });
      if (batches.blocker && address) return asOne();
      let result: unknown;
      try {
        result = await sendCalls.mutateAsync({ account: owner, chainId: 8453, forceAtomic: true,
          // A wallet that drops `dataSuffix` (MetaMask) gets the code in the call's own data.
          calls: attributedCallsV1({ calls: [{ to: call.to as `0x${string}`, data: call.data as `0x${string}`, value: BigInt(call.value) }],
            suffix: SPEND_BUILDER_SUFFIX_V1, capabilities: batches.capabilities }),
          capabilities: SPEND_BUILDER_SUFFIX_V1 ? { dataSuffix: { value: SPEND_BUILDER_SUFFIX_V1, optional: true } } : undefined,
        });
      } catch (error) {
        if (!address || !walletRefusedBatchesV1(error)) throw error;
        batches.remember(error);
        return asOne();
      }
      const batchId = typeof result === 'string' ? result : (result as { id?: string } | null)?.id;
      if (!batchId) throw new Error('spend_wallet_no_batch_id');
      return { batchId };
    },
    lookup: async (batchId) => (await getCallsStatus(config, { id: batchId })).receipts?.map((receipt) => receipt.transactionHash) ?? null,
  });
  // Once Base shows the payment, Bitrefill says where the order stands.
  const paid = payment.view?.state === 'confirmed' ? orderId : null;
  const [delivered, setDelivered] = useState(false);
  const order = useStillSpendOrderV1(paid, { refetchInterval: delivered ? false : 15_000 });
  const orderView = order.data !== undefined ? spendOrderViewV1(order.data) : null;
  useEffect(() => { if (orderView?.delivered) setDelivered(true); }, [orderView?.delivered]);
  return (
    <StillFrame tab="more" sky={sky}>
      {session.booting
        ? <p className="still-section still-note" role="status">Checking your sign-in…</p>
        : <StillSpendWalletPay sky={sky} model={payment} order={orderView} orderReading={order.isFetching} />}
    </StillFrame>
  );
}
