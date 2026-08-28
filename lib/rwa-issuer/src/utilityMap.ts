import type { ReviewedIssuerIdV1 } from './issuers.js';
import {
  REPRESENTATION_STRUCTURE_ADAPTERS_V1,
  type ReviewedCapabilitySourceV1,
  type ReviewedTypedFieldV1,
} from './structureAdapters.js';

export const UTILITY_EVIDENCE_STATES_V1 = [
  'available',
  'observed',
  'documented',
  'not_established',
  'stale',
] as const;
export type UtilityEvidenceStateV1 = (typeof UTILITY_EVIDENCE_STATES_V1)[number];

export const UTILITY_EDGE_IDS_V1 = [
  'market_trade',
  'defi_lend',
  'defi_borrow',
  'defi_collateral',
  'defi_vault',
  'defi_yield_agent',
  'defi_lp',
  'issuer_mint_issue',
  'issuer_redeem_sell',
  'issuer_distributions',
  'issuer_corporate_actions',
  'issuer_bridge',
] as const;
export type UtilityEdgeIdV1 = (typeof UTILITY_EDGE_IDS_V1)[number];

export type UtilityDomainV1 = 'market_defi' | 'issuer';
export type UtilityNextStepKindV1 = 'read_only' | 'external_ui' | 'miorail_execution';

export interface UtilityEvidenceRefV1 {
  kind:
    | ReviewedCapabilitySourceV1['kind']
    | 'router_quote'
    | 'reviewed_registry_check';
  ref: string;
  checkedAt: string;
  /** Null for family-level documentation/call evidence. The edge itself is
   * still keyed to the exact representation, but evidence is never silently
   * retargeted to an address it did not name. */
  targetAddress: string | null;
  providerId: string | null;
}

export interface UtilityNextStepV1 {
  kind: UtilityNextStepKindV1;
  label: string;
  /** Only reviewed static metadata may populate this. Null is the normal
   * state; no URL is synthesized from a ticker, provider name or model text. */
  href: string | null;
}

export interface RepresentationUtilityEdgeV1 {
  edgeId: UtilityEdgeIdV1;
  domain: UtilityDomainV1;
  label: string;
  state: UtilityEvidenceStateV1;
  chainId: 8453;
  tokenAddress: string;
  caip10: string;
  issuerId: ReviewedIssuerIdV1;
  providerId: string | null;
  checkedAt: string;
  note: string;
  eligibilityNote: string;
  evidence: readonly UtilityEvidenceRefV1[];
  nextStep: UtilityNextStepV1;
}

export interface RepresentationUtilityMapV1 {
  schemaVersion: 'representation-utility-map/v1';
  chainId: 8453;
  tokenAddress: string;
  caip10: string;
  issuerId: ReviewedIssuerIdV1;
  evaluatedAt: string;
  marketDefi: readonly RepresentationUtilityEdgeV1[];
  issuer: readonly RepresentationUtilityEdgeV1[];
  ranking: 'none';
}

export interface MarketTradeUtilityObservationV1 {
  /** A router quote proves reachability/estimated economics, never execution,
   * so this input deliberately cannot say `available`. */
  state: 'observed' | 'stale' | 'not_established';
  providerId: string | null;
  checkedAt: string;
  evidenceRef: string | null;
  note: string;
}

const ADDRESS_V1 = /^0x[0-9a-f]{40}$/;

const EDGE_LABELS_V1: Readonly<Record<UtilityEdgeIdV1, string>> = {
  market_trade: 'Trade',
  defi_lend: 'Lend',
  defi_borrow: 'Borrow',
  defi_collateral: 'Use as collateral',
  defi_vault: 'Vault',
  defi_yield_agent: 'Yield agent',
  defi_lp: 'Liquidity position',
  issuer_mint_issue: 'Mint / issue',
  issuer_redeem_sell: 'Redeem / sell through issuer',
  issuer_distributions: 'Corporate distributions',
  issuer_corporate_actions: 'Corporate actions',
  issuer_bridge: 'Bridge',
};

function reviewedEvidenceV1(sources: readonly ReviewedCapabilitySourceV1[]): UtilityEvidenceRefV1[] {
  return sources.map((source) => ({
    kind: source.kind,
    ref: source.ref,
    checkedAt: source.reviewedAt,
    targetAddress: null,
    providerId: null,
  }));
}

