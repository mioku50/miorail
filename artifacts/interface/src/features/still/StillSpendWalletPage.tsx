import { useEffect, useState } from 'react';
import { useRoute } from 'wouter';
import { concat, type Hex } from 'viem';
import { useAccount, useConfig, useSendCalls } from 'wagmi';
import { sendTransaction } from 'wagmi/actions';
import { useStillSpendOrderV1 } from '@mioagent/api-client-react';
import { walletRefusedBatchesV1 } from '@mioagent/ui';
import { StillFrame, StillSpendWalletPay, spendOrderViewV1, useSpendWalletPaymentV1 } from '@mioagent/ui/still';
import { builderCodeForSurfaceV1, builderCodeToDataSuffix, useWalletBatchSupportV1 } from '@mioagent/wallet-actions';
import { useStillSky, useStillWallet } from './useStillSky';

const SPEND_BUILDER_SUFFIX_V1 = builderCodeToDataSuffix(builderCodeForSurfaceV1({
  VITE_BASE_BUILDER_CODE: import.meta.env?.VITE_BASE_BUILDER_CODE as string | undefined,
  VITE_BUILDER_CODE: import.meta.env?.VITE_BUILDER_CODE as string | undefined,
}));

/** A Bitrefill invoice paid from the wallet's own USDC. The host supplies the
 * wallet: one call, as a batch of one where the wallet sends batches and as one
 * transaction where it cannot, each with Still's builder code. A wallet that
 * refuses a batch for what it is (Coinbase Wallet with an imported key) sent
 * nothing, so the same call goes as one transaction on the same press. */
export function StillSpendWalletPage() {
  const [, params] = useRoute('/spend/pay/:id');
  const sky = useStillSky(), session = useStillWallet();
  const { address } = useAccount(), sendCalls = useSendCalls(), config = useConfig();
  const batches = useWalletBatchSupportV1();
  const orderId = params?.id && /^[0-9a-f-]{36}$/.test(params.id) ? params.id : null;
  const payment = useSpendWalletPaymentV1({
    orderId, sessionWalletAddress: session.signedIn ? session.wallet : null, walletAddress: address ?? null, walletName: batches.walletName,
    send: async (call) => {
      const asOne = async () => ({ transactionHash: (await sendTransaction(config, { account: address!, chainId: 8453, to: call.to as Hex, value: BigInt(call.value),
        data: SPEND_BUILDER_SUFFIX_V1 ? concat([call.data as Hex, SPEND_BUILDER_SUFFIX_V1 as Hex]) : call.data as Hex })).toLowerCase() });
      if (batches.blocker && address) return asOne();
      let result: unknown;
      try {
        result = await sendCalls.mutateAsync({ chainId: 8453, forceAtomic: true,
          calls: [{ to: call.to as `0x${string}`, data: call.data as `0x${string}`, value: BigInt(call.value) }],
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
