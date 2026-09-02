import {
  B20_POLICY_REGISTRY_V1,
  bridgeCapabilityFromReadsV1,
  decodeUint64WordV1,
  encodeIsAuthorizedCallV1,
  encodeIsPausedCallV1,
  encodeOftPeersCallV1,
  encodeOftProbeCallV1,
  encodePolicyExistsCallV1,
  encodePolicyIdCallV1,
  transferPauseFromReadV1,
  transferPolicyBindingFromReadsV1,
  walletPolicyCheckFromReadsV1,
  type B20TransferScopeV1,
  type BridgeCapabilityV1,
  type RawCallResultV1,
  type TransferPauseStateV1,
  type TransferPolicyBindingV1,
  type WalletPolicyCheckV1,
} from './onchainUse.js';

// ---------------------------------------------------------------------------
// Use & access, assembled for one exact address.
//
// Every field here is a measurement or a named absence. Nothing is inferred
// from the issuer, from the ticker, or from what a sibling representation
// answered — three CHEESEBURGE contracts once shared a screen, and the whole
// point of an exact-address surface is that an address speaks only for itself.
//
// One block anchor for the whole snapshot, taken first, so a card cannot mix a
// pause read from one block with a policy read from another.
// ---------------------------------------------------------------------------

/** The LayerZero endpoint ids a bridge destination may be claimed for.
 *
 * A short pinned list rather than a scan: `peers(uint32)` has no enumeration,
 * so a destination can only be claimed for an id somebody named. These are the
 * chains a Base representation plausibly bridges to, and a peer configured to
 * an id NOT in this list is invisible here — which is why the copy says
 * "checked", never "the only ones". */
export const BRIDGE_ENDPOINT_IDS_V1: Readonly<Record<number, string>> = {
  30101: 'Ethereum',
  30110: 'Arbitrum',
  30111: 'Optimism',
  30109: 'Polygon',
  30102: 'BNB Chain',
  30106: 'Avalanche',
  30184: 'Base',
};

export type DefiUseKindV1 = 'lend' | 'borrow' | 'collateral';

export interface DefiVenueListingV1 {
  venueId: string;
  venueName: string;
  /** `listed` only when the venue itself names this exact address. */
  state: 'listed' | 'not_listed' | 'unread';
  /** Per axis, and never merged: a token accepted as collateral is not
   * necessarily one anybody can borrow. Null means the venue did not say. */
  uses: Readonly<Record<DefiUseKindV1, boolean | null>>;
  marketRef: string | null;
  reason: string | null;
}

export interface DefiListingV1 {
  /** Named in the copy, so "not found" is always bounded by where we looked. */
  checkedVenues: string[];
  venues: DefiVenueListingV1[];
}

export interface RepresentationUseAccessV1 {
  schemaVersion: 'representation-use-access/v1';
  chainId: 8453;
  tokenAddress: string;
  caip10: string;
  /** The one block every onchain field below was read at. Null when the anchor
   * itself could not be taken, in which case nothing onchain was read. */
  blockTag: string | null;
  observedAt: string;
  transfers: TransferPauseStateV1;
  transferPolicies: TransferPolicyBindingV1[];
  bridge: BridgeCapabilityV1;
  defi: DefiListingV1;
  /**
   * The signed-in wallet's own answer, or null when nobody is signed in.
   *
   * ONCHAIN ADDRESS-POLICY ONLY. Not KYC, not jurisdiction eligibility, not
   * legal permission to trade a security. There is no field here that could be
   * read as one.
   */
  wallet: { address: string; checks: WalletPolicyCheckV1[] } | null;
}

export interface UseAccessReaderV1 {
  readBlockAnchor(): Promise<{ ok: true; value: { blockTag: string } } | { ok: false; reason: string }>;
  call(input: { to: string; data: string; blockTag: string }): Promise<
    { ok: true; value: string } | { ok: false; reason: string; detail?: string }
  >;
}

export interface DefiListingSourceV1 {
  venueId: string;
  venueName: string;
  lookup(tokenAddress: string): Promise<DefiVenueListingV1>;
}

const SCOPES_V1: readonly B20TransferScopeV1[] = ['sender', 'receiver', 'executor'];

function rawV1(
  result: { ok: true; value: string } | { ok: false; reason: string; detail?: string },
): RawCallResultV1 {
  return result.ok ? { ok: true, value: result.value } : { ok: false, reason: result.reason };
}

function unreadEverythingV1(
  tokenAddress: string,
  observedAt: string,
  reason: string,
  defi: DefiListingV1,
  walletAddress: string | null,
): RepresentationUseAccessV1 {
  return {
    schemaVersion: 'representation-use-access/v1',
    chainId: 8453,
    tokenAddress,
    caip10: `eip155:8453:${tokenAddress}`,
    blockTag: null,
    observedAt,
    transfers: { state: 'unread', reason },
    transferPolicies: SCOPES_V1.map((scope) => ({ scope, state: 'unread' as const, reason })),
    bridge: { state: 'unread', reason },
    defi,
    wallet: walletAddress
      ? {
          address: walletAddress,
          checks: SCOPES_V1.map((scope) => ({ scope, state: 'not_confirmed' as const, reason })),
        }
      : null,
  };
}

