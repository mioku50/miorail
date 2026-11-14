import { attributedCallsV1 } from './attribution';
import { gasLimitedCallsV1, publicGasMeterV1, sendCallsKeepingCallCapabilitiesV1, type CodeReaderV1, type GasEstimatorV1, type WalletSendCallsInputV1 } from './gasLimitOverride';
import { requireLiveWalletAccountV1 } from './liveWalletConnection';
import { isWalletRejectionError } from './useSubmitApprovedBlueprint';

// ---------------------------------------------------------------------------
// A B20 entry, sent the same way on the site and in the mini app
// (audits WAL-5, WAL-6 and BASE-1, 2026-11-14).
//
// The server releases an entry's calls for the wallet its plan was made for,
// and says which: `payload.from`. Both pages asked the wallet as whichever
// account it had selected, and the mini app compared that with nothing, so a
// plan made under one sign-in could be asked of another account (the class of
// N13-3). The mini app also carried the Builder Code only as the `dataSuffix`
// capability, which MetaMask drops, and neither page gave Base Account each
// call's measured gas (734f6fa6, 2026-11-12: a batch given no gas to spare
// reverted twice on a multi-pool swap, and an entry is one).
//
// Now the account is the plan's, and it must be the one connected on the page;
// the code goes in each call's own data for a wallet that drops the capability;
// and each call carries its measured gas where the wallet takes it. Nothing is
// sent when the account differs: the wallet is not asked.
// ---------------------------------------------------------------------------

/** Refused before the wallet was asked: nothing was sent. */
export class B20EntryNotAskedErrorV1 extends Error {
  override name = 'B20EntryNotAskedError';
}

const shortV1 = (address: string): string => `${address.slice(0, 6)}…${address.slice(-4)}`;

/** Why the wallet connected here is not asked for an entry prepared for another account. */
export function b20EntryOtherAccountSentenceV1(planned: string, connected: string): string {
  return `This entry was prepared for ${shortV1(planned.toLowerCase())}, and the wallet connected here is ${shortV1(connected.toLowerCase())}. `
    + 'Your wallet was not asked and nothing was sent. Switch to that account in your wallet, then press again.';
}

export interface B20EntryPayloadV1 {
  from: string;
  calls: readonly { to: string; value: string; data: string }[];
  atomicRequired: boolean;
}

export interface SendB20EntryCallsInputV1 {
  config: object;
  payload: B20EntryPayloadV1;
  /** The account the page has connected now. */
  connectedAddress: string | undefined;
  suffix: string | null | undefined;
  /** The wallet's capabilities, asked now. */
  readCapabilities: () => Promise<unknown>;
  /** wagmi's `sendCalls`, for a batch without call capabilities. */
  sendCalls: (request: { account: `0x${string}`; calls: never; chainId: 8453; forceAtomic: boolean; capabilities?: Record<string, unknown> }) => Promise<unknown>;
  /** A send that carried measured gas failed for a reason but the person's No: the next press goes without. */
  gasLimitsDeclined: boolean;
  onGasLimitsDeclined?: () => void;
  /** Called once, just before the wallet is asked. */
  onAsk: () => void;
  /** Injected in tests. */
  meter?: { estimate: GasEstimatorV1; code: CodeReaderV1 };
  sendKeepingCallCapabilities?: (config: object, input: WalletSendCallsInputV1) => Promise<{ id: string }>;
  requireLiveAccount?: (config: object, account: string) => Promise<unknown>;
}

/** Sends a B20 entry's calls from the plan's account and says the wallet's batch id, or null when it named none. */
export async function sendB20EntryCallsV1(input: SendB20EntryCallsInputV1): Promise<{ batchId: string | null; measured: boolean }> {
  const from = input.payload.from.toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(from)) throw new B20EntryNotAskedErrorV1('This entry names no account to send from, so your wallet was not asked and nothing was sent.');
  if (!input.connectedAddress) throw new B20EntryNotAskedErrorV1('Your wallet is not connected, so it was not asked and nothing was sent.');
  if (input.connectedAddress.toLowerCase() !== from) throw new B20EntryNotAskedErrorV1(b20EntryOtherAccountSentenceV1(from, input.connectedAddress));
  // A restored connection is brought back before the wallet is asked (2026-11-09), for the plan's account:
  // a wallet that answers as another is not asked.
  await (input.requireLiveAccount ?? ((config, account) => requireLiveWalletAccountV1(config as never, account)))(input.config, from);
  const capabilities = await input.readCapabilities();
  // Each call's gas, measured, for a wallet that takes it; only a batch the wallet must keep whole.
  const sized = await gasLimitedCallsV1({ from, ...(input.meter ?? publicGasMeterV1(input.config)),
    // The calls' own bytes are the server's, untouched; only the code follows them, for a wallet that drops `dataSuffix`.
    calls: attributedCallsV1({ calls: input.payload.calls, suffix: input.suffix, capabilities }),
    capabilities: input.payload.atomicRequired && !input.gasLimitsDeclined ? capabilities : undefined });
  // Optional, so a wallet that does not understand the capability still sends the batch.
  const requestCapabilities = input.suffix ? { dataSuffix: { value: input.suffix, optional: true } } : undefined;
  input.onAsk();
  try {
    const result = sized.limits
      // viem drops a call's own capabilities, so calls carrying their gas go as the same request, sent directly.
      ? await (input.sendKeepingCallCapabilities ?? sendCallsKeepingCallCapabilitiesV1)(input.config,
        { account: from, chainId: 8453, forceAtomic: input.payload.atomicRequired, calls: sized.calls, capabilities: requestCapabilities })
      : await input.sendCalls({ account: from as `0x${string}`, calls: sized.calls as never, chainId: 8453, forceAtomic: input.payload.atomicRequired,
        capabilities: requestCapabilities });
    const batchId = typeof result === 'string' ? result : ((result as { id?: unknown } | null)?.id ?? null);
    return { batchId: typeof batchId === 'string' && batchId.length > 0 ? batchId : null, measured: sized.limits !== null };
  } catch (error) {
    if (sized.limits && !isWalletRejectionError(error)) input.onGasLimitsDeclined?.();
    throw error;
  }
}
