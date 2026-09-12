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

import {
  ecosystemBlockV1,
  type EcosystemEvidenceV1,
  type RepresentationEcosystemV1,
} from './ecosystemClaims.js';

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

/**
 * Where one venue row came from, and when.
 *
 * Deliberately NOT the envelope's `blockTag`. Aave and Compound answer from
 * chain state read at head, unpinned and on purpose; Moonwell and Morpho answer
 * from their own catalogues, which publish no block at all. Four rows are four
 * readings, and the only axis all four share is the wall clock — so the wall
 * clock is the axis this states, and no block appears here to be mistaken for
 * the one above.
 */
export interface DefiVenueObservationV1 {
  /** `chain_head` — an `eth_call` at head. `venue_catalogue` — the venue's own API. */
  source: 'chain_head' | 'venue_catalogue';
  /** When this reading was taken. */
  at: string;
}

/**
 * What a venue said about one address.
 *
 * Carries no provenance on purpose: a pure projection of a venue's answer
 * cannot know when the answer was fetched, so it must not be able to claim it.
 * Only the caller that took the reading stamps that — see `DefiVenueListingV1`.
 */
export interface DefiVenueReadingV1 {
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

export interface DefiVenueListingV1 extends DefiVenueReadingV1 {
  /**
   * The reading's own provenance.
   *
   * Optional for the same reason `curated` is: a reply from a server that
   * predates the field still parses. Absent means "not stated" — it never
   * means this row was read at the envelope's block, because no row ever is.
   */
  observed?: DefiVenueObservationV1;
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
  /**
   * The one block the PINNED onchain fields below were read at — `transfers`,
   * `transferPolicies`, `bridge` and `wallet`. Null when the anchor itself
   * could not be taken, in which case none of those were read.
   *
   * It does not cover `defi`. Venue listings are read outside this anchor by
   * design, and two of the four venues publish no block at all; each venue row
   * carries its own `observed` instead. A reader that attributes this block to
   * a venue row is reading a claim nothing here makes.
   */
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
  /**
   * What the pools holding this exact address were MEASURED to contain.
   *
   * Stored, not read here: the balances come from a paced worker that pins
   * every pool and its pair to one block, and this route would otherwise pay
   * for thirty-nine chain reads on a page load. So the rows carry their own
   * block and clock, exactly like every other stored measurement, and
   * `state: 'not_measured'` is a real answer — a token nobody has measured yet
   * is not a token with no pools.
   *
   * Optional in the TYPE for the same reason it is optional in the schema: a
   * reply from a server that predates this field must still parse during a
   * rolling deploy. The assembler always sets it, so absent means "an older
   * deployment answered", never "no pools".
   */
  pools?: PooledLiquidityV1;
  /**
   * Who Base says supports these stocks, against who Miorail can see
   * supporting THIS address.
   *
   * Optional like `pools`, and for the same rolling-deploy reason. Absent
   * means the caller supplied no ecosystem evidence — never that nobody
   * supports the address, which is why an app Miorail cannot read is carried
   * as an `unchecked` ROW rather than dropped from the list.
   */
  ecosystem?: RepresentationEcosystemV1;
}

/**
 * Ranked by measured balance, deepest first, and never by count.
 *
 * Thirty-nine pools hold NVDAc and twenty-four of them pair it against a
 * memecoin — 71 NVDAc against 212 million KUMA. A count is true arithmetic
 * about a market that does not exist.
 */
export interface PooledLiquidityV1 {
  state: 'measured' | 'not_measured';
  /** The block the rows were read at. Null when nothing has been measured. */
  blockNumber: number | null;
  readAt: string | null;
  rows: PooledLiquidityRowV1[];
}

export interface PooledLiquidityRowV1 {
  poolAddress: string;
  /** Null when the factory answered and is not one we can name, and null when
   * the address answers no factory at all. `factoryAddress` tells the two
   * apart, and neither is an absence: a pool holding real money stays in the
   * answer without a label. */
  venueId: string | null;
  venueName: string | null;
  /**
   * The exchange's own page for this exact pool, or null.
   *
   * Built on the server from the venue tier, because only a `protocol` tier has
   * an exchange to point at and only a URL shape somebody opened and read back
   * may be built at all. Null is the common case and means the block explorer
   * is the whole link this row can honestly carry.
   */
  venuePageUrl: string | null;
  factoryAddress: string | null;
  /** Atomic, with its own decimals. Never a float: 1,614,910.95 USDC is
   * 1614910950000 and rounding it once rounds it forever. */
  tokenBalanceAtomic: string;
  tokenDecimals: number;
  pairedTokenAddress: string | null;
  pairedBalanceAtomic: string | null;
  pairedDecimals: number | null;
  pairedSymbol: string | null;
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
              // Optional for the same reason `curated` is. Absent is "not
              // stated", never "the block above".
              observed: z
                .object({
                  source: z.enum(['chain_head', 'venue_catalogue']),
                  at: z.string().min(1),
                })
                .strict()
                .optional(),
            })
            .strict(),
        ),
      })
      .strict(),
    // Optional so a reply from a server that predates this field still parses.
    // Absent is "this deployment does not measure pools", never "no pools".
    pools: z
      .object({
        state: z.enum(['measured', 'not_measured']),
        blockNumber: z.number().int().nonnegative().nullable(),
        readAt: z.string().min(1).nullable(),
        rows: z.array(
          z
            .object({
              poolAddress: z.string().regex(/^0x[0-9a-f]{40}$/),
              venueId: z.string().nullable(),
              venueName: z.string().nullable(),
              // Optional for the same reason `pools` is: a rolling deploy has
              // one side newer than the other, and a missing link must read as
              // "no page to point at" rather than fail the whole parse.
              venuePageUrl: z.string().url().nullable().default(null),
              factoryAddress: z.string().regex(/^0x[0-9a-f]{40}$/).nullable(),
              tokenBalanceAtomic: z.string().regex(/^\d+$/),
              tokenDecimals: z.number().int().min(0).max(36),
              pairedTokenAddress: z.string().regex(/^0x[0-9a-f]{40}$/).nullable(),
              pairedBalanceAtomic: z.string().regex(/^\d+$/).nullable(),
              pairedDecimals: z.number().int().min(0).max(36).nullable(),
              pairedSymbol: z.string().nullable(),
            })
            .strict(),
        ),
      })
      .strict()
      .optional(),
    /**
     * Who Base says supports these stocks, against who Miorail can see
     * supporting THIS address.
     *
     * Optional so a browser that loads a cached bundle against a newer server
     * -- and a server that predates the field -- both still parse. The outer
     * object is strict, so this line is what lets the field exist at all: the
     * same reason `pools` carries one.
     */
    ecosystem: z
      .object({
        listedBy: z.string().min(1).max(80),
        sourceTitle: z.string().min(1).max(200),
        sourceRef: z.string().url().startsWith('https://'),
        reviewedAt: z.string().min(1).max(40),
        tally: z
          .object({
            named: z.number().int().nonnegative(),
            namesIt: z.number().int().nonnegative(),
            doesNot: z.number().int().nonnegative(),
            unread: z.number().int().nonnegative(),
            unchecked: z.number().int().nonnegative(),
          })
          .strict(),
        rows: z.array(
          z
            .object({
              appId: z.string().min(1).max(60),
              appName: z.string().min(1).max(80),
              claim: z.string().min(1).max(300),
              category: z.enum([
                'issuance',
                'oracle',
                'exchange',
                'routing',
                'lending',
                'yield',
                'analytics',
                'wallet',
              ]),
              measured: z.enum(['listed', 'not_listed', 'unread', 'unchecked']),
              evidence: z.string().max(300).nullable(),
              detail: z.string().max(300).nullable(),
              reason: z.string().max(300).nullable(),
            })
            .strict(),
        ),
      })
      .strict()
      .optional(),
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
  /** How this venue answers. Declared by the source because the source is the
   * only thing that knows, and stamped by `defiListingV1` because the source
   * has no clock. */
  kind: DefiVenueObservationV1['source'];
  lookup(tokenAddress: string): Promise<DefiVenueReadingV1>;
}