export async function assembleUseAccessV1(input: {
  tokenAddress: string;
  reader: UseAccessReaderV1;
  now: Date;
  defiSources?: readonly DefiListingSourceV1[];
  /** The signed-in wallet, or null. Never taken from a request field. */
  walletAddress?: string | null;
  bridgeEndpointIds?: readonly number[];
}): Promise<RepresentationUseAccessV1> {
  const tokenAddress = input.tokenAddress.toLowerCase();
  const observedAt = input.now.toISOString();
  const walletAddress = input.walletAddress?.toLowerCase() ?? null;
  const endpointIds = input.bridgeEndpointIds ?? Object.keys(BRIDGE_ENDPOINT_IDS_V1).map(Number);

  // DeFi first and independently: it does not read the chain through this
  // reader, so a chain outage must not also erase the venue answer.
  const defi = await defiListingV1(tokenAddress, input.defiSources ?? []);

  const anchor = await input.reader.readBlockAnchor();
  if (!anchor.ok) {
    return unreadEverythingV1(tokenAddress, observedAt, anchor.reason, defi, walletAddress);
  }
  const blockTag = anchor.value.blockTag;
  const at = (to: string, data: string) => input.reader.call({ to, data, blockTag });

  const transfers = transferPauseFromReadV1(rawV1(await at(tokenAddress, encodeIsPausedCallV1())));

  const transferPolicies: TransferPolicyBindingV1[] = [];
  for (const scope of SCOPES_V1) {
    const policyIdRead = rawV1(await at(tokenAddress, encodePolicyIdCallV1(scope)));
    let existsRead: RawCallResultV1 | null = null;
    if (policyIdRead.ok) {
      const policyId = decodeUint64WordV1(policyIdRead.value);
      if (policyId !== null && policyId !== 0n) {
        existsRead = rawV1(
          await at(B20_POLICY_REGISTRY_V1, encodePolicyExistsCallV1(policyId)),
        );
      }
    }
    transferPolicies.push(transferPolicyBindingFromReadsV1(scope, policyIdRead, existsRead));
  }

  const endpointRead = rawV1(await at(tokenAddress, encodeOftProbeCallV1('endpoint')));
  const peers: { endpointId: number; read: RawCallResultV1 }[] = [];
  if (endpointRead.ok) {
    for (const endpointId of endpointIds) {
      peers.push({
        endpointId,
        read: rawV1(await at(tokenAddress, encodeOftPeersCallV1(endpointId))),
      });
    }
  }
  const bridge = bridgeCapabilityFromReadsV1({ endpoint: endpointRead, peers });

  let wallet: RepresentationUseAccessV1['wallet'] = null;
  if (walletAddress) {
    const checks: WalletPolicyCheckV1[] = [];
    for (const binding of transferPolicies) {
      // Only a scope with a real, existing policy is worth an RPC call, and
      // only such a scope can produce anything but `not_confirmed`.
      const authorized =
        binding.state === 'bound' && binding.policyExists
          ? rawV1(
              await at(
                B20_POLICY_REGISTRY_V1,
                encodeIsAuthorizedCallV1(BigInt(binding.policyId), walletAddress),
              ),
            )
          : null;
      checks.push(walletPolicyCheckFromReadsV1(binding, authorized));
    }
    wallet = { address: walletAddress, checks };
  }

  return {
    schemaVersion: 'representation-use-access/v1',
    chainId: 8453,
    tokenAddress,
    caip10: `eip155:8453:${tokenAddress}`,
    blockTag,
    observedAt,
    transfers,
    transferPolicies,
    bridge,
    defi,
    wallet,
  };
}

/**
 * Venue listings, each venue failing on its own.
 *
 * A venue that could not be read is `unread` for that venue only. Collapsing a
 * transport failure into "not listed" is how a gap of ours becomes a claim
 * about the token, and `checkedVenues` exists so the absence copy can never say
 * more than "the venues Miorail checked".
 */
export async function defiListingV1(
  tokenAddress: string,
  sources: readonly DefiListingSourceV1[],
): Promise<DefiListingV1> {
  const venues: DefiVenueListingV1[] = [];
  for (const source of sources) {
    try {
      venues.push(await source.lookup(tokenAddress.toLowerCase()));
    } catch (error) {
      venues.push({
        venueId: source.venueId,
        venueName: source.venueName,
        state: 'unread',
        uses: { lend: null, borrow: null, collateral: null },
        marketRef: null,
        reason: error instanceof Error ? error.message.slice(0, 200) : 'venue read failed',
      });
    }
  }
  return { checkedVenues: sources.map((source) => source.venueName), venues };
}

/** The venues that found this exact address, with what each of them allows. */
export function establishedDefiUsesV1(
  listing: DefiListingV1,
): { kind: DefiUseKindV1; venues: string[] }[] {
  const byKind: { kind: DefiUseKindV1; venues: string[] }[] = [
    { kind: 'lend', venues: [] },
    { kind: 'borrow', venues: [] },
    { kind: 'collateral', venues: [] },
  ];
  for (const venue of listing.venues) {
    if (venue.state !== 'listed') continue;
    for (const entry of byKind) {
      if (venue.uses[entry.kind] === true) entry.venues.push(venue.venueName);
    }
  }
  return byKind.filter((entry) => entry.venues.length > 0);
}