function latestCheckedAtV1(
  sources: readonly ReviewedCapabilitySourceV1[],
  fallback: string,
): string {
  if (sources.length === 0) return fallback;
  return sources.slice(1).reduce(
    (latest, source) =>
      Date.parse(source.reviewedAt) > Date.parse(latest) ? source.reviewedAt : latest,
    sources[0]!.reviewedAt,
  );
}

function reviewedExternalStepV1(
  sources: readonly ReviewedCapabilitySourceV1[],
): UtilityNextStepV1 {
  const href = sources.map((source) => source.ref).find((ref) => /^https:\/\//.test(ref)) ?? null;
  return href
    ? { kind: 'external_ui', label: 'Read reviewed source', href }
    : { kind: 'read_only', label: 'Read evidence', href: null };
}

function uniqueSourcesV1(
  fields: readonly ReviewedTypedFieldV1<string>[],
): ReviewedCapabilitySourceV1[] {
  const seen = new Set<string>();
  const sources: ReviewedCapabilitySourceV1[] = [];
  for (const field of fields) {
    for (const source of field.sources) {
      const key = `${source.kind}:${source.ref}:${source.reviewedAt}`;
      if (seen.has(key)) continue;
      seen.add(key);
      sources.push(source);
    }
  }
  return sources;
}

function baseEdgeV1(input: {
  edgeId: UtilityEdgeIdV1;
  domain: UtilityDomainV1;
  state: UtilityEvidenceStateV1;
  tokenAddress: string;
  issuerId: ReviewedIssuerIdV1;
  providerId: string | null;
  checkedAt: string;
  note: string;
  eligibilityNote: string;
  evidence: readonly UtilityEvidenceRefV1[];
  nextStep: UtilityNextStepV1;
}): RepresentationUtilityEdgeV1 {
  return {
    ...input,
    label: EDGE_LABELS_V1[input.edgeId],
    chainId: 8453,
    caip10: `eip155:8453:${input.tokenAddress}`,
  };
}

function unknownDefiEdgeV1(input: {
  edgeId: Exclude<
    UtilityEdgeIdV1,
    | 'market_trade'
    | 'issuer_mint_issue'
    | 'issuer_redeem_sell'
    | 'issuer_distributions'
    | 'issuer_corporate_actions'
    | 'issuer_bridge'
  >;
  tokenAddress: string;
  issuerId: ReviewedIssuerIdV1;
  evaluatedAt: string;
  eligibilityNote: string;
}): RepresentationUtilityEdgeV1 {
  return baseEdgeV1({
    ...input,
    domain: 'market_defi',
    state: 'not_established',
    providerId: null,
    checkedAt: input.evaluatedAt,
    note: 'No reviewed exact-address integration is established for this representation.',
    evidence: [],
    nextStep: { kind: 'read_only', label: 'No action available', href: null },
  });
}

function issuerEdgeV1(input: {
  edgeId:
    | 'issuer_mint_issue'
    | 'issuer_redeem_sell'
    | 'issuer_distributions'
    | 'issuer_corporate_actions'
    | 'issuer_bridge';
  tokenAddress: string;
  issuerId: ReviewedIssuerIdV1;
  evaluatedAt: string;
  fields: readonly ReviewedTypedFieldV1<string>[];
  note: string;
  eligibilityNote: string;
}): RepresentationUtilityEdgeV1 {
  const reviewed = input.fields.every((field) => field.status === 'reviewed');
  const sources = reviewed ? uniqueSourcesV1(input.fields) : [];
  return baseEdgeV1({
    edgeId: input.edgeId,
    domain: 'issuer',
    state: reviewed ? 'documented' : 'not_established',
    tokenAddress: input.tokenAddress,
    issuerId: input.issuerId,
    providerId: input.issuerId,
    checkedAt: latestCheckedAtV1(sources, input.evaluatedAt),
    note: input.note,
    eligibilityNote: input.eligibilityNote,
    evidence: reviewedEvidenceV1(sources),
    nextStep: reviewed
      ? reviewedExternalStepV1(sources)
      : { kind: 'read_only', label: 'No action available', href: null },
  });
}

function mintNoteV1(issuerId: ReviewedIssuerIdV1): string {
  if (issuerId === 'coinbase') {
    return 'Primary mint / issuance is documented as an authenticated authorized-participant process.';
  }
  if (issuerId === 'dinari') {
    return 'Minting is documented as an issuer-account, KYC and jurisdiction-dependent process.';
  }
  return 'New legacy bToken issuance is documented as closed; this records the issuer terms, not an available action.';
}

export function representationUtilityMapV1(input: {
  tokenAddress: string;
  issuerId: ReviewedIssuerIdV1;
  evaluatedAt: string;
  marketTrade: MarketTradeUtilityObservationV1;
}): RepresentationUtilityMapV1 {
  const tokenAddress = input.tokenAddress.toLowerCase();
  if (!ADDRESS_V1.test(tokenAddress)) {
    throw new Error('representationUtilityMapV1 requires an exact lowercase Base address');
  }
  if (!Number.isFinite(Date.parse(input.evaluatedAt))) {
    throw new Error('representationUtilityMapV1 requires an evaluatedAt timestamp');
  }
  const adapter = REPRESENTATION_STRUCTURE_ADAPTERS_V1[input.issuerId];
  const eligibilityNote = adapter.eligibility.note;
  const tradeEvidence: UtilityEvidenceRefV1[] =
    input.marketTrade.evidenceRef && input.marketTrade.providerId
      ? [
          {
            kind: 'router_quote',
            ref: input.marketTrade.evidenceRef,
            checkedAt: input.marketTrade.checkedAt,
            targetAddress: tokenAddress,
            providerId: input.marketTrade.providerId,
          },
        ]
      : [];
  const marketTrade = baseEdgeV1({
    edgeId: 'market_trade',
    domain: 'market_defi',
    state: input.marketTrade.state,
    tokenAddress,
    issuerId: input.issuerId,
    providerId: input.marketTrade.providerId,
    checkedAt: input.marketTrade.checkedAt,
    note: input.marketTrade.note,
    eligibilityNote:
      'Router evidence does not establish whether this wallet may hold, transfer or redeem the representation.',
    evidence: tradeEvidence,
    // A quote is deliberately read-only. It cannot create approval calldata or
    // become Miorail-owned execution without a separate simulation/approval path.
    nextStep: { kind: 'read_only', label: 'Read market evidence', href: null },
  });

  const marketDefi = [
    marketTrade,
    ...(
      [
        'defi_lend',
        'defi_borrow',
        'defi_collateral',
        'defi_vault',
        'defi_yield_agent',
        'defi_lp',
      ] as const
    ).map((edgeId) =>
      unknownDefiEdgeV1({
        edgeId,
        tokenAddress,
        issuerId: input.issuerId,
        evaluatedAt: input.evaluatedAt,
        eligibilityNote,
      }),
    ),
  ];

  const issuer = [
    issuerEdgeV1({
      edgeId: 'issuer_mint_issue',
      tokenAddress,
      issuerId: input.issuerId,
      evaluatedAt: input.evaluatedAt,
      fields: [adapter.redemption, adapter.eligibility],
      note: mintNoteV1(input.issuerId),
      eligibilityNote,
    }),
    issuerEdgeV1({
      edgeId: 'issuer_redeem_sell',
      tokenAddress,
      issuerId: input.issuerId,
      evaluatedAt: input.evaluatedAt,
      fields: [adapter.redemption],
      note: adapter.redemption.note,
      eligibilityNote,
    }),
    issuerEdgeV1({
      edgeId: 'issuer_distributions',
      tokenAddress,
      issuerId: input.issuerId,
      evaluatedAt: input.evaluatedAt,
      fields: [adapter.distributions],
      note: adapter.distributions.note,
      eligibilityNote,
    }),
    issuerEdgeV1({
      edgeId: 'issuer_corporate_actions',
      tokenAddress,
      issuerId: input.issuerId,
      evaluatedAt: input.evaluatedAt,
      fields: [adapter.corporateActions],
      note: adapter.corporateActions.note,
      eligibilityNote,
    }),
    issuerEdgeV1({
      edgeId: 'issuer_bridge',
      tokenAddress,
      issuerId: input.issuerId,
      evaluatedAt: input.evaluatedAt,
      fields: [adapter.bridge],
      note: adapter.bridge.note,
      eligibilityNote,
    }),
  ];

  return {
    schemaVersion: 'representation-utility-map/v1',
    chainId: 8453,
    tokenAddress,
    caip10: `eip155:8453:${tokenAddress}`,
    issuerId: input.issuerId,
    evaluatedAt: input.evaluatedAt,
    marketDefi,
    issuer,
    ranking: 'none',
  };
}
