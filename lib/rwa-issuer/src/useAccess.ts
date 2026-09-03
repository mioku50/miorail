import { z } from 'zod';

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
  /**
   * Did the venue itself put this asset on its list, or did somebody deploy a
   * market against it?
   *
   * On Morpho anyone can create a market for any token, and both of the two
   * tokenized-stock markets that exist on Base come back `listed: false` — not
   * on Morpho's curated list. That flag was queried and then never read, so an
   * uncurated market a stranger deployed rendered exactly like an asset the
   * venue accepted. Aave, Compound and Moonwell only carry assets their own
   * governance added, so `true` there is a fact about the protocol, not a
   * default.
   *
   * Null is a venue that does not publish the distinction; absent is a server
   * that predates the field. Neither is `false` — an unstated curation is not
   * a permissionless market.
   */
  curated?: boolean | null;
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

/**
 * The wire schema, defined beside the projection that fills it.
 *
 * Same object on both sides on purpose: a field dropped from one and not the
 * other is how a column renders blank with nothing failing.
 */
const ScopeV1 = z.enum(['sender', 'receiver', 'executor']);

export const RepresentationUseAccessV1Schema = z
  .object({
    schemaVersion: z.literal('representation-use-access/v1'),
    chainId: z.literal(8453),
    tokenAddress: z.string().regex(/^0x[0-9a-f]{40}$/),
    caip10: z.string().regex(/^eip155:8453:0x[0-9a-f]{40}$/),
    blockTag: z.string().min(1).max(80).nullable(),
    observedAt: z.string().min(1),
    transfers: z.discriminatedUnion('state', [
      z.object({ state: z.literal('read'), transfersPaused: z.boolean() }).strict(),
      z.object({ state: z.literal('unread'), reason: z.string() }).strict(),
    ]),
    transferPolicies: z.array(
      z.discriminatedUnion('state', [
        z.object({ scope: ScopeV1, state: z.literal('unrestricted') }).strict(),
        z
          .object({
            scope: ScopeV1,
            state: z.literal('bound'),
            policyId: z.string(),
            policyExists: z.boolean(),
          })
          .strict(),
        z.object({ scope: ScopeV1, state: z.literal('unread'), reason: z.string() }).strict(),
      ]),
    ),
    bridge: z.discriminatedUnion('state', [
      z.object({ state: z.literal('none_detected') }).strict(),
      z
        .object({
          state: z.literal('detected'),
          endpointAddress: z.string().nullable(),
          configuredPeers: z.array(z.number().int()),
        })
        .strict(),
      z.object({ state: z.literal('unread'), reason: z.string() }).strict(),
    ]),
    defi: z
      .object({
        checkedVenues: z.array(z.string()),
        venues: z.array(
          z
            .object({
              venueId: z.string(),
              venueName: z.string(),
              state: z.enum(['listed', 'not_listed', 'unread']),
              uses: z
                .object({
                  lend: z.boolean().nullable(),
                  borrow: z.boolean().nullable(),
                  collateral: z.boolean().nullable(),
                })
                .strict(),
              // Optional so a reply from a server that predates this field
              // still parses; absent and null both mean "not stated".
              curated: z.boolean().nullable().optional(),
              marketRef: z.string().nullable(),
              reason: z.string().nullable(),
            })
            .strict(),
        ),
      })
      .strict(),
    wallet: z
      .object({
        address: z.string().regex(/^0x[0-9a-f]{40}$/),
        checks: z.array(
          z.discriminatedUnion('state', [
            z
              .object({
                scope: ScopeV1,
                state: z.enum(['allowed', 'blocked']),
                policyId: z.string(),
              })
              .strict(),
            z.object({ scope: ScopeV1, state: z.literal('unrestricted') }).strict(),
            z
              .object({ scope: ScopeV1, state: z.literal('not_confirmed'), reason: z.string() })
              .strict(),
          ]),
        ),
      })
      .strict()
      .nullable(),
  })
  .strict();

function rawV1(
  result: { ok: true; value: string } | { ok: false; reason: string; detail?: string },
): RawCallResultV1 {
  return result.ok ? { ok: true, value: result.value } : { ok: false, reason: result.reason };
}

export type UseAccessCallV1 = { to: string; data: string; blockTag: string };
export type UseAccessAnswerV1 =
  | { ok: true; value: string }
  | { ok: false; reason: string; detail?: string };

export interface UseAccessReaderV1 {
  readBlockAnchor(): Promise<{ ok: true; value: { blockTag: string } } | { ok: false; reason: string }>;
  call(input: UseAccessCallV1): Promise<UseAccessAnswerV1>;
  /**
   * Several pinned calls in as few round trips as the endpoint allows.
   *
   * Optional, and the reason this whole assembly is written in rounds. The
   * public Base endpoint serves roughly half an `eth_call` a second; a live run
   * issuing eight sequential reads had the later ones fail and render as
   * `unread` and `not_confirmed` — a flaky surface producing honest-looking
   * absences, which is the worst possible failure for a page about permission.
   */
  callMany?(inputs: readonly UseAccessCallV1[]): Promise<UseAccessAnswerV1[]>;
}

