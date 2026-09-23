// ---------------------------------------------------------------------------
// Sponsored gas, from the wallet's side.
//
// The approve response may carry an offer: Miorail's paymaster URL and an
// opaque context bound to the exact calls just approved. This module decides
// whether that offer goes into `wallet_sendCalls` as the ERC-7677
// `paymasterService` capability, and what the screen may say about who pays
// the network fee. It never claims "paid by Miorail" for a wallet that did not
// say it can take a sponsor.
// ---------------------------------------------------------------------------

export interface SponsoredGasOfferV1 {
  paymasterUrl: string;
  context: { sponsorship: string };
}

/**
 * What happened to the fee on this submission.
 *
 * - `sponsored`: offered, and the wallet reports paymaster support.
 * - `offered`: offered, and the wallet did not say either way — it may ignore
 *   the optional capability and ask the person to pay.
 * - `unsupported_by_wallet`: offered, and the wallet cannot take a sponsor.
 * - `declined`: the wallet failed to send WITH the sponsor, so the next
 *   attempt goes without it.
 * - `not_offered`: no offer came with the approval.
 */
export type SponsoredGasStateV1 = 'sponsored' | 'offered' | 'unsupported_by_wallet' | 'declined' | 'not_offered';

export const SPONSORED_GAS_LABELS_V1: Readonly<Record<SponsoredGasStateV1, string | null>> = {
  sponsored: 'Miorail pays the network fee for this transaction.',
  offered: 'Miorail offered to pay the network fee; your wallet decides whether to use it.',
  unsupported_by_wallet: 'You pay the network fee: this wallet cannot take a fee sponsor.',
  declined:
    'The wallet could not send this with the fee sponsored. Press again to send it with you paying the network fee.',
  not_offered: null,
};

/** Whether the wallet reports ERC-7677 paymaster support on this chain. */
export function paymasterServiceSupportV1(capabilities: unknown, chainId = 8453): boolean | null {
  if (!capabilities || typeof capabilities !== 'object') return null;
  const byChain = capabilities as Record<string | number, unknown>;
  // wagmi keys by decimal chain id; the raw RPC keys by hex.
  const entry = byChain[chainId] ?? byChain[`0x${chainId.toString(16)}`];
  if (!entry || typeof entry !== 'object') return null;
  const service = (entry as Record<string, unknown>).paymasterService;
  if (!service || typeof service !== 'object') return null;
  const supported = (service as { supported?: unknown }).supported;
  return typeof supported === 'boolean' ? supported : null;
}

/**
 * The capability to send, and what to tell the person about the fee.
 *
 * `optional: true`, because the person asked for the transaction and not for
 * the sponsor: a wallet that does not understand the capability still sends
 * the batch, with the person paying, instead of refusing it.
 */
export function sponsoredGasPlanV1(input: {
  offer: SponsoredGasOfferV1 | null | undefined;
  capabilities: unknown;
  declinedBefore: boolean;
  chainId?: number;
}): {
  capability: { paymasterService: { url: string; context: { sponsorship: string }; optional: true } } | null;
  state: SponsoredGasStateV1;
} {
  if (!input.offer) return { capability: null, state: 'not_offered' };
  if (input.declinedBefore) return { capability: null, state: 'declined' };
  const support = paymasterServiceSupportV1(input.capabilities, input.chainId ?? 8453);
  if (support === false) return { capability: null, state: 'unsupported_by_wallet' };
  return {
    capability: {
      paymasterService: { url: input.offer.paymasterUrl, context: input.offer.context, optional: true },
    },
    state: support === true ? 'sponsored' : 'offered',
  };
}
