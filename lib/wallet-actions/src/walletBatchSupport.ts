// Whether the connected wallet can send a batch as ONE transaction. The
// classification lives in lib/ui (src/console/walletBatchSupport.ts) because
// the Still lending and stock action consoles there read the same answers; this
// module keeps the names wallet-actions has always exported, and the hook that
// asks the wallet, which needs wagmi.

import { useCallback, useSyncExternalStore } from 'react';
import { useAccount, useCapabilities, useConfig } from 'wagmi';
import { getCapabilities } from 'wagmi/actions';
import {
  rememberWalletCannotBatchV1,
  subscribeWalletBatchVerdictsV1,
  walletBatchBlockerV1,
  walletBatchKeyV1,
  walletKnownNotToBatchV1,
  walletLacksCapabilitiesMethodV1,
  walletRefusedBatchesV1,
} from '@mioagent/ui';

export {
  WALLET_CANNOT_BATCH_V1,
  WALLET_HAS_NO_BATCHES_V1,
  WALLET_UPGRADE_DECLINED_V1,
  atomicBatchSupportV1,
  rememberWalletCannotBatchV1,
  walletBatchBlockerV1,
  walletBatchKeyV1,
  walletCannotSendSentenceV1,
  walletDidNotSendV1,
  walletKnownNotToBatchV1,
  walletLacksCapabilitiesMethodV1,
  walletRefusedBatchesV1,
  walletSubmissionFailureMessageV1,
} from '@mioagent/ui';
export type { AtomicBatchSupportV1 } from '@mioagent/ui';

/** How long a press waits for a wallet that has not answered yet. */
const CAPABILITIES_AT_PRESS_TIMEOUT_MS_V1 = 2_500;

/**
 * The connected wallet's capabilities, and the sentence that stops a page
 * before anything is approved when the wallet cannot send one batch.
 *
 * A missing method is an answer, so it is not retried: three retries would
 * leave the button live for seven seconds in front of a wallet that already
 * said no. Nor is it asked again on focus: TanStack puts a query that holds only
 * an error back to `pending` while it refetches, so every return to the tab
 * blanked Rabby's answer for a moment, and a press in that moment asked it for
 * a batch (2026-10-31).
 */
export function useWalletBatchSupportV1(): {
  capabilities: unknown;
  /** Why the capabilities could not be read; a missing method is an answer. */
  capabilitiesError: unknown;
  /** The wallet has answered, one way or the other. */
  answered: boolean;
  /** This wallet refused a batch earlier in this tab. */
  knownNotToBatch: boolean;
  blocker: string | null;
  walletName: string | null;
  /** Asks the wallet now, for a press that cannot wait for the hook. */
  readNow: () => Promise<{ capabilities: unknown; capabilitiesError: unknown }>;
  /** Keeps a refusal that is about the wallet, so it is not asked again. */
  remember: (cause: unknown) => void;
} {
  const { address, connector } = useAccount();
  const config = useConfig();
  const { data, error } = useCapabilities({
    account: address,
    query: {
      retry: (failures, cause) => !walletLacksCapabilitiesMethodV1(cause) && failures < 3,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      retryOnMount: false,
      staleTime: Number.POSITIVE_INFINITY,
    },
  });
  const walletName = connector?.name ?? null;
  const key = walletBatchKeyV1(connector?.id, address);
  const knownNotToBatch = useSyncExternalStore(
    subscribeWalletBatchVerdictsV1,
    () => walletKnownNotToBatchV1(key),
    () => false,
  );
  const readNow = useCallback(async () => {
    if (!address) return { capabilities: undefined, capabilitiesError: null };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<{ capabilities: unknown; capabilitiesError: unknown }>((resolve) => {
      timer = setTimeout(() => resolve({ capabilities: undefined, capabilitiesError: null }), CAPABILITIES_AT_PRESS_TIMEOUT_MS_V1);
    });
    const read = getCapabilities(config, { account: address }).then(
      (capabilities) => ({ capabilities: capabilities as unknown, capabilitiesError: null }),
      (cause: unknown) => ({ capabilities: undefined, capabilitiesError: cause }),
    );
    try {
      return await Promise.race([read, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }, [address, config]);
  const remember = useCallback(
    (cause: unknown) => {
      if (walletRefusedBatchesV1(cause)) rememberWalletCannotBatchV1(key);
    },
    [key],
  );
  return {
    capabilities: data,
    capabilitiesError: error,
    answered: data !== undefined || Boolean(error),
    knownNotToBatch,
    blocker: address ? walletBatchBlockerV1({ capabilities: data, capabilitiesError: error, walletName, knownNotToBatch }) : null,
    walletName,
    readNow,
    remember,
  };
}