const SCOPES_V1: readonly B20TransferScopeV1[] = ['sender', 'receiver', 'executor'];

function unreadEverythingV1(
  tokenAddress: string,
  observedAt: string,
  reason: string,
  defi: DefiListingV1,
  walletAddress: string | null,
  // Pools survive a chain outage: they were measured earlier, by a different
  // worker, at a block of their own. Blanking them because THIS read failed
  // would delete a good measurement to report a bad one.
  pools: PooledLiquidityV1 = { state: 'not_measured', blockNumber: null, readAt: null, rows: [] },
  // Survives a chain outage for the same reason pools do: the venue answers
  // and the stored pool rows it reads were gathered without this anchor.
  ecosystem?: RepresentationEcosystemV1,
): RepresentationUseAccessV1 {
  return {
    ...(ecosystem ? { ecosystem } : {}),
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
    pools,
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
  /**
   * Read per venue row, so each carries the moment its own answer arrived.
   *
   * Defaults to the single `now` above, which is right for a caller that has no
   * clock and wrong for nobody: it only collapses four stamps that a real clock
   * would spread by seconds.
   */
  clock?: () => Date;
  /**
   * Measured pool balances, already stored. Passed in rather than read here:
   * this is one database row set, not thirty-nine chain calls on a page load,
   * and the caller owns the repository.
   */
  pools?: PooledLiquidityV1;
  /**
   * The evidence the ecosystem card needs and this assembly does not read:
   * whose representation this is, which routers were asked and which answered,
   * and the reference feed a reviewed source binds to the address.
   *
   * Omitted by a caller that has none, and then the card is omitted whole
   * rather than rendered as thirty apps that do not support the token.
   */
  ecosystem?: Omit<EcosystemEvidenceV1, 'venues' | 'poolRows'>;
}): Promise<RepresentationUseAccessV1> {
  const tokenAddress = input.tokenAddress.toLowerCase();
  const observedAt = input.now.toISOString();
  const walletAddress = input.walletAddress?.toLowerCase() ?? null;
  const endpointIds = input.bridgeEndpointIds ?? Object.keys(BRIDGE_ENDPOINT_IDS_V1).map(Number);

  // DeFi first and independently: it does not read the chain through this
  // reader, so a chain outage must not also erase the venue answer.
  const defi = await defiListingV1(
    tokenAddress,
    input.defiSources ?? [],
    input.clock ?? (() => input.now),
  );

  const pools: PooledLiquidityV1 = input.pools ?? {
    state: 'not_measured',
    blockNumber: null,
    readAt: null,
    rows: [],
  };

  // Built from the venue answers and the stored pool rows, both of which exist
  // before the chain is touched -- so the card survives an anchor failure.
  const ecosystem = input.ecosystem
    ? ecosystemBlockV1({
        ...input.ecosystem,
        venues: defi.venues,
        poolRows: pools.state === 'measured' ? pools.rows : null,
      })
    : undefined;

  const anchor = await input.reader.readBlockAnchor();
  if (!anchor.ok) {
    return unreadEverythingV1(
      tokenAddress,
      observedAt,
      anchor.reason,
      defi,
      walletAddress,
      pools,
      ecosystem,
    );
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
    ...(ecosystem ? { ecosystem } : {}),
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
    pools,
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
/**
 * The venues, each stamped with when its own answer came back.
 *
 * `clock` is read once per row, after that row's lookup returns, and not once
 * for the whole set. The sources run in sequence and two of them are network
 * fetches, so one instant stamped on four rows would be the same overclaim this
 * function exists to stop, only smaller.
 */
export async function defiListingV1(
  tokenAddress: string,
  sources: readonly DefiListingSourceV1[],
  clock: () => Date,
): Promise<DefiListingV1> {
  const venues: DefiVenueListingV1[] = [];
  for (const source of sources) {
    const observed = (): DefiVenueObservationV1 => ({
      source: source.kind,
      at: clock().toISOString(),
    });
    try {
      const reading = await source.lookup(tokenAddress.toLowerCase());
      // Stamped here and nowhere else: a source cannot hand up its own
      // provenance, so it cannot hand up a wrong one.
      venues.push({ ...reading, observed: observed() });
    } catch (error) {
      venues.push({
        venueId: source.venueId,
        venueName: source.venueName,
        state: 'unread',
        uses: { lend: null, borrow: null, collateral: null },
        curated: null,
        marketRef: null,
        reason: error instanceof Error ? error.message.slice(0, 200) : 'venue read failed',
        // A failed reading is still a reading: it says when we tried.
        observed: observed(),
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
