// Whether the connected wallet can send a batch as ONE transaction. The
// classification lives in lib/ui (src/console/walletBatchSupport.ts) because
// the Still lending and stock action consoles there read the same answers; this
// module keeps the names wallet-actions has always exported, and the hook that
// asks the wallet, which needs wagmi.

import { useAccount, useCapabilities } from 'wagmi';
import { walletBatchBlockerV1, walletLacksCapabilitiesMethodV1 } from '@mioagent/ui';

export {
  WALLET_CANNOT_BATCH_V1,
  WALLET_HAS_NO_BATCHES_V1,
  WALLET_UPGRADE_DECLINED_V1,
  atomicBatchSupportV1,
  walletBatchBlockerV1,
  walletCannotSendSentenceV1,
  walletDidNotSendV1,
  walletLacksCapabilitiesMethodV1,
  walletSubmissionFailureMessageV1,
} from '@mioagent/ui';
export type { AtomicBatchSupportV1 } from '@mioagent/ui';

/**
 * The connected wallet's capabilities, and the sentence that stops a page
 * before anything is approved when the wallet cannot send one batch.
 *
 * A missing method is an answer, so it is not retried: three retries would
 * leave the button live for seven seconds in front of a wallet that already
 * said no.
 */
export function useWalletBatchSupportV1(): {
  capabilities: unknown;
  /** Why the capabilities could not be read; a missing method is an answer. */
  capabilitiesError: unknown;
  blocker: string | null;
  walletName: string | null;
} {
  const { address, connector } = useAccount();
  const { data, error } = useCapabilities({
    account: address,
    query: { retry: (failures, cause) => !walletLacksCapabilitiesMethodV1(cause) && failures < 3 },
  });
  const walletName = connector?.name ?? null;
  return {
    capabilities: data,
    capabilitiesError: error,
    blocker: address ? walletBatchBlockerV1({ capabilities: data, capabilitiesError: error, walletName }) : null,
    walletName,
  };
}