async function roundV1(
  reader: UseAccessReaderV1,
  inputs: readonly UseAccessCallV1[],
): Promise<RawCallResultV1[]> {
  if (inputs.length === 0) return [];
  const answers = reader.callMany
    ? await reader.callMany(inputs)
    : await (async () => {
        const results: UseAccessAnswerV1[] = [];
        for (const input of inputs) results.push(await reader.call(input));
        return results;
      })();
  return answers.map(rawV1);
}

export interface DefiListingSourceV1 {
  venueId: string;
  venueName: string;
  lookup(tokenAddress: string): Promise<DefiVenueListingV1>;
}

const SCOPES_V1: readonly B20TransferScopeV1[] = ['sender', 'receiver', 'executor'];

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
  const call = (to: string, data: string): UseAccessCallV1 => ({ to, data, blockTag });

  // Round 1 — everything that depends on nothing.
  const first = await roundV1(input.reader, [
    call(tokenAddress, encodeIsPausedCallV1()),
    ...SCOPES_V1.map((scope) => call(tokenAddress, encodePolicyIdCallV1(scope))),
    call(tokenAddress, encodeOftProbeCallV1('endpoint')),
  ]);
  const transfers = transferPauseFromReadV1(first[0]!);
  const policyIdReads = SCOPES_V1.map((_, index) => first[index + 1]!);
  const endpointRead = first[SCOPES_V1.length + 1]!;

  // Round 2 — one existence read per DISTINCT policy, and the bridge peers.
  //
  // All three transfer scopes are normally bound to the same policy, so asking
  // the registry three times about policy 5 spent three calls to learn one
  // fact, and against a rate-limited endpoint the third is the one that fails.
  const distinctPolicies: string[] = [];
  for (const read of policyIdReads) {
    if (!read.ok) continue;
    const policyId = decodeUint64WordV1(read.value);
    if (policyId === null || policyId === 0n) continue;
    const key = policyId.toString();
    if (!distinctPolicies.includes(key)) distinctPolicies.push(key);
  }
  const peerIds = endpointRead.ok ? [...endpointIds] : [];
  const second = await roundV1(input.reader, [
    ...distinctPolicies.map((policyId) =>
      call(B20_POLICY_REGISTRY_V1, encodePolicyExistsCallV1(BigInt(policyId))),
    ),
    ...peerIds.map((endpointId) => call(tokenAddress, encodeOftPeersCallV1(endpointId))),
  ]);
  const existsByPolicy = new Map<string, RawCallResultV1>(
    distinctPolicies.map((policyId, index) => [policyId, second[index]!]),
  );
  const peers = peerIds.map((endpointId, index) => ({
    endpointId,
    read: second[distinctPolicies.length + index]!,
  }));

  const transferPolicies = SCOPES_V1.map((scope, index) => {
    const policyIdRead = policyIdReads[index]!;
    let existsRead: RawCallResultV1 | null = null;
    if (policyIdRead.ok) {
      const policyId = decodeUint64WordV1(policyIdRead.value);
      if (policyId !== null && policyId !== 0n) {
        existsRead = existsByPolicy.get(policyId.toString()) ?? null;
      }
    }
    return transferPolicyBindingFromReadsV1(scope, policyIdRead, existsRead);
  });

  const bridge = bridgeCapabilityFromReadsV1({ endpoint: endpointRead, peers });

  // Round 3 — the signed-in wallet, once per distinct gating policy.
  let wallet: RepresentationUseAccessV1['wallet'] = null;
  if (walletAddress) {
    const gating: string[] = [];
    for (const binding of transferPolicies) {
      if (binding.state === 'bound' && binding.policyExists && !gating.includes(binding.policyId)) {
        gating.push(binding.policyId);
      }
    }
    const third = await roundV1(
      input.reader,
      gating.map((policyId) =>
        call(B20_POLICY_REGISTRY_V1, encodeIsAuthorizedCallV1(BigInt(policyId), walletAddress)),
      ),
    );
    const authorizedByPolicy = new Map<string, RawCallResultV1>(
      gating.map((policyId, index) => [policyId, third[index]!]),
    );
    wallet = {
      address: walletAddress,
      checks: transferPolicies.map((binding) =>
        walletPolicyCheckFromReadsV1(
          binding,
          binding.state === 'bound' ? (authorizedByPolicy.get(binding.policyId) ?? null) : null,
        ),
      ),
    };
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
        curated: null,
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
